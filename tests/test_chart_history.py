"""Server buckets keep outages, coverage, bounds and original rollups honest."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from computedeck.demo import demo_chart_history
from computedeck.history import chart_history
from computedeck.store import Store

END = datetime(2026, 1, 15, 14, 2, tzinfo=UTC)


def point(minutes: float, value: float | None = 8, **extra: Any) -> dict[str, Any]:
    return {
        "at": (END - timedelta(minutes=minutes)).isoformat(),
        "allocated_gpus": value,
        "gpu_utilization": value,
        "chart_coverage": {
            "allocation": {"known": 3, "total": 3},
            "utilization": {"known": 2, "total": 3},
            "intervals": [900, 900, 900],
        },
        **extra,
    }


def chart(points: list[dict[str, Any]], hours: int = 24) -> dict[str, Any]:
    return chart_history(points, hours, end=END, current=END)


@pytest.mark.parametrize(
    ("hours", "seconds", "count"), [(24, 300, 289), (168, 3600, 169), (720, 86400, 31)]
)
def test_resolved_bucket_edges_and_sizes(hours: int, seconds: int, count: int) -> None:
    result = chart([], hours)
    buckets = result["series"][0]["buckets"]
    assert result["bucket_seconds"] == seconds
    assert len(buckets) == count
    assert buckets[0]["start"] == (END - timedelta(hours=hours)).isoformat()
    assert buckets[-1]["end"] == END.isoformat()
    assert all(a["end"] == b["start"] for a, b in zip(buckets, buckets[1:], strict=False))
    assert all(b["value"] is None and b["samples"] == 0 for b in buckets)
    assert [b["so_far"] for b in buckets].count(True) == 1


def test_empty_bins_and_unknown_readings_are_not_zero_or_interpolated() -> None:
    result = chart([point(90), point(30, None), point(0, 0)])
    buckets = result["series"][1]["buckets"]
    assert [b["value"] for b in buckets if b["samples"]] == [8, 0]
    held = [b for b in buckets if b["held_from"] == point(90)["at"]]
    assert held and all(b["value"] == b["min"] == b["max"] == 8 for b in held)
    assert all(b["samples"] == 0 and b["held_from"] == point(90)["at"] for b in held)
    assert all(b["value"] is None for b in buckets if b["gap_reason"])
    unknown = next(b for b in buckets if b["gap_reason"] == {"code": "chart_unknown"})
    assert unknown["samples"] == 0
    assert any(b["held_from"] == point(30, None)["at"] and b["value"] is None for b in buckets)
    assert any(b["gap_reason"] == {"code": "chart_not_collecting"} for b in buckets)
    assert result["last_sample"] == END.isoformat()


def test_means_extrema_sample_counts_and_partial_bounds() -> None:
    samples = [
        point(1.5, 4),
        point(1, 8),
        point(0, None, known_allocated_gpus=6, unknown_allocation_sources=1),
    ]
    result = chart(samples)
    allocation = result["series"][1]["buckets"][-1]
    assert (allocation["value"], allocation["min"], allocation["max"]) == (6, 4, 8)
    assert allocation["samples"] == 3
    assert allocation["expected_samples"] == 1
    assert allocation["lower_bound"] is True
    assert allocation["partial"] is True
    # A mean of measured utilisation is not a lower bound on unmeasured GPUs.
    utilization = result["series"][0]["buckets"][-1]
    assert utilization["partial"] is True
    assert utilization["lower_bound"] is False
    assert (utilization["known_sources"], utilization["total_sources"]) == (2, 3)
    assert result["series"][1]["summary"]["partial"] == 1


def test_older_observations_do_not_invent_coverage_or_intervals() -> None:
    old = point(0, None, known_allocated_gpus=4)
    del old["chart_coverage"]
    bucket = chart([old])["series"][1]["buckets"][-1]
    assert bucket["known_sources"] is None
    assert bucket["total_sources"] is None
    assert bucket["expected_samples"] is None
    assert bucket["value"] == 4
    assert bucket["lower_bound"] is True


def test_expired_and_future_readings_do_not_enter_buckets_but_last_sample_is_kept() -> None:
    result = chart([point(1500), point(-1)])
    assert result["last_sample"] == point(1500)["at"]
    assert all(b["value"] is None for s in result["series"] for b in s["buckets"])


def test_stale_threshold_uses_recorded_collection_interval() -> None:
    slow = point(20)
    fast = point(20)
    fast["chart_coverage"]["intervals"] = [300]
    a = chart([slow])["series"][0]["buckets"][-1]
    b = chart([fast])["series"][0]["buckets"][-1]
    assert a["gap_reason"] is None
    assert a["value"] == a["min"] == a["max"] == 8
    assert a["samples"] == 0 and a["held_from"] == slow["at"]
    assert b["gap_reason"] == {"code": "chart_not_collecting"}


def test_historical_window_is_not_so_far() -> None:
    result = chart_history([point(60)], 24, end=END - timedelta(minutes=30), current=END)
    assert not any(b["so_far"] for s in result["series"] for b in s["buckets"])


def test_demo_contains_gap_unknown_partial_and_current_states(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COMPUTEDECK_DEMO_NOW", END.isoformat())
    result = chart(demo_chart_history(24, END))
    buckets = result["series"][1]["buckets"]
    assert any(b["gap_reason"] == {"code": "chart_unknown"} for b in buckets)
    assert any(b["gap_reason"] == {"code": "chart_not_collecting"} for b in buckets)
    assert any(b["lower_bound"] for b in buckets)
    assert buckets[-1]["so_far"]
    assert result == chart(demo_chart_history(24, END))


def test_demo_readings_are_stable_across_ranges_and_paging(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMPUTEDECK_DEMO_NOW", END.isoformat())
    first = {p["at"]: p for p in demo_chart_history(24, END)}
    earlier = demo_chart_history(24, END - timedelta(hours=12))
    assert all(first[p["at"]] == p for p in earlier if p["at"] in first)
    assert earlier[-1]["at"] in first


def test_new_history_coverage_excludes_old_ssh_metrics_and_counts_job_reporters() -> None:
    from computedeck.history import chart_observation

    source = {
        "id": "cluster-a",
        "enabled": True,
        "interval_minutes": 5,
        "status": "ready",
        "capabilities": ["jobs"],
        "last_success": END.isoformat(),
    }
    data = {
        "sources": [source],
        "jobs": [
            {
                "id": "job-a",
                "source_id": "cluster-a",
                "state": "RUNNING",
                "gpu_utilization": 30,
                "gpu_count": 2,
            }
        ],
        "instances": [
            {
                "id": "machine",
                "source_id": "manual",
                "state": "running",
                "manual": True,
                "monitoring": True,
                "ssh_status": "reachable",
                "observed_at": "2000-01-01T00:00:00Z",
                "gpu_utilization": 80,
                "gpu_count": 1,
            }
        ],
        "summary": {"unmeasured": [{"subject": {"id": "machine", "kind": "instance"}}]},
    }
    coverage = chart_observation(data)
    assert coverage["allocation"] == {"known": 1, "total": 2}
    assert coverage["utilization"] == {"known": 1, "total": 2}
    assert coverage["intervals"] == [300, 600]


@pytest.mark.parametrize(("hours", "cadence"), [(24, 600), (168, 3600)])
def test_regular_cadence_holds_between_collections(
    tmp_path: Path, hours: int, cadence: int
) -> None:
    start = END - timedelta(hours=hours)
    at = start.replace(minute=0, second=0, microsecond=0)
    samples = []
    while at <= END:
        sample = point(0)
        sample["at"] = at.isoformat()
        sample["chart_coverage"] = {
            "intervals": [cadence],
            "allocation": {"known": 1, "total": 1},
            "utilization": {"known": 1, "total": 1},
        }
        samples.append(sample)
        at += timedelta(seconds=cadence)
    store = Store(tmp_path / "history.sqlite")
    try:
        with store.db:
            store.db.executemany(
                "INSERT INTO history VALUES (?, ?)", [(p["at"], json.dumps(p)) for p in samples]
            )
        result = store.history_chart(hours, END, END)
    finally:
        store.db.close()
    for series in result["series"]:
        buckets = series["buckets"]
        assert all(b["value"] == 8 and b["gap_reason"] is None for b in buckets)
        held = [b for b in buckets if b["samples"] == 0]
        assert held
        assert all(b["held_from"] and b["min"] == b["max"] == 8 for b in held)
        assert all(b["held_from"] is None for b in buckets if b["samples"])
    assert not any(b["partial"] or b["lower_bound"] for b in result["series"][1]["buckets"])


def test_hold_expires_at_bucket_start_and_does_not_revive_an_unknown_value() -> None:
    sample = point(32, None, known_allocated_gpus=5, unknown_allocation_sources=1)
    sample["chart_coverage"]["intervals"] = [600]
    sample["chart_coverage"]["allocation"] = {"known": 2, "total": 3}
    result = chart([sample])
    for bucket in result["series"][1]["buckets"]:
        age = (
            datetime.fromisoformat(bucket["start"]) - datetime.fromisoformat(sample["at"])
        ).total_seconds()
        if 0 < age < 1200:
            assert bucket["held_from"] == sample["at"]
            assert bucket["samples"] == 0 and bucket["value"] == 5
            assert bucket["partial"] and bucket["lower_bound"]
            assert (bucket["known_sources"], bucket["total_sources"]) == (2, 3)
        elif age >= 1200:
            assert bucket["value"] is None and bucket["held_from"] is None
            assert bucket["gap_reason"] == {"code": "chart_not_collecting"}
    # The utilisation reading was unknown; holding never replaces it by zero.
    util = result["series"][0]["buckets"]
    assert all(b["value"] is None for b in util)
    assert any(b["held_from"] == sample["at"] and b["samples"] == 0 for b in util)
    assert any(b["gap_reason"] == {"code": "chart_unknown"} for b in util)


def test_expected_sample_shortfall_is_informational() -> None:
    samples = []
    for minute in [122, 112, 102, 92, 82]:
        sample = point(minute)
        sample["chart_coverage"] = {
            "intervals": [600],
            "allocation": {"known": 1, "total": 1},
            "utilization": {"known": 1, "total": 1},
        }
        samples.append(sample)
    bucket = next(b for b in chart(samples, 168)["series"][1]["buckets"] if b["samples"] == 5)
    assert bucket["expected_samples"] == 6
    assert not bucket["partial"] and not bucket["lower_bound"]


def test_hold_uses_legacy_threshold_without_inventing_source_coverage() -> None:
    sample = point(32, 0)
    del sample["chart_coverage"]
    buckets = chart([sample])["series"][1]["buckets"]
    held = [b for b in buckets if b["held_from"]]
    assert held and all(b["value"] == 0 and b["samples"] == 0 for b in held)
    assert all(b["known_sources"] is None and b["total_sources"] is None for b in held)
    assert buckets[-1]["gap_reason"] == {"code": "chart_not_collecting"}


@pytest.mark.parametrize("points", [[], [point(0, None)]])
def test_empty_summary_has_null_statistics(points: list[dict[str, Any]]) -> None:
    for series in chart(points)["series"]:
        summary = series["summary"]
        assert summary["code"] == "chart_empty_summary"
        assert summary["mean"] is summary["min"] is summary["max"] is None
        assert summary["lower_bound"] is False


def test_summary_rounds_utilization_and_marks_allocation_bounds() -> None:
    samples = [point(1, 44 + 1 / 3), point(0, None, known_allocated_gpus=55.59)]
    util, allocation = chart(samples)["series"]
    assert (util["summary"]["mean"], util["summary"]["min"], util["summary"]["max"]) == (
        44.3,
        44.3,
        44.3,
    )
    assert util["summary"]["lower_bound"] is False
    assert allocation["summary"]["lower_bound"] is True
    assert allocation["summary"]["max"] == 55.5


def test_demo_chart_starts_with_recorded_rollups(monkeypatch: pytest.MonkeyPatch) -> None:
    from computedeck.demo import demo_history

    monkeypatch.setenv("COMPUTEDECK_DEMO_NOW", END.isoformat())
    first_recorded = next(p["at"] for p in demo_history(720) if p.get("by_group"))
    points = demo_chart_history(720, END)
    assert points[0]["at"] == first_recorded
    assert all(p["at"] >= first_recorded for p in points)
    assert demo_chart_history(24, END - timedelta(days=11)) == []


def test_utilization_coverage_excludes_idle_cpu_and_same_node_sources() -> None:
    from computedeck.history import chart_observation

    source = {
        "enabled": True,
        "interval_minutes": 5,
        "status": "ready",
        "capabilities": ["jobs"],
        "last_success": END.isoformat(),
    }
    job = {
        "id": "job-a",
        "source_id": "active",
        "state": "RUNNING",
        "gpu_count": 2,
        "gpu_utilization": 30,
    }
    data = {
        "sources": [
            {**source, "id": name} for name in ("active", "idle", "cpu", "linked", "stopped")
        ],
        "jobs": [job, {**job, "id": "cpu-job", "source_id": "cpu", "gpu_count": 0}],
        "instances": [
            {
                "id": "linked-host",
                "source_id": "linked",
                "same_node": {"id": "node-a"},
                "gpu_count": 8,
                "state": "running",
            },
            {"id": "stopped-host", "source_id": "stopped", "gpu_count": 8, "state": "stopped"},
        ],
        "summary": {"unmeasured": []},
    }
    coverage = chart_observation(data, current=END)
    assert coverage["allocation"] == {"known": 5, "total": 5}
    assert coverage["utilization"] == {"known": 1, "total": 1}
    sample = point(0)
    sample["chart_coverage"] = coverage
    assert chart([sample])["series"][0]["buckets"][-1]["partial"] is False
    data["sources"].append({**source, "id": "failing", "status": "error"})
    data["instances"].append(
        {
            "id": "manual-machine",
            "source_id": "manual",
            "manual": True,
            "monitoring": True,
            "ssh_status": "error",
            "state": "unknown",
        }
    )
    data["summary"]["unmeasured"] = [
        {"subject": {"id": "failing", "kind": "source"}},
        {"subject": {"id": "manual-machine", "kind": "instance"}},
    ]
    coverage = chart_observation(data, current=END)
    assert coverage["allocation"] == {"known": 5, "total": 7}
    assert coverage["utilization"] == {"known": 1, "total": 3}
    sample["chart_coverage"] = coverage
    bucket = chart([sample])["series"][0]["buckets"][-1]
    assert (bucket["known_sources"], bucket["total_sources"]) == (1, 3)
    assert bucket["partial"] is True
    data["jobs"].append({**job, "id": "unmeasured", "source_id": "idle", "gpu_utilization": None})
    assert chart_observation(data, current=END)["utilization"] == {"known": 1, "total": 4}


def test_summary_counts_contiguous_gap_runs_and_their_duration() -> None:
    result = chart([point(120), point(60, None), point(0)])
    for series in result["series"]:
        # Gaps: window start at 14:02 to 12:00 next day, then 12:35 to 14:00.
        assert series["summary"]["gaps"] == 2
        assert series["summary"]["minutes"] == 1318 + 85


def test_demo_coverage_uses_dashboard_subjects_and_cadence(monkeypatch: pytest.MonkeyPatch) -> None:
    from computedeck.demo import dashboard
    from computedeck.history import chart_observation

    monkeypatch.setenv("COMPUTEDECK_DEMO_NOW", END.isoformat())
    coverage = chart_observation(dashboard(), current=END)
    points = demo_chart_history(24, END)
    for metric in ("allocation", "utilization"):
        assert all(
            p["chart_coverage"][metric]["total"] == coverage[metric]["total"] for p in points
        )
    assert all(p["chart_coverage"]["intervals"] == coverage["intervals"] for p in points)
    assert (
        datetime.fromisoformat(points[-1]["at"]) - datetime.fromisoformat(points[-2]["at"])
    ).total_seconds() == min(coverage["intervals"])
    utilization = chart(points)["series"][0]["buckets"]
    assert any(b["value"] is not None and not b["partial"] for b in utilization)
    assert any(b["value"] is not None and b["partial"] for b in utilization)


def test_usage_buckets_integrate_groups_and_keep_currencies_separate() -> None:
    sample = {
        "allocated": 6,
        "known_allocated": 6,
        "unknown_allocation_sources": 0,
        "spend": {"USD": 12, "EUR": 6},
        "spend_unknown": 0,
    }
    result = chart([point(12, by_group={"cluster-a": sample})])
    series = {s["id"]: s for s in result["usage_series"]}
    assert set(series) == {"gpu_hours:cluster-a", "money:USD", "money:EUR"}
    assert series["money:EUR"]["format"] == {"kind": "money", "currency": "EUR"}
    assert sum(b["value"] or 0 for b in series["gpu_hours:cluster-a"]["buckets"]) == pytest.approx(
        1.2
    )
    assert sum(b["value"] or 0 for b in series["money:USD"]["buckets"]) == pytest.approx(2.4)
    assert sum(b["value"] or 0 for b in series["money:EUR"]["buckets"]) == pytest.approx(1.2)
    assert [b["start"] for b in series["money:USD"]["buckets"]] == [
        b["start"] for b in result["series"][0]["buckets"]
    ]
    assert series["money:USD"]["buckets"][0]["value"] is None


def test_usage_partial_values_remain_bounds_and_long_outages_remain_gaps() -> None:
    sample = {
        "allocated": None,
        "known_allocated": 2,
        "unknown_allocation_sources": 1,
        "spend": {"USD": 4},
        "spend_unknown": 1,
    }
    result = chart([point(90, by_group={"cluster-a": sample})])
    for series in result["usage_series"]:
        known = [b for b in series["buckets"] if b["value"] is not None]
        assert known and all(b["lower_bound"] and b["partial"] for b in known)
        assert series["buckets"][-1]["value"] is None
        assert series["buckets"][-1]["gap_reason"]


def test_demo_exposes_group_and_currency_integrals_with_unknowns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COMPUTEDECK_DEMO_NOW", END.isoformat())
    result = chart(demo_chart_history(24, END))
    series = result["usage_series"]
    assert {s["format"]["kind"] for s in series} == {"gpu_hours", "money"}
    assert any(b["lower_bound"] for s in series for b in s["buckets"])
    assert any(b["value"] is None for s in series for b in s["buckets"])
