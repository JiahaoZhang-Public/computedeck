"""One server contract for fleet, login, history, navigation and usable capacity."""

from datetime import UTC, datetime, timedelta

import pytest

from computedeck.drivers.base import cluster_state, node_health
from computedeck.store import now
from computedeck.summary import summarize


def machine(name="dev-box", **changes):
    return {
        "id": f"manual:{name}",
        "source_id": "manual",
        "manual": True,
        "name": name,
        "platform": "Workstations",
        "monitoring": True,
        "state": "running",
        "ssh_status": "reachable",
        "observed_at": now(),
        "gpu_count": 8,
        "gpu_allocated": 1,
        "gpu_observed_count": 2,
        "gpu_utilization": 50,
        "cpu_utilization": 20,
        "memory_utilization": 30,
        **changes,
    }


def test_manual_machines_are_named_and_monitoring_off_is_out_of_scope(store):
    store.save_instance(machine())
    store.save_instance(machine("build-box", observed_at=None, gpu_allocated=None))
    store.save_instance(machine("ssh-shortcut", monitoring=False, gpu_allocated=8))
    data = store.dashboard()
    figures = data["summary"]
    assert figures["allocated"] is None
    assert figures["known_allocated"] == 1
    assert figures["unmonitored"] == 1
    assert figures["unmeasured"] == [
        {
            "subject": {"kind": "instance", "id": "manual:build-box", "name": "build-box"},
            "reason": {"code": "summary_not_probed_yet"},
        }
    ]
    assert figures["covered"] == 2
    assert figures["utilization"] == 50
    assert figures["cpu_utilization"] == 20
    assert figures["memory_utilization"] == 30
    assert figures["groups"]["platform:workstations"]["known_allocated"] == 1
    store.record_history()
    point = store.history(24)[-1]
    assert point["allocated_gpus"] == figures["allocated"]
    assert point["known_allocated_gpus"] == figures["known_allocated"]
    assert point["gpu_utilization"] == figures["utilization"]
    assert point["coverage_count"] == figures["covered"]


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"ssh_status": "error"}, "summary_probe_failed"),
        ({"observed_at": None}, "summary_not_probed_yet"),
        (
            {"observed_at": (datetime.now(UTC) - timedelta(minutes=21)).isoformat()},
            "summary_probe_stale",
        ),
        (
            {
                "gpu_allocated": None,
                "probe_warnings": [{"code": "gpu_processes_unavailable", "detail": "rocm-smi"}],
            },
            "summary_gpu_processes_unavailable",
        ),
    ],
)
def test_manual_reason_does_not_trust_persisted_running_state(store, changes, reason):
    store.save_instance(machine(**changes))
    figures = store.dashboard()["summary"]
    assert figures["allocated"] is None
    assert figures["known_allocated"] is None
    assert figures["unmeasured"][0]["reason"]["code"] == reason


def test_two_unmeasured_machines_are_not_one_manual_source(store):
    for name in ("dev-box", "build-box"):
        store.save_instance(machine(name, observed_at=None))
    figures = store.dashboard()["summary"]
    assert [entry["subject"]["name"] for entry in figures["unmeasured"]] == ["dev-box", "build-box"]
    assert figures["unknown_allocation_sources"] == 2
    assert all(entry["subject"]["kind"] == "instance" for entry in figures["unmeasured"])


def test_disabled_and_stale_logins_do_not_hide_a_fresh_shared_job(store, add_source):
    fresh = add_source(capabilities=["jobs", "nodes"])
    stale = add_source(username="bob", stale=True)
    disabled = add_source(username="carol", enabled=False)
    # Staleness is derived from time on reads.
    stale["last_success"] = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    store.save_source(stale)
    for source, count in ((fresh, 4), (stale, 8), (disabled, 16)):
        store.save_snapshot(
            source["id"],
            {
                "jobs": [
                    {
                        "id": "cluster-a:1",
                        "source_id": source["id"],
                        "cluster_id": source["cluster_id"],
                        "state": "RUNNING",
                        "gpu_count": count,
                        "gpu_utilization": 50,
                        "observed_at": now(),
                    },
                    {
                        "id": source["id"] + ":queued",
                        "source_id": source["id"],
                        "cluster_id": source["cluster_id"],
                        "state": "PENDING",
                        "gpu_count": 2,
                    },
                ]
            },
        )
    data = store.dashboard()
    figures = data["summary"]
    assert data["jobs"][0]["source_id"] == fresh["id"]
    assert figures["known_allocated"] == 4
    assert figures["allocated"] is None
    assert figures["known_requested"] == 2
    assert figures["requested"] is None
    assert figures["known_running"] == 1
    assert figures["running"] is None
    assert figures["jobs"] == {
        "known": 2,
        "total": None,
        "current_ids": ["cluster-a:1", fresh["id"] + ":queued"],
        "listed_ids": ["cluster-a:1", fresh["id"] + ":queued", stale["id"] + ":queued"],
        "missing_source_ids": [stale["id"]],
    }
    assert figures["unmeasured"][0]["subject"]["name"] == "Cluster A · bob"
    assert figures["unmeasured"][0]["reason"]["code"] == "summary_source_stale"
    assert figures["groups"][fresh["cluster_id"]]["known_allocated"] == 4
    assert figures["sources"][fresh["id"]]["allocated"] == 4
    assert figures["sources"][stale["id"]]["allocated"] is None
    assert figures["sources"][disabled["id"]]["jobs"]["total"] == 0
    store.record_history()
    assert store.history(24)[-1]["known_allocated_gpus"] == 4


