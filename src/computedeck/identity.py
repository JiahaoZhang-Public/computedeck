"""Stable six-colour identity slots, independent of source order and status."""

from collections import Counter
from typing import Any


def group_keys(sources: list[dict[str, Any]], instances: list[dict[str, Any]]) -> list[str]:
    groups: dict[str, dict[str, Any]] = {}
    for source in sources:
        groups.setdefault(source["cluster_id"], source)
    keys = [
        source["cluster_id"]
        if source["kind"] == "cluster"
        else f"platform:{source['name'].strip().lower()}"
        for source in groups.values()
    ]
    keys += [
        f"platform:{item['platform'].strip().lower()}"
        for item in instances
        if (item.get("manual") or item.get("source_id") == "manual")
        and isinstance(item.get("platform"), str)
    ]
    return list(dict.fromkeys(keys))


def assign_slots(keys: list[str], saved: dict[str, int]) -> dict[str, int]:
    """Keep existing choices; fill free slots before sharing the least-used one."""
    slots = {key: saved[key] for key in keys if key in saved}
    counts = Counter(slots.values())
    for key in keys:
        if key in slots:
            continue
        # A small deterministic string hash, not Python's process-randomised hash().
        preferred = 0
        for char in key:
            preferred = (preferred * 31 + ord(char)) % 6
        free = [slot for slot in range(1, 7) if not counts[slot]]
        slot = (
            preferred + 1
            if preferred + 1 in free
            else free[0]
            if free
            else min(range(1, 7), key=lambda value: counts[value])
        )
        slots[key] = slot
        counts[slot] += 1
    return slots
