"""Extension points: server plugins and external drivers on the shared service."""

import asyncio
import io
import logging
import sys
import time
from pathlib import Path
from typing import Any, ClassVar, Literal

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import cli, credentials, drivers
from computedeck import plugins as plugin_host
from computedeck.drivers.base import Batch, SourceError
from computedeck.plugins import Plugin, PluginContext, Runtime
from computedeck.store import Store

HEADERS = {
    "Origin": "http://127.0.0.1:8710",
    "X-ComputeDeck": "1",
    "Content-Type": "application/json",
}


def example_plugin(events: list[str], plugin_id: str = "example") -> Plugin:
    def setup(context: PluginContext) -> None:
        events.append("setup")

        @context.router.get("/status")
        async def status() -> dict[str, Any]:
            return {
                "id": context.id,
                "sources": len(context.store.sources()),
                "data_dir": str(context.data_dir),
            }

        @context.router.post("/echo")
        async def echo(body: dict[str, Any]) -> dict[str, Any]:
            return body

        async def loop() -> None:
            events.append("loop started")
            try:
                await asyncio.Event().wait()
            finally:
                events.append("loop stopped")

        context.background(loop)
        context.on_startup(lambda: events.append(f"startup with {len(context.store.sources())}"))
        context.on_shutdown(lambda: events.append("shutdown"))
        context.health = lambda: {"ok": True}

    return Plugin(id=plugin_id, setup=setup)


def quiet_plugin(plugin_id: str = "quiet") -> Plugin:
    return Plugin(id=plugin_id, setup=lambda context: None)


def test_plugin_routes_are_mounted_under_their_id(tmp_path: Path) -> None:
    events: list[str] = []
    app = api.create_app(tmp_path, polling=False, plugins=[example_plugin(events)])
    with TestClient(app) as client:
        assert client.get("/api/plugins/example/status").json() == {
            "id": "example",
            "sources": 0,
            "data_dir": str(tmp_path / "plugins/example"),
        }
        assert client.get("/status").status_code == 404
        assert client.get("/api/plugins/other/status").status_code == 404
        # Plugin writes get the same local-origin protection as core writes.
        assert client.post("/api/plugins/example/echo", json={"a": 1}).status_code == 403
        response = client.post("/api/plugins/example/echo", json={"a": 1}, headers=HEADERS)
        assert response.json() == {"a": 1}
        # And the same check of request text: nothing a plugin stores can break a later read.
        response = client.post(
            "/api/plugins/example/echo", content='{"a": "x\\ud800"}', headers=HEADERS
        )
        assert response.status_code == 422
        assert response.json() == {"detail": {"code": "text_invalid"}}


def test_loops_do_not_start_without_polling(tmp_path: Path) -> None:
    events: list[str] = []
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[example_plugin(events)])):
        assert events == ["setup", "startup with 0"]
    assert events == ["setup", "startup with 0", "shutdown"]


def test_loops_run_with_polling_and_stop_on_shutdown(tmp_path: Path) -> None:
    events: list[str] = []
    with TestClient(api.create_app(tmp_path, polling=True, plugins=[example_plugin(events)])):
        for _ in range(100):
            if "loop started" in events:
                break
            time.sleep(0.01)
        assert "loop started" in events
        assert "loop stopped" not in events
    assert events[-2:] == ["loop stopped", "shutdown"]


def test_a_loop_slow_to_stop_cannot_keep_the_service_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api, "SHUTDOWN_SECONDS", 0.2)
    stopped: list[str] = []

    def setup(context: PluginContext) -> None:
        async def slow() -> None:
            try:
                await asyncio.sleep(3600)
            finally:
                # E.g. waiting for a remote command to exit.
                await asyncio.sleep(30)

        context.background(slow)
        context.on_shutdown(lambda: stopped.append("shutdown"))

    started = time.monotonic()
    with TestClient(api.create_app(tmp_path, polling=True, plugins=[Plugin("slow", setup)])):
        time.sleep(0.1)
    assert stopped == ["shutdown"]
    assert time.monotonic() - started < 3


