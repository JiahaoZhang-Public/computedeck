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
    assert kinds(rows) == [("job.failed", "job.failed:cluster-a:9:2026-01-01T00:00:00")]
    assert rows[0]["silent"] is True


def test_jobs_that_start_or_leave_the_queue_are_reported() -> None:
    old = {"jobs": [job("1", "PENDING"), job("2", "RUNNING"), job("3", "PENDING")]}
    batch = Batch(jobs=[job("1", "RUNNING"), job("3", "PENDING")], failures=[failure("2")])
    rows = events.collected(SOURCE, old, batch, first=False)
    assert kinds(rows) == [
        ("job.failed", "job.failed:cluster-a:2:2026-01-01T00:00:00"),
        ("job.started", "job.started:cluster-a:1"),
        ("job.ended", "job.ended:cluster-a:2"),
    ]
    assert not any(row.get("silent") for row in rows)
    assert rows[2]["data"]["job"]["name"] == "job-2"
    assert rows[2]["data"]["source_name"] == "Cluster A"


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
        ("job.failed", True),
        ("job.started", False),
        ("source.failed", False),
        ("job.failed", False),
        ("job.ended", False),
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
    assert not [row for row in rows if row["type"] == "job.ended"]
    # Afterwards an element that leaves the queue is reported as usual.
    later = events.collected(SOURCE, {"jobs": batch.jobs}, Batch(jobs=[]), first=False)
    assert [row["type"] for row in later] == ["job.ended"]
