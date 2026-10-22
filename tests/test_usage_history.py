"""Observed integrals use raw samples and preserve missing time and currencies."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from computedeck.demo import dashboard, demo_history
from computedeck.history import HOLD_SECONDS, group_history, rollup_history
from computedeck.store import Store

END = datetime(2026, 1, 2, tzinfo=UTC)


def point(
    minutes: float, allocated: int | None = 4, known: int | None = 4, **extra: Any
) -> dict[str, Any]:
    return {
        "at": (END - timedelta(minutes=minutes)).isoformat(),
        "by_group": {
            "cluster-a": {
                "allocated": allocated,
                "known_allocated": known,
                "unknown_allocation_sources": int(allocated is None),
                "spend": {"USD": 2, "EUR": 3},
                "spend_unknown": 0,
                **extra,
            }
        },
    }


def test_integrates_changes_across_hours_without_mixing_currencies() -> None:
    result = rollup_history([point(75), point(60, 8), point(30, 2)], 2, end=END)
    first, second = [b["groups"]["cluster-a"] for b in result["buckets"]]
    assert first["gpu_hours"] == 1
    assert first["observed_seconds"] == 900
    assert first["gpu_partial"]
    assert second["gpu_hours"] == 5
    assert second["spend"] == {"USD": 2, "EUR": 3}
    assert second["observed_seconds"] == 3600
    assert not second["gpu_partial"]


def test_gap_preupgrade_and_unknown_are_not_zero_filled() -> None:
    old = {"at": (END - timedelta(hours=4)).isoformat(), "allocated_gpus": 99}
    result = rollup_history(
        [old, point(120), point(30, None, None, spend={}, spend_unknown=1)], 4, end=END
    )
    buckets = result["buckets"]
    assert buckets[0]["groups"] == buckets[1]["groups"] == {}
    assert buckets[0]["observed_seconds"] == 0
    partial = buckets[2]["groups"]["cluster-a"]
    assert partial["gpu_hours"] == 2  # Only 30 minutes held through the gap.
    assert partial["observed_seconds"] == 1800
    unknown = buckets[3]["groups"]["cluster-a"]
    assert unknown["gpu_hours"] is None
    assert unknown["spend"] == {}
    assert unknown["gpu_partial"] and unknown["spend_partial"]
    assert not unknown["spend_known"]


def test_lower_bounds_and_range_boundary_carry() -> None:
    result = rollup_history(
        [point(65, None, 3, spend_unknown=1), point(40, 4), point(10, 4)], 1, end=END
    )
    group = result["buckets"][0]["groups"]["cluster-a"]
    assert group["gpu_hours"] == pytest.approx(3 * 20 / 60 + 4 * 40 / 60)
    assert group["observed_seconds"] == 3600
    assert group["gpu_partial"] and group["spend_partial"]
    assert HOLD_SECONDS == 1800


def test_store_rollups_use_unthinned_samples_and_history_omits_groups(store: Store) -> None:
    current = datetime.now(UTC)
    rows = []
    for index in range(1201):
        row = point(0, 1 if index % 2 else 9)
        row["at"] = (current - timedelta(seconds=1200 - index)).isoformat()
        rows.append((row["at"], json.dumps(row)))
    with store.db:
        store.db.executemany("INSERT INTO history VALUES (?, ?)", rows)
    assert len(store.history(1)) <= 600
    assert all("by_group" not in p for p in store.history(1))
    result = store.history_rollups(1)
    gpu_hours = sum(b["groups"].get("cluster-a", {}).get("gpu_hours", 0) for b in result["buckets"])
    assert gpu_hours == pytest.approx(6000 / 3600, abs=0.01)
    assert all("by_group" not in p for p in store.dashboard()["history"])


def test_records_group_summary_and_keeps_thirty_days(store: Store) -> None:
    current = datetime.now(UTC)
    with store.db:
        for days in (10, 31):
            at = (current - timedelta(days=days)).isoformat()
            store.db.execute("INSERT INTO history VALUES (?, ?)", (at, json.dumps({"at": at})))
    store.record_history()
    raw = [json.loads(row[0]) for row in store.db.execute("SELECT data FROM history ORDER BY at")]
    assert len(raw) == 2
    assert raw[-1]["by_group"] == group_history(store.dashboard()["summary"])
    assert (current - datetime.fromisoformat(raw[0]["at"])).days == 10


def test_demo_exercises_missing_days() -> None:
    assert "by_group" not in dashboard()["history"][-1]
    trace = demo_history(720)
    assert "by_group" not in trace[0]
    assert trace[-1]["by_group"] == group_history(dashboard()["summary"])


def test_hold_cap_is_identical_across_ranges() -> None:
    # Successive gaps of 40 minutes and two hours must never gain coverage on zoom-out.
    points = [point(200), point(160, 8), point(40, None, 2, spend_unknown=1), point(10)]
    results = [rollup_history(points, hours, end=END) for hours in (24, 168, 720)]
    overlap = results[0]["buckets"]
    assert results[1]["buckets"][-24:] == overlap
    assert results[2]["buckets"][-24:] == overlap
    assert sum(bucket["observed_seconds"] for bucket in overlap) == 100 * 60
    groups = [bucket["groups"]["cluster-a"] for bucket in overlap if bucket["groups"]]
    assert sum(group["gpu_hours"] for group in groups) == pytest.approx(23 / 3)
    assert sum(group["spend"]["USD"] for group in groups) == pytest.approx(10 / 3)
    assert any(group["gpu_partial"] and group["spend_partial"] for group in groups)
