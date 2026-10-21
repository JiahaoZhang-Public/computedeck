"""Notifications: send matching events to email, webhooks or channels other plugins add.

A rule picks events (for example ``job.failed`` on one cluster) and channels. Its message
comes from a template, or an AI model writes it from the event's facts and the owner's
instructions. A rule can attach the last lines of the job's log, read over SSH.

Each (rule, channel) delivery is stored before its first attempt. A failure that may pass
is retried from that queue later, so a slow or failing channel holds up no other rule,
channel or event, and a restart loses nothing.
"""

import asyncio
import fnmatch
import json
import logging
import math
import re
import secrets
import shlex
import time
from collections import deque
from typing import Any

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..drivers import ssh
from ..errors import SourceError, message
from ..events import FAILURE_OUTCOMES, OUTCOMES
from ..plugins import Plugin, PluginContext, SettingField
from ..ssh_config import validate_alias
from ..store import Store, now
from ..toolbox import _coerce
from . import channels
from .channels import Message

NOTIFY_TYPES = ("job.started", "job.finished", "source.failed", "source.recovered")

logger = logging.getLogger("computedeck")

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_AI_BASE_URL = "https://api.anthropic.com"
DEFAULT_MAX_PER_HOUR = 20
LOG_LINES = 60
# A log written with carriage returns (progress bars) can be one huge "line": the remote
# command reads at most this many bytes from the end before counting lines.
LOG_BYTES = 65536
LOG_CHARS = 8000
# The AI request, from connecting to the end of the answer; when it runs out the
# template text is sent.
AI_TIMEOUT = 90
# One attempt at sending, likewise.
SEND_TIMEOUT = 30
# Waits before the second and the third attempt at a delivery that failed.
RETRY_DELAYS = (20, 90)
RETRY_POLL = 5
# How long handling an event waits for its first attempts. They go on after that,
# so a slow channel holds up the following events this long at most.
FIRST_WAIT = 5
# A delivery still queued after a day (the tool was off, or the service stopped) is
# dropped rather than sent that late.
QUEUE_EXPIRY = 86400
# A missing secret, a bad address or an unknown kind will not fix itself by waiting.
PERMANENT_ERRORS = ("credential_unavailable", "webhook_url_invalid", "channel_kind_unknown")

# ---- Messages ----

DEFAULTS: dict[str, dict[str, tuple[str, str]]] = {
    "en": {
        "job.finished": (
            "{job}: {outcome} on {cluster}",
            "{job} ({job_id}): {outcome} on {cluster}.\nState: {state}\n"
            "Exit code: {exit_code}\nEnded: {end}",
        ),
        "job.failed": (
            "{job} failed on {cluster}",
            "{job} ({job_id}) failed on {cluster}.\n\nState: {state}\nExit code: {exit_code}\n"
            "User: {user}\nPartition / QoS: {partition} / {qos}\nGPUs: {gpus}\nNode: {node}\n"
            "Ended: {end}",
        ),
        "job.started": (
            "{job} started on {cluster}",
            "{job} ({job_id}) is running on {node}.\n\nGPUs: {gpus}\nPartition / QoS: "
            "{partition} / {qos}",
        ),
        "job.ended": (
            "{job} left the queue on {cluster}",
            "{job} ({job_id}) is no longer in the queue of {cluster}. Last seen as {state} "
            "after {elapsed}.",
        ),
        "source.failed": ("{source} could not be collected", "{source}: {error}"),
        "source.recovered": ("{source} is collected again", "{source} is collected again."),
    },
    "zh-CN": {
        "job.finished": (
            "{job}：{outcome}（{cluster}）",
            "{job}（{job_id}）：{outcome}（{cluster}）。\n状态：{state}\n退出码：{exit_code}\n结束时间：{end}",
        ),
        "job.failed": (
            "{job} 在 {cluster} 上失败",
            "{job}（{job_id}）在 {cluster} 上失败。\n\n状态：{state}\n退出码：{exit_code}\n"
            "用户：{user}\n分区 / QoS：{partition} / {qos}\nGPU：{gpus}\n节点：{node}\n"
            "结束时间：{end}",
        ),
        "job.started": (
            "{job} 已在 {cluster} 上开始运行",
            "{job}（{job_id}）正在 {node} 上运行。\n\nGPU：{gpus}\n分区 / QoS：{partition} / {qos}",
        ),
        "job.ended": (
            "{job} 已离开 {cluster} 的队列",
            "{job}（{job_id}）已不在 {cluster} 的队列中。最后状态 {state}，运行了 {elapsed}。",
        ),
        "source.failed": ("{source} 采集失败", "{source}：{error}"),
        "source.recovered": ("{source} 已恢复采集", "{source} 已恢复采集。"),
    },
}
OUTCOME_TEXT = {
    "en": {
        "completed": "completed",
        "cancelled": "cancelled",
        "failed": "failed",
        "timeout": "time limit reached",
        "out_of_memory": "out of memory",
        "node_fail": "node failure",
        "boot_fail": "boot failure",
        "deadline": "deadline reached",
        "preempted": "preempted",
        "unknown": "outcome unknown",
    },
    "zh-CN": {
        "completed": "已完成",
        "cancelled": "已取消",
        "failed": "失败",
        "timeout": "达到时间限制",
        "out_of_memory": "内存不足",
        "node_fail": "节点故障",
        "boot_fail": "启动失败",
        "deadline": "达到截止时间",
        "preempted": "被抢占",
        "unknown": "结果未知",
    },
}
PLACEHOLDERS = (
    "event",
    "outcome",
    "source",
    "cluster",
    "user",
    "job",
    "job_id",
    "state",
    "exit_code",
    "reason",
    "node",
    "partition",
    "qos",
    "gpus",
    "elapsed",
    "end",
    "error",
    "time",
)


