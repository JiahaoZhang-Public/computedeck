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
"""

from datetime import datetime
from typing import Any

from .drivers import Batch
from .drivers.base import job_time
from .store import now
from .summary import RUNNING

LEGACY_TYPES = ("job.started", "job.ended", "job.failed", "source.failed", "source.recovered")
TYPES = (*LEGACY_TYPES, "job.finished")
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
    return bool(
        previous
        and (datetime.fromisoformat(at) - datetime.fromisoformat(previous)).total_seconds()
        > 120 * source.get("interval_minutes", 10)
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
    source: dict[str, Any], old: dict[str, Any] | None, batch: Batch, *, first: bool
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
    # The wider failure window can resolve departures missed by terminal history.
    for job in batch.failures or []:
        if job["id"] in pending:
            terminal.setdefault(job["id"], job)
    unknown: set[str] = set()
    # An old accounting row for a requeued ID cannot resolve its newer attempt.
    for job_id, job in {**previous, **pending, **current}.items():
        reported = terminal.get(job_id)
        started = job_time(job.get("started_at"))
        end = job_time(reported.get("end")) if reported else None
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
        end = job_time(raw_end)
        before = ended.get(job_id)
        # Late or incomplete accounting must not announce the same ending again.
        if before and (not raw_end or not before.get("end")):
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
        ended[job_id] = {"id": job_id, "end": raw_end, "observed_at": at}
    batch.lifecycle_pending = waiting
    batch.lifecycle_ended = list(ended.values())
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
