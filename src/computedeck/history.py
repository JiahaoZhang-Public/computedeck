"""Observed usage integrals. Missing collection time is never filled with zero."""

from datetime import UTC, datetime, timedelta
from typing import Any

HOLD_SECONDS = 1800


def group_history(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        key: {
            "allocated": group["allocated"],
            "known_allocated": group["known_allocated"],
            "unknown_allocation_sources": group["unknown_allocation_sources"],
            "spend": group["spend"]["rates"],
            "spend_unknown": len(group["spend"]["unpriced"]),
        }
        for key, group in summary["groups"].items()
    }


def rollup_history(
    points: list[dict[str, Any]], hours: int, *, end: datetime | None = None
) -> dict[str, Any]:
    end = end or datetime.now(UTC)
    start = end - timedelta(hours=hours)
    gap = timedelta(seconds=HOLD_SECONDS)
    buckets: dict[datetime, dict[str, Any]] = {}
    cursor = start.replace(minute=0, second=0, microsecond=0)
    while cursor < end:
        left, right = max(start, cursor), min(end, cursor + timedelta(hours=1))
        buckets[cursor] = {
            "at": left.isoformat(),
            "end": right.isoformat(),
            "observed_seconds": 0.0,
            "groups": {},
        }
        cursor += timedelta(hours=1)
    for index, point in enumerate(points):
        at = datetime.fromisoformat(point["at"])
        next_at = (
            datetime.fromisoformat(points[index + 1]["at"]) if index + 1 < len(points) else end
        )
        left, right = max(start, at), min(end, next_at, at + gap)
        if "by_group" not in point:
            continue  # Pre-upgrade points have no breakdown, including known zeroes.
        while left < right:
            hour = left.replace(minute=0, second=0, microsecond=0)
            stop = min(right, hour + timedelta(hours=1))
            seconds = (stop - left).total_seconds()
            bucket = buckets[hour]
            bucket["observed_seconds"] += seconds
            for key, sample in point["by_group"].items():
                group = bucket["groups"].setdefault(
                    key,
                    {
                        "gpu_hours": None,
                        "spend": {},
                        "observed_seconds": 0.0,
                        "gpu_partial": False,
                        "spend_partial": False,
                        "spend_known": False,
                    },
                )
                group["observed_seconds"] += seconds
                allocated = sample["allocated"]
                known = allocated if allocated is not None else sample["known_allocated"]
                if known is not None:
                    group["gpu_hours"] = (group["gpu_hours"] or 0) + known * seconds / 3600
                group["gpu_partial"] |= allocated is None or bool(
                    sample["unknown_allocation_sources"]
                )
                group["spend_partial"] |= bool(sample["spend_unknown"])
                group["spend_known"] |= bool(sample["spend"]) or not sample["spend_unknown"]
                for currency, rate in sample["spend"].items():
                    group["spend"][currency] = (
                        group["spend"].get(currency, 0) + rate * seconds / 3600
                    )
            left = stop
    for bucket in buckets.values():
        duration = (
            datetime.fromisoformat(bucket["end"]) - datetime.fromisoformat(bucket["at"])
        ).total_seconds()
        for group in bucket["groups"].values():
            missing = group["observed_seconds"] < duration - 0.001
            group["gpu_partial"] |= missing
            group["spend_partial"] |= missing
    return {"start": start.isoformat(), "end": end.isoformat(), "buckets": list(buckets.values())}