def facts(event: dict[str, Any]) -> dict[str, str]:
    """The flat values templates may use. Missing values read as "—"."""
    data = event.get("data") or {}
    job = data.get("job") or {}
    error = data.get("error")
    if isinstance(error, dict):
        error = ": ".join(str(part) for part in (error.get("code"), error.get("detail")) if part)
    values = {
        "event": event.get("type"),
        "outcome": data.get("outcome"),
        "source": data.get("source_name"),
        "cluster": data.get("source_name") or data.get("cluster_id"),
        "user": job.get("user") or data.get("username"),
        "job": job.get("name") or job.get("id"),
        "job_id": job.get("id"),
        "state": job.get("state"),
        "exit_code": job.get("exit_code"),
        "reason": job.get("reason"),
        "node": job.get("node"),
        "partition": job.get("partition"),
        "qos": job.get("qos"),
        "gpus": job.get("gpu_count"),
        "elapsed": job.get("elapsed"),
        "end": job.get("end"),
        "error": error,
        "time": event.get("at"),
    }
    if event.get("type") == "job.finished":
        values.update(
            state=data.get("state"),
            exit_code=data.get("exit_code"),
            end=data.get("ended_at")
            or (job.get("end") if data.get("outcome") != "unknown" else None),
        )
    return {key: "—" if value in (None, "") else str(value) for key, value in values.items()}


def render(template: str, values: dict[str, str]) -> str:
    """Replace known ``{name}`` placeholders; anything else stays as written."""
    return re.sub(r"\{(\w+)\}", lambda match: values.get(match[1], match[0]), template)


# ---- Rules and channels ----


class ChannelInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    kind: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    config: dict[str, Any] = Field(default_factory=dict)


class RuleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    events: list[str] = Field(default_factory=lambda: ["job.finished"], min_length=1)
    outcomes: list[str] = Field(default_factory=lambda: list(FAILURE_OUTCOMES))
    clusters: list[str] = Field(default_factory=list, max_length=50)
    users: list[str] = Field(default_factory=list, max_length=50)
    name_pattern: str = Field(default="", max_length=200)
    channels: list[str] = Field(min_length=1, max_length=10)
    subject: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=5000)
    include_log: bool = False
    agent: bool = False
    instructions: str = Field(default="", max_length=2000)


def _prepare(store: Store) -> None:
    with store.db:
        store.db.executescript("""
            CREATE TABLE IF NOT EXISTS notify_channels (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notify_rules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notify_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                data TEXT NOT NULL
            );
            -- Deliveries not yet sent or given up: the composed message for one channel.
            -- "due" and "created" are Unix times.
            CREATE TABLE IF NOT EXISTS notify_queue (
                rule TEXT NOT NULL,
                event INTEGER NOT NULL,
                channel TEXT NOT NULL,
                attempts INTEGER NOT NULL,
                due REAL NOT NULL,
                created REAL NOT NULL,
                data TEXT NOT NULL,
                PRIMARY KEY (rule, event, channel)
            );
        """)

    for rule in _rows(store, "notify_rules"):
        migrated = migrate_rule(rule)
        if migrated != rule:
            _save(store, "notify_rules", migrated)


def migrate_rule(rule: dict[str, Any]) -> dict[str, Any]:
    kinds = rule.get("events", [])
    if not {"job.failed", "job.ended"}.intersection(kinds):
        return rule
    outcomes = [] if "job.ended" in kinds else list(FAILURE_OUTCOMES)
    if "job.finished" in kinds:
        outcomes = rule.get("outcomes", [])
    return {
        **rule,
        "events": list(
            dict.fromkeys(
                "job.finished" if kind in {"job.failed", "job.ended"} else kind for kind in kinds
            )
        ),
        "outcomes": outcomes,
    }


def _rows(store: Store, table: str) -> list[dict[str, Any]]:
    rows = store.db.execute(f"SELECT rowid, data FROM {table} ORDER BY rowid")
    records = [store.record(table, key, data, {"id": str}) for key, data in rows]
    return [record for record in records if record is not None]


def _save(store: Store, table: str, row: dict[str, Any]) -> None:
    with store.db:
        store.db.execute(
            f"INSERT INTO {table} VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            (row["id"], json.dumps(row)),
        )


def _delete(store: Store, table: str, row_id: str) -> bool:
    with store.db:
        return store.db.execute(f"DELETE FROM {table} WHERE id=?", (row_id,)).rowcount == 1


def _write_log(store: Store, entry: dict[str, Any]) -> None:
    # The caller owns the transaction, including when reserving a whole digest.
    store.db.execute("INSERT INTO notify_log (at, data) VALUES (?, ?)", (now(), json.dumps(entry)))
    store.db.execute("DELETE FROM notify_log WHERE id <= (SELECT MAX(id) - 500 FROM notify_log)")


def _log(store: Store, entry: dict[str, Any]) -> None:
    with store.db:
        _write_log(store, entry)


def _recent_log(store: Store, limit: int = 50) -> list[dict[str, Any]]:
    rows = store.db.execute(
        "SELECT id, at, data FROM notify_log ORDER BY id DESC LIMIT ?", (limit,)
    )
    entries = ((row[0], row[1], store.record("notify_log", row[0], row[2], {})) for row in rows)
    return [{"id": key, "at": at, **entry} for key, at, entry in entries if entry is not None]


def _new_id(name: str) -> str:
    stem = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "item"
    return f"{stem}-{secrets.token_hex(3)}"


def check_channel(body: ChannelInput) -> dict[str, Any]:
    """Validate a channel's settings against its kind; secrets must be references."""
    try:
        kind = channels.get(body.kind)
    except SourceError as error:
        raise ValueError(error.code) from None
    config: dict[str, Any] = {}
    for field in kind.fields:
        value = _coerce(field, body.config.get(field.key, field.default))
        if field.required and value in (None, ""):
            raise ValueError("setting_required")
        config[field.key] = value
    unknown = set(body.config) - {field.key for field in kind.fields}
    if unknown:
        raise ValueError("setting_unknown")
    if body.kind == "email":
        config["port"] = channels.email_port(config)
    if kind.validate:
        kind.validate(config)
    return config


