"""Events: what changed between two collections of a source.

Events are stored with a unique key, so an observation repeated by later collections
(a failure stays in the 24-hour window) is recorded once. The first successful
collection of a source only records what already exists, silently: adding a cluster
must not announce every failure of the past day.

Types:

- ``job.started``: a job that was pending is running.
- ``job.ended``: a job left the queue (finished, failed or cancelled; see ``job.failed``).
- ``job.failed``: a job of the source ended with a failure in the last 24 hours.
- ``source.failed``: a source that worked could not be collected.
- ``source.recovered``: a failing source was collected again.
"""

from typing import Any

from .drivers import Batch
from .store import now
from .summary import PENDING, RUNNING

TYPES = ("job.started", "job.ended", "job.failed", "source.failed", "source.recovered")


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
    for failure in batch.failures or []:
        events.append(
            {
                # A requeued job can fail again under the same id; each end is one event.
                "key": f"job.failed:{failure['id']}:{failure.get('end') or ''}",
                "type": "job.failed",
                "at": at,
                "source_id": source["id"],
                "silent": first,
                "data": {**context, "job": failure},
            }
        )
    previous = {job["id"]: job for job in (old or {}).get("jobs") or []}
    if batch.jobs is not None and previous and not first:
        current = {job["id"]: job for job in batch.jobs}
        renamed = _renamed(previous, current)
        for job_id, job in current.items():
            before = previous.get(job_id)
            if (
                before
                and str(before.get("state", "")).upper() in PENDING
                and str(job.get("state", "")).upper() in RUNNING
            ):
                events.append(
                    {
                        # A requeued job starts again under the same id.
                        "key": f"job.started:{job_id}:{at}",
                        "type": "job.started",
                        "at": at,
                        "source_id": source["id"],
                        "data": {**context, "job": job},
                    }
                )
        for job_id, before in previous.items():
            if job_id not in current and job_id not in renamed:
                events.append(
                    {
                        "key": f"job.ended:{job_id}",
                        "type": "job.ended",
                        "at": at,
                        "source_id": source["id"],
                        "data": {**context, "job": before},
                    }
                )
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