def test_shared_jobs_remain_counted_in_each_fresh_login(store, add_source):
    for username in ("alice", "bob"):
        source = add_source(username=username)
        store.save_snapshot(
            source["id"],
            {
                "jobs": [
                    {
                        "id": "cluster-a:1",
                        "source_id": source["id"],
                        "cluster_id": source["cluster_id"],
                        "state": "CONFIGURING",
                        "gpu_count": 4,
                    }
                ]
            },
        )
    figures = store.dashboard()["summary"]
    assert figures["allocated"] == 4
    assert figures["running"] == 1
    assert all(row["allocated"] == 4 for row in figures["sources"].values())


@pytest.mark.parametrize(
    ("state", "health"),
    [
        ("RESERVED", "unavailable"),
        ("UNKNOWN", "unavailable"),
        ("idle*", "unavailable"),
        ("idle+POWERING_DOWN", "usable"),
        ("idle+POWERED_DOWN", "usable"),
        ("down+POWERING_UP", "unavailable"),
        ("not_ready+cordoned", "unavailable"),
        ("unrecognized", "unknown"),
        ("mixed", "usable"),
    ],
)
def test_one_node_health_rule(state, health):
    assert node_health(state) == health
    assert (
        cluster_state([{"state": state}])
        == {
            "usable": "available",
            "unavailable": "unavailable",
            "unknown": "unknown",
        }[health]
    )


def test_outage_has_no_usable_capacity_and_disabled_nodes_are_excluded(store, add_source):
    active = add_source(capabilities=["nodes", "jobs"])
    off = add_source(username="bob", enabled=False, capabilities=["nodes", "jobs"])
    for source, state in ((active, "RESERVED"), (off, "idle")):
        store.save_snapshot(
            source["id"],
            {
                "nodes": [
                    {
                        "id": source["id"] + ":node",
                        "source_id": source["id"],
                        "cluster_id": source["cluster_id"],
                        "name": "node-1",
                        "state": state,
                        "gpu_count": 8,
                        "gpu_allocated": 0,
                    }
                ]
            },
        )
    data = store.dashboard()
    assert (
        next(n for n in data["nodes"] if n["source_id"] == active["id"])["health"] == "unavailable"
    )
    assert data["sources"][0]["cluster_state"] == "unavailable"
    for scope in (
        data["summary"],
        data["summary"]["groups"][active["cluster_id"]],
        data["summary"]["sources"][active["id"]],
    ):
        assert scope["nodes"]["nodes"] == 1
        assert scope["nodes"]["capacity"] == 8
        assert scope["nodes"]["usable"] == 0
        assert scope["nodes"]["unavailable"] == 8
        assert scope["nodes"]["unallocated"] == 0
    active["last_success"] = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    store.save_source(active)
    assert store.dashboard()["summary"]["nodes"]["usable"] is None


def test_summary_does_not_mutate_dashboard(store, add_source):
    add_source()
    data = store.dashboard()
    original = repr(data)
    assert summarize(data) == data["summary"]
    assert repr(data) == original


def test_unrecognized_node_health_does_not_become_zero_capacity(store, add_source):
    source = add_source(capabilities=["jobs", "nodes"])
    store.save_snapshot(
        source["id"],
        {
            "nodes": [
                {
                    "id": "cluster-a:node",
                    "source_id": source["id"],
                    "cluster_id": source["cluster_id"],
                    "name": "node",
                    "state": "new_scheduler_state",
                    "gpu_count": 8,
                    "gpu_allocated": 0,
                }
            ]
        },
    )
    data = store.dashboard()
    assert data["nodes"][0]["health"] == "unknown"
    assert data["summary"]["nodes"]["capacity"] == 8
    assert data["summary"]["nodes"]["usable"] is None
    assert data["summary"]["nodes"]["known_usable"] == 0
    assert data["summary"]["nodes"]["unallocated"] is None


@pytest.mark.parametrize("state", ["FUTURE", "ERROR"])
def test_unknown_node_preserves_known_usable_capacity(store, add_source, state):
    source = add_source(capabilities=["jobs", "nodes"])
    store.save_snapshot(
        source["id"],
        {
            "nodes": [
                {
                    "id": f"cluster-a:node-{i}",
                    "source_id": source["id"],
                    "cluster_id": source["cluster_id"],
                    "name": f"node-{i}",
                    "state": health,
                    "gpu_count": 8,
                    "gpu_allocated": 2,
                }
                for i, health in enumerate(["mixed", state])
            ]
        },
    )
    summary = store.dashboard()["summary"]
    for scope in [
        summary,
        summary["groups"][source["cluster_id"]],
        summary["sources"][source["id"]],
    ]:
        assert scope["nodes"]["usable"] is None
        assert scope["nodes"]["known_usable"] == 8
        assert scope["nodes"]["capacity"] == 16


def test_summary_keys_are_snake_case_and_job_ids_only_appear_at_fleet_level():
    from computedeck.demo import dashboard

    summary = dashboard()["summary"]
    scopes = [summary, *summary["groups"].values(), *summary["sources"].values()]
    for scope in scopes:
        for row in [scope, scope["nodes"], scope["jobs"]]:
            assert all(key == key.lower() for key in row)
        assert {"known", "total", "missing_source_ids"} <= scope["jobs"].keys()
        assert ("current_ids" in scope["jobs"]) == (scope is summary)
        assert ("listed_ids" in scope["jobs"]) == (scope is summary)
    assert len(summary["jobs"]["current_ids"]) == summary["jobs"]["known"] == 6
