"""Background collection and probes: commit only good results, never resurrect old settings."""

import asyncio
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
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
    assert saved["state"] == result["state"] == "running"
    assert store.dashboard()["history"][-1]["gpu_utilization"] == 50
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
    assert store.dashboard()["instances"] == [pod]
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
        (Batch(jobs=[], capabilities=["jobs"]), ["source.recovered"]),
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
