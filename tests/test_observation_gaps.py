"""Missing observations are explicit, without changing lifecycle or Notify delivery."""

import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from computedeck import collector as collector_module
from computedeck import events, sdk
from computedeck.collector import Collector
from computedeck.drivers.base import Batch
from computedeck.plugins import Runtime
from computedeck.store import Store
from computedeck.tools import notify

AT = datetime.now(UTC).replace(microsecond=0)
SOURCE = {
    "id": "cluster-a-alice",
    "name": "Cluster A",
    "cluster_id": "cluster-a",
    "driver": "slurm",
    "username": "alice",
    "interval_minutes": 10,
    "last_success": (AT - timedelta(hours=30)).isoformat(),
}


def collect_gap(monkeypatch: pytest.MonkeyPatch, **changes: Any) -> list[dict[str, Any]]:
    monkeypatch.setattr(events, "now", lambda: AT.isoformat())
    return events.collected(
        {**SOURCE, **changes},
        {"lifecycle_pending": []},
        Batch(jobs=[], capabilities=["jobs", "history"], history_window_seconds=86400),
        first=False,
    )


def test_source_gap_bounds_context_and_deduplication(
    monkeypatch: pytest.MonkeyPatch, store: Store
) -> None:
    rows = collect_gap(monkeypatch)
    assert len(rows) == 1
    gap = rows[0]
    assert gap["key"] == f"source.gap:{SOURCE['id']}:{SOURCE['last_success']}"
    assert gap["type"] == "source.gap" and not gap.get("silent")
    assert gap["at"] == AT.isoformat()
    assert gap["source_id"] == SOURCE["id"]
    assert gap["data"] == {
        "source_name": "Cluster A",
        "cluster_id": "cluster-a",
        "driver": "slurm",
        "username": "alice",
        "unobserved_from": SOURCE["last_success"],
        "unobserved_to": AT.isoformat(),
        "failures_checked_from": (AT - timedelta(hours=24)).isoformat(),
    }
    assert store.add_events(rows) == 1
    assert store.add_events(collect_gap(monkeypatch)) == 0
    assert len(store.recent_events()) == 1


@pytest.mark.parametrize("minutes,interval", [(10, 10), (1380, 10), (1445, 1440)])
def test_short_gap_and_daily_scheduling_stay_quiet(
    monkeypatch: pytest.MonkeyPatch, minutes: int, interval: int
) -> None:
    assert (
        collect_gap(
            monkeypatch,
            last_success=(AT - timedelta(minutes=minutes)).isoformat(),
            interval_minutes=interval,
        )
        == []
    )


def test_near_window_gap_does_not_claim_missing_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    [gap] = collect_gap(monkeypatch, last_success=(AT - timedelta(minutes=1430)).isoformat())
    assert gap["data"]["failures_checked_from"] < gap["data"]["unobserved_from"]


@pytest.mark.parametrize("seconds", [1205, 3500, 3700])
def test_short_known_window_keeps_the_unknown_window_floor(
    monkeypatch: pytest.MonkeyPatch, seconds: int
) -> None:
    monkeypatch.setattr(events, "now", lambda: AT.isoformat())
    rows = events.collected(
        {**SOURCE, "last_success": (AT - timedelta(seconds=seconds)).isoformat()},
        {"lifecycle_pending": []},
        Batch(jobs=[], capabilities=["jobs", "history"], history_window_seconds=3600),
        first=False,
    )
    if seconds <= 3600:
        assert rows == []
    else:
        [gap] = rows
        assert gap["type"] == "source.gap"
        assert gap["data"]["failures_checked_from"] == (AT - timedelta(seconds=3600)).isoformat()
        assert gap["data"]["failures_checked_from"] > gap["data"]["unobserved_from"]


@pytest.mark.parametrize("capabilities,window", [(["jobs"], 86400), (["jobs", "history"], None)])
def test_unknown_or_unavailable_history_has_no_checked_bound(
    monkeypatch: pytest.MonkeyPatch, capabilities: list[str], window: int | None
) -> None:
    monkeypatch.setattr(events, "now", lambda: AT.isoformat())
    batch = Batch(jobs=[], capabilities=capabilities, history_window_seconds=window)
    source = {**SOURCE, "capabilities_seen": ["jobs", "history"], "history_window_seconds": 86400}
    [gap] = events.collected(source, {}, batch, first=False)
    assert gap["data"]["failures_checked_from"] is None
    for minutes in (20, 60):
        assert (
            events.collected(
                {**source, "last_success": (AT - timedelta(minutes=minutes)).isoformat()},
                {},
                batch,
                first=False,
            )
            == []
        )
    assert events.collected(source, {}, batch, first=True) == []
    assert events.collected({**source, "last_success": None}, {}, batch, first=False) == []


@pytest.mark.parametrize("capabilities", [["instances"], ["nodes"], []])
def test_non_job_sources_have_no_gap(capabilities: list[str]) -> None:
    assert events.collected(SOURCE, {}, Batch(capabilities=capabilities), first=False) == []


def runtime(store: Store, tmp_path: Path) -> Runtime:
    value = Runtime(tmp_path)
    value.store = store
    return value