def test_serve_bounds_the_wait_for_requests_in_flight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import uvicorn

    configs: list[Any] = []
    monkeypatch.setattr(uvicorn.Server, "run", lambda self: configs.append(self.config))
    monkeypatch.setenv("COMPUTEDECK_DATA_DIR", str(tmp_path))
    api.serve(port=19999)
    assert configs[0].timeout_graceful_shutdown == api.SHUTDOWN_SECONDS == 10


def test_health_includes_plugin_health(tmp_path: Path) -> None:
    app = api.create_app(tmp_path, polling=False, plugins=[example_plugin([]), quiet_plugin()])
    with TestClient(app) as client:
        assert client.get("/api/health").json()["plugins"] == {
            "example": {"ok": True, "enabled": True},
            "quiet": {"enabled": True},
        }


def test_one_plugin_failing_does_not_stop_the_service(tmp_path: Path) -> None:
    def broken(context: PluginContext) -> None:
        raise RuntimeError("no config")

    def failing(context: PluginContext) -> None:
        def health() -> dict[str, Any]:
            raise ValueError("bad row")

        context.on_startup(lambda: [][0])
        context.health = health

    plugins = [Plugin(id="broken", setup=broken), Plugin(id="failing", setup=failing)]
    app = api.create_app(tmp_path, polling=False, plugins=[*plugins, example_plugin([])])
    with TestClient(app) as client:
        health = client.get("/api/health").json()
        assert health["plugins"]["failing"] == {"error": "ValueError: bad row", "enabled": True}
        assert health["plugins"]["example"] == {"ok": True, "enabled": True}
        items = client.get("/api/dashboard").json()["attention"]
        assert {item["kind"] for item in items} == {"service_loop_failed", "plugin_error"}
        assert next(item for item in items if item["kind"] == "plugin_error")["details"] == [
            "ValueError: bad row"
        ]
        tools = {tool["id"]: tool for tool in client.get("/api/toolbox").json()}
        assert tools["broken"]["rejected"] == {
            "code": "plugin_setup_failed",
            "detail": "RuntimeError: no config",
        }
        assert tools["failing"]["errors"]["failing:startup"]["error"] == (
            "IndexError: list index out of range"
        )
        assert tools["example"]["rejected"] is None and tools["example"]["errors"] == {}
        assert client.get("/api/plugins/example/status").status_code == 200


@pytest.mark.parametrize("result", [None, [], "invalid", 1])
def test_invalid_plugin_health_does_not_stop_the_dashboard(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, result: Any
) -> None:
    def setup(context: PluginContext) -> None:
        context.health = lambda: result

    app = api.create_app(tmp_path, polling=False, plugins=[Plugin("invalid", setup)])
    error = f"{type(result).__name__} is not a health dict"
    with TestClient(app) as client:
        response = client.get("/api/dashboard")
        assert response.status_code == 200
        [item] = response.json()["attention"]
        assert item["kind"] == "plugin_error"
        assert item["subject"]["id"] == "invalid"
        assert item["details"] == [error]
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["plugins"]["invalid"] == {"error": error, "enabled": True}
    assert error in caplog.text


def test_duplicate_plugin_ids_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Duplicate plugin id: example"):
        api.create_app(tmp_path, plugins=[example_plugin([]), quiet_plugin("example")])


def test_explicit_empty_plugin_list_skips_discovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def discover() -> list[Plugin]:
        raise AssertionError("Installed plugins must not be loaded")

    monkeypatch.setattr(plugin_host, "discover", discover)
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/health").json()["plugins"] == {}
        assert client.get("/api/plugins/example/status").status_code == 404


def test_default_loads_installed_plugins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[str] = []
    monkeypatch.setattr(plugin_host, "discover", lambda data_dir=None: [example_plugin(events)])
    with TestClient(api.create_app(tmp_path, polling=False)) as client:
        assert client.get("/api/health").json()["plugins"] == {
            "example": {"ok": True, "enabled": True}
        }
    assert "setup" in events


class Entry:
    def __init__(self, name: str, value: object) -> None:
        self.name = name
        self.value = value

    def load(self) -> object:
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


