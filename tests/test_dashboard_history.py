"""Allocation history: only fresh observations count, and unknown stays a gap, never zero."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from computedeck.store import Store, now

AddSource = Callable[..., dict[str, Any]]


def running_job(
    identifier: str = "cluster-a:1", source_id: str = "cluster-a-alice", gpu_count: int | None = 8
) -> dict[str, Any]:
    return {"id": identifier, "source_id": source_id, "state": "RUNNING", "gpu_count": gpu_count}


def latest_point(store: Store) -> dict[str, Any]:
    store.record_history()
    point: dict[str, Any] = store.dashboard()["history"][-1]
    return point


def test_no_fresh_data_is_unknown_but_observed_empty_queue_is_zero(
    store: Store, add_source: AddSource
) -> None:
    point = latest_point(store)
    assert point["known_allocated_gpus"] is None
    assert point["allocated_gpus"] is None
    add_source(capabilities=["nodes"])
    point = latest_point(store)
    assert point["known_allocated_gpus"] is None
    assert point["allocated_gpus"] is None
    assert point["unknown_allocation_sources"] == 1
    add_source(status="syncing")
    point = latest_point(store)
    assert point["known_allocated_gpus"] == point["allocated_gpus"] == 0
    assert point["unknown_allocation_sources"] == 0


def test_unavailable_cluster_keeps_allocation_history_unknown(
    store: Store, add_source: AddSource
) -> None:
    source = add_source(fresh=False)
    assert latest_point(store)["allocated_gpus"] is None
    source.update(status="error", last_success=now(), capabilities=["jobs"])
    store.save_source(source)
    assert latest_point(store)["allocated_gpus"] is None
    source.update(status="ready")
    store.save_source(source)
    assert latest_point(store)["allocated_gpus"] == 0


def test_missing_utilization_is_not_zero_and_pending_is_not_allocated(
    store: Store, add_source: AddSource
) -> None:
    source = add_source()
    store.save_snapshot(
        source["id"],
        {
            "jobs": [
                running_job(source_id=source["id"], gpu_count=4),
                {**running_job("cluster-a:2", source["id"]), "state": "PENDING"},
            ]
        },
    )
    point = latest_point(store)
    assert point["allocated_gpus"] == 4
    assert point["gpu_utilization"] is None
    assert point["coverage_count"] == 0


def test_unknown_cloud_does_not_erase_confirmed_cluster_gpu_subtotal(
    store: Store, add_source: AddSource
) -> None:
    cluster = add_source()
    cloud = add_source("RunPod", driver="runpod")
    store.save_snapshot(cluster["id"], {"jobs": [running_job()]})
    store.save_snapshot(
        cloud["id"],
        {
            "instances": [
                {
                    "id": "runpod:one",
                    "source_id": cloud["id"],
                    "state": "desired_running",
                    "gpu_count": 4,
                },
                {"id": "runpod:two", "source_id": cloud["id"], "state": "missing", "gpu_count": 4},
            ]
        },
    )
    point = latest_point(store)
    assert point["allocated_gpus"] is None
    assert point["known_allocated_gpus"] == 8
    assert point["unknown_allocation_sources"] == 1
    assert store.dashboard()["instances"][1]["state"] == "missing"


def test_unknown_gpu_counts_and_stale_sources_are_counted_once_per_source(
    store: Store, add_source: AddSource
) -> None:
    add_source()
    add_source("Cluster B", last_success=(datetime.now(UTC) - timedelta(hours=1)).isoformat())
    store.save_snapshot(
        "cluster-a-alice",
        {
            "jobs": [
                running_job(),
                running_job("cluster-a:2", gpu_count=None),
                running_job("cluster-a:3", gpu_count=None),
            ]
        },
    )
    store.save_snapshot(
        "cluster-b-alice", {"jobs": [running_job("cluster-b:1", "cluster-b-alice", 64)]}
    )
    point = latest_point(store)
    assert point["known_allocated_gpus"] == 8
    assert point["allocated_gpus"] is None
    assert point["unknown_allocation_sources"] == 2


def test_disabled_source_is_ignored_but_manual_instance_remains_unknown(
    store: Store, add_source: AddSource
) -> None:
    add_source()
    cloud = add_source("RunPod", driver="runpod", enabled=False)
    store.save_snapshot("cluster-a-alice", {"jobs": [running_job()]})
    store.save_snapshot(
        cloud["id"],
        {
            "instances": [
                {"id": "runpod:auto", "source_id": cloud["id"], "state": "missing", "gpu_count": 4}
            ]
        },
    )
    point = latest_point(store)
    assert point["allocated_gpus"] == point["known_allocated_gpus"] == 8
    assert point["unknown_allocation_sources"] == 0
    store.save_instance(
        {
            "id": "manual:lab-box1",
            "source_id": "manual",
            "manual": True,
            "state": "unknown",
            "gpu_count": 2,
            "ssh_status": "reachable",
            "observed_at": now(),
            "gpu_observed_count": 2,
            "gpu_utilization": 75,
        }
    )
    point = latest_point(store)
    assert point["known_allocated_gpus"] == 8
    assert point["allocated_gpus"] is None
    assert point["unknown_allocation_sources"] == 1
    assert point["gpu_utilization"] == 75
    assert point["coverage_count"] == 2


def test_unknown_allocation_stays_a_gap_while_cloud_metrics_remain_observable(
    store: Store,
) -> None:
    store.save_instance(
        {
            "id": "manual:lab-box1",
            "source_id": "manual",
            "manual": True,
            "state": "unknown",
            "gpu_count": 2,
            "gpu_observed_count": 1,
            "gpu_utilization": 75,
            "ssh_status": "reachable",
            "observed_at": now(),
        }
    )
    point = latest_point(store)
    assert point["allocated_gpus"] is None
    assert point["gpu_utilization"] == 75
    assert point["coverage_count"] == 1


def test_old_probe_measurements_do_not_count_as_current(store: Store) -> None:
    store.save_instance(
        {
            "id": "manual:lab-box1",
            "source_id": "manual",
            "manual": True,
            "state": "unknown",
            "gpu_observed_count": 1,
            "gpu_utilization": 75,
            "ssh_status": "reachable",
            "observed_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
        }
    )
    point = latest_point(store)
    assert point["gpu_utilization"] is None
    assert point["coverage_count"] == 0


def test_utilization_is_weighted_by_observed_gpus(store: Store, add_source: AddSource) -> None:
    add_source()
    store.save_snapshot(
        "cluster-a-alice",
        {
            "jobs": [
                {**running_job(gpu_count=4), "gpu_utilization": 100},
                {**running_job("cluster-a:2", gpu_count=4), "gpu_utilization": 40},
                {
                    **running_job("cluster-a:3", gpu_count=8),
                    "gpu_utilization": 10,
                    "gpu_observed_count": 2,
                },
            ]
        },
    )
    point = latest_point(store)
    assert point["allocated_gpus"] == 16
    assert point["coverage_count"] == 10
    assert point["gpu_utilization"] == (100 * 4 + 40 * 4 + 10 * 2) / 10


def test_old_null_history_is_not_backfilled_as_zero(store: Store, add_source: AddSource) -> None:
    old = {
        "at": (datetime.now(UTC) - timedelta(minutes=5)).isoformat(),
        "allocated_gpus": None,
        "gpu_utilization": None,
        "coverage_count": 0,
    }
    with store.db:
        store.db.execute("INSERT INTO history VALUES (?, ?)", (old["at"], json.dumps(old)))
    add_source()
    latest_point(store)
    history = store.dashboard()["history"]
    assert len(history) == 2
    preserved = history[0]
    assert preserved == old
    assert "known_allocated_gpus" not in preserved
    assert "unknown_allocation_sources" not in preserved
    assert history[1]["allocated_gpus"] == 0


def test_history_older_than_a_week_is_pruned(store: Store) -> None:
    old = {"at": (datetime.now(UTC) - timedelta(days=8)).isoformat(), "allocated_gpus": 1}
    with store.db:
        store.db.execute("INSERT INTO history VALUES (?, ?)", (old["at"], json.dumps(old)))
    store.record_history()
    history = store.dashboard()["history"]
    assert len(history) == 1
    assert history[0]["at"] != old["at"]


def insert_point(store: Store, at: datetime, allocated: int | None) -> None:
    point = {"at": at.isoformat(), "allocated_gpus": allocated, "gpu_utilization": None}
    with store.db:
        store.db.execute("INSERT INTO history VALUES (?, ?)", (point["at"], json.dumps(point)))


def test_history_range_excludes_older_points(store: Store) -> None:
    current = datetime.now(UTC)
    insert_point(store, current - timedelta(hours=30), 4)
    insert_point(store, current - timedelta(hours=2), 6)
    assert [point["allocated_gpus"] for point in store.history(24)] == [6]
    assert [point["allocated_gpus"] for point in store.history(72)] == [4, 6]
    assert [point["allocated_gpus"] for point in store.dashboard()["history"]] == [6]


def test_thinning_keeps_whole_points_and_gaps(store: Store) -> None:
    current = datetime.now(UTC)
    # Two points per bucket when thinning 24 h to 12 points; the later one is kept as is.
    for index in range(24):
        at = current - timedelta(hours=23.9 - index)
        insert_point(store, at, None if index % 2 else index)
    points = store.history(24, max_points=12)
    assert 10 <= len(points) <= 13
    assert all(point["allocated_gpus"] is None for point in points)
    times = [point["at"] for point in points]
    assert times == sorted(times)