def test_heartbeat_startup_tick_restart_and_write_frequency(
    monkeypatch: pytest.MonkeyPatch, store: Store, tmp_path: Path
) -> None:
    collector = Collector(runtime(store, tmp_path))
    clock = AT
    monkeypatch.setattr(collector_module, "now", lambda: clock.isoformat())
    collector._schedule()
    assert store._meta("service:alive_at") == AT.isoformat()
    assert store.recent_events() == []
    clock += timedelta(seconds=59)
    collector._schedule()
    assert store._meta("service:alive_at") == AT.isoformat()
    clock += timedelta(seconds=1)
    collector._schedule()
    assert store._meta("service:alive_at") == clock.isoformat()
    previous = clock.isoformat()
    clock += timedelta(seconds=300)
    collector._schedule()
    assert store.recent_events() == []  # strictly longer than five minutes
    previous = clock.isoformat()
    clock += timedelta(hours=48)
    collector = Collector(runtime(store, tmp_path))
    collector._schedule()  # first tick after a restart
    [gap] = store.recent_events()
    assert gap["type"] == "service.gap"
    assert gap["source_id"] is None
    assert gap["key"] == f"service.gap:{previous}"
    assert gap["data"] == {"from": previous, "to": clock.isoformat()}
    assert store.service_gap() == gap["data"]
    collector._schedule()
    assert len(store.recent_events()) == 1
    previous = clock.isoformat()
    clock += timedelta(seconds=301)
    collector._schedule()  # a wall-clock jump in the same process
    assert len(store.recent_events()) == 2
    assert store.service_gap()["from"] == previous


def test_heartbeat_backwards_clock_rewrites_without_a_gap(store: Store) -> None:
    assert store.record_heartbeat(AT.isoformat()) is None
    earlier = (AT - timedelta(seconds=30)).isoformat()
    assert store.record_heartbeat(earlier) is None
    assert store._meta("service:alive_at") == earlier
    assert store.service_gap() is None
    assert store.recent_events() == []


def test_heartbeat_gap_and_metadata_roll_back_together(store: Store) -> None:
    store.record_heartbeat(AT.isoformat())
    resumed = (AT + timedelta(seconds=301)).isoformat()
    # Fail the last write, after the gap event and last-gap metadata were inserted.
    store.db.execute(
        "CREATE TEMP TRIGGER reject_heartbeat BEFORE INSERT ON meta "
        "WHEN NEW.key = 'service:alive_at' BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="test failure"):
        store.record_heartbeat(resumed)
    assert store._meta("service:alive_at") == AT.isoformat()
    assert store.service_gap() is None
    assert store.recent_events() == []
    store.db.execute("DROP TRIGGER reject_heartbeat")
    gap = store.record_heartbeat(resumed)
    assert gap == {"from": AT.isoformat(), "to": resumed}
    assert store.service_gap() == gap
    assert store._meta("service:alive_at") == resumed
    assert [row["data"] for row in store.recent_events()] == [gap]
    assert store.record_heartbeat(resumed) is None
    assert len(store.recent_events()) == 1


@pytest.mark.parametrize("covered", [True, False])
async def test_collector_suppresses_only_source_gaps_covered_by_service_gap(
    monkeypatch: pytest.MonkeyPatch,
    store: Store,
    tmp_path: Path,
    add_source: Callable[..., dict[str, Any]],
    covered: bool,
) -> None:
    source = add_source(last_success=(AT - timedelta(hours=48)).isoformat())
    collector = Collector(runtime(store, tmp_path))
    monkeypatch.setattr(collector_module, "now", lambda: AT.isoformat())
    monkeypatch.setattr(events, "now", lambda: AT.isoformat())
    store.record_heartbeat((AT - timedelta(hours=48 if covered else 2, minutes=-5)).isoformat())
    collector._heartbeat()

    async def batch(_: dict[str, Any]) -> Batch:
        return Batch(jobs=[], capabilities=["jobs", "history"], history_window_seconds=86400)

    monkeypatch.setattr(collector, "_batch", batch)
    await collector.collect(source["id"])
    kinds = [row["type"] for row in store.recent_events()]
    assert kinds.count("service.gap") == 1
    assert kinds.count("source.gap") == (0 if covered else 1)
    assert store.source(source["id"])["history_window_seconds"] == 86400
    await collector.collect(source["id"])
    assert [row["type"] for row in store.recent_events()] == kinds


def test_old_service_gap_does_not_hide_later_source_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(events, "now", lambda: AT.isoformat())
    [gap] = events.collected(
        SOURCE,
        {},
        Batch(capabilities=["jobs"]),
        first=False,
        service_gap={
            "from": SOURCE["last_success"],
            "to": (AT - timedelta(hours=29)).isoformat(),
        },
    )
    assert gap["type"] == "source.gap"


@pytest.mark.parametrize("kind", events.GAP_TYPES)
def test_gaps_require_named_handlers_and_are_refused_by_notify(kind: str) -> None:
    event = {"type": kind, "data": {}}
    assert kind not in events.TYPES
    assert kind not in sdk.EVENT_TYPES
    assert events.for_handler(event, None) is None
    assert events.for_handler(event, frozenset(["source.failed"])) is None
    assert events.for_handler(event, frozenset([kind])) == event
    with pytest.raises(ValueError, match="event_type_unknown"):
        notify.check_rule(notify.RuleInput(name="Gaps", events=[kind], channels=["team"]), {"team"})


def test_batch_window_is_optional_and_not_snapshot_data() -> None:
    assert Batch().history_window_seconds is None
    assert "history_window_seconds" not in Batch(history_window_seconds=86400).snapshot()
    for invalid in (-1, True, 1.5, "86400"):
        with pytest.raises(ValueError):
            Batch(history_window_seconds=invalid)