def test_discover_retains_broken_or_foreign_entry_points(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    first, second = quiet_plugin("alpha"), quiet_plugin("beta")
    groups: list[str] = []

    def entry_points(group: str) -> list[Entry]:
        groups.append(group)
        return [
            Entry("beta", second),
            Entry("broken", ImportError("missing dependency")),
            Entry("alpha", first),
            Entry("foreign", object()),
        ]

    monkeypatch.setattr(plugin_host, "entry_points", entry_points)
    with caplog.at_level(logging.ERROR, logger="computedeck"):
        found = plugin_host.discover()
    assert found[:2] == [first, second]
    assert [(plugin.id, plugin.load_error) for plugin in found[2:]] == [
        ("broken", "ImportError"),
        ("foreign", "Invalid plugin entry point"),
    ]
    # Policy reads the names of both groups; only plugins are loaded.
    assert set(groups) == {"computedeck.plugins", "computedeck.drivers"}
    assert "broken" in caplog.text
    assert "foreign" in caplog.text


def test_plugin_credential_scheme_is_accepted_by_sources(tmp_path: Path) -> None:
    def setup(context: PluginContext) -> None:
        context.credential_scheme("vault", lambda name: f"secret-{name}", r"[a-z/]{1,40}")

    body = {"name": "RunPod", "driver": "runpod", "credential": "vault:team/runpod"}
    with TestClient(api.create_app(tmp_path / "plain", polling=False, plugins=[])) as client:
        assert client.post("/api/sources", json=body, headers=HEADERS).status_code == 422
    app = api.create_app(tmp_path / "vault", polling=False, plugins=[Plugin("vault", setup)])
    with TestClient(app) as client:
        response = client.post("/api/sources", json=body, headers=HEADERS)
        assert response.status_code == 201, response.text
        assert response.json()["credential"] == "vault:team/runpod"
        bad = {**body, "name": "RunPod B", "credential": "vault:Team Runpod"}
        assert client.post("/api/sources", json=bad, headers=HEADERS).status_code == 422


def test_a_switched_off_plugin_runs_and_resolves_nothing(tmp_path: Path) -> None:
    calls: list[str] = []

    def setup(context: PluginContext) -> None:
        context.credential_scheme("vault", lambda name: f"secret-{name}")
        context.on_startup(lambda: calls.append("startup"))
        context.on_shutdown(lambda: calls.append("shutdown"))
        context.health = lambda: {"ready": True}

    plugin = Plugin("vault", setup)
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[plugin])) as client:
        off = client.put("/api/toolbox/vault", json={"enabled": False}, headers=HEADERS)
        assert off.status_code == 200
    calls.clear()
    # After a restart with the plugin off: no startup, no health, no secrets.
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[plugin])) as client:
        assert calls == []
        assert client.get("/api/health").json()["plugins"]["vault"] == {"enabled": False}
        with pytest.raises(SourceError, match="credential_scheme_off"):
            credentials.resolve("vault:team")
        client.put("/api/toolbox/vault", json={"enabled": True}, headers=HEADERS)
        assert calls == ["startup"]
        assert credentials.resolve("vault:team") == "secret-team"
    assert calls == ["startup", "shutdown"]


def test_collect_follows_the_toolbox_of_its_data_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    store = Store(tmp_path / "computedeck.sqlite")
    store.set_plugin_enabled("vault", False)
    store.db.close()

    def setup(context: PluginContext) -> None:
        context.credential_scheme("vault", lambda name: "secret")

    monkeypatch.setattr(plugin_host, "discover", lambda data_dir=None: [Plugin("vault", setup)])
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"action": "info"}'))
    assert cli.main(["--data-dir", str(tmp_path), "collect"]) == 0
    capsys.readouterr()
    with pytest.raises(SourceError, match="credential_scheme_off"):
        credentials.resolve("vault:team")


def test_runtime_store_is_available_only_after_startup(tmp_path: Path) -> None:
    runtime = Runtime(tmp_path)
    with pytest.raises(RuntimeError, match="not started"):
        _ = runtime.store
    assert runtime.cluster_lock("cluster-a") is runtime.cluster_lock("cluster-a")
    assert runtime.cluster_lock("cluster-a") is not runtime.cluster_lock("cluster-b")


