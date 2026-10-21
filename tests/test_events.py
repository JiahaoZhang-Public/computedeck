"""Events between collections: recorded once, silent on the first collection, delivered in order."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from computedeck import events
from computedeck.collector import Collector
from computedeck.drivers.base import Batch, SourceError
from computedeck.drivers.slurm import SlurmDriver
from computedeck.plugins import Plugin, PluginContext, Runtime, deliver
from computedeck.store import Store

AddSource = Callable[..., dict[str, Any]]


def job(job_id: str, state: str) -> dict[str, Any]:
    return {
        "id": f"cluster-a:{job_id}",
        "source_id": "cluster-a-alice",
        "state": state,
        "name": f"job-{job_id}",
        "gpu_count": 1,
    }


def failure(job_id: str) -> dict[str, Any]:
    return {**job(job_id, "FAILED"), "exit_code": "1:0", "end": "2026-01-01T00:00:00"}


SOURCE = {"id": "cluster-a-alice", "name": "Cluster A", "cluster_id": "cluster-a"}


def kinds(rows: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Type and key; a job.started key ends with when it was seen, left out here."""
    return [(row["type"], row["key"].removesuffix(":" + row["at"])) for row in rows]


def test_first_collection_records_existing_failures_silently() -> None:
    rows = events.collected(SOURCE, None, Batch(jobs=[], failures=[failure("9")]), first=True)
    assert kinds(rows) == [("job.finished", "job.finished:cluster-a:9:2026-01-01T00:00:00")]
    assert rows[0]["silent"] is True


def test_jobs_that_start_or_leave_the_queue_are_reported() -> None:
    old = {
        "jobs": [job("1", "PENDING"), job("2", "RUNNING"), job("3", "PENDING")],
        "lifecycle_pending": [],
    }
    batch = Batch(jobs=[job("1", "RUNNING"), job("3", "PENDING")], failures=[failure("2")])
    rows = events.collected(SOURCE, old, batch, first=False)
    assert kinds(rows) == [
        ("job.started", "job.started:cluster-a:1"),
        ("job.finished", "job.finished:cluster-a:2:2026-01-01T00:00:00"),
    ]
    assert not any(row.get("silent") for row in rows)
    assert rows[1]["data"]["job"]["name"] == "job-2"
    assert rows[1]["data"]["source_name"] == "Cluster A"


def test_jobs_not_collected_are_not_reported_as_ended() -> None:
    old = {"jobs": [job("1", "RUNNING")]}
    # The job list was not collected this time: nothing can be said to have ended.
    assert events.collected(SOURCE, old, Batch(jobs=None), first=False) == []


def test_source_failure_and_recovery_are_reported_on_change_only() -> None:
    working = {**SOURCE, "last_success": "2026-01-01T00:00:00+00:00", "status_before": "ready"}
    assert [row["type"] for row in events.failed(working, {"code": "timeout"})] == ["source.failed"]
    # Already failing, or never worked: no new event.
    assert events.failed({**working, "status_before": "error"}, {"code": "timeout"}) == []
    assert events.failed({**SOURCE, "status_before": "ready"}, {"code": "timeout"}) == []
    recovered = events.collected({**working, "status_before": "error"}, None, Batch(), first=False)
    assert [row["type"] for row in recovered] == ["source.recovered"]


def test_store_keeps_each_event_once_and_lists_recent_ones(store: Store) -> None:
    rows = [
        {"key": "a", "type": "job.failed", "data": {"n": 1}},
        {"key": "b", "type": "job.ended", "silent": True},
        {"key": "c", "type": "job.started"},
    ]
    assert store.add_events(rows) == 3
    assert store.add_events(rows) == 0
    assert [row["key"] for row in store.events()] == ["a", "b", "c"]
    assert [row["key"] for row in store.recent_events()] == ["c", "a"]
    assert store.recent_events(1)[0]["key"] == "c"
    assert store.last_event_id() == 3


