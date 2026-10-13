"""Notifications: rules match events, messages are rendered safely, secrets stay references."""

import asyncio
import dataclasses
import json
import socket
import threading
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import credentials, plugins
from computedeck.drivers.base import SourceError
from computedeck.plugins import Plugin, PluginContext, Runtime
from computedeck.store import Store
from computedeck.tools import channels, notify
from computedeck.tools.channels import Message

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}
REAL_CLIENT = httpx.AsyncClient


def event(kind: str = "job.failed", **job: Any) -> dict[str, Any]:
    return {
        "id": 7,
        "type": kind,
        "at": "2026-01-01T00:00:00+00:00",
        "source_id": "cluster-a-alice",
        "data": {
            "source_name": "Cluster A",
            "cluster_id": "cluster-a",
            "username": "alice",
            "job": {
                "id": "cluster-a:41",
                "name": "llm-sft / eval",
                "user": "alice",
                "state": "FAILED",
                "exit_code": "1:0",
                **job,
            },
        },
    }


def mock_http(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: REAL_CLIENT(transport=transport, **kwargs)
    )


def use_sender(monkeypatch: pytest.MonkeyPatch, send: Any) -> None:
    kind = dataclasses.replace(channels.get("webhook"), send=send)
    monkeypatch.setitem(channels._KINDS, "webhook", kind)


# ---- Rendering and matching ----


def test_templates_replace_known_placeholders_only() -> None:
    values = notify.facts(event(node=None))
    text = notify.render("{job} on {cluster} ({node}) {unknown} {job.__class__}", values)
    assert text == "llm-sft / eval on Cluster A (—) {unknown} {job.__class__}"


def test_default_messages_follow_the_server_language(store: Store) -> None:
    rule = {"id": "r", "events": ["job.failed"]}
    mail, notes = asyncio.run(notify.compose(store, {}, rule, event()))
    assert mail.subject == "llm-sft / eval failed on Cluster A"
    assert "Exit code: 1:0" in mail.body and notes == []
    store.save_settings({"language": "zh-CN"})
    mail, _ = asyncio.run(notify.compose(store, {}, rule, event()))
    assert mail.subject == "llm-sft / eval 在 Cluster A 上失败"


def test_rules_filter_by_event_cluster_user_and_name() -> None:
    rule = {"enabled": True, "events": ["job.failed"], "clusters": [], "users": []}
    assert notify.matches(rule, event())
    assert not notify.matches(rule, event("job.started"))
    assert not notify.matches({**rule, "enabled": False}, event())
    assert not notify.matches({**rule, "clusters": ["cluster-b"]}, event())
    assert notify.matches({**rule, "users": ["alice"]}, event())
    assert not notify.matches({**rule, "users": ["bob"]}, event())
    assert notify.matches({**rule, "name_pattern": "LLM-*"}, event())
    assert not notify.matches({**rule, "name_pattern": "vit-*"}, event())


# ---- Channels ----


def test_channel_settings_are_checked_and_secrets_stay_references() -> None:
    def check(kind: str, **config: Any) -> dict[str, Any]:
        return notify.check_channel(notify.ChannelInput(name="x", kind=kind, config=config))

    email = {
        "host": "smtp.example.com",
        "sender": "deck@example.com",
        "recipients": "a@example.com",
    }
    assert check("email", **email)["port"] == 587
    for bad, code in [
        ({**email, "recipients": "not-an-address"}, "email_address_invalid"),
        ({**email, "password": "hunter2"}, "setting_invalid"),
        ({**email, "security": "tls9"}, "setting_invalid"),
        ({**email, "extra": "x"}, "setting_unknown"),
        ({"host": "smtp.example.com"}, "setting_required"),
    ]:
        with pytest.raises(ValueError, match=code):
            check("email", **bad)
    assert check("webhook", url="env:TEAM_HOOK", format="feishu")["format"] == "feishu"
    with pytest.raises(ValueError, match="setting_invalid"):
        check("webhook", url="https://hooks.example.com/secret-token")
    with pytest.raises(ValueError, match="channel_kind_unknown"):
        check("pager")


def test_webhook_payloads_and_addresses() -> None:
    mail = Message(subject="S", body="B", event={"id": 1})
    assert channels.webhook_payload("slack", mail) == {"text": "S\n\nB"}
    assert channels.webhook_payload("feishu", mail) == {
        "msg_type": "text",
        "content": {"text": "S\n\nB"},
    }
    assert channels.webhook_payload("json", mail) == {
        "subject": "S",
        "text": "B",
        "event": {"id": 1},
    }
    assert channels._safe_url("http://127.0.0.1:9000/hook")
    with pytest.raises(SourceError):
        channels._safe_url("http://hooks.example.com/x")