class ExampleDriver:
    name: ClassVar[str] = "example-scheduler"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("ssh_alias"):
            raise SourceError("cluster_connection_required")

    async def collect(self, source: dict[str, Any]) -> Batch:
        return Batch(jobs=[], capabilities=["jobs"])


class ImpostorDriver(ExampleDriver):
    name: ClassVar[str] = "slurm"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cloud"


def test_external_drivers_register_without_replacing_built_ins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(drivers, "_DRIVERS", dict(drivers._DRIVERS))
    monkeypatch.setattr(drivers, "_loaded", False)
    monkeypatch.setattr(
        drivers,
        "entry_points",
        lambda group: [
            Entry("example", ExampleDriver),
            Entry("impostor", ImpostorDriver),
            Entry("broken", RuntimeError("cannot import")),
        ],
    )
    with caplog.at_level(logging.ERROR, logger="computedeck"):
        assert drivers.names() == [
            "aws-ec2",
            "example-scheduler",
            "gpuhub",
            "kubernetes",
            "lambda",
            "lsf",
            "pbs",
            "runpod",
            "slurm",
            "ssh",
            "vastai",
        ]
    assert "broken" in caplog.text
    assert drivers.get("slurm").kind == "cluster"
    with pytest.raises(SourceError) as error:
        drivers.get("absent")
    assert error.value.message() == {"code": "unknown_driver", "driver": "absent"}
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        listed = {row["name"]: row for row in client.get("/api/drivers").json()}
        # A driver without a description still gets a usable entry.
        assert listed["example-scheduler"]["kind"] == "cluster"
        assert listed["example-scheduler"]["label"] == {"en": "example-scheduler"}
        assert listed["example-scheduler"]["fields"] == []
        body = {"name": "Cluster C", "driver": "example-scheduler", "username": "alice"}
        assert client.post("/api/sources", json=body, headers=HEADERS).status_code == 422
        body["ssh_alias"] = "cluster-c"
        response = client.post("/api/sources", json=body, headers=HEADERS)
        assert response.status_code == 201, response.text
        assert response.json()["kind"] == "cluster"


async def test_crashed_loops_are_logged_reported_and_restarted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    host = plugin_host
    runtime = Runtime(tmp_path)
    runs: list[int] = []

    async def flaky() -> None:
        runs.append(1)
        if len(runs) == 1:
            raise ValueError("unexpected page")

    async def no_wait(_: float) -> None:
        return None

    monkeypatch.setattr(host.asyncio, "sleep", no_wait)
    await asyncio.wait_for(host.supervise("example:0", flaky, runtime), timeout=5)
    assert len(runs) == 2
    assert runtime.loop_errors["example:0"]["error"] == "ValueError: unexpected page"


async def test_a_loop_that_recovers_is_no_longer_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = Runtime(tmp_path)
    monkeypatch.setattr(plugin_host, "RECOVERED_AFTER", 0.05)
    real_sleep = asyncio.sleep
    monkeypatch.setattr(plugin_host.asyncio, "sleep", lambda seconds: real_sleep(0))
    runs: list[int] = []
    running = asyncio.Event()

    async def flaky() -> None:
        runs.append(1)
        if len(runs) == 1:
            raise ValueError("unexpected page")
        running.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(plugin_host.supervise("example:0", flaky, runtime))
    await asyncio.wait_for(running.wait(), timeout=5)
    assert "example:0" in runtime.loop_errors
    for _ in range(100):
        if "example:0" not in runtime.loop_errors:
            break
        await real_sleep(0.01)
    assert runtime.loop_errors == {}
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_a_reinstalled_plugin_starts_at_the_head_of_the_event_log(
    tmp_path: Path, store: Store
) -> None:
    runtime = Runtime(tmp_path)
    runtime.store = store
    watcher = plugin_host.load([quiet_plugin("watcher")], runtime, lambda plugin: False)
    blocked = plugin_host.load([quiet_plugin("watcher")], runtime, lambda plugin: True)
    event = {"type": "job.failed", "data": {}}
    plugin_host.track(watcher, store)
    store.set_plugin_cursor("watcher", 0)
    store.add_events([{**event, "key": "while-restarting"}])
    # A restart with the plugin still installed keeps its place: nothing is missed.
    plugin_host.track(watcher, store)
    assert store.plugin_cursor("watcher") == 0
    # Uninstalled (or blocked) for a while, then back: no backlog from back then.
    for absent in ([], blocked):
        plugin_host.track(absent, store)
        store.add_events([{**event, "key": f"while-absent-{len(absent)}"}])
        plugin_host.track(watcher, store)
        assert store.plugin_cursor("watcher") == store.last_event_id()
        store.set_plugin_cursor("watcher", 0)
    # The service records what it loaded when it starts.
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[quiet_plugin()])):
        pass
    reopened = Store(tmp_path / "computedeck.sqlite")
    assert reopened.loaded_plugins() == ["quiet"]
    reopened.db.close()