async def test_collector_records_events_between_collections(
    monkeypatch: pytest.MonkeyPatch, store: Store, add_source: AddSource, tmp_path: Path
) -> None:
    source = add_source(fresh=False)
    runtime = Runtime(tmp_path)
    runtime.store = store
    collector = Collector(runtime)
    batches = [
        Batch(jobs=[job("1", "PENDING")], failures=[failure("0")], capabilities=["jobs"]),
        Batch(jobs=[job("1", "RUNNING")], failures=[failure("0")], capabilities=["jobs"]),
        SourceError("timeout"),
        Batch(jobs=[], failures=[failure("0"), failure("1")], capabilities=["jobs"]),
    ]

    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        result = batches.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    for _ in range(4):
        await collector.collect(source["id"])
    assert [(row["type"], row["silent"]) for row in store.events()] == [
        ("job.finished", True),
        ("job.started", False),
        ("source.failed", False),
        ("job.finished", False),
        ("source.recovered", False),
    ]


async def test_delivery_follows_a_cursor_and_survives_a_bad_handler(
    store: Store, tmp_path: Path
) -> None:
    runtime = Runtime(tmp_path)
    runtime.store = store
    store.add_events([{"key": "before", "type": "job.failed"}])
    context = PluginContext(Plugin("watcher", lambda ctx: None), runtime)
    seen: list[str] = []

    async def handle(event: dict[str, Any]) -> None:
        if event["key"] == "bad":
            raise RuntimeError("boom")
        seen.append(event["key"])

    context.on_event(handle, ["job.failed"])
    task = asyncio.create_task(deliver(context, poll=0.01))
    await asyncio.sleep(0.05)
    store.add_events(
        [
            {"key": "bad", "type": "job.failed"},
            {"key": "quiet", "type": "job.failed", "silent": True},
            {"key": "other", "type": "job.started"},
            {"key": "after", "type": "job.failed"},
        ]
    )
    await asyncio.sleep(0.1)
    task.cancel()
    # Events from before the plugin first ran are not a backlog to deliver.
    assert seen == ["after"]
    assert "watcher:events" in runtime.loop_errors
    assert store.plugin_cursor("watcher") == store.last_event_id()


def test_a_configuring_job_has_started() -> None:
    old = {"jobs": [job("1", "PENDING")]}
    rows = events.collected(SOURCE, old, Batch(jobs=[job("1", "CONFIGURING")]), first=False)
    assert [row["type"] for row in rows] == ["job.started"]


def test_a_requeued_job_starts_and_fails_again() -> None:
    first = events.collected(
        SOURCE, {"jobs": [job("1", "PENDING")]}, Batch(jobs=[job("1", "RUNNING")]), first=False
    )
    again = events.collected(
        SOURCE, {"jobs": [job("1", "PENDING")]}, Batch(jobs=[job("1", "RUNNING")]), first=False
    )
    # Each start is keyed by when it was seen, so a second run is not taken for the first.
    assert [row["key"] for row in (*first, *again)] == [
        f"job.started:cluster-a:1:{row['at']}" for row in (*first, *again)
    ]
    later = {**failure("1"), "end": "2026-01-01T05:00:00"}
    keys = {
        row["key"]
        for batch in (Batch(jobs=[], failures=[failure("1")]), Batch(jobs=[], failures=[later]))
        for row in events.collected(SOURCE, None, batch, first=False)
    }
    assert len(keys) == 2


def test_the_first_collection_after_array_ids_does_not_end_running_elements() -> None:
    # A snapshot from 0.2 named a running array element by its own job id.
    old = {"jobs": [{**job("1240", "RUNNING"), "name": "sweep"}]}
    batch = Batch(jobs=[{**job("1234_7", "RUNNING"), "name": "sweep"}])
    rows = events.collected(SOURCE, old, batch, first=False)
    assert not [row for row in rows if row["type"] == "job.finished"]
    # Afterwards an element that leaves the queue is reported as usual.
    later = events.collected(SOURCE, {"jobs": batch.jobs}, Batch(jobs=[]), first=False)
    assert [row["type"] for row in later] == ["job.finished"]