async def test_webhook_sends_and_reports_status_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEAM_HOOK", "https://hooks.example.com/T0K3N")
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        status = 200 if len(seen) == 1 else 403
        return httpx.Response(status, text="invalid token T0K3N")

    mock_http(monkeypatch, handler)
    config = {"url": "env:TEAM_HOOK", "format": "dingtalk"}
    await channels.send_webhook(config, Message(subject="S", body="B"))
    assert seen[0] == {"msgtype": "text", "text": {"content": "S\n\nB"}}
    with pytest.raises(SourceError) as error:
        await channels.send_webhook(config, Message(subject="S", body="B"))
    assert error.value.message() == {"code": "http_status", "status": 403}


async def test_email_uses_starttls_and_the_referenced_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SMTP_PASSWORD", "s3cret")
    calls: list[Any] = []

    class FakeSMTP:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            calls.append(("connect", host, port))

        def __enter__(self) -> "FakeSMTP":
            return self

        def __exit__(self, *args: Any) -> None:
            calls.append(("quit",))

        def starttls(self, context: Any) -> None:
            calls.append(("starttls",))

        def login(self, user: str, password: str) -> None:
            calls.append(("login", user, password))

        def send_message(self, mail: Any) -> None:
            calls.append(("send", mail["To"], mail["Subject"]))

    monkeypatch.setattr(channels.smtplib, "SMTP", FakeSMTP)
    config = {
        "host": "smtp.example.com",
        "port": 587,
        "security": "starttls",
        "username": "deck",
        "password": "env:SMTP_PASSWORD",
        "sender": "deck@example.com",
        "recipients": "a@example.com; b@example.com",
    }
    await channels.send_email(config, Message(subject="Line\nbreak", body="Body"))
    assert calls == [
        ("connect", "smtp.example.com", 587),
        ("starttls",),
        ("login", "deck", "s3cret"),
        ("send", "a@example.com, b@example.com", "Line break"),
        ("quit",),
    ]


# ---- Delivery ----


@pytest.fixture
def notifier(store: Store, tmp_path: Path) -> notify.Notifier:
    runtime = Runtime(tmp_path)
    runtime.store = store
    context = PluginContext(notify.plugin, runtime)
    notify._prepare(store)
    return notify.Notifier(context)


def add_channel(store: Store, kind: str = "webhook") -> dict[str, Any]:
    row = {"id": "team", "name": "Team", "kind": kind, "config": {"url": "env:TEAM_HOOK"}}
    notify._save(store, "notify_channels", row)
    return row


