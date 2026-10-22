"""Typical waits from the login's own accounting records, never queue predictions."""

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from statistics import quantiles
from typing import Any

from . import drivers
from .errors import SourceError
from .summary import timestamp


def supports_wait_history(source: dict[str, Any]) -> bool:
    """Drivers opt in only when their own terminal accounting can supply all three times."""
    try:
        return (
            getattr(type(drivers.get(source.get("driver", ""))), "supports_wait_history", False)
            is True
        )
    except SourceError:
        return False


def gpu_bucket(count: int) -> tuple[int, int]:
    """Keep CPU, one- and two-GPU jobs separate, then use power-of-two upper bounds."""
    upper = 0 if count == 0 else 1 << (count - 1).bit_length()
    return (upper if upper <= 2 else upper // 2 + 1, upper)


def wait_sample(job: dict[str, Any], source: dict[str, Any]) -> dict[str, Any] | None:
    """Keep own ordered, aware times; retain null GPU counts to explain missing buckets."""
    if (
        not source.get("username")
        or job.get("user") != source["username"]
        or job.get("cluster_id") != source["cluster_id"]
    ):
        return None
    count = job.get("gpu_count")
    if count is not None and (isinstance(count, bool) or not isinstance(count, int) or count < 0):
        return None
    times = [timestamp(job.get(key)) for key in ("submitted_at", "started_at", "ended_at")]
    if not all(times):
        return None
    submitted, started, ended = [datetime.fromisoformat(at) for at in times if at]
    if not submitted <= started <= ended:
        return None
    # Slurm can report Start == End for jobs cancelled without ever allocating.
    if count is None and started == ended:
        return None
    # Do not retain names, paths, scheduler output or other users' records.
    return {
        "id": job["id"],
        "cluster_id": source["cluster_id"],
        "user": source["username"],
        "qos": job.get("qos") or None,
        "partition": job.get("partition") or None,
        "gpu_count": count,
        "submitted_at": submitted.astimezone(UTC).isoformat(),
        "started_at": started.astimezone(UTC).isoformat(),
        "ended_at": ended.astimezone(UTC).isoformat(),
    }


def summarize_waits(
    sources: list[dict[str, Any]], samples: list[dict[str, Any]], *, now: datetime
) -> dict[str, Any]:
    """One summary per login; same-account twins share deduplicated accounting samples."""
    since = now - timedelta(days=30)
    groups: dict[tuple[Any, ...], dict[tuple[str, str], dict[str, Any]]] = defaultdict(dict)
    unknown_gpus: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    known_gpus: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    for sample in samples:
        if not since <= datetime.fromisoformat(sample["ended_at"]) <= now:
            continue
        login = (sample["cluster_id"], sample["user"])
        attempt = (sample["id"], sample["started_at"])
        if sample["gpu_count"] is None:
            unknown_gpus[login].add(attempt)
            continue
        known_gpus[login].add(attempt)
        lower, upper = gpu_bucket(sample["gpu_count"])
        key = (
            sample["cluster_id"],
            sample["user"],
            sample["qos"],
            sample["partition"],
            lower,
            upper,
        )
        groups[key][(sample["id"], sample["started_at"])] = sample
    buckets: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for (cluster, user, qos, partition, lower, upper), jobs in groups.items():
        waits = [
            (
                datetime.fromisoformat(j["started_at"]) - datetime.fromisoformat(j["submitted_at"])
            ).total_seconds()
            for j in jobs.values()
        ]
        quartiles = quantiles(waits, n=4, method="inclusive") if len(waits) >= 8 else None
        buckets[(cluster, user)].append(
            {
                "qos": qos,
                "partition": partition,
                "gpu_min": lower,
                "gpu_max": upper,
                "samples": len(waits),
                "p25_seconds": quartiles[0] if quartiles else None,
                "p75_seconds": quartiles[2] if quartiles else None,
            }
        )
    result = {}
    for source in sources:
        if source.get("kind") != "cluster":
            continue
        twins = [
            s
            for s in sources
            if s["cluster_id"] == source["cluster_id"]
            and s.get("username") == source.get("username")
        ]
        supported = supports_wait_history(source)
        accounting = [
            s
            for s in twins
            if supports_wait_history(s) and "history" in (s.get("capabilities") or [])
        ]
        result[source["id"]] = {
            "status": "unsupported"
            if not supported
            else "available"
            if accounting
            else "unavailable"
            if any(s.get("last_success") for s in twins)
            else "not_collected",
            "observed_at": (
                max((s.get("last_success") or "" for s in accounting), default="") or None
            )
            if supported
            else None,
            # A known count from a twin login resolves that attempt's missing count.
            "unknown_gpu_samples": len(
                unknown_gpus[(source["cluster_id"], source.get("username", ""))]
                - known_gpus[(source["cluster_id"], source.get("username", ""))]
            )
            if supported
            else 0,
            "buckets": sorted(
                buckets[(source["cluster_id"], source.get("username", ""))],
                key=lambda b: (b["qos"] or "", b["partition"] or "", b["gpu_min"]),
            )
            if supported
            else [],
        }
    return result