def test_departure_waits_once_then_reports_unknown_and_ignores_late_accounting() -> None:
    old = {"jobs": [job("1", "RUNNING")], "lifecycle_pending": []}
    batch = Batch(jobs=[], finished=[], capabilities=["history"])
    assert events.collected(SOURCE, old, batch, first=False) == []
    assert batch.snapshot()["lifecycle_pending"] == old["jobs"]
    assert "finished" not in batch.snapshot()
    next_batch = Batch(jobs=[], finished=[], capabilities=["history"])
    rows = events.collected(SOURCE, batch.snapshot(), next_batch, first=False)
    assert len(rows) == 1 and rows[0]["data"]["outcome"] == "unknown"
    assert rows[0]["data"]["outcome_reason"] == "outcome_not_reported"
    late = Batch(jobs=[], finished=[failure("1")], capabilities=["history"])
    assert events.collected(SOURCE, next_batch.snapshot(), late, first=False) == []


def test_delayed_accounting_replaces_the_held_departure() -> None:
    first = Batch(jobs=[], finished=[], capabilities=["history"])
    events.collected(
        SOURCE, {"jobs": [job("1", "RUNNING")], "lifecycle_pending": []}, first, first=False
    )
    second = Batch(jobs=[], finished=[failure("1")], capabilities=["history"])
    rows = events.collected(SOURCE, first.snapshot(), second, first=False)
    assert len(rows) == 1 and rows[0]["data"]["outcome"] == "failed"
    assert second.lifecycle_pending == []


def test_no_history_reports_unknown_immediately() -> None:
    rows = events.collected(
        SOURCE,
        {"jobs": [job("1", "RUNNING")], "lifecycle_pending": []},
        Batch(jobs=[]),
        first=False,
    )
    assert len(rows) == 1 and not rows[0]["silent"]
    assert rows[0]["data"]["outcome_reason"] == "outcomes_unavailable"
    assert rows[0]["data"]["ended_at"] is None
    assert rows[0]["at"] == rows[0]["data"]["observed_at"]


def test_history_only_short_job_uses_its_own_time_and_deduplicates(store: Store) -> None:
    end = events.now()
    terminal = {**job("2", "COMPLETED"), "end": end, "exit_code": "0:0"}
    batch = Batch(jobs=[], finished=[terminal], capabilities=["history"])
    rows = events.collected(SOURCE, {"jobs": [], "lifecycle_pending": []}, batch, first=False)
    assert len(rows) == 1 and rows[0]["at"] == end
    assert rows[0]["data"]["outcome"] == "completed"
    assert store.add_events(rows) == 1
    assert store.add_events(rows) == 0
    assert events.collected(SOURCE, batch.snapshot(), batch, first=False) == []


def test_upgrade_records_terminal_history_silently() -> None:
    batch = Batch(jobs=[], finished=[failure("1")])
    rows = events.collected(SOURCE, {"jobs": [job("1", "RUNNING")]}, batch, first=False)
    assert len(rows) == 1 and rows[0]["silent"]
    assert "lifecycle_pending" in batch.snapshot()


def test_gap_delivers_only_failure_outcomes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(events, "now", lambda: "2026-01-02T12:00:00+00:00")
    source = {**SOURCE, "last_success": "2026-01-01T12:00:00+00:00", "interval_minutes": 10}
    rows = events.collected(
        source,
        {"lifecycle_pending": []},
        Batch(
            jobs=[],
            finished=[
                {**job(str(index), outcome.upper()), "end": "2026-01-02T11:00:00+00:00"}
                for index, outcome in enumerate(events.OUTCOMES)
            ],
        ),
        first=False,
    )
    assert len(rows) == len(events.OUTCOMES)
    assert all(
        row["silent"] == (row["data"]["outcome"] not in events.FAILURE_OUTCOMES) for row in rows
    )
    assert not events.after_gap(
        {**source, "last_success": "2026-01-02T11:40:00+00:00"}, events.now()
    )


def test_first_seen_running_uses_start_time() -> None:
    start = "2026-01-01T12:00:00+04:00"
    rows = events.collected(
        SOURCE,
        {"jobs": [], "lifecycle_pending": []},
        Batch(jobs=[{**job("1", "RUNNING"), "started_at": start}]),
        first=False,
    )
    assert len(rows) == 1 and rows[0]["type"] == "job.started"
    assert rows[0]["at"] == rows[0]["data"]["started_at"] == start