def check_rule(body: RuleInput, known_channels: set[str]) -> None:
    if any(event not in (*NOTIFY_TYPES, "job.failed", "job.ended") for event in body.events):
        raise ValueError("event_type_unknown")
    if any(outcome not in OUTCOMES for outcome in body.outcomes):
        raise ValueError("setting_invalid")
    if any(channel not in known_channels for channel in body.channels):
        raise ValueError("channel_not_found")
    for value in [*body.clusters, *body.users]:
        if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,80}", value):
            raise ValueError("setting_invalid")


def matches(rule: dict[str, Any], event: dict[str, Any]) -> bool:
    # Pre-upgrade events can still be waiting behind the plugin cursor.
    if event["type"] in {"job.failed", "job.ended"} and "job.finished" in rule.get("events", []):
        data = event.get("data") or {}
        state = str((data.get("job") or {}).get("state", "")).lower()
        outcome = (
            state
            if state in FAILURE_OUTCOMES
            else "failed"
            if event["type"] == "job.failed"
            else "unknown"
        )
        event = {**event, "type": "job.finished", "data": {**data, "outcome": outcome}}
    if not rule.get("enabled", True) or event["type"] not in rule.get("events", []):
        return False
    data = event.get("data") or {}
    job = data.get("job") or {}
    if (
        event["type"] == "job.finished"
        and rule.get("outcomes")
        and data.get("outcome") not in rule["outcomes"]
    ):
        return False
    if rule.get("clusters") and data.get("cluster_id") not in rule["clusters"]:
        return False
    if rule.get("users") and not {job.get("user"), data.get("username")} & set(rule["users"]):
        return False
    pattern = rule.get("name_pattern") or ""
    if pattern and not fnmatch.fnmatch(str(job.get("name") or "").lower(), pattern.lower()):
        return False
    return True


# ---- Settings ----


def _whole(value: Any, low: int, high: int) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and low <= value <= high
        and int(value) == value
    )


def check_ai_base_url(value: Any) -> str:
    """An https address of the AI API without query or fragment; raises ValueError."""
    try:
        url = httpx.URL(value)
        port = url.port
    except (httpx.InvalidURL, TypeError):
        raise ValueError("setting_invalid") from None
    if (
        url.scheme != "https"
        or not re.fullmatch(r"[\w.:-]+", url.host)
        or not (port is None or 0 < port < 65536)
        or url.query
        or url.fragment
    ):
        raise ValueError("setting_invalid")
    return str(value).rstrip("/")


