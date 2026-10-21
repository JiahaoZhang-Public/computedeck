"""Events: what changed between two collections of a source.

Events are stored with a unique key, so an observation repeated by later collections
(a failure stays in the 24-hour window) is recorded once. The first successful
collection of a source only records what already exists, silently: adding a cluster
must not announce every failure of the past day.

Types:

- ``job.started``: a job is first seen running or changes to running.
- ``job.finished``: one reconciled terminal outcome (possibly unknown).
- ``job.ended`` / ``job.failed``: legacy API-1 delivery names.
- ``source.failed``: a source that worked could not be collected.
- ``source.recovered``: a failing source was collected again.
- ``source.gap`` / ``service.gap``: a span without observations (explicit subscriptions only).
"""

from collections import Counter
from datetime import datetime, timedelta
from typing import Any

from .drivers import Batch
from .drivers.base import job_time
from .store import now
from .summary import RUNNING

LEGACY_TYPES = ("job.started", "job.ended", "job.failed", "source.failed", "source.recovered")
TYPES = (*LEGACY_TYPES, "job.finished")
GAP_TYPES = ("service.gap", "source.gap")
CHANGE_TYPES = ("change.source", "change.node", "change.instance", "change.tool", "change.import")
FAILURE_OUTCOMES = (
    "failed",
    "timeout",
    "out_of_memory",
    "node_fail",
    "boot_fail",
    "deadline",
    "preempted",
)
OUTCOMES = ("completed", "cancelled", *FAILURE_OUTCOMES, "unknown")


def after_gap(source: dict[str, Any], at: str) -> bool:
    previous = job_time(source.get("last_success"))
    # A failed attempt and the recovery both take time between scheduled intervals.
    return bool(
        previous
        and (datetime.fromisoformat(at) - datetime.fromisoformat(previous)).total_seconds()
        > 120 * source.get("interval_minutes", 10) + 240
    )


def for_handler(event: dict[str, Any], types: frozenset[str] | None) -> dict[str, Any] | None:
    """New types require an explicit subscription; API-1 endings keep their old names."""
    kind = event["type"]
    if kind.startswith("change."):
        return None
    if kind == "job.finished" and (types is None or kind not in types):
        kind = "job.failed" if event["data"].get("outcome") in FAILURE_OUTCOMES else "job.ended"
        event = {**event, "type": kind}
    if (types is None and kind in LEGACY_TYPES) or (types is not None and kind in types):
        return event
    return None


def _context(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_name": source.get("name"),
        "cluster_id": source.get("cluster_id"),
        "username": source.get("username"),
        "driver": source.get("driver"),
    }


def source_gap(
    source: dict[str, Any], batch: Batch, at: str, service_gap: dict[str, str] | None
) -> list[dict[str, Any]]:
    previous = job_time(source.get("last_success"))
    if not previous or "jobs" not in batch.capabilities:
        return []
    start, end = datetime.fromisoformat(previous), datetime.fromisoformat(at)
    interval = source.get("interval_minutes", 10) * 60
    window = batch.history_window_seconds if "history" in batch.capabilities else None
    # Allow fixed scheduling slack without hiding long gaps at slow polling rates.
    threshold = max(2 * interval, 3600)
    if window is not None:
        threshold = max(window - 3600, interval + 900, 3600)
    if (end - start).total_seconds() <= threshold:
        return []
    if service_gap:
        offline = job_time(service_gap.get("from"))
        resumed = job_time(service_gap.get("to"))
        # Include heartbeat/tick granularity and an in-flight collection's timeout.
        slack = timedelta(seconds=interval + 75 + 120)
        if (
            offline
            and resumed
            and datetime.fromisoformat(offline) - slack <= start
            and (end - datetime.fromisoformat(resumed)).total_seconds() <= threshold
        ):
            return []
    return [
        {
            "key": f"source.gap:{source['id']}:{previous}",
            "type": "source.gap",
            "at": at,
            "source_id": source["id"],
            "data": {
                **_context(source),
                "unobserved_from": previous,
                "unobserved_to": at,
                "failures_checked_from": (end - timedelta(seconds=window)).isoformat()
                if window is not None
                else None,
            },
        }
    ]


def _local(job_id: str) -> str:
    return job_id.split(":", 1)[-1]


def _renamed(previous: dict[str, Any], current: dict[str, Any]) -> set[str]:
    """Jobs of a snapshot taken before array elements had ids like 1234_7 (0.2), which are
    still there under their new id. Matched by name and state once, on the first
    collection after the upgrade."""
    if any("_" in _local(job_id) for job_id in previous) or not any(
        "_" in _local(job_id) for job_id in current
    ):
        return set()
    seen = {
        (job.get("name"), job.get("state"))
        for job_id, job in current.items()
        if "_" in _local(job_id)
    }
    return {
        job_id
        for job_id, job in previous.items()
        if job_id not in current and (job.get("name"), job.get("state")) in seen
    }


