"""Small SQLite store; one local service owns all writes."""

import json
import logging
import os
import re
import secrets
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from . import drivers, nodes
from .drivers.base import job_time, node_health, validate_row
from .drivers.cloud import instance_lifecycle
from .errors import SourceError, checked
from .summary import PROBE_INTERVAL as PROBE_INTERVAL
from .summary import fresh, freshness, summarize, timestamp
from .summary import gpu_allocation as gpu_allocation
from .summary import manual_state as manual_state

SCHEMA_VERSION = 2
DEFAULT_SETTINGS: dict[str, Any] = {"language": "en", "server_name": None}
# What an SSH check of a provider-listed instance leaves for the next listing to keep.
PROBE_RESULT = ("ssh_status", "ssh_error", "last_probe_attempt")
logger = logging.getLogger("computedeck")
# Fields every reader of a stored record relies on; a record without them is skipped.
_SOURCE_FIELDS: dict[str, type] = {
    "id": str,
    "name": str,
    "driver": str,
    "cluster_id": str,
    "enabled": bool,
    "interval_minutes": int,
}
_NODE_FIELDS: dict[str, type] = {"id": str, "name": str}
_INSTANCE_FIELDS: dict[str, type] = {"id": str}


class DatabaseVersionError(RuntimeError):
    """The database was written by an incompatible version of ComputeDeck."""


class Unreadable(ValueError):
    """A stored record cannot be decoded or lacks a field its readers need."""


def now() -> str:
    return datetime.now(UTC).isoformat()


def driver_kind(source: dict[str, Any]) -> str:
    try:
        return drivers.get(source.get("driver", "")).kind
    except SourceError:
        return "cluster"


def _decode(data: Any, fields: dict[str, type] | None = None) -> Any:
    try:
        value = json.loads(data)
    except (ValueError, TypeError, RecursionError) as error:
        raise Unreadable(f"not JSON ({type(error).__name__})") from None
    if fields is not None:
        if not isinstance(value, dict):
            raise Unreadable("not an object")
        for key, kind in fields.items():
            if not isinstance(value.get(key), kind):
                raise Unreadable(f"no valid {key}")
    return value