async def test_an_event_handler_that_works_again_is_no_longer_reported(
    store: Store, tmp_path: Path
) -> None:
    runtime = Runtime(tmp_path)
    runtime.store = store
    seen: list[int] = []

    def setup(context: PluginContext) -> None:
        async def handle(event: dict[str, Any]) -> None:
            if event["data"].get("bad"):
                raise ValueError("bad event")
            seen.append(event["id"])

        context.on_event(handle)

    [context] = plugin_host.load([Plugin("watcher", setup)], runtime, lambda plugin: False)
    store.set_plugin_cursor("watcher", 0)
    store.add_events([{"key": "a", "type": "job.failed", "data": {"bad": True}}])
    task = asyncio.create_task(plugin_host.deliver(context, poll=0.01))
    for _ in range(100):
        if "watcher:events" in runtime.loop_errors:
            break
        await asyncio.sleep(0.01)
    assert runtime.loop_errors["watcher:events"]["error"] == "ValueError: bad event"
    store.add_events([{"key": "b", "type": "job.failed", "data": {}}])
    for _ in range(100):
        if seen:
            break
        await asyncio.sleep(0.01)
    assert runtime.loop_errors == {}
    task.cancel()


@pytest.mark.parametrize(
    "subscription",
    [
        None,
        ["job.failed", "job.ended"],
        ["job.finished"],
        ["job.finished", "job.failed", "job.ended"],
    ],
)
async def test_finished_delivery_preserves_api1_and_named_opt_in(
    store: Store, tmp_path: Path, subscription: list[str] | None
) -> None:
    from computedeck.events import FAILURE_OUTCOMES, OUTCOMES

    runtime = plugin_host.Runtime(tmp_path)
    runtime.store = store
    context = plugin_host.PluginContext(plugin_host.Plugin("watcher", lambda ctx: None), runtime)
    seen: list[dict[str, Any]] = []
    received = asyncio.Event()

    async def handle(event: dict[str, Any]) -> None:
        seen.append(event)
        if len(seen) == len(OUTCOMES):
            received.set()

    context.on_event(handle, subscription)
    store.set_plugin_cursor("watcher", 0)
    store.add_events(
        [
            {"key": outcome, "type": "job.finished", "data": {"outcome": outcome}}
            for outcome in OUTCOMES
        ]
    )
    task = asyncio.create_task(plugin_host.deliver(context, poll=0.01))
    try:
        await asyncio.wait_for(received.wait(), 1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    expected = [
        "job.finished"
        if subscription and "job.finished" in subscription
        else "job.failed"
        if outcome in FAILURE_OUTCOMES
        else "job.ended"
        for outcome in OUTCOMES
    ]
    assert [event["type"] for event in seen] == expected
    assert len({event["id"] for event in seen}) == len(OUTCOMES)
    # The cursor prevents replay on restart.
    task = asyncio.create_task(plugin_host.deliver(context, poll=0.001))
    await asyncio.sleep(0.01)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert len(seen) == len(OUTCOMES)


def test_new_event_types_require_named_handlers() -> None:
    from computedeck.events import for_handler

    event = {"type": "source.gap", "data": {}}
    assert for_handler(event, None) is None
    assert for_handler(event, frozenset(["source.gap"])) == event
    assert for_handler({"type": "change.source", "data": {}}, frozenset(["change.source"])) is None