def collected(
    source: dict[str, Any],
    old: dict[str, Any] | None,
    batch: Batch,
    *,
    first: bool,
    service_gap: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Events from a successful collection. ``old`` is the snapshot before it."""
    at = now()
    events: list[dict[str, Any]] = []
    context = _context(source)
    old = old or {}
    baseline = first or "lifecycle_pending" not in old
    gap = after_gap(source, at)
    history_capable = "history" in batch.capabilities or "history" in (
        source.get("capabilities_seen") or source.get("capabilities") or []
    )
    previous = {job["id"]: job for job in old.get("jobs") or []}
    current = {job["id"]: job for job in batch.jobs or []}
    pending = {job["id"]: job for job in old.get("lifecycle_pending") or []}
    ended = {
        value["id"]: value
        for value in old.get("lifecycle_ended") or []
        if (
            datetime.fromisoformat(at) - datetime.fromisoformat(value["observed_at"])
        ).total_seconds()
        < 86400
    }
    # Drivers without terminal history can still supply the existing failure contract.
    terminal = {
        job["id"]: job
        for job in (batch.finished if batch.finished is not None else batch.failures) or []
    }
    # A departed pod may only have reported a container failure before it was deleted.
    # The wider failure window can also resolve departures missed by terminal history.
    departed = pending.keys() | (
        previous.keys() - current.keys() if batch.jobs is not None else set()
    )
    departed -= current.keys()
    for job in [*(batch.failures or []), *(old.get("failures") or [])]:
        if job["id"] in departed:
            terminal.setdefault(job["id"], job)
    unknown: set[str] = set()
    # An old accounting row for a requeued ID cannot resolve its newer attempt.
    for job_id, job in {**previous, **pending, **current}.items():
        reported = terminal.get(job_id)
        started = job_time(job.get("started_at"))
        end = (
            (job_time(reported.get("ended_at")) or job_time(reported.get("end")))
            if reported
            else None
        )
        if started and end and datetime.fromisoformat(end) < datetime.fromisoformat(started):
            terminal.pop(job_id, None)
    waiting: list[dict[str, Any]] = []
    if batch.jobs is not None:
        renamed = _renamed(previous, current)
        for job_id, job in current.items():
            before = previous.get(job_id)
            if str(job.get("state", "")).upper() in RUNNING and (
                before is None or str(before.get("state", "")).upper() not in RUNNING
            ):
                ended.pop(job_id, None)
                started = job_time(job.get("started_at"))
                events.append(
                    {
                        "key": f"job.started:{job_id}:{started or at}",
                        "type": "job.started",
                        "at": started or at,
                        "source_id": source["id"],
                        "silent": first,
                        "data": {**context, "job": job, "started_at": started, "observed_at": at},
                    }
                )
        for job_id, job in {**previous, **pending}.items():
            if job_id in current or job_id in terminal or job_id in renamed or job_id in ended:
                continue
            held_at = job.get("held_at", at)
            expired = (
                datetime.fromisoformat(at) - datetime.fromisoformat(held_at)
            ).total_seconds() >= 86400
            if (
                (history_capable or job_id in pending)
                and not expired
                and (job_id not in pending or "history" not in batch.capabilities)
            ):
                waiting.append(
                    {
                        **job,
                        "held_at": held_at,
                        "held_silent": job.get("held_silent", baseline or gap),
                    }
                )
            else:
                terminal[job_id] = job
                unknown.add(job_id)
    else:
        waiting = list(pending.values())
    for job_id, job in terminal.items():
        held_silent = pending.get(job_id, {}).get("held_silent", False)
        job = {key: value for key, value in job.items() if key not in {"held_at", "held_silent"}}
        raw_end = None if job_id in unknown else job.get("end")
        end = None if job_id in unknown else job_time(job.get("ended_at")) or job_time(raw_end)
        before = ended.get(job_id)
        # Retry the same key, but never announce one ending in two raw formats.
        if before and raw_end != before.get("end"):
            previous_end = job_time(before.get("ended_at")) or job_time(before.get("end"))
            if (
                not end
                or not previous_end
                or datetime.fromisoformat(end) == datetime.fromisoformat(previous_end)
            ):
                continue
        outcome = "unknown" if job_id in unknown else str(job.get("state", "")).lower()
        if outcome not in OUTCOMES:
            outcome = "unknown"
        reason = None
        if outcome == "unknown":
            reason = (
                "outcome_not_reported"
                if history_capable or job_id in pending
                else "outcomes_unavailable"
            )
        events.append(
            {
                "key": f"job.finished:{job_id}:{raw_end or 'left'}",
                "type": "job.finished",
                "at": end or at,
                "source_id": source["id"],
                "silent": baseline or ((gap or held_silent) and outcome not in FAILURE_OUTCOMES),
                "data": {
                    **context,
                    "job": job,
                    "outcome": outcome,
                    "state": None if job_id in unknown else job.get("state"),
                    "exit_code": None if job_id in unknown else job.get("exit_code"),
                    "submitted_at": job_time(job.get("submitted_at")),
                    "started_at": job_time(job.get("started_at")),
                    "ended_at": end,
                    "observed_at": at,
                    "outcome_reason": reason,
                },
            }
        )
        ended[job_id] = {"id": job_id, "end": raw_end, "ended_at": end, "observed_at": at}
    if gap:
        for event in events:
            event["data"]["since"] = source["last_success"]
    batch.lifecycle_pending = waiting
    batch.lifecycle_ended = list(ended.values())
    if not first:
        events.extend(source_gap(source, batch, at, service_gap))
    if source.get("status_before") == "error":
        events.append(
            {
                "key": f"source.recovered:{source['id']}:{at}",
                "type": "source.recovered",
                "at": at,
                "source_id": source["id"],
                "data": context,
            }
        )
    return events


def failed(source: dict[str, Any], error: dict[str, Any]) -> list[dict[str, Any]]:
    """An event when a source that last worked cannot be collected."""
    if source.get("status_before") == "error" or not source.get("last_success"):
        return []
    at = now()
    return [
        {
            "key": f"source.failed:{source['id']}:{at}",
            "type": "source.failed",
            "at": at,
            "source_id": source["id"],
            "data": {**_context(source), "error": error},
        }
    ]


def filter_events(
    rows: list[dict[str, Any]],
    *,
    types: list[str] | None = None,
    category: str | None = None,
    source_id: str | None = None,
    cluster_id: str | None = None,
    job: str | None = None,
    since: str | None = None,
    q: str | None = None,
    include_changes: bool = False,
    dashboard: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Example-mode counterpart of Store.query_events; apply before grouping and paging."""
    sources = (
        {source["id"]: source["cluster_id"] for source in dashboard["sources"]} if dashboard else {}
    )
    instances = (
        {
            item["id"]: "platform:" + item["platform"].strip().lower()
            for item in dashboard["instances"]
        }
        if dashboard
        else {}
    )
    # Match SQLite LIKE: case-insensitive for ASCII letters only.
    ascii_lower = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
    result = []
    for row in rows:
        kind, data = row["type"], row["data"]
        task = data.get("job") or {}
        categories = {
            "failed": kind in ("job.failed", "source.failed")
            or (kind == "job.finished" and data.get("outcome") in FAILURE_OUTCOMES),
            "jobs": kind.startswith("job."),
            "sources": kind in ("source.failed", "source.recovered"),
            "gaps": kind in GAP_TYPES,
            "changes": kind.startswith("change."),
            "plugins": kind == "change.tool",
        }
        if row.get("silent") or (not include_changes and kind.startswith("change.")):
            continue
        if types and kind not in types or category and not categories[category]:
            continue
        if source_id is not None and row.get("source_id") != source_id:
            continue
        if cluster_id is not None and cluster_id not in (
            data.get("cluster_id"),
            sources.get(row.get("source_id")),
            instances.get(data.get("subject_id")) if kind == "change.instance" else None,
        ):
            continue
        if job is not None and task.get("id") != job:
            continue
        if since and datetime.fromisoformat(row["at"]) < datetime.fromisoformat(since):
            continue
        if q and not any(
            q.translate(ascii_lower) in str(value or "").translate(ascii_lower)
            for value in (
                data.get("cluster_id"),
                task.get("id"),
                task.get("name"),
                data.get("source_name"),
                data.get("name"),
            )
        ):
            continue
        result.append(row)
    return sorted(result, key=lambda row: row["id"], reverse=True)


def group_events(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Opt-in Activity presentation only. Stored events and plugin delivery stay individual."""
    collections: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for event in rows:
        key = (
            event.get("source_id"),
            event["type"],
            event["id"]
            if event["type"].startswith("change.")
            else event["data"].get("observed_at") or event["at"],
        )
        collections.setdefault(key, []).append(event)
    result = []
    for siblings in collections.values():
        siblings.sort(key=lambda event: event["id"], reverse=True)
        if len(siblings) < 3:
            result.extend(siblings)
            continue
        names = Counter(
            str(job.get("name") or job.get("id") or "—")
            for event in siblings
            if (job := event["data"].get("job"))
        )
        stamps = [event["at"] for event in siblings]
        last_at = max(stamps, key=datetime.fromisoformat)
        time_field = {"job.finished": "ended_at", "job.started": "started_at"}.get(
            siblings[0]["type"]
        )
        unknown = [event for event in siblings if time_field and not event["data"].get(time_field)]
        result.append(
            {
                **siblings[0],
                "at": last_at,
                "group": {
                    "count": len(siblings),
                    "ids": [event["id"] for event in siblings],
                    "first_at": min(stamps, key=datetime.fromisoformat),
                    "last_at": last_at,
                    "names": [
                        {"name": name, "count": count} for name, count in names.most_common(10)
                    ],
                    "outcomes": dict(
                        Counter(
                            event["data"].get("outcome") or "unknown"
                            for event in siblings
                            if event["type"] == "job.finished"
                        )
                    ),
                    "observed_time": bool(unknown),
                    "since": next(
                        (event["data"]["since"] for event in unknown if event["data"].get("since")),
                        None,
                    ),
                    "events": siblings[:50],
                },
            }
        )
    return sorted(result, key=lambda event: event["id"], reverse=True)
