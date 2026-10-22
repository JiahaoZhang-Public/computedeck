"""Background collection and probes: commit only good results, never resurrect old settings."""

import asyncio
import sqlite3
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from computedeck import collector as collector_module
from computedeck.collector import Collector, ProbeConflict
from computedeck.drivers import cloud
from computedeck.drivers.base import Batch, SourceError, message
from computedeck.drivers.slurm import SlurmDriver
from computedeck.plugins import Runtime
from computedeck.records import InstanceInput, instance_record
from computedeck.store import Store, gpu_allocation, now

AddSource = Callable[..., dict[str, Any]]
Collect = Callable[[dict[str, Any]], Any]


@pytest.fixture
def runtime(tmp_path: Path, store: Store) -> Runtime:
    value = Runtime(tmp_path)
    value.store = store
    return value


@pytest.fixture
def collector(runtime: Runtime) -> Collector:
    return Collector(runtime)


def use_driver(monkeypatch: pytest.MonkeyPatch, collect: Collect) -> list[str]:
    calls: list[str] = []

    async def fake(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        calls.append(source["id"])
        result = collect(source)
        if asyncio.iscoroutine(result):
            result = await result
        assert isinstance(result, Batch)
        return result

    monkeypatch.setattr(SlurmDriver, "collect", fake)
    return calls


def job_batch(source: dict[str, Any], gpu_count: int = 8) -> Batch:
    return Batch(
        jobs=[
            {
                "id": f"{source['cluster_id']}:1",
                "source_id": source["id"],
                "cluster_id": source["cluster_id"],
                "state": "RUNNING",
                "gpu_count": gpu_count,
            }
        ],
        capabilities=["jobs"],
    )


def seconds_until(timestamp: str) -> float:
    return (datetime.fromisoformat(timestamp) - datetime.now(UTC)).total_seconds()


async def test_success_commits_snapshot_status_and_history(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    tmp_path: Path,
) -> None:
    source = add_source(fresh=False)
    warning = message("qos_unavailable", detail="permission denied")
    qos = [{"name": "normal", "limits": {}, "origin": "observed_job_access_unverified"}]

    def collect(source: dict[str, Any]) -> Batch:
        assert store.source(source["id"])["status"] == "syncing"
        batch = job_batch(source)
        batch.warnings.append(warning)
        batch.qos = qos
        return batch

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["status"] == "ready"
    assert saved["last_success"] and saved["last_attempt"]
    assert saved["error"] is None
    assert saved["failures"] == 0
    assert saved["capabilities"] == ["jobs"]
    assert saved["warnings"] == [warning]
    assert saved["qos"] == qos
    assert 590 < seconds_until(saved["next_due_at"]) <= 600
    data = store.dashboard()
    assert [job["id"] for job in data["jobs"]] == ["cluster-a:1"]
    assert data["history"][-1]["allocated_gpus"] == 8
    assert (tmp_path / "computedeck.conf").is_file()
    assert not collector.pending


async def test_failure_preserves_previous_snapshot_and_backs_off(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source(fresh=False)
    failure: Exception | None = None

    def collect(source: dict[str, Any]) -> Batch:
        if failure is not None:
            raise failure
        return job_batch(source)

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    success = store.source(source["id"])["last_success"]
    failure = SourceError("ssh_failed", "Permission denied (publickey).")
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["status"] == "error"
    assert saved["error"] == {"code": "ssh_failed", "detail": "Permission denied (publickey)."}
    assert saved["failures"] == 1
    assert saved["last_success"] == success
    assert 590 < seconds_until(saved["next_due_at"]) <= 600
    assert len(store.dashboard()["jobs"]) == 1
    # Repeated failures back off beyond the configured interval, up to 30 minutes.
    saved.update(failures=4, interval_minutes=5)
    store.save_source(saved)
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None and saved["failures"] == 5
    assert 1790 < seconds_until(saved["next_due_at"]) <= 1800


@pytest.mark.parametrize(
    ("failure", "error"),
    [
        (TimeoutError(), {"code": "timeout"}),
        (RuntimeError("boom"), {"code": "collection_failed", "detail": "RuntimeError: boom"}),
        (
            SourceError("unexpected_output", command="squeue"),
            {"code": "unexpected_output", "command": "squeue"},
        ),
    ],
)
async def test_errors_become_translatable_messages(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    failure: Exception,
    error: dict[str, Any],
) -> None:
    source = add_source(fresh=False)

    def collect(source: dict[str, Any]) -> Batch:
        raise failure

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    assert store.source(source["id"])["error"] == error


async def test_connection_change_during_collection_discards_result(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source(fresh=False)

    def collect(collected: dict[str, Any]) -> Batch:
        # The user points the source at another login while SSH is in flight.
        current = store.source(collected["id"])
        assert current is not None
        current.update(ssh_alias="cluster-a-new", status="ready", last_success=None)
        store.save_source(current)
        return job_batch(collected)

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["ssh_alias"] == "cluster-a-new"
    assert saved["last_success"] is None
    assert store.dashboard()["jobs"] == []


async def test_failed_attempt_after_a_reconnect_keeps_the_reset(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source()
    assert source["last_success"] is not None

    def collect(collected: dict[str, Any]) -> Batch:
        current = store.source(collected["id"])
        assert current is not None
        current.update(ssh_alias="cluster-a-new", status="ready", last_success=None)
        store.save_source(current)
        raise SourceError("ssh_failed", "connection reset")

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["ssh_alias"] == "cluster-a-new"
    assert saved["last_success"] is None
    assert saved["status"] == "ready"


async def test_other_edits_during_collection_are_kept_and_recollected(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source(fresh=False)

    def collect(collected: dict[str, Any]) -> Batch:
        current = store.source(collected["id"])
        assert current is not None
        current.update(name="Cluster A (renamed)", interval_minutes=30)
        store.save_source(current)
        return job_batch(collected)

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["name"] == "Cluster A (renamed)"
    assert saved["interval_minutes"] == 30
    assert saved["status"] == "ready"
    assert seconds_until(saved["next_due_at"]) <= 0
    assert len(store.dashboard()["jobs"]) == 1


async def test_source_deleted_during_collection_stays_deleted(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source(fresh=False)

    def collect(collected: dict[str, Any]) -> Batch:
        store.delete_source(collected["id"])
        return job_batch(collected)

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    assert store.source(source["id"]) is None
    assert store.dashboard()["jobs"] == []


async def test_disabled_or_missing_source_is_not_collected(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source(enabled=False)
    calls = use_driver(monkeypatch, job_batch)
    await collector.collect(source["id"])
    await collector.collect("cluster-z-nobody")
    assert calls == []
    assert store.source(source["id"])["status"] == "ready"


async def test_enqueue_coalesces_requests_for_one_source(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, add_source: AddSource
) -> None:
    source = add_source(fresh=False)

    async def collect(source: dict[str, Any]) -> Batch:
        await asyncio.sleep(0.01)
        return job_batch(source)

    calls = use_driver(monkeypatch, collect)
    assert collector.enqueue(source["id"]) is True
    assert collector.enqueue(source["id"]) is False
    assert collector.pending == {source["id"]}
    await asyncio.gather(*collector.tasks)
    assert calls == [source["id"]]
    assert not collector.pending
    assert collector.enqueue(source["id"]) is True
    await asyncio.gather(*collector.tasks)
    assert calls == [source["id"], source["id"]]


async def test_identities_of_one_cluster_share_a_connection_budget(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, add_source: AddSource
) -> None:
    sources = [
        add_source(fresh=False),
        add_source(username="bob", fresh=False),
        add_source("Cluster B", fresh=False),
    ]
    active: Counter[str] = Counter()
    peak: Counter[str] = Counter()
    overlap = 0

    async def collect(source: dict[str, Any]) -> Batch:
        nonlocal overlap
        active[source["cluster_id"]] += 1
        peak[source["cluster_id"]] = max(peak[source["cluster_id"]], active[source["cluster_id"]])
        overlap = max(overlap, sum(active.values()))
        await asyncio.sleep(0.02)
        active[source["cluster_id"]] -= 1
        return job_batch(source)

    use_driver(monkeypatch, collect)
    for source in sources:
        collector.enqueue(source["id"])
    await asyncio.gather(*collector.tasks)
    assert peak == {"cluster-a": 1, "cluster-b": 1}
    assert overlap == 2


async def test_recover_marks_interrupted_collections(
    collector: Collector, store: Store, add_source: AddSource
) -> None:
    syncing = add_source(status="syncing")
    ready = add_source("Cluster B")
    collector.recover()
    saved = store.source(syncing["id"])
    assert saved is not None
    assert saved["status"] == "error"
    assert saved["error"] == {"code": "collection_interrupted"}
    assert seconds_until(saved["next_due_at"]) <= 0
    assert store.source(ready["id"])["status"] == "ready"


async def test_runpod_secret_is_never_written_to_the_database(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    tmp_path: Path,
) -> None:
    secret = "rp-test-secret-token"
    monkeypatch.setenv("RUNPOD_API_KEY", secret)
    status = 403

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == f"Bearer {secret}"
        if status != 200:
            return httpx.Response(status, json={"error": f"bad key {secret}"})
        pod = {"id": "pod1", "desiredStatus": "RUNNING", "publicIp": "192.0.2.5"}
        return httpx.Response(200, json=[{**pod, "portMappings": {"22": 22005}}])

    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        cloud.httpx, "AsyncClient", lambda **kwargs: real(transport=transport, **kwargs)
    )
    source = add_source("RunPod", driver="runpod", fresh=False)
    assert source["credential"] == "env:RUNPOD_API_KEY"
    await collector.collect(source["id"])
    assert store.source(source["id"])["error"] == {"code": "http_status", "status": 403}
    status = 200
    await collector.collect(source["id"])
    assert [row["id"] for row in store.dashboard()["instances"]] == ["runpod:pod1"]
    store.db.execute("PRAGMA wal_checkpoint(FULL)")
    assert files_containing(tmp_path, secret.encode()) == []


def files_containing(directory: Path, data: bytes) -> list[str]:
    return [
        path.name for path in directory.iterdir() if path.is_file() and data in path.read_bytes()
    ]


def manual_instance(store: Store, **changes: Any) -> dict[str, Any]:
    body = {
        "platform": "Lab box",
        "name": "gpu one",
        "external_id": "gpu1",
        "host": "192.0.2.30",
        "username": "alice",
    }
    body.update(changes)
    instance = instance_record(InstanceInput(**body))
    store.save_instance(instance)
    return instance


async def test_probe_merges_measurements_into_manual_instance(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store
) -> None:
    instance = manual_instance(store, gpu_count=2, monitoring=True)
    probed: list[dict[str, Any]] = []

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        probed.append(row)
        return {
            "ssh_status": "reachable",
            "gpu_utilization": 50,
            "gpu_observed_count": 2,
            "observed_at": now(),
        }

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    result = await collector.probe(instance["id"])
    assert probed[0]["host"] == "192.0.2.30"
    assert result["ssh_status"] == "reachable"
    assert result["ssh_error"] is None
    assert result["last_probe_attempt"]
    [saved] = store.manual_instances()
    assert saved["gpu_utilization"] == 50
    assert saved["gpu_count"] == 2
    # It answered just now: running, as the dashboard derives it from this check.
    assert saved["state"] == instance["state"] == "unknown"
    assert result["state"] == store.dashboard()["instances"][0]["state"] == "running"
    assert store.dashboard()["history"][-1]["gpu_utilization"] == 50
    # A later probe must also read the stored row, not persist the dashboard's derived state.
    await collector.probe(instance["id"])
    assert store.manual_instances()[0]["state"] == "unknown"
    assert not collector.probes


@pytest.mark.parametrize(
    "bad", [{"memory_utilization": -3.0}, {"cpu_utilization": 140}, {"gpu_utilization": True}]
)
async def test_a_bad_probe_result_cannot_mark_the_cloud_source_failed(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    bad: dict[str, Any],
) -> None:
    source = add_source("RunPod", driver="runpod", capabilities=["instances", "ssh_probe"])
    pod = {
        "source_id": source["id"],
        "state": "running",
        "host": "203.0.113.9",
        "port": 22001,
        "username": "root",
    }
    rows = [{**pod, "id": "runpod:p1"}, {**pod, "id": "runpod:p2"}]
    store.save_snapshot(source["id"], {"instances": rows})

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        # e.g. a container whose /proc/meminfo reports MemAvailable > MemTotal
        return {
            "ssh_status": "reachable",
            "gpu_utilization": 10.0,
            "gpu_observed_count": 1,
            "cpu_utilization": 5.0,
            "memory_utilization": 40.0,
            "observed_at": now(),
            **bad,
        }

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    await collector.probe("runpod:p1")
    dashboard = store.dashboard()
    [listed] = dashboard["sources"]
    assert (listed["status"], listed["error"]) == ("ready", None)
    instances = {row["id"]: row for row in dashboard["instances"]}
    assert set(instances) == {"runpod:p1", "runpod:p2"}
    [key] = bad
    assert instances["runpod:p1"][key] is None
    assert instances["runpod:p1"]["ssh_status"] == "reachable"


def test_a_probe_update_the_listing_could_not_read_is_not_saved(store: Store) -> None:
    pod = {"id": "runpod:a", "source_id": "s", "state": "running", "host": "192.0.2.1"}
    store.save_snapshot("s", {"instances": [pod]})
    store.update_cloud_metrics("runpod:a", {"host": "192.0.2.1"}, {"gpu_count": -1})
    assert store.dashboard()["instances"] == [
        {
            **pod,
            "seen_running_since": None,
            "console_url": None,
            "low_use": {
                "state": "unknown",
                "since": None,
                "covered_minutes": 0,
                "samples": 0,
                "origin": None,
                "reason": "no_reading",
            },
        }
    ]
    assert store.unreadable_rows() == {}


async def test_probe_failure_is_recorded_and_raised(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store
) -> None:
    instance = manual_instance(store)

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        raise SourceError("ssh_failed", "Connection refused")

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    with pytest.raises(SourceError):
        await collector.probe(instance["id"])
    [saved] = store.manual_instances()
    assert saved["ssh_status"] == "error"
    assert saved["ssh_error"] == {"code": "ssh_failed", "detail": "Connection refused"}
    # A failed check says nothing about whether the machine runs: unknown, never stopped.
    assert saved["state"] == "unknown"
    assert not collector.probes


async def test_concurrent_or_unknown_probe_is_refused(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store
) -> None:
    instance = manual_instance(store)
    release = asyncio.Event()

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        await release.wait()
        return {"ssh_status": "reachable"}

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    first = asyncio.create_task(collector.probe(instance["id"]))
    await asyncio.sleep(0)
    with pytest.raises(ProbeConflict, match="probe_in_progress"):
        await collector.probe(instance["id"])
    release.set()
    await first
    with pytest.raises(LookupError):
        await collector.probe("manual:lab-box-absent")


async def test_cloud_probe_updates_snapshot_without_changing_inventory(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store
) -> None:
    pod = {
        "id": "runpod:pod1",
        "source_id": "runpod-runpod",
        "state": "reported_running",
        "host": "192.0.2.5",
        "port": 22005,
        "username": "root",
        "identity_file": None,
        "gpu_count": 2,
        "gpu_type": "A100",
    }
    store.save_snapshot("runpod-runpod", {"instances": [pod]})

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        return {"ssh_status": "reachable", "gpu_utilization": 70, "observed_at": now()}

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    await collector.probe("runpod:pod1")
    [saved] = store.dashboard()["instances"]
    assert saved["gpu_utilization"] == 70
    assert saved["gpu_count"] == 2
    assert saved["gpu_type"] == "A100"
    assert saved["state"] == "reported_running"
    assert store.manual_instances() == []


@pytest.mark.parametrize("state", ["running", "reported_running"])
async def test_a_check_never_changes_what_a_provider_listed(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    state: str,
) -> None:
    source = add_source("RunPod", driver="runpod")
    listed_at = now()
    pod = {
        "id": "runpod:pod1",
        "source_id": source["id"],
        "state": state,
        "host": "192.0.2.5",
        "port": 22005,
        "username": "root",
        "identity_file": None,
        "gpu_count": 2,
        "gpu_type": "A100",
        "gpu_utilization": None,
        "cpu_utilization": None,
        "observed_at": listed_at,
        "ssh_status": "unverified",
    }
    store.save_snapshot(source["id"], {"instances": [pod]})

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        # An idle rented pod: no compute processes, and a container that sees one GPU.
        return {
            "ssh_status": "reachable",
            "gpu_count": 1,
            "gpu_type": "NVIDIA L4",
            "gpu_allocated": 0,
            "gpu_utilization": 0.0,
            "gpu_observed_count": 1,
            "cpu_utilization": 12.0,
            "metrics_scope": "host_visible",
            "observed_at": now(),
            "probe_warnings": [],
        }

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    result = await collector.probe("runpod:pod1")
    [saved] = store.dashboard()["instances"]
    assert saved == result
    assert saved["ssh_status"] == "reachable"
    assert saved["last_probe_attempt"]
    assert (saved["gpu_utilization"], saved["cpu_utilization"]) == (0.0, 12.0)
    # The provider stays the authority for its inventory, the GPUs held and its listing time.
    assert (saved["gpu_count"], saved["gpu_type"]) == (2, "A100")
    assert saved["observed_at"] == listed_at
    for key in ("gpu_allocated", "metrics_scope", "probe_warnings"):
        assert key not in saved
    assert gpu_allocation(saved) == 2
    assert store.dashboard()["history"][-1]["allocated_gpus"] == 2
    # The next listing keeps the check, not its readings.
    store.save_snapshot(source["id"], {"instances": [pod]})
    [listed] = store.dashboard()["instances"]
    assert listed["ssh_status"] == "reachable"
    assert listed["last_probe_attempt"] == saved["last_probe_attempt"]
    assert listed["cpu_utilization"] is None


@pytest.mark.parametrize(
    "row",
    [
        {"name": "bad"},
        {
            "id": "cluster-a:1",
            "state": "RUNNING",
            "source_id": "cluster-a-alice",
            "gpu_count": "eight",
        },
    ],
)
async def test_malformed_batch_preserves_last_good_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    row: dict[str, Any],
) -> None:
    source = add_source()
    before = job_batch(source).snapshot()
    store.save_snapshot(source["id"], before)
    use_driver(monkeypatch, lambda source: Batch(jobs=[row], capabilities=["jobs"]))
    await collector.collect(source["id"])
    assert store.source(source["id"])["status"] == "error"
    assert store.snapshot(source["id"]) == before
    assert store.dashboard()["jobs"] == before["jobs"]


@pytest.mark.parametrize("edit", ["delete", "alias", "command", "name"])
async def test_node_edit_during_collection_never_resurrects_old_settings(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    edit: str,
) -> None:
    node = {"id": "gateway", "name": "Gateway", "ssh_alias": "old", "command": "computedeck"}
    store.save_node(node)
    source = add_source(node="gateway")

    async def collect(node: dict[str, Any], source: dict[str, Any]) -> Batch:
        if edit == "delete":
            store.delete_node(node["id"])
        else:
            key = "ssh_alias" if edit == "alias" else edit
            store.save_node({**node, key: "changed"})
        return job_batch(source)

    monkeypatch.setattr(collector_module.nodes, "collect", collect)
    await collector.collect(source["id"])
    current = store.node("gateway")
    if edit == "delete":
        assert current is None
    else:
        assert current["ssh_alias" if edit == "alias" else edit] == "changed"
    assert bool(store.snapshot(source["id"])) == (edit == "name")


@pytest.mark.parametrize(
    "changes",
    [
        {
            "instances": [
                {
                    "id": "cluster-a:pod",
                    "source_id": "cluster-a-alice",
                    "state": "running",
                    "vendor_metric": float("nan"),
                }
            ]
        },
        {
            "instances": [
                {"id": "cluster-a:pod", "source_id": "cluster-a-alice", "state": "bad\ud800"}
            ]
        },
        {"account": {"balance": float("nan"), "currency": "USD"}},
    ],
)
async def test_non_json_safe_batch_never_reaches_storage(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    changes: dict[str, Any],
) -> None:
    source = add_source()
    use_driver(monkeypatch, lambda source: Batch(**changes))
    await collector.collect(source["id"])
    assert store.source(source["id"])["status"] == "error"
    assert store.snapshot(source["id"]) is None


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        (Batch(jobs=[], capabilities=["jobs"]), ["source.gap", "source.recovered"]),
        (SourceError("ssh_timeout"), []),
    ],
)
async def test_a_source_failing_before_a_restart_is_still_failing_after_it(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    outcome: Batch | SourceError,
    expected: list[str],
) -> None:
    # It failed (source.failed was sent) and was being retried when the service stopped.
    source = add_source(
        status="syncing", last_success="2026-01-01T00:00:00+00:00", error={"code": "ssh_timeout"}
    )
    collector.recover()
    assert store.source(source["id"])["error"] == {"code": "ssh_timeout"}

    def collect(_: dict[str, Any]) -> Batch:
        if isinstance(outcome, SourceError):
            raise outcome
        return outcome

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    assert [row["type"] for row in store.events()] == expected


async def test_commit_fault_is_exposed_until_that_source_recovers(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, add_source: AddSource
) -> None:
    first = add_source()
    second = add_source("Cluster B")

    async def fail(source_id: str) -> None:
        raise OSError("database write failed")

    monkeypatch.setattr(collector, "_collect", fail)
    await collector.collect(first["id"])
    key = f"collector:commit:{first['id']}"
    assert collector.runtime.loop_errors[key]["error"] == "OSError: database write failed"
    assert collector.runtime.loop_errors[key]["at"]

    async def succeed(source_id: str) -> None:
        pass

    monkeypatch.setattr(collector, "_collect", succeed)
    await collector.collect(second["id"])
    assert key in collector.runtime.loop_errors
    await collector.collect(first["id"])
    assert key not in collector.runtime.loop_errors


async def test_schedule_fault_is_exposed_and_cleared_on_next_clean_pass(
    monkeypatch: pytest.MonkeyPatch, collector: Collector
) -> None:
    passes = 0

    def schedule() -> None:
        nonlocal passes
        passes += 1
        if passes == 1:
            raise ValueError("invalid schedule")

    async def sleep(seconds: int) -> None:
        if passes == 1:
            assert collector.runtime.loop_errors["collector:schedule"]["error"] == (
                "ValueError: invalid schedule"
            )
        else:
            assert "collector:schedule" not in collector.runtime.loop_errors
            raise asyncio.CancelledError

    monkeypatch.setattr(collector, "_schedule", schedule)
    monkeypatch.setattr(collector_module.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await collector.run()


@pytest.mark.parametrize("action", ["delete", "disable"])
async def test_collect_clears_a_commit_fault_for_an_inactive_source(
    collector: Collector, store: Store, add_source: AddSource, action: str
) -> None:
    source = add_source()
    key = f"collector:commit:{source['id']}"
    collector.runtime.report(key, OSError("database write failed"))
    collector.runtime.report("collector:schedule", ValueError("invalid schedule"))
    if action == "delete":
        store.delete_source(source["id"])
    else:
        store.save_source({**source, "enabled": False})
    await collector.collect(source["id"])
    assert key not in collector.runtime.loop_errors
    assert "collector:schedule" in collector.runtime.loop_errors


async def test_capabilities_seen_survive_regression_failure_and_recovery(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    # Upgrade from an existing source row, without capabilities_seen or a migration.
    source = add_source(capabilities=["jobs", "nodes"])
    batch = Batch(capabilities=["jobs"], warnings=[message("nodes_unavailable")])
    failure = False

    def collect(source: dict[str, Any]) -> Batch:
        if failure:
            raise SourceError("ssh_failed")
        return batch

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    assert store.source(source["id"])["capabilities_seen"] == ["jobs", "nodes"]
    failure = True
    await collector.collect(source["id"])
    assert store.source(source["id"])["capabilities_seen"] == ["jobs", "nodes"]
    failure = False
    batch = Batch(capabilities=["jobs", "nodes", "history"])
    await collector.collect(source["id"])
    assert store.source(source["id"])["capabilities_seen"] == ["history", "jobs", "nodes"]
    assert store.source(source["id"])["warnings"] == []


async def test_collection_clears_resolved_acknowledgement_before_same_fault_returns(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source()
    source.update(error={"code": "timeout"}, failures=2, status="error")
    store.save_source(source)
    [item] = collector.attention_items()
    store.set_attention_state(
        item["key"],
        {"fingerprint": item["fingerprint"], "acknowledged_at": now(), "snooze_until": None},
    )
    use_driver(monkeypatch, lambda source: Batch(capabilities=["jobs"]))
    await collector.collect(source["id"])
    assert store.attention_state() == {}

    def fail(source: dict[str, Any]) -> Batch:
        raise TimeoutError()

    use_driver(monkeypatch, fail)
    await collector.collect(source["id"])
    await collector.collect(source["id"])
    [returned] = collector.attention_items()
    assert returned["fingerprint"] == item["fingerprint"]
    assert returned["muted"] is None


async def test_collection_clears_changed_fingerprint_but_keeps_unchanged_acknowledgement(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, add_source: AddSource
) -> None:
    source = add_source()
    source.update(error={"code": "timeout"}, failures=2, status="error")
    store.save_source(source)
    [item] = collector.attention_items()
    store.set_attention_state(
        item["key"],
        {"fingerprint": item["fingerprint"], "acknowledged_at": now(), "snooze_until": None},
    )

    def fail(source: dict[str, Any]) -> Batch:
        raise TimeoutError()

    use_driver(monkeypatch, fail)
    await collector.collect(source["id"])
    assert collector.attention_items()[0]["muted"] is not None

    def changed(source: dict[str, Any]) -> Batch:
        raise SourceError("ssh_failed")

    use_driver(monkeypatch, changed)
    await collector.collect(source["id"])
    assert store.attention_state() == {}
    assert collector.attention_items()[0]["muted"] is None


async def test_successful_machine_check_clears_acknowledgement(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store
) -> None:
    instance = manual_instance(store, monitoring=True)
    instance.update(ssh_status="error", ssh_error={"code": "timeout"})
    store.save_instance(instance)
    [item] = collector.attention_items()
    store.set_attention_state(
        item["key"],
        {"fingerprint": item["fingerprint"], "acknowledged_at": now(), "snooze_until": None},
    )

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        return {"ssh_status": "reachable", "observed_at": now()}

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    await collector.probe(instance["id"])
    assert store.attention_state() == {}
    assert collector.attention_items() == []


@pytest.mark.parametrize("outcome", ["conflict", "error", "success"])
async def test_attention_cleanup_never_replaces_probe_outcome(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    outcome: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    instance = manual_instance(store, monitoring=True)
    probe_error = SourceError("ssh_failed")
    cleanup_calls = []

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        if outcome == "error":
            raise probe_error
        if outcome == "conflict":
            store.save_instance({**instance, "host": "192.0.2.31"})
        return {"ssh_status": "reachable", "observed_at": now()}

    def cleanup() -> None:
        cleanup_calls.append(True)
        raise ValueError("cleanup failed")

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    monkeypatch.setattr(collector, "clear_resolved_attention", cleanup)
    if outcome == "conflict":
        with pytest.raises(ProbeConflict, match="endpoint_changed"):
            await collector.probe(instance["id"])
        assert cleanup_calls == []
    elif outcome == "error":
        with pytest.raises(SourceError) as raised:
            await collector.probe(instance["id"])
        assert raised.value is probe_error
        assert store.manual_instances()[0]["ssh_error"] == {"code": "ssh_failed"}
        assert cleanup_calls == [True]
    else:
        result = await collector.probe(instance["id"])
        assert result["ssh_status"] == "reachable"
        assert store.manual_instances()[0]["ssh_status"] == "reachable"
        assert store.manual_instances()[0]["ssh_error"] is None
        assert store.dashboard()["history"]
        assert cleanup_calls == [True]
    if outcome != "conflict":
        assert "Attention cleanup failed" in caplog.text
    assert not collector.probes


async def test_collection_writes_history_and_config_before_attention_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    caplog: pytest.LogCaptureFixture,
) -> None:
    source = add_source()
    use_driver(monkeypatch, lambda source: Batch(capabilities=["jobs"]))
    steps = []
    write_config = collector_module.write_config

    def config(instances: list[dict[str, Any]], data_dir: Path) -> None:
        assert store.dashboard()["history"]
        steps.append("config")
        write_config(instances, data_dir)

    def cleanup() -> None:
        steps.append("cleanup")
        raise ValueError("cleanup failed")

    monkeypatch.setattr(collector_module, "write_config", config)
    monkeypatch.setattr(collector, "clear_resolved_attention", cleanup)
    await collector.collect(source["id"])
    assert steps == ["config", "cleanup"]
    assert store.source(source["id"])["status"] == "ready"
    assert collector.runtime.loop_errors == {}
    assert "Attention cleanup failed" in caplog.text


def test_attention_cleanup_discards_unreadable_state(collector: Collector, store: Store) -> None:
    with store.db:
        store.db.execute("INSERT INTO attention_state VALUES ('broken', 'not JSON')")
        store.db.execute("INSERT INTO sources VALUES ('broken-source', 'not JSON')")
    store.set_attention_state(
        "bad-time", {"fingerprint": "x", "acknowledged_at": now(), "snooze_until": "no time"}
    )
    assert any(
        item["key"] == "unreadable_rows:attention_state" for item in collector.attention_items()
    )
    collector.clear_resolved_attention()
    assert store.db.execute("SELECT * FROM attention_state").fetchall() == []
    assert store.unreadable_rows() == {"sources": 1}
    assert [item["key"] for item in collector.attention_items()] == ["unreadable_rows:sources"]


@pytest.mark.parametrize(
    "code,retries",
    [
        ("ssh_timeout", 1),
        ("ssh_closed", 1),
        ("ssh_authentication", 0),
        ("ssh_host_key", 0),
        ("ssh_refused", 0),
        ("ssh_network", 0),
        ("ssh_failed", 0),
    ],
)
@pytest.mark.parametrize("recovers", [False, True])
async def test_machine_retry_is_bounded_and_cause_specific(
    monkeypatch, collector, store, code, retries, recovers
):
    instance = manual_instance(store)
    attempts = []
    delays = []

    async def probe(row):
        attempts.append(row)
        if len(attempts) == 1 or not recovers:
            raise SourceError(code)
        return {"ssh_status": "reachable"}

    async def delay(seconds):
        delays.append(seconds)
        # A transient first failure is never committed or turned into attention.
        assert store.manual_instances()[0]["ssh_status"] == "unverified"

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    monkeypatch.setattr(collector_module.asyncio, "sleep", delay)
    if retries and recovers:
        result = await collector.probe(instance["id"])
        assert result["ssh_status"] == "reachable"
        assert result["ssh_error"] is None
    else:
        with pytest.raises(SourceError, match=code):
            await collector.probe(instance["id"])
        assert store.manual_instances()[0]["ssh_error"] == {"code": code}
    assert len(attempts) == 1 + retries
    assert delays == [2] * retries
    assert not collector.probes


async def test_machine_checks_have_two_slots_independent_of_collections(
    monkeypatch, collector, runtime, store
):
    original = manual_instance(store)
    ids = [original["id"]]
    for index in range(2):
        row = {**original, "id": f"manual:lab-box-{index}"}
        store.save_instance(row)
        ids.append(row["id"])
    runtime.semaphore = asyncio.Semaphore(0)
    entered = []
    two_running = asyncio.Event()
    release = asyncio.Event()

    async def probe(row):
        entered.append(row["id"])
        if len(entered) == 2:
            two_running.set()
        await release.wait()
        return {"ssh_status": "reachable"}

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    tasks = [asyncio.create_task(collector.probe(key)) for key in ids]
    try:
        await asyncio.wait_for(two_running.wait(), 10)
        assert len(entered) == 2
        release.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 10)
        assert len(entered) == 3
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_machine_endpoint_changed_during_retry_is_not_checked_again(
    monkeypatch, collector, store
):
    instance = manual_instance(store)
    calls = []

    async def probe(row):
        calls.append(row)
        raise SourceError("ssh_closed")

    async def delay(seconds):
        store.save_instance({**instance, "host": "192.0.2.99"})

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    monkeypatch.setattr(collector_module.asyncio, "sleep", delay)
    with pytest.raises(ProbeConflict, match="endpoint_changed"):
        await collector.probe(instance["id"])
    assert len(calls) == 1
    assert store.manual_instances()[0]["ssh_status"] == "unverified"
    assert not collector.probes


@pytest.mark.parametrize("manual", [False, True])
async def test_actual_probes_record_maximum_without_changing_provider_inventory(
    monkeypatch: pytest.MonkeyPatch, collector: Collector, store: Store, manual: bool
) -> None:
    import json

    from computedeck.drivers.ssh_host import MARKER
    from computedeck.hardware import parse_probe

    instance = (
        manual_instance(store, gpu_count=2, monitoring=True)
        if manual
        else {
            "id": "runpod:pod1",
            "source_id": "runpod-runpod",
            "state": "reported_running",
            "host": "192.0.2.5",
            "port": 22005,
            "username": "root",
            "gpu_count": 2,
        }
    )
    if not manual:
        store.save_snapshot("runpod-runpod", {"instances": [instance]})

    async def probe(row: dict[str, Any]) -> dict[str, Any]:
        return parse_probe(
            MARKER
            + json.dumps(
                {
                    "gpu_tool": "nvidia-smi",
                    "gpu": "0, GPU-aaaa, A100, 0, 0, 81920\n1, GPU-bbbb, A100, 18, 2000, 81920\n",
                    "apps": "",
                    "owners": "",
                    "user": "alice",
                }
            )
        )

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    await collector.probe(instance["id"])
    sample = store.db.execute(
        "SELECT gpu_util, gpu_util_max, origin FROM instance_samples"
    ).fetchone()
    assert sample == (9, 18, "probe")
    row = store.dashboard()["instances"][0]
    assert row["gpu_utilization_max"] == 18
    assert row["low_use"]["state"] == "busy"
    if not manual:
        assert row["state"] == "reported_running" and row["gpu_count"] == 2
        assert "gpus" not in row and "gpus_observed_at" not in row

    async def failed(row: dict[str, Any]) -> dict[str, Any]:
        raise SourceError("ssh_authentication")

    monkeypatch.setattr(collector_module, "probe_instance", failed)
    with pytest.raises(SourceError):
        await collector.probe(instance["id"])
    assert store.db.execute("SELECT count(*) FROM instance_samples").fetchone()[0] == 1
    assert store.dashboard()["instances"][0]["low_use"]["state"] == (
        "unknown" if manual else "busy"
    )


def test_low_use_ack_survives_retention_but_clears_when_the_condition_resolves(
    collector: Collector, store: Store
) -> None:
    instance = manual_instance(store, gpu_count=2, monitoring=True)
    current = datetime.now(UTC)
    instance.update(
        ssh_status="reachable",
        observed_at=current.isoformat(),
        gpu_utilization=3,
        gpu_utilization_max=4,
        gpu_observed_count=2,
    )
    store.save_instance(instance)
    held = {**instance, "state": "running"}
    for age in range(70, -1, -10):
        store.record_instance_sample(held, instance, (current - timedelta(minutes=age)).isoformat())
    [hint] = collector.attention_items()
    assert hint["kind"] == "instance_low_use"
    store.set_attention_state(
        hint["key"],
        {
            "fingerprint": hint["fingerprint"],
            "acknowledged_at": now(),
            "snooze_until": None,
        },
    )
    # Trimming the oldest sample changes since but leaves a fully covered low window.
    with store.db:
        store.db.execute(
            "DELETE FROM instance_samples WHERE at=?",
            ((current - timedelta(minutes=70)).isoformat(),),
        )
    collector.clear_resolved_attention()
    assert collector.attention_items()[0]["muted"]["state"] == "acknowledged"
    store.record_instance_sample(held, {**instance, "gpu_utilization_max": 80}, current.isoformat())
    collector.clear_resolved_attention()
    assert store.attention_state() == {}
    assert collector.attention_items() == []
    store.record_instance_sample(held, instance, current.isoformat())
    assert collector.attention_items()[0]["muted"] is None


@pytest.mark.parametrize("fails", [False, True])
async def test_ssh_source_checks_preserve_the_window_and_acknowledgement(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    fails: bool,
) -> None:
    source = add_source(driver="ssh", interval_minutes=30)
    current = datetime.now(UTC)
    row = {
        "id": "lab:server",
        "source_id": source["id"],
        "name": "Lab server",
        "state": "running",
        "host": "lab-server",
        "existing_alias": True,
        "gpu_count": 2,
        "gpu_observed_count": 2,
        "gpu_utilization": 1,
        "gpu_utilization_max": 2,
        "ssh_status": "reachable",
    }
    for age in [70, 40, 10]:
        row["observed_at"] = (current - timedelta(minutes=age)).isoformat()
        store.save_snapshot(source["id"], {"instances": [dict(row)]})
    for age in [55, 25]:
        store.record_instance_sample(row, row, (current - timedelta(minutes=age)).isoformat())
    before = store.dashboard()["instances"][0]["low_use"]
    assert (before["state"], before["samples"], before["origin"]) == ("low", 5, "source")
    [hint] = collector.attention_items()
    store.set_attention_state(
        hint["key"],
        {
            "fingerprint": hint["fingerprint"],
            "acknowledged_at": now(),
            "snooze_until": None,
        },
    )
    samples_before = list(store.db.execute("SELECT * FROM instance_samples ORDER BY at"))

    async def probe(instance: dict[str, Any]) -> dict[str, Any]:
        if fails:
            raise SourceError("ssh_authentication")
        return {**row, "observed_at": now()}

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    if fails:
        with pytest.raises(SourceError):
            await collector.probe(row["id"])
        assert (
            list(store.db.execute("SELECT * FROM instance_samples ORDER BY at")) == samples_before
        )
    else:
        await collector.probe(row["id"])
    usage = store.dashboard()["instances"][0]["low_use"]
    assert usage["state"] == "low"
    assert usage["since"] == before["since"]
    assert usage["samples"] == (5 if fails else 6)
    assert usage["origin"] == ("source" if fails else "probe")
    low_hint = next(i for i in collector.attention_items() if i["kind"] == "instance_low_use")
    assert low_hint["fingerprint"] == hint["fingerprint"]
    assert low_hint["muted"]["state"] == "acknowledged"

    store.save_snapshot(source["id"], {"instances": [{**row, "observed_at": now()}]})
    collector.clear_resolved_attention()
    usage = store.dashboard()["instances"][0]["low_use"]
    assert (usage["state"], usage["samples"], usage["origin"]) == (
        "low",
        6 if fails else 7,
        "source",
    )
    assert usage["since"] == before["since"]
    low_hint = next(i for i in collector.attention_items() if i["kind"] == "instance_low_use")
    assert low_hint["muted"]["state"] == "acknowledged"


@pytest.mark.parametrize("accounting", [True, False])
async def test_wait_history_uses_only_own_finished_accounting_jobs(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    accounting: bool,
) -> None:
    source = add_source(fresh=False)
    current = datetime.now(UTC)
    completed = {
        "id": f"{source['cluster_id']}:42",
        "source_id": source["id"],
        "cluster_id": source["cluster_id"],
        "user": source["username"],
        "state": "COMPLETED",
        "gpu_count": 1,
        "qos": "normal",
        "partition": "gpu",
        "submitted_at": (current - timedelta(hours=3)).isoformat(),
        "started_at": (current - timedelta(hours=2)).isoformat(),
        "ended_at": (current - timedelta(hours=1)).isoformat(),
        "observed_at": current.isoformat(),
    }

    def collect(_: dict[str, Any]) -> Batch:
        return Batch(
            jobs=[{**completed, "id": f"{source['cluster_id']}:running", "state": "RUNNING"}],
            failures=[{**completed, "id": f"{source['cluster_id']}:failure", "state": "FAILED"}],
            finished=[
                completed,
                {**completed, "id": f"{source['cluster_id']}:other", "user": "bob"},
            ],
            capabilities=["jobs", "history"] if accounting else ["jobs"],
        )

    calls = use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    await collector.collect(source["id"])
    assert len(calls) == 2
    rows = store.db.execute("SELECT job_id FROM job_wait_samples").fetchall()
    assert rows == ([(completed["id"],)] if accounting else [])
    result = store.dashboard()["wait_history"][source["id"]]
    assert result["status"] == ("available" if accounting else "unavailable")
    if accounting:
        assert result["buckets"][0]["samples"] == 1


async def test_wait_history_does_not_keep_a_repointed_collection(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
) -> None:
    source = add_source()
    calls = []
    monkeypatch.setattr(store, "record_job_waits", lambda *args: calls.append(args))

    def collect(collected: dict[str, Any]) -> Batch:
        store.save_source({**collected, "ssh_alias": "other-login"})
        return Batch(finished=[], capabilities=["history"])

    use_driver(monkeypatch, collect)
    await collector.collect(source["id"])
    assert calls == []


async def test_wait_history_write_failure_preserves_job_events(
    monkeypatch: pytest.MonkeyPatch,
    collector: Collector,
    store: Store,
    add_source: AddSource,
    caplog: pytest.LogCaptureFixture,
) -> None:
    source = add_source(fresh=False)
    batch = job_batch(source)
    batch.jobs = []
    batch.finished = []
    batch.capabilities.append("history")
    use_driver(monkeypatch, lambda _: batch)
    await collector.collect(source["id"])

    def fail(*_: Any) -> None:
        raise sqlite3.OperationalError("must-not-log-row-data")

    monkeypatch.setattr(store, "record_job_waits", fail)
    batch.jobs = job_batch(source).jobs
    await collector.collect(source["id"])
    assert store.source(source["id"])["status"] == "ready"
    assert store.source(source["id"])["error"] is None
    assert store.snapshot(source["id"])["jobs"] == batch.jobs
    assert "job.started" in [event["type"] for event in store.events()]
    assert not any(event["type"] == "source.failed" for event in store.events())
    assert "Could not record wait history (OperationalError)" in caplog.text
    assert "must-not-log-row-data" not in caplog.text