def check_settings(saved: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The settings as used, and the stored values that are not valid.

    Settings saved by an older build were not always checked. An empty rate limit means
    the default and an invalid one falls back to it. An invalid AI address stays unused:
    AI-written rules then send the template text instead of using another provider.
    """
    values, invalid = dict(saved), {}
    limit = saved.get("max_per_hour")
    if limit is None:
        values["max_per_hour"] = DEFAULT_MAX_PER_HOUR
    elif _whole(limit, 0, 100000):
        values["max_per_hour"] = int(limit)
    else:
        values["max_per_hour"] = DEFAULT_MAX_PER_HOUR
        invalid["max_per_hour"] = limit
    base = saved.get("ai_base_url")
    if base in (None, ""):
        values["ai_base_url"] = DEFAULT_AI_BASE_URL
    else:
        try:
            values["ai_base_url"] = check_ai_base_url(base)
        except ValueError:
            invalid["ai_base_url"] = base
    if not isinstance(saved.get("ai_model"), str) or not saved["ai_model"]:
        values["ai_model"] = DEFAULT_MODEL
    if not isinstance(saved.get("ai_key"), str):
        values["ai_key"] = ""
    return values, invalid


# ---- Job logs and AI summaries ----

_PATH = re.compile(r"/[^\x00-\x1f]{1,1000}")


def _as_shown(text: str) -> str:
    """Each line as a terminal leaves it: a progress bar's carriage returns overwrite it."""
    return "\n".join(line.rstrip("\r").rsplit("\r", 1)[-1] for line in text.split("\n"))


async def job_log(store: Store, event: dict[str, Any]) -> str | None:
    """The last lines of a Slurm job's output, read over the source's SSH alias."""
    source = store.source(event.get("source_id") or "")
    job = (event.get("data") or {}).get("job") or {}
    if not source or source.get("driver") != "slurm" or not job.get("id"):
        return None
    job_id = str(job["id"]).rsplit(":", 1)[-1]
    if not re.fullmatch(r"\d+(_\d+)?", job_id):
        return None
    try:
        alias = validate_alias(source.get("ssh_alias") or "")
    except ValueError:
        return None
    # Slurm keeps a finished job in scontrol for a few minutes (MinJobAge). OSError covers
    # a timeout and an ssh that cannot be started; the message is then sent without a log.
    try:
        details = await ssh.run(alias, f"scontrol show job {job_id} 2>/dev/null || true")
    except (ssh.SSHError, OSError):
        return None
    # scontrol prints these fields on dedicated indented lines. Never interpret
    # key-looking text embedded in JobName, Comment or another field as a path.
    paths = []
    for line in details.splitlines():
        line = line.strip()
        if line.startswith(("StdOut=", "StdErr=")):
            path = line.split("=", 1)[1]
            if _PATH.fullmatch(path):
                paths.append(path)
    for path in dict.fromkeys(paths):
        command = f"tail -c {LOG_BYTES} -- {shlex.quote(path)} | tail -n {LOG_LINES}"
        try:
            text = await ssh.run(alias, command)
        except (ssh.SSHError, OSError):
            continue
        if text.strip():
            return _as_shown(text[-LOG_BYTES:])[-LOG_CHARS:]
    return None


async def agent_text(
    settings: dict[str, Any],
    rule: dict[str, Any],
    event: dict[str, Any],
    log: str | None,
    language: str,
) -> str:
    """Ask the configured model for the message body. Raises SourceError on failure."""
    try:
        base = check_ai_base_url(settings.get("ai_base_url") or DEFAULT_AI_BASE_URL)
    except ValueError:
        raise SourceError("webhook_url_invalid") from None
    system = (
        "You write short notifications about compute jobs and data sources for the person "
        "who owns them. Use only the facts and log lines given; say plainly when something "
        "is unknown. Plain text, no Markdown headings. Write in "
        + ("Simplified Chinese." if language == "zh-CN" else "English.")
    )
    parts = [
        "Event facts (JSON):",
        json.dumps(
            {**facts(event), "job": (event.get("data") or {}).get("job")}, ensure_ascii=False
        ),
    ]
    if event.get("digest"):
        parts += [
            "Other events in this digest (JSON):",
            json.dumps(
                {
                    "count": len(event["digest"]) + 1,
                    "summary": digest_tail(event, language),
                    "sample": [facts(sibling) for sibling in event["digest"][:20]],
                },
                ensure_ascii=False,
            ),
        ]
    if log:
        parts += ["Last lines of the job log:", log]
    if rule.get("instructions"):
        parts += ["Instructions from the owner:", str(rule["instructions"])]
    try:
        # One bound for the key, which a keychain may read only after the user answers a
        # prompt, and the whole request; httpx's timeout bounds each read only.
        async with asyncio.timeout(AI_TIMEOUT):
            key = await channels.secret(settings.get("ai_key") or "")
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(
                    f"{base}/v1/messages",
                    headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                    json={
                        "model": settings.get("ai_model") or DEFAULT_MODEL,
                        "max_tokens": 800,
                        "system": system,
                        "messages": [{"role": "user", "content": "\n\n".join(parts)}],
                    },
                )
    except TimeoutError:
        raise SourceError("timeout") from None
    except (httpx.HTTPError, httpx.InvalidURL) as error:
        raise SourceError("request_failed", type(error).__name__) from None
    if response.status_code != 200:
        raise SourceError("http_status", status=response.status_code)
    try:
        blocks = response.json()["content"]
        if not isinstance(blocks, list):
            raise ValueError
        text = "".join(block["text"] for block in blocks if block.get("type") == "text")
    except (ValueError, KeyError, TypeError, AttributeError):
        raise SourceError("unexpected_output", command="POST /v1/messages") from None
    if not text.strip():
        raise SourceError("unexpected_output", command="POST /v1/messages")
    return text.strip()


def digest_scope(event: dict[str, Any]) -> str | None:
    """Normal standalone jobs keep their own message, even alongside an array burst."""
    if not event["type"].startswith("job."):
        return None
    data = event.get("data") or {}
    if (data.get("job") or {}).get("array_id"):
        return "arrays"
    return "catchup" if data.get("since") else None


def digest_tail(event: dict[str, Any], language: str) -> str:
    siblings = event.get("digest") or []
    if not siblings:
        return ""
    groups: dict[tuple[str, str, str], list[str]] = {}
    for sibling in siblings:
        data = sibling["data"]
        job = data.get("job") or {}
        key = (
            str(job.get("array_id") or ""),
            str(job.get("name") or job.get("id") or "—"),
            str(data.get("outcome") or ""),
        )
        groups.setdefault(key, []).append(str(job.get("id") or "—"))
    parts = []
    remaining = 10
    comma, semicolon, left, right = (
        ("，", "；", "（", "）") if language == "zh-CN" else (", ", "; ", " (", ")")
    )
    for (array, name, outcome), ids in list(groups.items())[:10]:
        label = OUTCOME_TEXT.get(language, OUTCOME_TEXT["en"]).get(outcome, outcome)
        shown = ids[:remaining]
        remaining -= len(shown)
        detail = comma.join(shown) + (f"{comma}…" if len(shown) < len(ids) else "")
        parts.append(
            f"{name}"
            + (f" [{array}]" if array else "")
            + f" ×{len(ids)}"
            + (f"{left}{label}{right}" if label else "")
            + (f"{left}{detail}{right}" if shown else "")
        )
    cluster = facts(event)["cluster"]
    omitted = sum(len(ids) for ids in list(groups.values())[10:])
    if omitted:
        parts.append(
            f"另有 {omitted} 个事件" if language == "zh-CN" else f"and {omitted} more events"
        )
    summary = semicolon.join(parts)
    return (
        f"另有 {len(siblings)} 个事件（{cluster}）：{summary}"
        if language == "zh-CN"
        else f"and {len(siblings)} more on {cluster}: {summary}"
    )


async def compose(
    store: Store, settings: dict[str, Any], rule: dict[str, Any], event: dict[str, Any]
) -> tuple[Message, list[str]]:
    """The message for one event under one rule, and notes about anything left out."""
    language = store.settings().get("language") or "en"
    defaults = DEFAULTS.get(language, DEFAULTS["en"]).get(event["type"], ("{event}", "{event}"))
    values = facts(event)
    outcome = (event.get("data") or {}).get("outcome")
    if outcome:
        values["outcome"] = OUTCOME_TEXT.get(language, OUTCOME_TEXT["en"]).get(outcome, outcome)
        if outcome == "unknown":
            unavailable = (event.get("data") or {}).get("outcome_reason") == "outcomes_unavailable"
            reason = (
                ("此集群不报告作业结果" if unavailable else "调度器尚未报告结果")
                if language == "zh-CN"
                else (
                    "this cluster does not report outcomes"
                    if unavailable
                    else "the scheduler has not reported an outcome"
                )
            )
            values["outcome"] += f" ({reason})"
    subject = render(rule.get("subject") or defaults[0], values)
    body = render(rule.get("body") or defaults[1], values)
    notes: list[str] = []
    log = await job_log(store, event) if rule.get("include_log") else None
    if rule.get("include_log") and log is None:
        notes.append("log_unavailable")
    if rule.get("agent"):
        try:
            body = await agent_text(settings, rule, event, log, language)
        except SourceError as error:
            notes.append(f"agent_failed:{error.code}")
    if log:
        heading = "作业日志最后几行" if language == "zh-CN" else "Last lines of the job log"
        body = f"{body}\n\n--- {heading} ---\n{log}"
    since = (event.get("data") or {}).get("since")
    if since:
        observed = event["data"].get("observed_at") or event["at"]
        window = (
            f"采集窗口：{since} 至 {observed}"
            if language == "zh-CN"
            else f"Collection window: between {since} and {observed}"
        )
        body += f"\n\n{window}"
    tail = digest_tail(event, language)
    if tail:
        body += f"\n\n{tail}"
    return Message(subject=subject, body=body, event=event), notes


# ---- Plugin ----


Key = tuple[str, int, str]  # rule, event, channel


class Notifier:
    def __init__(self, ctx: PluginContext) -> None:
        self.ctx = ctx
        self.sent: dict[str, deque[float]] = {}
        # Recent per-rule collections; keep both array and catch-up digests from one read.
        self.digests: dict[
            tuple[str, str | None, str, str],
            tuple[dict[str, Any], dict[str, dict[str, Any]]],
        ] = {}
        # Deliveries being attempted right now, each in its own task.
        self.sending: dict[Key, asyncio.Task[None]] = {}
        # Channels whose last attempt failed but may work later, and until when (Unix
        # time) their new messages wait in the queue instead of being tried at once.
        self.resting: dict[str, float] = {}

    @property
    def store(self) -> Store:
        return self.ctx.store

    def settings(self) -> dict[str, Any]:
        return check_settings(self.ctx.settings())[0]

    def channels(self) -> dict[str, dict[str, Any]]:
        return {row["id"]: row for row in _rows(self.store, "notify_channels")}

    def rules(self) -> list[dict[str, Any]]:
        return _rows(self.store, "notify_rules")

    def queued(self) -> int:
        return int(self.store.db.execute("SELECT COUNT(*) FROM notify_queue").fetchone()[0])

    async def on_event(self, event: dict[str, Any]) -> None:
        # The runtime advances its persistent event cursor after this returns; by then each
        # delivery is stored, and sent, being sent or waiting for its retry. Cancellation
        # leaves the event pending for delivery after restart. Rules run side by side.
        await asyncio.gather(
            *(self.deliver(rule, event) for rule in self.rules() if matches(rule, event))
        )

    def _allowed(self, rule: dict[str, Any]) -> bool:
        limit = self.settings()["max_per_hour"]
        window = self.sent.setdefault(rule["id"], deque())
        cutoff = time.monotonic() - 3600
        while window and window[0] < cutoff:
            window.popleft()
        if len(window) >= limit:
            return False
        window.append(time.monotonic())
        return True

    def _handled(self, rule: dict[str, Any], event: dict[str, Any]) -> bool:
        rows = self.store.db.execute(
            "SELECT data FROM notify_log WHERE CASE WHEN json_valid(data) THEN "
            "json_extract(data, '$.rule')=? AND json_extract(data, '$.event')=? END",
            (rule["id"], event["id"]),
        )
        entries = [json.loads(row[0]) for row in rows]
        if any(
            row.get("status") in {"grouped", "suppressed"}
            or (row.get("status") == "failed" and not row.get("channel"))
            for row in entries
        ):
            return True
        finished = {
            row.get("channel")
            for row in entries
            if row.get("status") in {"sent", "failed", "dropped"}
        }
        queued = {
            row[0]
            for row in self.store.db.execute(
                "SELECT channel FROM notify_queue WHERE rule=? AND event=?",
                (rule["id"], event["id"]),
            )
        }
        return bool(rule.get("channels")) and set(rule["channels"]) <= finished | queued

    def _digest(self, rule: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
        scope = digest_scope(event)
        if scope is None:
            return event
        key = (
            rule["id"],
            event.get("source_id"),
            event["type"],
            event["data"].get("observed_at") or event["at"],
        )
        cached = self.digests.get(key)
        if cached is None or cached[0] != rule:
            groups: dict[str, list[dict[str, Any]]] = {}
            for row in self.store.events_in_collection(key[1], key[3], key[2]):
                row_scope = digest_scope(row)
                if row_scope and matches(rule, row):
                    groups.setdefault(row_scope, []).append(row)
            digests = {
                name: {**rows[0], **({"digest": rows[1:]} if len(rows) > 1 else {})}
                for name, rows in groups.items()
            }
            if key not in self.digests and len(self.digests) >= 64:
                del self.digests[next(iter(self.digests))]
            self.digests[key] = (dict(rule), digests)
        return self.digests[key][1].get(scope, event)

    async def deliver(self, rule: dict[str, Any], event: dict[str, Any]) -> None:
        """Send one event under one rule to each of the rule's channels.

        Every delivery is queued first, then attempted at once, all channels together. A
        channel whose last attempt failed is not tried again before its retry is due.
        """
        event = self._digest(rule, event)
        if self._handled(rule, event):
            keys = self.store.db.execute(
                "SELECT rule, event, channel FROM notify_queue WHERE rule=? AND event=? AND due<=?",
                (rule["id"], event["id"], time.time()),
            ).fetchall()
            await self._first_attempts([tuple(key) for key in keys])
            return
        entry: dict[str, Any] = {
            "rule": rule["id"],
            "rule_name": rule.get("name"),
            "event": event.get("id"),
            "event_type": event.get("type"),
        }
        siblings = event.get("digest") or []
        if siblings:
            entry.update(
                count=len(siblings) + 1,
                digest=event["id"],
                events=[sibling["id"] for sibling in siblings],
            )
        if not self._allowed(rule):
            _log(self.store, {**entry, "status": "suppressed"})
            return
        reservation = self.sent[rule["id"]][-1]
        try:
            mail, notes = await compose(self.store, self.settings(), rule, event)
            if len(self.sent[rule["id"]]) == self.settings()["max_per_hour"]:
                # Put the notice in the last allowed message: never exceed the user's cap.
                language = self.store.settings().get("language")
                notice = (
                    "已达到通知上限；后续事件列在动态中。"
                    if language == "zh-CN"
                    else "Limit reached; further events are listed in Activity."
                )
                mail = Message(
                    subject=mail.subject, body=f"{mail.body}\n\n{notice}", event=mail.event
                )
            entry["subject"] = mail.subject
            await self._first_attempts(self._queue(rule, event, mail, notes, entry))
        except asyncio.CancelledError:
            # Re-enabling keeps this Notifier. An interrupted event must still be
            # eligible when the runtime retries it with the unchanged cursor.
            self.sent[rule["id"]].remove(reservation)
            raise
        except Exception as error:
            # Unexpected, for example a value an older build saved. Other rules go on, and
            # the log says why this one sent nothing.
            logger.exception("Notification rule %s failed on event %s", rule["id"], event.get("id"))
            detail = f"{type(error).__name__}: {str(error)[:200]}".rstrip(": ")
            _log(
                self.store,
                {**entry, "status": "failed", "error": message("rule_failed", detail=detail)},
            )

    def _queue(
        self,
        rule: dict[str, Any],
        event: dict[str, Any],
        mail: Message,
        notes: list[str],
        entry: dict[str, Any],
    ) -> list[Key]:
        """Store the message for each of the rule's channels, once per channel."""
        clock = time.time()
        keys = []
        with self.store.db:
            for channel_id in dict.fromkeys(rule.get("channels") or []):
                key = (str(rule["id"]), int(event["id"]), str(channel_id))
                # A replayed event: a channel that already has it is not sent it again.
                if self.store.db.execute(
                    "SELECT 1 FROM notify_log WHERE json_valid(data) AND "
                    "CASE WHEN json_valid(data) THEN json_extract(data, '$.rule')=? "
                    "AND json_extract(data, '$.event')=? AND json_extract(data, '$.channel')=? "
                    "AND json_extract(data, '$.status') IN ('sent', 'failed', 'dropped') "
                    "END LIMIT 1",
                    key,
                ).fetchone():
                    continue
                data = {
                    "entry": {**entry, "channel": channel_id},
                    "subject": mail.subject,
                    "body": mail.body,
                    "event": mail.event,
                    "notes": notes,
                }
                self.store.db.execute(
                    "INSERT OR IGNORE INTO notify_queue VALUES (?, ?, ?, 0, ?, ?, ?)",
                    (*key, max(clock, self.resting.get(key[2], 0)), clock, json.dumps(data)),
                )
                keys.append(key)
            if event.get("digest"):
                _write_log(
                    self.store, {**entry, "status": "grouped", "count": len(event["digest"])}
                )
        return keys

    async def _first_attempts(self, keys: list[Key]) -> None:
        """Start the first attempts and wait for them, for FIRST_WAIT at most.

        The deliveries are stored, so an attempt may go on after this returns: a slow
        channel holds up the following events by FIRST_WAIT at most. A channel that is
        resting after a failure, or still busy with an earlier message, is not waited for.
        """
        clock = time.time()
        busy = {key[2] for key in self.sending}
        started, waited = [], []
        for key in keys:
            if self.resting.get(key[2], 0) > clock:
                continue  # it waits in the queue for the channel's retry
            task = self._start(key)
            if task is not None:
                started.append(task)
                if key[2] not in busy:
                    waited.append(task)
        try:
            if waited:
                await asyncio.wait(waited, timeout=FIRST_WAIT)
        except asyncio.CancelledError:
            # Stopping: these attempts end as well; their deliveries stay queued.
            for task in started:
                task.cancel()
            await asyncio.gather(*started, return_exceptions=True)
            raise

    def _start(self, key: Key) -> asyncio.Task[None] | None:
        """Start an attempt at a queued delivery, unless one is running already."""
        if key in self.sending:
            return None
        task = asyncio.create_task(self._attempt(key))
        self.sending[key] = task
        task.add_done_callback(lambda _: self.sending.pop(key, None))
        return task

    async def _attempt(self, key: Key) -> None:
        """Try a queued delivery once; it is then sent, failed, or due again later."""
        row = self.store.db.execute(
            "SELECT attempts, data FROM notify_queue WHERE rule=? AND event=? AND channel=?", key
        ).fetchone()
        if row is None:  # sent or given up meanwhile
            return
        attempts = row[0] + 1
        data = self.store.record("notify_queue", key, row[1], {"subject": str, "body": str})
        if data is None:
            self._forget(key)
            return
        channel = self.channels().get(key[2])
        error: dict[str, Any] | None
        if channel is None:
            error, retry = message("channel_not_found"), False
        else:
            mail = Message(subject=data["subject"], body=data["body"], event=data["event"])
            error, retry = await send_once(channel, mail)
        if error is None:
            self.resting.pop(key[2], None)
        elif retry:
            self.resting[key[2]] = time.time() + RETRY_DELAYS[0]
            if attempts <= len(RETRY_DELAYS):
                with self.store.db:
                    self.store.db.execute(
                        "UPDATE notify_queue SET attempts=?, due=? "
                        "WHERE rule=? AND event=? AND channel=?",
                        (attempts, time.time() + RETRY_DELAYS[attempts - 1], *key),
                    )
                return
        self._finish(
            key,
            {
                **data["entry"],
                "channel_name": channel.get("name") if channel else None,
                "status": "failed" if error else "sent",
                "error": error,
                "notes": data["notes"],
            },
        )

    def _forget(self, key: Key) -> None:
        """Drop a queued delivery whose stored message cannot be read (counted in health)."""
        with self.store.db:
            self.store.db.execute(
                "DELETE FROM notify_queue WHERE rule=? AND event=? AND channel=?", key
            )

    def _finish(self, key: Key, entry: dict[str, Any]) -> None:
        with self.store.db:
            self.store.db.execute(
                "DELETE FROM notify_queue WHERE rule=? AND event=? AND channel=?", key
            )
            _log(self.store, entry)

    def start_due(self) -> list[asyncio.Task[None]]:
        """Start an attempt at each queued delivery that is due, and return them; drop
        the deliveries queued for too long."""
        clock = time.time()
        rows = self.store.db.execute(
            "SELECT rule, event, channel, created, data FROM notify_queue WHERE due <= ? "
            "ORDER BY due",
            (clock,),
        ).fetchall()
        started = []
        for rule_id, event_id, channel_id, created, data in rows:
            key = (rule_id, event_id, channel_id)
            if key in self.sending:
                continue
            if created < clock - QUEUE_EXPIRY:
                record = self.store.record("notify_queue", key, data, {"entry": dict})
                if record is None:
                    self._forget(key)
                    continue
                entry = {**record["entry"], "status": "dropped"}
                self._finish(key, {**entry, "error": message("delivery_expired")})
            elif task := self._start(key):
                started.append(task)
        return started

    async def retry_loop(self) -> None:
        """Retry queued deliveries when due, including those a stop or restart left."""
        try:
            while True:
                self.start_due()
                await asyncio.sleep(RETRY_POLL)
        except asyncio.CancelledError:
            await self.stop()
            raise

    async def stop(self) -> None:
        """End the attempts still running (the tool is switched off or the service stops);
        their deliveries stay queued for later."""
        tasks = list(self.sending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def send_once(channel: dict[str, Any], mail: Message) -> tuple[dict[str, Any] | None, bool]:
    """One attempt, cut off after SEND_TIMEOUT.

    Returns the error as a message (None when sent) and whether trying again later may help.
    """
    try:
        kind = channels.get(channel["kind"])
        async with asyncio.timeout(SEND_TIMEOUT):
            await kind.send(channel.get("config") or {}, mail)
    except TimeoutError:
        return message("send_timeout", seconds=SEND_TIMEOUT), True
    except SourceError as error:
        return error.message(), error.code not in PERMANENT_ERRORS
    except Exception as error:
        return message("send_failed", detail=type(error).__name__), False
    return None, False


def sample_event(kind: str = "job.finished", outcome: str = "failed") -> dict[str, Any]:
    """An example used by "Send test" and previews when no real event matches."""
    return {
        "id": 0,
        "type": kind,
        "at": now(),
        "source_id": None,
        "data": {
            "outcome": outcome,
            "state": outcome.upper() if outcome != "unknown" else None,
            "exit_code": None
            if outcome == "unknown"
            else "0:0"
            if outcome == "completed"
            else "1:0",
            "observed_at": now(),
            "ended_at": now(),
            "source_name": "Cluster A",
            "cluster_id": "cluster-a",
            "username": "alice",
            "job": {
                "id": "cluster-a:12345",
                "name": "example / test notification",
                "user": "alice",
                "state": outcome.upper(),
                "exit_code": "0:0" if outcome == "completed" else "1:0",
                "partition": "gpu",
                "qos": "normal",
                "gpu_count": 4,
                "node": "node001",
                "elapsed": "01:02:03",
                "end": now(),
            },
        },
    }


def setup(ctx: PluginContext) -> None:
    notifier = Notifier(ctx)
    ctx.on_startup(lambda: _prepare(ctx.store))
    ctx.on_event(notifier.on_event, types=(*NOTIFY_TYPES, "job.failed", "job.ended"))
    ctx.background(notifier.retry_loop)

    def validate_settings(values: dict[str, Any]) -> dict[str, Any]:
        if not _whole(values.get("max_per_hour", DEFAULT_MAX_PER_HOUR), 0, 100000):
            raise ValueError("setting_invalid")
        if values.get("ai_base_url"):
            check_ai_base_url(values["ai_base_url"])
        return values

    ctx.validator = validate_settings

    def health() -> dict[str, Any]:
        log = _recent_log(ctx.store, 1)
        channels, rules = len(notifier.channels()), len(notifier.rules())
        queued = notifier.queued()
        invalid = check_settings(ctx.settings())[1]
        en = f"{channels} channel{'s' * (channels != 1)} · {rules} rule{'s' * (rules != 1)}"
        zh = f"{channels} 个渠道 · {rules} 条规则"
        if queued:
            en += f" · {queued} waiting to be sent"
            zh += f" · {queued} 条待发送"
        labels = {field.key: field.label for field in ctx.plugin.settings}
        # What is used in place of a saved value that is not valid.
        instead = {
            "max_per_hour": {
                "en": f"using {DEFAULT_MAX_PER_HOUR}",
                "zh-CN": f"改用 {DEFAULT_MAX_PER_HOUR}",
            },
            "ai_base_url": {
                "en": "AI-written rules send the template text",
                "zh-CN": "AI 撰写的规则改发模板内容",
            },
        }
        for key, value in invalid.items():
            label, shown = labels[key], str(value)[:80]
            en += f" · saved “{label['en']}” {shown} is not valid; {instead[key]['en']}"
            zh += f" · 保存的“{label['zh-CN']}” {shown} 无效，{instead[key]['zh-CN']}"
        return {
            "channels": channels,
            "rules": rules,
            "queued": queued,
            "invalid_settings": {key: str(value)[:80] for key, value in invalid.items()},
            "last": log[0] if log else None,
            "summary": {"en": en, "zh-CN": zh},
        }

    ctx.health = health

    def bad_request(error: ValueError) -> HTTPException:
        return HTTPException(422, message(str(error) or "setting_invalid"))

    @ctx.router.get("")
    async def overview() -> dict[str, Any]:
        return {
            "channels": list(notifier.channels().values()),
            "rules": notifier.rules(),
            "kinds": [
                {
                    "kind": kind.kind,
                    "label": kind.label,
                    "fields": [field.model_dump() for field in kind.fields],
                }
                for kind in channels.kinds()
            ],
            "event_types": list(NOTIFY_TYPES),
            "placeholders": list(PLACEHOLDERS),
            "log": _recent_log(ctx.store),
            "ai_ready": bool(ctx.settings().get("ai_key")),
        }

    @ctx.router.post("/channels", status_code=201)
    async def add_channel(body: ChannelInput) -> dict[str, Any]:
        try:
            config = check_channel(body)
        except ValueError as error:
            raise bad_request(error) from None
        row = {"id": _new_id(body.name), "name": body.name, "kind": body.kind, "config": config}
        _save(ctx.store, "notify_channels", row)
        return row

    @ctx.router.put("/channels/{channel_id}")
    async def update_channel(channel_id: str, body: ChannelInput) -> dict[str, Any]:
        if channel_id not in notifier.channels():
            raise HTTPException(404, message("channel_not_found"))
        try:
            config = check_channel(body)
        except ValueError as error:
            raise bad_request(error) from None
        row = {"id": channel_id, "name": body.name, "kind": body.kind, "config": config}
        _save(ctx.store, "notify_channels", row)
        return row

    @ctx.router.delete("/channels/{channel_id}")
    async def delete_channel(channel_id: str) -> dict[str, bool]:
        if any(channel_id in rule.get("channels", []) for rule in notifier.rules()):
            raise HTTPException(409, message("channel_in_use"))
        if not _delete(ctx.store, "notify_channels", channel_id):
            raise HTTPException(404, message("channel_not_found"))
        return {"deleted": True}

    @ctx.router.post("/channels/{channel_id}/test")
    async def test_channel(channel_id: str) -> dict[str, Any]:
        channel = notifier.channels().get(channel_id)
        if channel is None:
            raise HTTPException(404, message("channel_not_found"))
        language = ctx.store.settings().get("language") or "en"
        mail = Message(
            subject="ComputeDeck test" if language != "zh-CN" else "ComputeDeck 测试消息",
            body=(
                "This channel works. Rules that use it will send messages like this one."
                if language != "zh-CN"
                else "这个渠道可以正常发送。使用它的规则会发送类似的消息。"
            ),
        )
        error, _ = await send_once(channel, mail)
        _log(
            ctx.store,
            {
                "channel": channel_id,
                "channel_name": channel.get("name"),
                "status": "failed" if error else "sent",
                "error": error,
                "subject": mail.subject,
                "test": True,
            },
        )
        if error:
            raise HTTPException(502, error)
        return {"sent": True}

    def rule_row(rule_id: str, body: RuleInput) -> dict[str, Any]:
        try:
            check_rule(body, set(notifier.channels()))
        except ValueError as error:
            raise bad_request(error) from None
        row = {"id": rule_id, **body.model_dump()}
        # A channel listed twice still gets one message.
        row["channels"] = list(dict.fromkeys(row["channels"]))
        return migrate_rule(row)

    @ctx.router.post("/rules", status_code=201)
    async def add_rule(body: RuleInput) -> dict[str, Any]:
        row = rule_row(_new_id(body.name), body)
        _save(ctx.store, "notify_rules", row)
        return row

    @ctx.router.put("/rules/{rule_id}")
    async def update_rule(rule_id: str, body: RuleInput) -> dict[str, Any]:
        if not any(rule["id"] == rule_id for rule in notifier.rules()):
            raise HTTPException(404, message("rule_not_found"))
        row = rule_row(rule_id, body)
        _save(ctx.store, "notify_rules", row)
        return row

    @ctx.router.delete("/rules/{rule_id}")
    async def delete_rule(rule_id: str) -> dict[str, bool]:
        if not _delete(ctx.store, "notify_rules", rule_id):
            raise HTTPException(404, message("rule_not_found"))
        return {"deleted": True}

    @ctx.router.post("/rules/preview")
    async def preview(body: RuleInput) -> dict[str, Any]:
        """Render a rule's message for its latest matching event, or an example, without sending.

        The AI step is skipped here so a preview never sends event data anywhere.
        """
        rule = migrate_rule({"id": "preview", **body.model_dump(), "agent": False})
        event = next(
            (
                row
                for row in ctx.store.recent_events(200)
                if matches({**rule, "enabled": True}, row)
            ),
            None,
        )
        mail, notes = await compose(
            ctx.store,
            notifier.settings(),
            rule,
            event or sample_event(rule["events"][0], next(iter(rule["outcomes"]), "failed")),
        )
        return {
            "subject": mail.subject,
            "body": mail.body,
            "example": event is None,
            "notes": notes,
        }


plugin = Plugin(
    id="notify",
    setup=setup,
    name={"en": "Notifications", "zh-CN": "任务提醒"},
    description={
        "en": "Email or webhook messages when jobs fail, start or end, or a source stops "
        "working. Rules choose the events; an AI model can write the message.",
        "zh-CN": "作业失败、开始或结束，以及来源采集出错时，发邮件或 Webhook 消息。"
        "规则决定哪些事件要提醒；也可以让 AI 模型撰写提醒内容。",
    },
    default_enabled=False,
    page="notify",
    icon="bell",
    permissions=(
        {
            "en": "sends email through the SMTP server you set, and posts to the webhooks you set",
            "zh-CN": "通过你设置的 SMTP 服务器发邮件，并向你设置的 Webhook 发送消息",
        },
        {
            "en": "reads the last lines of a job's log over SSH, when a rule asks for it",
            "zh-CN": "在规则要求时，通过 SSH 读取作业日志的最后几行",
        },
        {
            "en": "sends the event, and the log lines if included, to the AI provider when a "
            "rule uses an AI-written message",
            "zh-CN": "规则使用 AI 撰写时，把事件信息（以及附带的日志）发送给 AI 服务商",
        },
    ),
    settings=(
        SettingField(
            key="max_per_hour",
            label={"en": "Messages per rule per hour", "zh-CN": "每条规则每小时最多发送"},
            kind="number",
            default=20,
            hint={
                "en": "More are skipped and listed as suppressed, so a wave of failures "
                "does not flood the inbox.",
                "zh-CN": "超出的会被跳过并记为“已抑制”，避免大批失败时刷屏。",
            },
        ),
        SettingField(
            key="ai_key",
            label={"en": "AI API key reference", "zh-CN": "AI API Key 引用"},
            kind="credential",
            placeholder="env:ANTHROPIC_API_KEY",
            hint={
                "en": "Only needed for rules with an AI-written message.",
                "zh-CN": "只有使用 AI 撰写提醒的规则需要。",
            },
        ),
        SettingField(
            key="ai_model",
            label={"en": "AI model", "zh-CN": "AI 模型"},
            default=DEFAULT_MODEL,
        ),
        SettingField(
            key="ai_base_url",
            label={"en": "AI API address", "zh-CN": "AI API 地址"},
            default="https://api.anthropic.com",
            hint={
                "en": "An Anthropic Messages API endpoint; must use https.",
                "zh-CN": "Anthropic Messages API 地址，必须使用 https。",
            },
        ),
    ),
)
