"""Sustained low GPU use from consecutive, actually measured readings."""

from datetime import datetime
from typing import Any

from .drivers.cloud import instance_lifecycle


def measurement_family(origin: str) -> str:
    """SSH collections and checks share the same per-GPU measurement rule."""
    return "provider" if origin == "provider" else "ssh"


def low_use(
    instance: dict[str, Any],
    readings: list[dict[str, Any]],
    *,
    now: datetime,
    interval_minutes: float,
    threshold: int,
    window_minutes: int,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "state": "unknown",
        "since": None,
        "covered_minutes": 0,
        "samples": 0,
        "origin": None,
        "reason": "no_reading",
    }
    if instance_lifecycle(instance.get("state")) != "held":
        return {**result, "reason": "not_running"}
    if not readings:
        return result
    last = readings[-1]
    result["origin"] = last["origin"]
    gap = interval_minutes * 120
    if not 0 <= (now - datetime.fromisoformat(last["at"])).total_seconds() <= gap:
        return {**result, "reason": "stale"}
    streak: list[dict[str, Any]] = []
    previous = datetime.fromisoformat(last["at"])
    for reading in reversed(readings):
        at = datetime.fromisoformat(reading["at"])
        if (
            measurement_family(reading["origin"]) != measurement_family(last["origin"])
            or (previous - at).total_seconds() > gap
        ):
            break
        if max(reading["gpu_util"], reading["gpu_util_max"] or 0) >= threshold:
            if not streak:
                return {**result, "state": "busy", "samples": 1, "reason": None}
            break
        streak.append(reading)
        previous = at
    minutes = (datetime.fromisoformat(last["at"]) - previous).total_seconds() / 60
    enough = len(streak) >= 3 and minutes >= window_minutes
    return {
        **result,
        "state": "low" if enough else "unknown",
        "since": streak[-1]["at"],
        "covered_minutes": minutes,
        "samples": len(streak),
        "reason": None if enough else "coverage",
    }