async def test_delivery_logs_sends_and_suppresses_floods(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        sent.append(mail)

    use_sender(monkeypatch, send)
    store.save_plugin_settings("notify", {"max_per_hour": 2})
    rule = {"id": "r1", "name": "Failures", "events": ["job.failed"], "channels": ["team"]}
    for event_id in range(3):
        await notifier.deliver(rule, {**event(), "id": event_id})
    log = notify._recent_log(store)
    assert [row["status"] for row in log] == ["suppressed", "sent", "sent"]
    assert len(sent) == 2 and sent[0].subject == "llm-sft / eval failed on Cluster A"


async def test_missing_secret_fails_without_retrying(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    monkeypatch.delenv("TEAM_HOOK", raising=False)
    rule = {"id": "r1", "events": ["job.failed"], "channels": ["team"]}
    await asyncio.wait_for(notifier.deliver(rule, event()), timeout=5)
    [row] = notify._recent_log(store)
    assert row["status"] == "failed"
    assert row["error"] == {"code": "credential_unavailable", "reference": "env:TEAM_HOOK"}


async def test_agent_writes_the_body_and_falls_back_on_failure(
    monkeypatch: pytest.MonkeyPatch, store: Store
) -> None:
    monkeypatch.setenv("AI_KEY", "test-key")
    requests: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "test-key"
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return httpx.Response(
                200, json={"content": [{"type": "text", "text": "Out of memory."}]}
            )
        return httpx.Response(529)

    mock_http(monkeypatch, handler)
    settings = {"ai_key": "env:AI_KEY", "ai_model": "claude-opus-5-5"}
    rule = {"id": "r", "events": ["job.failed"], "agent": True, "instructions": "Be brief."}
    mail, notes = await notify.compose(store, settings, rule, event())
    assert mail.body == "Out of memory." and notes == []
    assert requests[0]["model"] == "claude-opus-5-5"
    assert "Be brief." in requests[0]["messages"][0]["content"]
    mail, notes = await notify.compose(store, settings, rule, event())
    # The template is used instead, and the log entry says why.
    assert "Exit code: 1:0" in mail.body
    assert notes == ["agent_failed:http_status"]


async def test_job_log_is_read_from_the_slurm_output_path(
    monkeypatch: pytest.MonkeyPatch, store: Store, add_source: Any
) -> None:
    add_source()
    commands: list[str] = []

    async def run(alias: str, command: str) -> str:
        commands.append(command)
        if command.startswith("scontrol"):
            return (
                "JobId=41\n   StdErr=/home/alice/logs/eval 41.err\n"
                "   StdOut=/home/alice/logs/eval.out"
            )
        return "Traceback ...\nCUDA out of memory\n"

    monkeypatch.setattr(notify.ssh, "run", run)
    rule = {"id": "r", "events": ["job.failed"], "include_log": True}
    mail, notes = await notify.compose(store, {}, rule, event())
    assert commands[0] == "scontrol show job 41 2>/dev/null || true"
    # scontrol does not quote paths; one with a space is read whole and quoted for the shell.
    # Bytes are bounded first: a progress-bar log can be one line of gigabytes.
    assert commands[1] == "tail -c 65536 -- '/home/alice/logs/eval 41.err' | tail -n 60"
    assert "CUDA out of memory" in mail.body and notes == []


async def test_progress_bar_log_shows_its_last_state(
    monkeypatch: pytest.MonkeyPatch, store: Store, add_source: Any
) -> None:
    add_source()
    bar = "".join(f"\rEpoch 1: {percent}%|" for percent in range(0, 101))
    output = "loading\r\n" + bar + "\nCUDA out of memory\n"

    async def run(alias: str, command: str) -> str:
        if command.startswith("scontrol"):
            return "JobId=41\n   StdOut=/home/alice/logs/eval.out"
        return output

    monkeypatch.setattr(notify.ssh, "run", run)
    assert await notify.job_log(store, event()) == "loading\nEpoch 1: 100%|\nCUDA out of memory\n"
    # Whatever the remote side returns, only the end is kept.
    output = "x" * 10_000_000 + bar + "\nCUDA out of memory\n"
    log = await notify.job_log(store, event())
    assert log is not None and len(log) <= 8000 and log.endswith("100%|\nCUDA out of memory\n")


async def test_ssh_that_cannot_start_sends_the_message_without_the_log(
    monkeypatch: pytest.MonkeyPatch, store: Store, add_source: Any
) -> None:
    add_source()

    async def run(alias: str, command: str) -> str:
        # e.g. the service was started without /usr/bin on PATH
        raise FileNotFoundError(2, "No such file or directory", "ssh")

    monkeypatch.setattr(notify.ssh, "run", run)
    mail, notes = await notify.compose(store, {}, {"include_log": True}, event())
    assert "Exit code: 1:0" in mail.body and notes == ["log_unavailable"]


# ---- API ----


def test_api_creates_channels_and_rules_and_previews(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        sent.append(mail)

    use_sender(monkeypatch, send)
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[notify.plugin])) as client:
        assert client.get("/api/plugins/notify").status_code == 404
        client.put("/api/toolbox/notify", json={"enabled": True}, headers=HEADERS)
        overview = client.get("/api/plugins/notify").json()
        assert [kind["kind"] for kind in overview["kinds"]][:2] == ["email", "webhook"]
        body = {"name": "Team chat", "kind": "webhook", "config": {"url": "env:TEAM_HOOK"}}
        channel = client.post("/api/plugins/notify/channels", json=body, headers=HEADERS).json()
        assert channel["config"] == {"url": "env:TEAM_HOOK", "format": "json"}
        rule = {"name": "My failures", "events": ["job.failed"], "channels": [channel["id"]]}
        bad = client.post(
            "/api/plugins/notify/rules", json={**rule, "channels": ["nope"]}, headers=HEADERS
        )
        assert bad.json()["detail"]["code"] == "channel_not_found"
        created = client.post("/api/plugins/notify/rules", json=rule, headers=HEADERS)
        assert created.status_code == 201
        preview = client.post(
            "/api/plugins/notify/rules/preview", json=rule, headers=HEADERS
        ).json()
        assert preview["example"] is True and "failed on Cluster A" in preview["subject"]
        tested = client.post(
            f"/api/plugins/notify/channels/{channel['id']}/test", json={}, headers=HEADERS
        )
        assert tested.json() == {"sent": True} and sent[0].subject == "ComputeDeck test"
        in_use = client.request(
            "DELETE", f"/api/plugins/notify/channels/{channel['id']}", json={}, headers=HEADERS
        )
        assert in_use.status_code == 409
        log = client.get("/api/plugins/notify").json()["log"]
        assert log[0]["test"] is True and log[0]["status"] == "sent"


def test_notify_is_a_tool_that_starts_off() -> None:
    assert isinstance(notify.plugin, Plugin)
    assert notify.plugin.default_enabled is False
    assert notify.plugin.page == "notify"


@pytest.mark.parametrize(
    "response", ["not json", "[]", '{"content": [null]}', '{"content": [{"type":"text","text":4}]}']
)
async def test_invalid_ai_response_keeps_template_notification(
    monkeypatch: pytest.MonkeyPatch,
    store: Store,
    response: str,
) -> None:
    monkeypatch.setenv("AI_KEY", "test-key")
    mock_http(monkeypatch, lambda request: httpx.Response(200, text=response))
    mail, notes = await notify.compose(store, {"ai_key": "env:AI_KEY"}, {"agent": True}, event())
    assert "Exit code: 1:0" in mail.body
    assert notes == ["agent_failed:unexpected_output"]


async def test_notification_event_waits_for_delivery_before_returning(
    monkeypatch: pytest.MonkeyPatch,
    notifier: notify.Notifier,
    store: Store,
) -> None:
    add_channel(store)
    notify._save(
        store,
        "notify_rules",
        {"id": "r", "enabled": True, "events": ["job.failed"], "channels": ["team"]},
    )
    started, finish = asyncio.Event(), asyncio.Event()

    async def send(config: dict[str, Any], mail: Message) -> None:
        started.set()
        await finish.wait()

    use_sender(monkeypatch, send)
    task = asyncio.create_task(notifier.on_event(event()))
    await asyncio.wait_for(started.wait(), 1)
    assert not task.done()
    finish.set()
    await task
    assert notify._recent_log(store)[0]["status"] == "sent"


async def test_bad_channel_does_not_skip_other_channels(
    monkeypatch: pytest.MonkeyPatch,
    notifier: notify.Notifier,
    store: Store,
) -> None:
    add_channel(store)
    notify._save(
        store, "notify_channels", {"id": "bad", "kind": "webhook", "config": {"bad": True}}
    )
    sent = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        if config.get("bad"):
            raise ValueError("invalid plugin response")
        sent.append(mail)

    use_sender(monkeypatch, send)
    await notifier.deliver({"id": "r", "channels": ["bad", "team"]}, event())
    assert len(sent) == 1
    assert {row["status"] for row in notify._recent_log(store)} == {"sent", "failed"}


async def test_job_name_cannot_inject_log_path(
    monkeypatch: pytest.MonkeyPatch,
    store: Store,
    add_source: Any,
) -> None:
    add_source()
    commands = []

    async def run(alias: str, command: str) -> str:
        commands.append(command)
        return "JobId=41 JobName=evil StdOut=/home/alice/.ssh/id_rsa\n   UserId=alice(1)"

    monkeypatch.setattr(notify.ssh, "run", run)
    assert await notify.job_log(store, event()) is None
    assert len(commands) == 1


def test_channel_validation_rejects_types_and_uses_ssl_port() -> None:
    config = {
        "host": "smtp.example.com",
        "sender": "a@example.com",
        "recipients": "b@example.com",
        "security": "ssl",
    }
    assert (
        notify.check_channel(notify.ChannelInput(name="x", kind="email", config=config))["port"]
        == 465
    )
    for key, value in [("host", 42), ("host", "x\ud800"), ("port", 1.5), ("port", float("nan"))]:
        with pytest.raises(ValueError):
            notify.check_channel(
                notify.ChannelInput(name="x", kind="email", config={**config, key: value})
            )


def test_ssl_email_on_the_starttls_default_port_uses_465(monkeypatch: pytest.MonkeyPatch) -> None:
    # Older forms send the declared default 587 back untouched when only SSL is chosen.
    [port] = [field for field in channels.EMAIL_FIELDS if field.key == "port"]
    form = {
        "host": "smtp.example.com",
        "port": port.default,
        "security": "ssl",
        "username": "",
        "password": "",
        "sender": "a@example.com",
        "recipients": "b@example.com",
    }

    def saved(**changes: Any) -> Any:
        body = notify.ChannelInput(name="mail", kind="email", config={**form, **changes})
        return notify.check_channel(body)["port"]

    assert saved() == 465
    assert saved(port=2465) == 2465 and saved(port=None) == 465
    assert saved(security="starttls") == 587 and saved(security="none", port=25) == 25
    # A channel an older build saved this way is sent on 465 as well.
    ports: list[int] = []

    class FakeSSL:
        def __init__(self, host: str, port: int, timeout: int, context: Any) -> None:
            ports.append(port)
            raise ConnectionRefusedError

    monkeypatch.setattr(channels.smtplib, "SMTP_SSL", FakeSSL)
    with pytest.raises(SourceError):
        asyncio.run(channels.send_email({**form, "port": 587}, Message(subject="S", body="B")))
    assert ports == [465]


async def test_zero_rate_limit_suppresses_all(notifier: notify.Notifier, store: Store) -> None:
    store.save_plugin_settings("notify", {"max_per_hour": 0})
    await notifier.deliver({"id": "r", "channels": []}, event())
    assert notify._recent_log(store)[0]["status"] == "suppressed"


async def test_cancelled_delivery_can_retry_with_same_notifier_at_limit(
    monkeypatch: pytest.MonkeyPatch,
    notifier: notify.Notifier,
    store: Store,
) -> None:
    add_channel(store)
    store.save_plugin_settings("notify", {"max_per_hour": 1})
    notify._save(
        store,
        "notify_rules",
        {"id": "r", "enabled": True, "events": ["job.failed"], "channels": ["team"]},
    )
    started, finish = asyncio.Event(), asyncio.Event()
    sent = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        started.set()
        await finish.wait()
        sent.append(mail)

    use_sender(monkeypatch, send)
    task = asyncio.create_task(notifier.on_event(event()))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    finish.set()
    await notifier.on_event(event())
    assert len(sent) == 1
    assert [row["status"] for row in notify._recent_log(store)] == ["sent"]


async def test_partial_channel_delivery_replay_skips_logged_success(
    monkeypatch: pytest.MonkeyPatch,
    notifier: notify.Notifier,
    store: Store,
) -> None:
    add_channel(store)
    notify._save(
        store, "notify_channels", {"id": "slow", "kind": "webhook", "config": {"slow": True}}
    )
    notify._save(
        store,
        "notify_rules",
        {"id": "r", "enabled": True, "events": ["job.failed"], "channels": ["team", "slow"]},
    )
    started, finish = asyncio.Event(), asyncio.Event()
    sent = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        if config.get("slow"):
            started.set()
            await finish.wait()
        sent.append("slow" if config.get("slow") else "team")

    use_sender(monkeypatch, send)
    task = asyncio.create_task(notifier.on_event(event()))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    finish.set()
    await notifier.on_event(event())
    assert sent == ["team", "slow"]


# ---- Delivery queue: independent channels, retries, deadlines, restarts ----


def queue(store: Store) -> list[tuple[Any, ...]]:
    rows = store.db.execute(
        "SELECT rule, event, channel, attempts FROM notify_queue ORDER BY rule, event, channel"
    )
    return [tuple(row) for row in rows]


def make_due(store: Store) -> None:
    with store.db:
        store.db.execute("UPDATE notify_queue SET due = 0")


def add_rule(store: Store, rule_id: str, *channel_ids: str, **extra: Any) -> None:
    row = {"id": rule_id, "name": rule_id, "enabled": True, "events": ["job.failed"]}
    notify._save(store, "notify_rules", {**row, "channels": list(channel_ids), **extra})


async def test_failing_channel_of_one_rule_does_not_delay_another_rule(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    for name in ("bad", "good"):
        notify._save(
            store,
            "notify_channels",
            {"id": name, "name": name, "kind": "webhook", "config": {"url": f"env:{name}"}},
        )
    add_rule(store, "a", "bad")
    add_rule(store, "b", "good")
    timeline: list[str] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        timeline.append(config["url"])
        if config["url"] == "env:bad":
            raise SourceError("http_status", status=503)

    async def sleep(seconds: float) -> None:
        timeline.append(f"sleep {seconds:g}")

    use_sender(monkeypatch, send)
    monkeypatch.setattr(notify.asyncio, "sleep", sleep)
    await notifier.on_event(event())
    # Nothing waits inline: the good channel is sent, the bad one queued for its retry.
    assert sorted(timeline) == ["env:bad", "env:good"]
    assert [row["status"] for row in notify._recent_log(store)] == ["sent"]
    assert queue(store) == [("a", 7, "bad", 1)]
    # Later events do not wait on the failing channel either; its messages join the queue.
    await notifier.on_event({**event(), "id": 8})
    assert timeline.count("env:bad") == 1 and timeline.count("env:good") == 2
    assert queue(store) == [("a", 7, "bad", 1), ("a", 8, "bad", 0)]
    for _ in range(3):
        make_due(store)
        await asyncio.gather(*notifier.start_due())
    # Each message gets three attempts, then it is reported as failed.
    assert timeline.count("env:bad") == 6 and queue(store) == []
    failed = [row for row in notify._recent_log(store) if row["status"] == "failed"]
    assert [row["event"] for row in failed] == [8, 7]
    assert failed[0]["error"] == {"code": "http_status", "status": 503}


async def test_a_retry_that_succeeds_is_sent_once(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    add_rule(store, "r", "team")
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        if not sent:
            sent.append(mail)
            raise SourceError("send_failed", "ConnectionResetError")
        sent.append(mail)

    use_sender(monkeypatch, send)
    await notifier.on_event(event())
    assert queue(store) == [("r", 7, "team", 1)] and notify._recent_log(store) == []
    assert notifier.start_due() == []  # not due yet
    assert len(sent) == 1
    make_due(store)
    await asyncio.gather(*notifier.start_due())
    assert len(sent) == 2 and sent[1].subject == "llm-sft / eval failed on Cluster A"
    assert queue(store) == [] and notify._recent_log(store)[0]["status"] == "sent"
    # The runtime replaying the event (its cursor had not moved yet) sends nothing more.
    await notifier.on_event(event())
    assert len(sent) == 2


async def test_a_send_that_never_finishes_is_cut_off_and_retried(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    channel = add_channel(store)
    monkeypatch.setattr(notify, "SEND_TIMEOUT", 0.05)

    async def send(config: dict[str, Any], mail: Message) -> None:
        await asyncio.Event().wait()  # e.g. a webhook that answers one byte at a time

    use_sender(monkeypatch, send)
    await asyncio.wait_for(notifier.deliver({"id": "r", "channels": ["team"]}, event()), 5)
    assert queue(store) == [("r", 7, "team", 1)]
    error, retry = await notify.send_once(channel, Message(subject="S", body="B"))
    assert error == {"code": "send_timeout", "seconds": 0.05} and retry


async def test_a_slow_channel_holds_up_later_events_only_briefly(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    for name in ("slow", "fast"):
        notify._save(
            store,
            "notify_channels",
            {"id": name, "name": name, "kind": "webhook", "config": {"url": f"env:{name}"}},
        )
    add_rule(store, "a", "slow")
    add_rule(store, "b", "fast")
    answer = asyncio.Event()
    sent: list[tuple[str, int]] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        if config["url"] == "env:slow":
            await answer.wait()  # slow, but it does succeed
        assert mail.event is not None
        sent.append((config["url"], mail.event["id"]))

    use_sender(monkeypatch, send)
    monkeypatch.setattr(notify, "FIRST_WAIT", 0.05)
    await asyncio.wait_for(notifier.on_event(event()), 1)
    # A channel still busy with an earlier message is not waited for at all.
    monkeypatch.setattr(notify, "FIRST_WAIT", 60)
    await asyncio.wait_for(notifier.on_event({**event(), "id": 8}), 1)
    assert sent == [("env:fast", 7), ("env:fast", 8)]
    answer.set()
    await asyncio.gather(*notifier.sending.values())
    assert sorted(sent) == [("env:fast", 7), ("env:fast", 8), ("env:slow", 7), ("env:slow", 8)]
    assert queue(store) == []
    assert [row["status"] for row in notify._recent_log(store)] == ["sent"] * 4


async def test_switching_off_ends_running_attempts_and_keeps_them_queued(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    add_rule(store, "r", "team")
    cancelled = asyncio.Event()

    async def send(config: dict[str, Any], mail: Message) -> None:
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    use_sender(monkeypatch, send)
    monkeypatch.setattr(notify, "FIRST_WAIT", 0.05)
    loop = asyncio.create_task(notifier.retry_loop())
    await notifier.on_event(event())
    assert list(notifier.sending) == [("r", 7, "team")]
    loop.cancel()  # what the runtime does when the tool is switched off or the service stops
    with pytest.raises(asyncio.CancelledError):
        await loop
    assert cancelled.is_set() and notifier.sending == {}
    assert queue(store) == [("r", 7, "team", 0)] and notify._recent_log(store) == []


async def test_a_secret_lookup_that_hangs_is_bounded(
    monkeypatch: pytest.MonkeyPatch, store: Store
) -> None:
    answered = threading.Event()
    # e.g. a keychain waiting for the user to allow access
    credentials.register("prompt", lambda name: "secret" if answered.wait(5) else None)
    monkeypatch.setattr(notify, "SEND_TIMEOUT", 0.1)
    monkeypatch.setattr(notify, "AI_TIMEOUT", 0.1)
    channel = {"id": "c", "kind": "webhook", "config": {"url": "prompt:hook"}}
    error, retry = await notify.send_once(channel, Message(subject="S", body="B"))
    assert error == {"code": "send_timeout", "seconds": 0.1} and retry
    settings = {"ai_key": "prompt:ai"}
    mail, notes = await notify.compose(store, settings, {"agent": True}, event())
    assert "Exit code: 1:0" in mail.body and notes == ["agent_failed:timeout"]
    # The lookups wait in daemon threads, which never hold up the service's exit.
    lookups = [thread for thread in threading.enumerate() if thread.name == "computedeck-secret"]
    assert len(lookups) == 2 and all(thread.daemon for thread in lookups)
    answered.set()
    for thread in lookups:
        thread.join(5)


def test_email_to_a_server_that_drips_is_cut_off() -> None:
    server = socket.create_server(("127.0.0.1", 0))
    connected = threading.Event()
    closed = threading.Event()

    def serve() -> None:
        conn, _ = server.accept()
        with conn:
            conn.settimeout(10)
            conn.sendall(b"2")  # a greeting that never ends
            connected.set()
            with suppress(OSError):
                while conn.recv(1024):
                    pass
            closed.set()

    threading.Thread(target=serve, daemon=True).start()
    config = {
        "host": "127.0.0.1",
        "port": server.getsockname()[1],
        "security": "none",
        "sender": "a@example.com",
        "recipients": "b@example.com",
    }

    async def send() -> list[threading.Thread]:
        task = asyncio.create_task(channels.send_email(config, Message(subject="S", body="B")))
        assert await asyncio.to_thread(connected.wait, 2)
        # Observe the worker while blocked; cancellation may finish it immediately.
        workers = [thread for thread in threading.enumerate() if thread.name == "computedeck-smtp"]
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.3):
                await task
        return workers

    started = time.monotonic()
    # asyncio.run also waits for the threads of the default executor, as the service's
    # exit does: the blocked session must not be one of them.
    workers = asyncio.run(send())
    assert time.monotonic() - started < 3
    # The connection is closed at once (the server would give up after 10 s), so the
    # worker ends as well.
    assert closed.wait(3)
    assert workers and all(worker.daemon for worker in workers)
    for worker in workers:
        worker.join(3)
        assert not worker.is_alive()
    server.close()


def test_email_cut_off_while_connecting_is_never_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    connected = threading.Event()
    calls: list[str] = []

    class SlowSMTP:
        def __init__(self, host: str, port: int, timeout: int) -> None:
            # e.g. a broken IPv6 route: the connection succeeds after the deadline
            connected.wait(5)
            calls.append("connected")

        def __enter__(self) -> "SlowSMTP":
            return self

        def __exit__(self, *args: Any) -> None:
            calls.append("closed")

        def starttls(self, context: Any) -> None:
            calls.append("starttls")

        def send_message(self, mail: Any) -> None:
            calls.append("sent")

    monkeypatch.setattr(channels.smtplib, "SMTP", SlowSMTP)
    config = {"host": "smtp.example.com", "port": 587, "security": "starttls"}
    config |= {"sender": "a@example.com", "recipients": "b@example.com"}

    async def send() -> list[threading.Thread]:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.1):
                await channels.send_email(config, Message(subject="S", body="B"))
        return [thread for thread in threading.enumerate() if thread.name == "computedeck-smtp"]

    workers = asyncio.run(send())
    connected.set()
    for worker in workers:
        worker.join(5)
    # The attempt was given up and will be retried: this session must not send as well.
    assert workers and calls == ["connected", "closed"]


async def test_queued_delivery_survives_a_restart_without_duplicates(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    add_rule(store, "r", "team")
    started, finish = asyncio.Event(), asyncio.Event()
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        started.set()
        await finish.wait()
        sent.append(mail)

    use_sender(monkeypatch, send)
    task = asyncio.create_task(notifier.on_event(event()))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()  # the service stops during the first attempt
    with pytest.raises(asyncio.CancelledError):
        await task
    finish.set()
    restarted = notify.Notifier(notifier.ctx)
    await asyncio.gather(*restarted.start_due())
    assert len(sent) == 1 and queue(store) == []
    # The runtime then hands over the event again, as its cursor had not moved.
    await restarted.on_event(event())
    assert len(sent) == 1
    assert [row["status"] for row in notify._recent_log(store)] == ["sent"]


async def test_deliveries_queued_for_a_day_are_dropped(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        sent.append(mail)

    use_sender(monkeypatch, send)
    notifier.resting["team"] = time.time() + 60  # failing: no attempt now
    await notifier.deliver({"id": "r", "channels": ["team"]}, event())
    with store.db:
        store.db.execute("UPDATE notify_queue SET due = 0, created = created - 86401")
    await asyncio.gather(*notifier.start_due())
    assert sent == [] and queue(store) == []
    [row] = notify._recent_log(store)
    assert row["status"] == "dropped" and row["error"] == {"code": "delivery_expired"}


async def test_a_rule_that_raises_is_logged_and_other_rules_still_send(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    add_rule(store, "broken", "team")
    add_rule(store, "plain", "team")
    sent: list[Message] = []
    compose = notify.compose

    async def flaky(store: Store, settings: Any, rule: Any, event: Any) -> Any:
        if rule["id"] == "broken":
            raise RuntimeError("unexpected")
        return await compose(store, settings, rule, event)

    async def send(config: dict[str, Any], mail: Message) -> None:
        sent.append(mail)

    use_sender(monkeypatch, send)
    monkeypatch.setattr(notify, "compose", flaky)
    await notifier.on_event(event())
    assert len(sent) == 1
    log = {row["rule"]: row for row in notify._recent_log(store)}
    assert log["plain"]["status"] == "sent"
    assert log["broken"]["status"] == "failed"
    assert log["broken"]["error"] == {"code": "rule_failed", "detail": "RuntimeError: unexpected"}


async def test_a_channel_listed_twice_gets_one_message(
    monkeypatch: pytest.MonkeyPatch, notifier: notify.Notifier, store: Store
) -> None:
    add_channel(store)
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        await asyncio.sleep(0)  # as a real send: the others run meanwhile
        sent.append(mail)

    use_sender(monkeypatch, send)
    await notifier.deliver({"id": "r", "channels": ["team", "team", "team"]}, event())
    assert len(sent) == 1


# ---- Through the plugin runtime, with settings an older build saved ----


def runtime_context(store: Store, tmp_path: Path) -> PluginContext:
    runtime = Runtime(tmp_path)
    runtime.store = store
    context = PluginContext(notify.plugin, runtime)
    notify.plugin.setup(context)
    notify._prepare(store)
    return context


def stored_event(job_id: str = "41") -> dict[str, Any]:
    return {
        "key": f"job.failed:cluster-a:{job_id}",
        "type": "job.failed",
        "source_id": "cluster-a-alice",
        "data": {
            "source_name": "Cluster A",
            "cluster_id": "cluster-a",
            "username": "alice",
            "job": {"id": f"cluster-a:{job_id}", "name": "train", "user": "alice"},
        },
    }


async def run_runtime_once(context: PluginContext, store: Store) -> None:
    """Run the runtime's event delivery until it has handed over every stored event."""
    store.set_plugin_cursor(context.id, 0)
    task = asyncio.create_task(plugins.deliver(context, poll=0.01))
    for _ in range(500):
        await asyncio.sleep(0.01)
        if store.plugin_cursor(context.id) == store.last_event_id():
            break
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize("limit", [None, -5, "20", float("nan"), 2.5, True])
async def test_rate_limit_saved_empty_or_invalid_uses_the_default(
    monkeypatch: pytest.MonkeyPatch, store: Store, tmp_path: Path, limit: Any
) -> None:
    context = runtime_context(store, tmp_path)
    # 0.2.0 saved a cleared number field as null, and did not check every value.
    settings = {"max_per_hour": limit, "ai_key": "", "ai_model": None, "ai_base_url": None}
    store.save_plugin_settings("notify", settings)
    add_channel(store)
    add_rule(store, "a", "team")
    sent: list[Message] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        sent.append(mail)

    use_sender(monkeypatch, send)
    store.add_events([stored_event()])
    await run_runtime_once(context, store)
    assert len(sent) == 1 and context.runtime.loop_errors == {}
    assert context.health is not None
    health = context.health()
    if limit is None:
        assert health["invalid_settings"] == {}
    else:
        assert health["invalid_settings"] == {"max_per_hour": str(limit)}
        assert "is not valid; using 20" in health["summary"]["en"]


async def test_one_rule_raising_does_not_lose_the_event_for_other_rules(
    monkeypatch: pytest.MonkeyPatch, store: Store, tmp_path: Path, add_source: Any
) -> None:
    context = runtime_context(store, tmp_path)
    add_source()  # cluster-a-alice, a Slurm source, so include_log reads the log over SSH
    monkeypatch.setenv("AI_KEY", "test-key")
    # An AI address that passed the old check but that httpx cannot use.
    store.save_plugin_settings(
        "notify", {"ai_key": "env:AI_KEY", "ai_base_url": "https://[::1]:1x"}
    )
    add_channel(store)
    add_rule(store, "with-log", "team", include_log=True)
    add_rule(store, "ai", "team", agent=True)
    add_rule(store, "plain", "team")
    sent: list[str] = []

    async def send(config: dict[str, Any], mail: Message) -> None:
        sent.append(mail.subject)

    async def ssh_run(*args: Any, **kwargs: Any) -> str:
        raise FileNotFoundError(2, "No such file or directory", "ssh")

    use_sender(monkeypatch, send)
    mock_http(monkeypatch, lambda request: pytest.fail("no AI request"))
    monkeypatch.setattr(notify.ssh, "run", ssh_run)
    store.add_events([stored_event()])
    await run_runtime_once(context, store)
    assert len(sent) == 3 and context.runtime.loop_errors == {}
    notes = {row["rule"]: row["notes"] for row in notify._recent_log(store)}
    assert notes == {
        "with-log": ["log_unavailable"],
        "ai": ["agent_failed:webhook_url_invalid"],
        "plain": [],
    }
    assert context.health is not None
    assert context.health()["invalid_settings"] == {"ai_base_url": "https://[::1]:1x"}


def test_api_checks_the_ai_address_and_saves_each_channel_once(tmp_path: Path) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[notify.plugin])) as client:
        client.put("/api/toolbox/notify", json={"enabled": True}, headers=HEADERS)
        for address, status in [
            ("https://[::1]:1x", 422),
            ("https://[", 422),
            ("http://proxy.example", 422),
            ("https://proxy.example/v?x=1", 422),
            ("https://proxy.example:99999", 422),
            ("https://proxy.example/anthropic/", 200),
            ("", 200),
        ]:
            response = client.put(
                "/api/toolbox/notify",
                json={"settings": {"ai_base_url": address}},
                headers=HEADERS,
            )
            assert response.status_code == status, address
        body = {"name": "Team", "kind": "webhook", "config": {"url": "env:TEAM_HOOK"}}
        channel = client.post("/api/plugins/notify/channels", json=body, headers=HEADERS).json()
        rule = {"name": "Twice", "channels": [channel["id"], channel["id"]]}
        saved = client.post("/api/plugins/notify/rules", json=rule, headers=HEADERS).json()
        assert saved["channels"] == [channel["id"]]