def test_finished_rows_are_validated() -> None:
    with pytest.raises(ValueError, match="state"):
        Batch(finished=[{"id": "1", "source_id": SOURCE["id"]}]).validate_rows()


def test_old_accounting_does_not_resolve_a_requeued_attempt() -> None:
    old = {
        "jobs": [{**job("1", "RUNNING"), "started_at": "2026-01-01T10:00:00+00:00"}],
        "lifecycle_pending": [],
    }
    stale = {**failure("1"), "end": "2026-01-01T09:00:00+00:00"}
    first = Batch(jobs=[], finished=[stale], capabilities=["history"])
    assert events.collected(SOURCE, old, first, first=False) == []
    assert first.lifecycle_pending == old["jobs"]
    second = Batch(
        jobs=[], finished=[{**stale, "end": "2026-01-01T11:00:00+00:00"}], capabilities=["history"]
    )
    rows = events.collected(SOURCE, first.snapshot(), second, first=False)
    assert len(rows) == 1 and rows[0]["data"]["ended_at"] == "2026-01-01T11:00:00+00:00"


def test_accounted_completing_job_has_only_one_ending_after_departure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    completing = job("7", "COMPLETING")
    old = {"jobs": [completing], "lifecycle_pending": []}
    terminal = {**job("7", "COMPLETED"), "end": "2026-01-01T12:00:00+00:00"}
    rows = []
    for at, batch in [
        (
            "2026-01-01T12:01:00+00:00",
            Batch(jobs=[completing], finished=[terminal], capabilities=["history"]),
        ),
        ("2026-01-01T12:20:00+00:00", Batch(jobs=[], finished=[], capabilities=["history"])),
        ("2026-01-01T12:30:00+00:00", Batch(jobs=[], finished=[], capabilities=["history"])),
    ]:
        monkeypatch.setattr(events, "now", lambda at=at: at)
        rows.extend(events.collected(SOURCE, old, batch, first=False))
        assert batch.lifecycle_pending == []
        old = batch.snapshot()
    endings = [row for row in rows if row["type"] == "job.finished"]
    assert len(endings) == 1
    assert endings[0]["data"]["outcome"] == "completed"
    # An explicit terminal row without an end cannot announce the same ending again.
    assert (
        events.collected(
            SOURCE,
            old,
            Batch(jobs=[], finished=[{**job("7", "UNKNOWN"), "end": None}]),
            first=False,
        )
        == []
    )


def test_history_failure_holds_departure_until_accounting_recovers() -> None:
    source = {**SOURCE, "capabilities": ["jobs", "history"]}
    old = {"jobs": [job("7", "RUNNING")], "lifecycle_pending": []}
    unavailable = Batch(jobs=[], capabilities=["jobs"], warnings=[{"code": "history_unavailable"}])
    assert events.collected(source, old, unavailable, first=False) == []
    assert unavailable.lifecycle_pending == old["jobs"]
    recovered = Batch(
        jobs=[],
        finished=[{**job("7", "COMPLETED"), "end": events.now()}],
        capabilities=["jobs", "history"],
    )
    rows = events.collected(
        {**source, "capabilities": unavailable.capabilities},
        unavailable.snapshot(),
        recovered,
        first=False,
    )
    assert len(rows) == 1 and rows[0]["data"]["outcome"] == "completed"
    assert rows[0]["data"]["outcome_reason"] is None
    assert recovered.lifecycle_pending == []


def test_history_failure_still_explains_unknown_after_one_held_collection() -> None:
    source = {**SOURCE, "capabilities": ["history"]}
    unavailable = Batch(jobs=[], warnings=[{"code": "history_unavailable"}])
    assert (
        events.collected(
            source,
            {"jobs": [job("7", "RUNNING")], "lifecycle_pending": []},
            unavailable,
            first=False,
        )
        == []
    )
    rows = events.collected(
        {**source, "capabilities": []}, unavailable.snapshot(), Batch(jobs=[]), first=False
    )
    assert len(rows) == 1 and rows[0]["data"]["outcome"] == "unknown"
    assert rows[0]["data"]["outcome_reason"] == "outcome_not_reported"