def _keep_probe(row: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    """A listed instance with the last SSH check of its unchanged endpoint. A listing cannot
    check SSH, so a failed connection stays failed until checked again or no longer held."""
    if (
        old is None
        or instance_lifecycle(row.get("state")) == "not_held"
        or instance_lifecycle(old.get("state")) == "not_held"
        or not old.get("last_probe_attempt")
        or row.get("ssh_status", "unverified") != "unverified"
        or not row.get("host")
        or any(row.get(key) != old.get(key) for key in ("host", "port", "username"))
    ):
        return row
    return {**row, **{key: old[key] for key in PROBE_RESULT if key in old}}


def _read_snapshot(encoded: str, *, lifecycle: bool = True) -> tuple[dict[str, Any], bool]:
    """Keep readable records from snapshots written before row validation existed."""
    try:
        snapshot = json.loads(encoded)
    except (ValueError, TypeError, RecursionError):
        return {}, True
    if not isinstance(snapshot, dict):
        return {}, True
    invalid = False
    result: dict[str, Any] = {}
    for key in ("jobs", "nodes", "instances", "failures", "lifecycle_pending", "lifecycle_ended"):
        if not lifecycle and key.startswith("lifecycle_"):
            continue
        if key not in snapshot:
            continue
        result[key] = []
        rows = snapshot[key]
        if not isinstance(rows, list):
            invalid = True
            continue
        for row in rows:
            try:
                if not isinstance(row, dict):
                    raise ValueError("Invalid collection row")
                validate_row(row)
            except (ValueError, TypeError, UnicodeError):
                invalid = True
                logging.getLogger("computedeck").warning("Skipped malformed stored %s row", key)
                continue
            result[key].append(row)
    return result, invalid


class Store:
    def __init__(self, path: Path, *, readonly: bool = False) -> None:
        self.unreadable: dict[str, set[str]] = {}
        if readonly:
            self.path = path
            self.db = sqlite3.connect(
                path.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False
            )
            self._check_version()
            return
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = path
        # SQLite derives WAL/SHM permissions from the database when opening WAL mode.
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        path.chmod(0o600)
        self.db = sqlite3.connect(path, check_same_thread=False)
        # Keys of stored rows that could not be read, by table: skipped, logged once and
        # counted in /api/health, so one bad row never stops the service or a page.
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS attention_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshots (source_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history (at TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL,
                at TEXT NOT NULL,
                source_id TEXT,
                silent INTEGER NOT NULL DEFAULT 0,
                data TEXT NOT NULL
            );
        """)
        self._check_version()
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists():
                sidecar.chmod(0o600)

    def _check_version(self) -> None:
        row = self.db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if row is None:
            if any(
                isinstance(record, dict) and "driver" not in record
                for record in (
                    self._read("sources", key, data)
                    for key, data in self.db.execute("SELECT id, data FROM sources")
                )
            ):
                raise DatabaseVersionError(
                    "This database was created by a pre-release of ComputeDeck. "
                    "Migrate it or start with a new data directory."
                )
            with self.db:
                self.db.execute(
                    "INSERT INTO meta VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),)
                )
        elif int(row[0]) > SCHEMA_VERSION:
            raise DatabaseVersionError(
                f"This database needs a newer ComputeDeck (schema {row[0]})."
            )

    def _skip(self, table: str, key: Any, reason: Any) -> None:
        keys = self.unreadable.setdefault(table, set())
        if str(key) not in keys:
            keys.add(str(key))
            logger.warning("Skipped unreadable %s row %s: %s", table, key, reason)

    def _repaired(self, table: str, key: Any) -> None:
        self.unreadable.get(table, set()).discard(str(key))

    def _read(self, table: str, key: Any, data: Any, fields: dict[str, type] | None = None) -> Any:
        """A stored record, or None (logged and counted) when it cannot be read."""
        try:
            return _decode(data, fields)
        except Unreadable as error:
            self._skip(table, key, error)
            return None

    def record(self, table: str, key: Any, data: Any, fields: dict[str, type] | None = None) -> Any:
        """For plugins' own tables: a stored JSON record, or None (logged and counted in
        /api/health) when it cannot be read or lacks one of ``fields``."""
        return self._read(table, key, data, fields)

    def unreadable_rows(self) -> dict[str, int]:
        return {table: len(keys) for table, keys in sorted(self.unreadable.items()) if keys}

    def attention_state(self) -> dict[str, dict[str, Any]]:
        # A read-only doctor may open a version-2 database before the service upgrades it.
        if not self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='attention_state'"
        ).fetchone():
            return {}
        result = {}
        for key, raw in self.db.execute("SELECT key, data FROM attention_state"):
            data = self._read(
                "attention_state", key, raw, {"fingerprint": str, "acknowledged_at": str}
            )
            if data is None:
                continue
            until = data.get("snooze_until")
            try:
                if until is not None and datetime.fromisoformat(until).tzinfo is None:
                    raise ValueError("snooze time needs an offset")
            except (ValueError, TypeError):
                self._skip("attention_state", key, "invalid snooze time")
                continue
            self._repaired("attention_state", key)
            result[key] = data
        return result

    def set_attention_state(self, key: str, data: dict[str, Any]) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO attention_state VALUES (?, ?)", (key, json.dumps(data))
            )
        self._repaired("attention_state", key)

    def delete_attention_state(self, keys: list[str]) -> None:
        if not keys:
            return
        with self.db:
            self.db.executemany("DELETE FROM attention_state WHERE key=?", ((key,) for key in keys))
        for key in keys:
            self._repaired("attention_state", key)

    def settings(self) -> dict[str, Any]:
        result = dict(DEFAULT_SETTINGS)
        for key, value in self.db.execute("SELECT key, value FROM meta WHERE key LIKE 'setting:%'"):
            setting = self._read("meta", key, value)
            name = key.removeprefix("setting:")
            if (name == "language" and setting not in ("en", "zh-CN")) or (
                name == "server_name" and not isinstance(setting, str)
            ):
                if setting is not None:
                    self._skip("meta", key, "unsupported value")
                continue
            result[name] = setting
        return result

    def save_settings(self, changes: dict[str, Any]) -> dict[str, Any]:
        with self.db:
            for key, value in changes.items():
                if key not in DEFAULT_SETTINGS:
                    raise ValueError(f"Unknown setting: {key}")
                self.db.execute(
                    "INSERT OR REPLACE INTO meta VALUES (?, ?)",
                    (f"setting:{key}", json.dumps(value)),
                )
                self._repaired("meta", f"setting:{key}")
        return self.settings()

    # ---- Plugins: on/off, settings and the position in the event log ----

    def _meta(self, key: str) -> Any:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return None if row is None else self._read("meta", key, row[0])

    def _set_meta(self, key: str, value: Any) -> None:
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, json.dumps(value)))
        self._repaired("meta", key)

    def plugin_enabled(self, plugin_id: str, default: bool) -> bool:
        value = self._meta(f"plugin:{plugin_id}:enabled")
        return default if value is None else bool(value)

    def set_plugin_enabled(self, plugin_id: str, enabled: bool) -> None:
        self._set_meta(f"plugin:{plugin_id}:enabled", enabled)

    def plugin_settings(self, plugin_id: str) -> dict[str, Any]:
        value = self._meta(f"plugin:{plugin_id}:settings")
        return value if isinstance(value, dict) else {}

    def save_plugin_settings(self, plugin_id: str, values: dict[str, Any]) -> None:
        self._set_meta(f"plugin:{plugin_id}:settings", values)

    def plugin_cursor(self, plugin_id: str) -> int | None:
        value = self._meta(f"plugin:{plugin_id}:cursor")
        return value if isinstance(value, int) else None

    def set_plugin_cursor(self, plugin_id: str, cursor: int) -> None:
        self._set_meta(f"plugin:{plugin_id}:cursor", cursor)

    def loaded_plugins(self) -> list[str] | None:
        """The plugins the last service run loaded; None before any run recorded them."""
        value = self._meta("plugins:loaded")
        return value if isinstance(value, list) else None

    def set_loaded_plugins(self, plugin_ids: list[str]) -> None:
        self._set_meta("plugins:loaded", plugin_ids)

    # ---- Events: what changed between collections ----

    def service_gap(self) -> dict[str, str] | None:
        value = self._meta("service:last_gap")
        return value if isinstance(value, dict) else None

    def record_heartbeat(self, at: str) -> dict[str, str] | None:
        """Record a heartbeat and any gap together; ordinary ticks write at most once a minute."""
        gap = None
        updates: dict[str, Any] = {}
        with self.db:
            previous = job_time(self._meta("service:alive_at"))
            elapsed = (
                (datetime.fromisoformat(at) - datetime.fromisoformat(previous)).total_seconds()
                if previous
                else None
            )
            if previous is not None and elapsed is not None and elapsed > 300:
                gap = {"from": previous, "to": at}
                self.db.execute(
                    "INSERT OR IGNORE INTO events (key, type, at, source_id, silent, data) "
                    "VALUES (?, 'service.gap', ?, NULL, 0, ?)",
                    (f"service.gap:{previous}", at, json.dumps(gap)),
                )
                self._prune_events()
                updates["service:last_gap"] = gap
            if elapsed is None or elapsed >= 60 or elapsed < 0:
                updates["service:alive_at"] = at
            if updates:
                self.db.executemany(
                    "INSERT OR REPLACE INTO meta VALUES (?, ?)",
                    [(key, json.dumps(value)) for key, value in updates.items()],
                )
        for key in updates:
            self._repaired("meta", key)
        return gap

    def add_events(self, events: list[dict[str, Any]]) -> int:
        """Store events; one whose ``key`` was seen before is ignored. Returns how many are new."""
        added = 0
        with self.db:
            for event in events:
                added += self.db.execute(
                    "INSERT OR IGNORE INTO events (key, type, at, source_id, silent, data) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        event["key"],
                        event["type"],
                        event.get("at") or now(),
                        event.get("source_id"),
                        int(bool(event.get("silent"))),
                        json.dumps(event.get("data") or {}),
                    ),
                ).rowcount
            self._prune_events()
        return added

    def add_change(
        self,
        type: str,
        subject_id: str,
        name: str,
        action: str,
        fields: list[str],
        source_id: str | None = None,
        *,
        counts: dict[str, int] | None = None,
    ) -> None:
        """Record a saved user action, with field names only; never pass setting values."""
        at = now()
        data: dict[str, Any] = {
            "subject_id": subject_id,
            "name": name,
            "action": action,
            "fields": sorted(fields),
        }
        if counts is not None:
            data["counts"] = counts
        self.add_events(
            [
                {
                    "key": f"change:{type}:{subject_id}:{at}:{secrets.token_hex(8)}",
                    "type": type,
                    "at": at,
                    "source_id": source_id,
                    "data": data,
                }
            ]
        )

    def _prune_events(self) -> None:
        cutoff = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        self.db.execute("DELETE FROM events WHERE at < ?", (cutoff,))

    def events(
        self,
        after: int = 0,
        limit: int = 100,
        *,
        include_silent: bool = True,
        include_changes: bool = True,
    ) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT id, key, type, at, source_id, silent, data FROM events "
            "WHERE id > ? AND (? OR silent = 0) "
            "AND (? OR type NOT LIKE 'change.%') ORDER BY id LIMIT ?",
            (after, int(include_silent), int(include_changes), limit),
        )
        result = []
        for row in rows:
            data = self._read("events", row[0], row[6], {})
            # An unreadable event stays in the log as a silent one: nobody is shown it or
            # sent it, and every plugin's position still moves past it.
            result.append(
                {
                    "id": row[0],
                    "key": row[1],
                    "type": row[2],
                    "at": row[3],
                    "source_id": row[4],
                    "silent": bool(row[5]) or not isinstance(data, dict),
                    "data": data if isinstance(data, dict) else {},
                }
            )
        return result

    def recent_events(
        self, limit: int = 50, *, include_changes: bool = False
    ) -> list[dict[str, Any]]:
        """The latest events people should see, newest first."""
        rows = self.db.execute(
            "SELECT id FROM events WHERE silent = 0 "
            "AND (? OR type NOT LIKE 'change.%') ORDER BY id DESC LIMIT ?",
            (int(include_changes), limit),
        ).fetchall()
        if not rows:
            return []
        oldest = rows[-1][0]
        events = self.events(
            oldest - 1, limit, include_silent=False, include_changes=include_changes
        )
        return [event for event in reversed(events) if not event["silent"]]

    def query_events(
        self,
        limit: int = 50,
        *,
        before_id: int | None = None,
        after_id: int | None = None,
        types: list[str] | None = None,
        category: str | None = None,
        source_id: str | None = None,
        cluster_id: str | None = None,
        job: str | None = None,
        since: str | None = None,
        q: str | None = None,
        include_changes: bool = False,
        group: bool = False,
    ) -> list[dict[str, Any]]:
        """Visible Activity rows. Filters precede grouping; cursors address display rows."""
        # Local import: events also uses Store's clock.
        from .events import FAILURE_OUTCOMES, group_events

        where = ["silent = 0", "json_valid(data)"]
        args: list[Any] = []
        if not include_changes:
            where.append("type NOT LIKE 'change.%'")
        if types:
            where.append("type IN (" + ",".join("?" for _ in types) + ")")
            args.extend(types)
        if category == "failed":
            where.append(
                "(type IN ('job.failed', 'source.failed') OR (type = 'job.finished' "
                "AND json_extract(data, '$.outcome') IN ("
                + ",".join("?" for _ in FAILURE_OUTCOMES)
                + ")))"
            )
            args.extend(FAILURE_OUTCOMES)
        elif category:
            where.append(
                {
                    "jobs": "type LIKE 'job.%'",
                    "sources": "type IN ('source.failed', 'source.recovered')",
                    "gaps": "type IN ('source.gap', 'service.gap')",
                    "changes": "type LIKE 'change.%'",
                    "plugins": "type = 'change.tool'",
                }[category]
            )
        for column, value in (("source_id", source_id), ("json_extract(data, '$.job.id')", job)):
            if value is not None:
                where.append(f"{column} = ?")
                args.append(value)
        if cluster_id is not None:
            where.append(
                "(json_extract(data, '$.cluster_id') = ? OR source_id IN "
                "(SELECT id FROM sources WHERE json_valid(data) "
                "AND json_extract(data, '$.cluster_id') = ?) OR "
                "(type = 'change.instance' AND json_extract(data, '$.subject_id') IN "
                "(SELECT id FROM instances WHERE json_valid(data) AND 'platform:' || "
                "lower(trim(json_extract(data, '$.platform'))) = ?)))"
            )
            args.extend([cluster_id] * 3)
        if since is not None:
            where.append("julianday(at) >= julianday(?)")
            args.append(since)
        if q:
            # Treat LIKE metacharacters as literal search text.
            pattern = "%" + q.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
            fields = ("cluster_id", "job.id", "job.name", "source_name", "name")
            where.append(
                "("
                + " OR ".join(
                    f"json_extract(data, '$.{field}') LIKE ? ESCAPE '!'" for field in fields
                )
                + ")"
            )
            args.extend([pattern] * len(fields))
        cursor = []
        for operator, cursor_id in (("<", before_id), (">", after_id)):
            if cursor_id is not None:
                cursor.append(f"display_id {operator} ?")
                args.append(cursor_id)
        cursor_sql = " AND ".join(cursor) or "1"
        filtered = "SELECT * FROM events WHERE " + " AND ".join(where)
        if group:
            sql = (
                "WITH filtered AS (" + filtered + "), collections AS ("
                "SELECT *, CASE WHEN type LIKE 'change.%' THEN key ELSE "
                "COALESCE(json_extract(data, '$.observed_at'), at) END AS observed FROM filtered), "
                "sizes AS (SELECT source_id, type, observed, COUNT(*) AS n, MAX(id) AS newest "
                "FROM collections GROUP BY source_id, type, observed), keyed AS ("
                "SELECT c.*, CASE WHEN s.n >= 3 THEN s.newest ELSE c.id END AS display_id "
                "FROM collections c JOIN sizes s ON c.source_id IS s.source_id "
                "AND c.type = s.type AND c.observed = s.observed), page AS ("
                "SELECT DISTINCT display_id FROM keyed WHERE "
                + cursor_sql
                + " ORDER BY display_id DESC LIMIT ?) SELECT id, key, type, at, source_id, data "
                "FROM keyed WHERE display_id IN (SELECT display_id FROM page) ORDER BY id DESC"
            )
        else:
            sql = (
                "WITH keyed AS (SELECT *, id AS display_id FROM (" + filtered + ")) "
                "SELECT id, key, type, at, source_id, data FROM keyed WHERE "
                + cursor_sql
                + " ORDER BY id DESC LIMIT ?"
            )
        args.append(limit)
        result = []
        for key, event_key, kind, at, source, raw in self.db.execute(sql, args):
            data = self.record("events", key, raw, {})
            if data is not None:
                result.append(
                    dict(
                        id=key,
                        key=event_key,
                        type=kind,
                        at=at,
                        source_id=source,
                        silent=False,
                        data=data,
                    )
                )
        return group_events(result) if group else result

    def events_in_collection(
        self, source_id: str | None, observed_at: str, kind: str
    ) -> list[dict[str, Any]]:
        """Non-silent siblings, in delivery order; pre-0.6 rows use their event time."""
        rows = self.db.execute(
            "SELECT id, key, type, at, source_id, data FROM events WHERE silent = 0 "
            "AND source_id IS ? AND type = ? AND CASE WHEN json_valid(data) THEN "
            "COALESCE(json_extract(data, '$.observed_at'), at) END = ? ORDER BY id",
            (source_id, kind, observed_at),
        )
        result = []
        for key, event_key, event_type, at, source, raw in rows:
            data = self.record("events", key, raw, {})
            if data is not None:
                result.append(
                    {
                        "id": key,
                        "key": event_key,
                        "type": event_type,
                        "at": at,
                        "source_id": source,
                        "silent": False,
                        "data": data,
                    }
                )
        return result

    def recent_event_collections(
        self, limit: int, *, include_changes: bool = False
    ) -> list[dict[str, Any]]:
        """Complete collections for display, so a burst does not consume the row limit."""
        rows = self.db.execute(
            "WITH collections AS ("
            "SELECT id, source_id, type, CASE WHEN type LIKE 'change.%' THEN key "
            "ELSE COALESCE(json_extract(data, '$.observed_at'), at) END "
            "AS observed FROM events WHERE silent = 0 AND json_valid(data) "
            "AND (? OR type NOT LIKE 'change.%')), "
            "latest AS (SELECT source_id, type, observed FROM collections "
            "GROUP BY source_id, type, observed ORDER BY MAX(id) DESC LIMIT ?) "
            "SELECT e.id, e.key, e.type, e.at, e.source_id, e.data FROM latest "
            "JOIN collections c ON c.source_id IS latest.source_id "
            "AND c.type = latest.type AND c.observed = latest.observed "
            "JOIN events e ON e.id = c.id ORDER BY e.id DESC",
            (int(include_changes), limit),
        )
        result = []
        for key, event_key, kind, at, source, raw in rows:
            data = self.record("events", key, raw, {})
            if data is not None:
                result.append(
                    {
                        "id": key,
                        "key": event_key,
                        "type": kind,
                        "at": at,
                        "source_id": source,
                        "silent": False,
                        "data": data,
                    }
                )
        return result

    def last_event_id(self) -> int:
        row = self.db.execute("SELECT MAX(id) FROM events").fetchone()
        return int(row[0] or 0)

    # ---- Collection nodes ----

    def _node(self, key: str, data: str) -> dict[str, Any] | None:
        node = self._read("nodes", key, data, _NODE_FIELDS)
        if node is not None:
            for name in ("ssh_alias", "command"):
                if not isinstance(node.get(name), str):
                    node[name] = ""
            node["checked_at"] = timestamp(node.get("checked_at"))
            # What a node reported before replies were checked: never shown as is.
            node["version"] = nodes.reported_version(node.get("version"))
            node["drivers"] = nodes.reported_drivers(node.get("drivers")) or []
            node["error"] = checked(node.get("error"))
        return node

    def nodes(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, data FROM nodes ORDER BY rowid")
        return [node for node in (self._node(*row) for row in rows) if node is not None]

    def node(self, node_id: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT id, data FROM nodes WHERE id=?", (node_id,)).fetchone()
        return self._node(*row) if row else None

    def save_node(self, node: dict[str, Any]) -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO nodes VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (node["id"], json.dumps(node)),
            )
        self._repaired("nodes", node["id"])

    def delete_node(self, node_id: str) -> bool:
        with self.db:
            deleted = self.db.execute("DELETE FROM nodes WHERE id=?", (node_id,)).rowcount == 1
        self._repaired("nodes", node_id)
        return deleted

    def _snapshot(
        self, source_id: str, encoded: str, *, lifecycle: bool = False
    ) -> tuple[dict[str, Any], bool]:
        snapshot, invalid = _read_snapshot(encoded, lifecycle=lifecycle)
        if invalid:
            self._skip("snapshots", source_id, "malformed snapshot")
        return snapshot, invalid

    def snapshot(self, source_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT data FROM snapshots WHERE source_id = ?", (source_id,)
        ).fetchone()
        return self._snapshot(source_id, row[0], lifecycle=True)[0] if row else None

    def sources(self) -> list[dict[str, Any]]:
        result = []
        for source_id, data in self.db.execute("SELECT id, data FROM sources ORDER BY rowid"):
            source = self._read("sources", source_id, data, _SOURCE_FIELDS)
            if source is None:
                continue
            for key in ("last_success", "last_attempt", "next_due_at"):
                if key in source:
                    source[key] = timestamp(source[key])
            if not isinstance(source.get("options", {}), dict):
                source["options"] = {}
            for key in ("account", "qos", "warnings", "capabilities", "capabilities_seen", "error"):
                kind = (
                    list
                    if key in ("qos", "warnings", "capabilities", "capabilities_seen")
                    else dict
                )
                try:
                    if not isinstance(source.get(key), kind | None):
                        raise ValueError(f"Stored {key} is not a {kind.__name__}")
                    json.dumps(source.get(key), allow_nan=False, ensure_ascii=False).encode("utf-8")
                except (ValueError, UnicodeError):
                    source[key] = [] if kind is list else None
                    source.update(
                        status="error",
                        error={
                            "code": "collection_failed",
                            "detail": "Stored collection metadata is malformed; collect again.",
                        },
                    )
            source["kind"] = driver_kind(source)
            result.append(source)
        return result

    def source(self, source_id: str) -> dict[str, Any] | None:
        return next((item for item in self.sources() if item["id"] == source_id), None)

    def save_source(self, source: dict[str, Any]) -> None:
        stored = {key: value for key, value in source.items() if key not in {"kind", "stale"}}
        with self.db:
            self.db.execute(
                "INSERT INTO sources VALUES (?, ?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (source["id"], json.dumps(stored)),
            )
        self._repaired("sources", source["id"])

    def delete_source(self, source_id: str) -> bool:
        with self.db:
            deleted = self.db.execute("DELETE FROM sources WHERE id=?", (source_id,)).rowcount
            self.db.execute("DELETE FROM snapshots WHERE source_id=?", (source_id,))
        self._repaired("sources", source_id)
        self._repaired("snapshots", source_id)
        return deleted == 1

    def save_snapshot(self, source_id: str, snapshot: dict[str, Any]) -> None:
        for rows in snapshot.values():
            if not isinstance(rows, list):
                raise ValueError("Snapshot inventory must be a list")
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError("Invalid collection row")
                validate_row(row)
        old = self.db.execute(
            "SELECT data FROM snapshots WHERE source_id = ?", (source_id,)
        ).fetchone()
        merged = _read_snapshot(old[0])[0] if old else {}
        if "instances" in snapshot and merged.get("instances"):
            previous = {row["id"]: row for row in merged["instances"]}
            listed = [_keep_probe(row, previous.get(row["id"])) for row in snapshot["instances"]]
            # Keep an unexplained disappearance for one successful listing. A second
            # complete listing confirms absence; partial failures never reach here.
            seen = {row["id"] for row in listed}
            missing = [
                {**row, "state": "missing"}
                for row in merged["instances"]
                if row["id"] not in seen
                and row.get("state") not in {"missing", "terminated", "deleted"}
            ]
            snapshot = {**snapshot, "instances": [*listed, *missing]}
        merged.update(snapshot)
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO snapshots VALUES (?, ?)", (source_id, json.dumps(merged))
            )
        self._repaired("snapshots", source_id)

    def manual_instances(self) -> list[dict[str, Any]]:
        result = []
        for key, data in self.db.execute("SELECT id, data FROM instances"):
            instance = self._read("instances", key, data, _INSTANCE_FIELDS)
            if instance is not None:
                for name in ("observed_at", "last_probe_attempt"):
                    if name in instance:
                        instance[name] = timestamp(instance[name])
                result.append(instance)
        return result

    def update_cloud_metrics(
        self, instance_id: str, endpoint: dict[str, Any], updates: dict[str, Any]
    ) -> None:
        # A hardware probe updates one endpoint, never the inventory membership.
        rows = list(self.db.execute("SELECT source_id, data FROM snapshots"))
        with self.db:
            for source_id, encoded in rows:
                snapshot = _read_snapshot(encoded)[0]
                changed = False
                for row in snapshot.get("instances", []):
                    if row["id"] == instance_id and all(
                        row.get(key) == value for key, value in endpoint.items()
                    ):
                        updated = {**row, **updates}
                        try:
                            validate_row(updated)
                        except (ValueError, TypeError, UnicodeError) as error:
                            # Dropped for this instance: the source's listing stays readable.
                            logger.warning("Probe result for %s not saved: %s", instance_id, error)
                            continue
                        row.update(updated)
                        changed = True
                if changed:
                    self.db.execute(
                        "UPDATE snapshots SET data=? WHERE source_id=?",
                        (json.dumps(snapshot), source_id),
                    )

    def save_instance(self, instance: dict[str, Any]) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO instances VALUES (?, ?)",
                (instance["id"], json.dumps(instance)),
            )
        self._repaired("instances", instance["id"])

    def delete_instance(self, instance_id: str) -> bool:
        with self.db:
            deleted = self.db.execute("DELETE FROM instances WHERE id=?", (instance_id,)).rowcount
        self._repaired("instances", instance_id)
        return deleted == 1

    fresh = staticmethod(fresh)

    def dashboard(self) -> dict[str, Any]:
        sources = self.sources()
        for source in sources:
            age = (
                (datetime.now(UTC) - datetime.fromisoformat(source["last_success"])).total_seconds()
                if source.get("last_success")
                else None
            )
            # A disabled source is not collected, so it is never late.
            source["stale"] = (
                source["enabled"]
                and age is not None
                and age > source["interval_minutes"] * 66 + 120
            )
        history_sources = [s for s in sources if self.fresh(s, "history")]
        history_ids = {source["id"] for source in history_sources}
        # One job/node observed through two login identities must count only once.
        jobs: dict[str, Any] = {}
        nodes: dict[str, Any] = {}
        instances: dict[str, Any] = {}
        failures: dict[str, Any] = {}
        observations: dict[str, list[dict[str, Any]]] = {"jobs": [], "nodes": [], "instances": []}
        source_by_id = {s["id"]: s for s in sources}

        def observation_rank(item: dict[str, Any], capability: str) -> tuple[bool, bool, str]:
            source = source_by_id.get(item.get("source_id", ""), {})
            return (
                bool(source and fresh(source, capability)),
                bool(source.get("enabled")),
                item.get("observed_at") or "",
            )

        for source_id, encoded in self.db.execute("SELECT source_id, data FROM snapshots"):
            snapshot, invalid = self._snapshot(source_id, encoded)
            if invalid:
                for source in sources:
                    if source["id"] == source_id:
                        source.update(
                            status="error",
                            error={
                                "code": "collection_failed",
                                "detail": "Stored snapshot contains malformed rows; collect again.",
                            },
                        )
                history_ids.discard(source_id)
            for key, target in (("jobs", jobs), ("nodes", nodes), ("instances", instances)):
                rows = [{"source_id": source_id, **item} for item in snapshot.get(key, [])]
                observations[key].extend(rows)
                for item in rows:
                    previous = target.get(item["id"])
                    if not previous or observation_rank(item, key) >= observation_rank(
                        previous, key
                    ):
                        target[item["id"]] = item
            # Failures are a 24-hour window as of the last collection; only a fresh
            # collection may show them as recent.
            if source_id in history_ids:
                for item in snapshot.get("failures", []):
                    failures.setdefault(item["id"], item)
        history_sources = [source for source in history_sources if source["id"] in history_ids]
        manual = [
            {"source_id": "manual", "manual": True, **item, "state": manual_state(item)}
            for item in self.manual_instances()
        ]
        instances.update({item["id"]: item for item in manual})
        observations["instances"].extend(manual)
        history = self.history(24)
        for node in nodes.values():
            node["health"] = node_health(node.get("state", ""))
        data = {
            "mode": "live",
            **freshness(sources),
            "collecting": [],
            "sources": sources,
            "jobs": list(jobs.values()),
            "nodes": list(nodes.values()),
            "instances": list(instances.values()),
            "history": history,
            "updated_at": max(
                [s["last_success"] for s in sources if s.get("last_success")]
                + [row["observed_at"] for row in instances.values() if row.get("observed_at")],
                default=None,
            ),
            "refreshing": False,
            "recent_failures": sorted(
                failures.values(), key=lambda job: (job.get("end") or "", job["id"]), reverse=True
            ),
            "failure_history_sources": [source["id"] for source in history_sources],
            "failure_history_observed_at": min(
                (source["last_success"] for source in history_sources), default=None
            ),
        }

        data["summary"] = summarize({**data, **observations})
        return data

    def history(self, hours: int, max_points: int = 600) -> list[dict[str, Any]]:
        """Points of the last ``hours``, thinned to at most ``max_points``.

        Thinning keeps the latest point of each time bucket rather than averaging, so a
        gap (unknown) stays a gap and is never blended into a number.
        """
        since = (datetime.now(UTC) - timedelta(hours=hours)).isoformat()
        rows = []
        for at, data in self.db.execute(
            "SELECT at, data FROM history WHERE at >= ? ORDER BY at", (since,)
        ):
            row = self._read("history", at, data, {"at": str})
            if row is not None and timestamp(row["at"]) is None:
                self._skip("history", at, "no valid at")
            elif row is not None:
                rows.append(row)
        if len(rows) <= max_points:
            return rows
        bucket = hours * 3600 / max_points
        kept: dict[int, dict[str, Any]] = {}
        for row in rows:
            index = int(datetime.fromisoformat(row["at"]).timestamp() // bucket)
            kept[index] = row
        # A sliding window can overlap an extra absolute bucket; keep the newest ones.
        return [kept[index] for index in sorted(kept)[-max_points:]]

    def record_history(self) -> None:
        dashboard = self.dashboard()
        summary = dashboard["summary"]
        point = {
            "at": now(),
            "allocated_gpus": summary["allocated"],
            "known_allocated_gpus": summary["known_allocated"],
            "unknown_allocation_sources": summary["unknown_allocation_sources"],
            "gpu_utilization": summary["utilization"],
            "coverage_count": summary["covered"],
        }
        with self.db:
            self.db.execute("INSERT INTO history VALUES (?, ?)", (point["at"], json.dumps(point)))
            cutoff = (datetime.now(UTC) - timedelta(days=7)).isoformat()
            self.db.execute("DELETE FROM history WHERE at < ?", (cutoff,))

    def backup(self, directory: Path, keep: int = 10) -> Path:
        """Write a consistent copy; then remove all but the newest ``keep`` copies."""
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / f"computedeck-{datetime.now(UTC):%Y%m%d-%H%M%S-%f}.sqlite"
        with closing(sqlite3.connect(path)) as backup:
            self.db.backup(backup)
        path.chmod(0o600)
        # Only files named as this method names them; the names sort by time.
        copies = sorted(
            item
            for item in directory.iterdir()
            if re.fullmatch(r"computedeck-\d{8}-\d{6}-\d{6}\.sqlite", item.name)
        )
        for old in copies[: max(0, len(copies) - max(1, keep))]:
            old.unlink(missing_ok=True)
        return path
