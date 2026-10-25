"""Observed usage integrals. Missing collection time is never filled with zero."""

import math
from datetime import UTC, datetime, timedelta
from typing import Any

from .summary import PROBE_INTERVAL, RUNNING, fresh, ssh_sampled_at

HOLD_SECONDS = 1800


def group_history(data: dict[str, Any]) -> dict[str, Any]:
    source_ids = {source["id"] for source in data["sources"]}
    active = {source["cluster_id"] for source in data["sources"] if source["enabled"]}
    active.update(
        f"platform:{(item.get('platform') or '').strip().lower()}"
        for item in data["instances"]
        if item["source_id"] not in source_ids
    )
    return {
        key: {
            "allocated": group["allocated"],
            "known_allocated": group["known_allocated"],
            "unknown_allocation_sources": group["unknown_allocation_sources"],
            "spend": group["spend"]["rates"],
            "spend_unknown": len(group["spend"]["unpriced"]),
        }
        for key, group in data["summary"]["groups"].items()
        if key in active
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
                        "gpu_observed_seconds": 0.0,
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
                    group["gpu_observed_seconds"] += seconds
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


def chart_observation(data: dict[str, Any]) -> dict[str, Any]:
    """Coverage at collection time, not inferred later from today's configuration."""
    sources = {s["id"]: s for s in data["sources"] if s["enabled"]}
    manuals = {i["id"]: i for i in data["instances"] if i.get("manual") and i.get("monitoring")}
    subjects = set(sources) | set(manuals)
    owners = {i["id"]: i["id"] if i.get("manual") else i["source_id"] for i in data["instances"]}
    unknown = {
        owners.get(entry["subject"]["id"], entry["subject"]["id"])
        for entry in data["summary"]["unmeasured"]
    }
    current = datetime.now(UTC)
    sampled = [
        j
        for j in data["jobs"]
        if j.get("state", "").upper() in RUNNING
        and j["source_id"] in sources
        and fresh(sources[j["source_id"]], "jobs")
    ] + [
        i
        for i in data["instances"]
        if not i.get("same_node")
        and (not i.get("manual") or i.get("monitoring"))
        and (i.get("manual") or i["source_id"] in sources)
        and i.get("ssh_status") == "reachable"
        and (at := ssh_sampled_at(i))
        and (current - datetime.fromisoformat(at)).total_seconds() < 720
    ]
    measured = {
        owners.get(i["id"], i["source_id"])
        for i in sampled
        if i.get("gpu_utilization") is not None
        and (i.get("gpu_observed_count", i.get("gpu_count")) or 0) > 0
    }
    return {
        "allocation": {"known": len(subjects - unknown), "total": len(subjects)},
        "utilization": {"known": len(subjects & measured), "total": len(subjects)},
        "intervals": [s["interval_minutes"] * 60 for s in sources.values()]
        + [PROBE_INTERVAL.total_seconds() for _ in manuals],
    }


def chart_history(
    points: list[dict[str, Any]], hours: int, *, end: datetime, current: datetime
) -> dict[str, Any]:
    """Aggregate raw observations; empty bins and unknown values never become zero."""
    seconds = 300 if hours <= 24 else 3600 if hours <= 168 else 86400
    start = end - timedelta(hours=hours)
    available = [p for p in points if datetime.fromisoformat(p["at"]) <= end]
    last_sample = max((p["at"] for p in available), default=None)
    preceding = [p for p in available if datetime.fromisoformat(p["at"]) < start]
    previous_sample = max(preceding, key=lambda p: p["at"], default=None)
    points = sorted(
        (p for p in available if start <= datetime.fromisoformat(p["at"])),
        key=lambda p: p["at"],
    )
    bins: list[tuple[datetime, datetime, list[dict[str, Any]]]] = []
    cursor = start
    index = 0
    while cursor < end:
        boundary = datetime.fromtimestamp((int(cursor.timestamp()) // seconds + 1) * seconds, UTC)
        right = min(end, boundary)
        samples = []
        while index < len(points):
            at = datetime.fromisoformat(points[index]["at"])
            if at >= right and not (right == end and at == end):
                break
            samples.append(points[index])
            index += 1
        bins.append((cursor, right, samples))
        cursor = right
    series = []
    for metric, field in (("utilization", "gpu_utilization"), ("allocation", "allocated_gpus")):
        buckets: list[dict[str, Any]] = []
        previous: dict[str, Any] | None = previous_sample
        for left, right, samples in bins:
            observation = samples[-1] if samples else previous
            intervals = (observation or {}).get("chart_coverage", {}).get("intervals", [])
            expected = (
                max(1, math.ceil(sum((right - left).total_seconds() / n for n in intervals)))
                if intervals
                else None
            )
            threshold = 2 * min(intervals) if intervals else HOLD_SECONDS
            held = (
                not samples
                and previous is not None
                and (left - datetime.fromisoformat(previous["at"])).total_seconds() < threshold
            )
            readings = [previous] if held and previous is not None else samples
            values = [
                p.get(field)
                if p.get(field) is not None or metric == "utilization"
                else p.get("known_allocated_gpus")
                for p in readings
            ]
            known_values = [v for v in values if v is not None]
            coverage = [p.get("chart_coverage", {}).get(metric) for p in readings]
            complete_coverage = bool(coverage) and all(c is not None for c in coverage)
            known = min(c["known"] for c in coverage) if complete_coverage else None
            total = max(c["total"] for c in coverage) if complete_coverage else None
            missing_sources = any(c is not None and c["known"] < c["total"] for c in coverage)
            lower_bound = metric == "allocation" and (
                missing_sources
                or any(
                    (p.get("allocated_gpus") is None and p.get("known_allocated_gpus") is not None)
                    or bool(p.get("unknown_allocation_sources", 0))
                    for p in readings
                )
            )
            partial = lower_bound or any(v is None for v in values) or missing_sources
            reason = None
            if not known_values:
                reason = (
                    "chart_unknown"
                    if readings
                    else "chart_not_collecting"
                    if previous is not None
                    else "chart_no_samples"
                )
            buckets.append(
                {
                    "start": left.isoformat(),
                    "end": right.isoformat(),
                    "value": sum(known_values) / len(known_values) if known_values else None,
                    "min": min(known_values) if known_values else None,
                    "max": max(known_values) if known_values else None,
                    "samples": 0 if held else len(known_values),
                    "held_from": previous["at"] if held and previous is not None else None,
                    "expected_samples": expected,
                    "known_sources": known,
                    "total_sources": total,
                    "partial": partial,
                    "lower_bound": lower_bound,
                    "gap_reason": {"code": reason} if reason else None,
                    "so_far": right == current,
                }
            )
            if samples:
                previous = samples[-1]
        bucket_values = [b["value"] for b in buckets if b["value"] is not None]
        gaps = [b for b in buckets if b["value"] is None]
        series.append(
            {
                "id": metric,
                "buckets": buckets,
                "summary": {
                    "code": "chart_summary" if bucket_values else "chart_empty_summary",
                    "mean": round(sum(bucket_values) / len(bucket_values), 1)
                    if bucket_values
                    else 0,
                    "min": min(b["min"] for b in buckets if b["min"] is not None)
                    if bucket_values
                    else 0,
                    "max": max(b["max"] for b in buckets if b["max"] is not None)
                    if bucket_values
                    else 0,
                    "gaps": len(gaps),
                    "minutes": round(
                        sum(
                            (
                                datetime.fromisoformat(b["end"])
                                - datetime.fromisoformat(b["start"])
                            ).total_seconds()
                            / 60
                            for b in gaps
                        )
                    ),
                    "partial": sum(b["partial"] for b in buckets),
                },
            }
        )
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "as_of": current.isoformat(),
        "bucket_seconds": seconds,
        "last_sample": last_sample,
        "series": series,
    }
