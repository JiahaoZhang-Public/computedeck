"""One server contract for fleet, login, history, navigation and usable capacity."""

from datetime import UTC, datetime, timedelta

import pytest

from computedeck import attention
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
        "running_ids": ["cluster-a:1"],
        "pending_ids": [fresh["id"] + ":queued", stale["id"] + ":queued"],
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
        ("idle+POWERING_DOWN", "on_demand"),
        ("idle+POWERED_DOWN", "on_demand"),
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
            "on_demand": "available",
            "unavailable": "unavailable",
            "unknown": "unknown",
        }[health]
    )


def test_outage_has_no_usable_capacity_and_disabled_nodes_are_excluded(store, add_source):
    active = add_source(capabilities=["nodes", "jobs"], cluster_state="unavailable")
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
                    "partitions": ["gpu"],
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


@pytest.mark.parametrize("state", ["new_scheduler_state"])
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
                    "partitions": ["gpu"],
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
        assert ("running_ids" in scope["jobs"]) == (scope is summary)
        assert ("pending_ids" in scope["jobs"]) == (scope is summary)
    assert len(summary["jobs"]["current_ids"]) == summary["jobs"]["known"] == 36


@pytest.mark.parametrize("known_source", [True, False])
def test_null_instance_platform_does_not_break_dashboard_or_history(
    store, add_source, known_source
):
    if known_source:
        source = add_source(driver="runpod")
        store.save_snapshot(
            source["id"],
            {
                "instances": [
                    {
                        "id": "pod-1",
                        "source_id": source["id"],
                        "platform": None,
                        "state": "running",
                        "gpu_count": 1,
                    }
                ]
            },
        )
        group = source["cluster_id"]
    else:
        store.save_instance(machine(platform=None))
        group = "platform:"
    data = store.dashboard()
    assert data["instances"][0]["platform"] is None
    assert data["summary"]["groups"][group]["allocated"] == 1
    assert data["summary"]["allocated"] == 1
    store.record_history()
    assert store.history(24)[-1]["allocated_gpus"] == 1


def test_job_tab_ids_use_the_same_states_as_counts(store, add_source):
    from computedeck.summary import PENDING, RUNNING

    source = add_source()
    states = sorted(RUNNING | PENDING | {"COMPLETED", "FAILED", "UNKNOWN"})
    store.save_snapshot(
        source["id"],
        {
            "jobs": [
                {
                    "id": f"cluster-a:{state}",
                    "source_id": source["id"],
                    "cluster_id": source["cluster_id"],
                    "state": state.lower(),
                    "gpu_count": 1,
                }
                for state in states
            ]
        },
    )
    summary = store.dashboard()["summary"]
    assert set(summary["jobs"]["running_ids"]) == {f"cluster-a:{state}" for state in RUNNING}
    assert set(summary["jobs"]["pending_ids"]) == {f"cluster-a:{state}" for state in PENDING}
    assert len(summary["jobs"]["running_ids"]) == summary["known_running"]
    assert len(summary["jobs"]["pending_ids"]) == summary["known_pending"]


def test_gpu_outage_is_not_hidden_by_cpu_nodes_or_unknown_gpu_counts() -> None:
    from computedeck.drivers.base import cluster_state
    from computedeck.summary import summarize_nodes

    nodes = [
        {
            "id": "gpu1",
            "name": "gpu1",
            "cluster_id": "a",
            "state": "down",
            "gpu_count": 8,
            "gpu_allocated": 0,
        },
        {
            "id": "gpu2",
            "name": "gpu2",
            "cluster_id": "a",
            "state": "drained",
            "gpu_count": None,
            "gpu_allocated": 0,
        },
    ]
    assert cluster_state(nodes) == "unavailable"
    summary = summarize_nodes(nodes)
    assert summary["nodes"] == summary["abnormal"] == 2
    assert summary["usable"] == 0
    assert summary["unavailable"] is None
    nodes.append(
        {
            "id": "cpu",
            "name": "cpu",
            "cluster_id": "a",
            "state": "idle",
            "gpu_count": 0,
            "gpu_allocated": 0,
        }
    )
    assert cluster_state(nodes) == "unavailable"
    assert summarize_nodes(nodes)["usable"] == 0


@pytest.mark.parametrize(
    ("state", "partitions", "expected"),
    [
        ("IDLE", [], "unavailable"),
        ("IDLE+CLOUD+POWERED_DOWN", [], "unavailable"),
        ("IDLE+CLOUD+POWERED_DOWN", ["gpu"], "on_demand"),
        ("DOWN+CLOUD+POWERED_DOWN", ["gpu"], "unavailable"),
        ("IDLE+CLOUD+POWERING_UP", ["gpu"], "on_demand"),
        ("IDLE+POWERING_DOWN", ["gpu"], "on_demand"),
        ("ALLOCATED+CLOUD+POWERING_UP", ["gpu"], "usable"),
        ("MIXED+POWER_DOWN", ["gpu"], "usable"),
        ("COMPLETING+POWER_DOWN", ["gpu"], "usable"),
        ("job-busy+sleep", None, "usable"),
        ("POWERING_UP", ["gpu"], "on_demand"),
        ("IDLE+DYNAMIC_FUTURE", ["gpu"], "usable"),
        ("IDLE+ERROR", ["gpu"], "unavailable"),
        ("FUTURE", ["gpu"], "unavailable"),
        ("ERROR", ["gpu"], "unavailable"),
        ("provisioning", None, "on_demand"),
        ("sleep", None, "on_demand"),
        ("wait-provisioning", None, "on_demand"),
        ("free+sleep", None, "on_demand"),
        ("idle", ["gpu"], "usable"),
        ("mixed", None, "usable"),
        ("new_scheduler_state", ["gpu"], "unknown"),
    ],
)
def test_node_usability(state, partitions, expected):
    assert node_health(state, partitions=partitions) == expected


@pytest.mark.parametrize("driver", ["slurm", "pbs", "lsf", "kubernetes"])
def test_node_membership_and_power_in_dashboard(store, add_source, driver):
    source = add_source(driver=driver, capabilities=["jobs", "nodes"])
    rows = [
        {
            "id": f"cluster-a:node-{i}",
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": f"node-{i}",
            "state": state,
            "partitions": partitions,
            "gpu_count": 8,
            "gpu_allocated": 2 if state == "mixed" else 0,
        }
        for i, (state, partitions) in enumerate(
            [
                ("mixed", ["gpu"]),
                ("idle", []),
                ("IDLE+CLOUD+POWERED_DOWN", ["gpu"]),
                ("IDLE+CLOUD+POWERING_UP", ["gpu"]),
                ("FUTURE", ["gpu"]),
                ("ERROR", ["gpu"]),
                ("provisioning", ["gpu"]),
                ("sleep", ["gpu"]),
                ("wait-provisioning", ["gpu"]),
            ]
        )
    ]
    store.save_snapshot(source["id"], {"nodes": rows})
    data = store.dashboard()
    assert [n["health"] for n in data["nodes"]] == [
        "usable",
        "unavailable" if driver == "slurm" else "usable",
        "on_demand",
        "on_demand",
        "unavailable",
        "unavailable",
        *(["on_demand"] * 3),
    ]
    assert data["nodes"][1]["health_reason"] == ("no_partition" if driver == "slurm" else None)
    expected_usable = 8 if driver == "slurm" else 16
    for scope in [
        data["summary"],
        data["summary"]["groups"][source["cluster_id"]],
        data["summary"]["sources"][source["id"]],
    ]:
        assert scope["nodes"]["usable"] == expected_usable
        assert scope["nodes"]["allocated"] == 2
        assert scope["nodes"]["unallocated"] == expected_usable - 2
        assert scope["nodes"]["unavailable"] == 32 - expected_usable
        assert scope["nodes"]["on_demand"] == 40
        assert sum(scope["nodes"][key] for key in ("usable", "unavailable", "on_demand")) == 72
        assert scope["nodes"]["unknown"] == 0
    assert cluster_state(rows, require_partition=driver == "slurm") == "available"
    assert cluster_state(rows[1:], require_partition=True) == "available"


@pytest.mark.parametrize("fault", ["DOWN", "DRAIN", "IDLE*", "RESERVED", "FUTURE", "ERROR"])
@pytest.mark.parametrize("saving", ["CLOUD+POWERED_DOWN", "POWERING_UP", "sleep"])
def test_node_faults_take_priority_over_power_saving(fault, saving):
    assert node_health(f"{fault}+{saving}", partitions=["gpu"]) == "unavailable"


@pytest.mark.parametrize(
    "state",
    [
        "IDLE+CLOUD+POWERED_DOWN",
        "IDLE+POWERED_DOWN",
        "IDLE+POWERING_DOWN",
        "IDLE+POWER_DOWN",
        "IDLE+POWERING_UP",
        "IDLE+POWER_UP",
        "IDLE+CLOUD+POWERING_UP",
        "sleep",
        "provisioning",
        "wait-provisioning",
        "free+sleep",
    ],
)
def test_power_saving_cluster_is_healthy_but_not_free(store, add_source, state):
    rows = [
        {
            "id": f"cluster-a:node-{i}",
            "name": f"node-{i}",
            "state": state,
            "partitions": ["gpu"],
            "gpu_count": 8,
            "gpu_allocated": 0,
        }
        for i in range(2)
    ]
    status = cluster_state(rows, require_partition=True)
    assert status == "available"
    source = add_source(capabilities=["jobs", "nodes"], cluster_state=status)
    store.save_snapshot(source["id"], {"nodes": rows})
    data = store.dashboard()
    summary = data["summary"]["nodes"]
    assert summary["capacity"] == summary["on_demand"] == 16
    assert summary["usable"] == summary["unallocated"] == summary["unavailable"] == 0
    assert summary["abnormal"] == 0
    assert not any(
        item["kind"] in {"cluster_unavailable", "cluster_degraded"}
        for item in attention.derive(data, [], now=datetime.now(UTC))
    )
    # Even a non-faulty power-saving node needs a Slurm partition.
    assert node_health(state, partitions=[]) == "unavailable"


@pytest.mark.parametrize("state", ["ALLOCATED+CLOUD+POWERING_UP", "MIXED+POWER_DOWN"])
def test_power_flags_keep_assigned_work_in_capacity(store, add_source, state):
    source = add_source(capabilities=["jobs", "nodes"])
    allocation = 8 if state.startswith("ALLOCATED") else 3
    rows = [
        {
            "id": f"cluster-a:node-{i}",
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": f"node-{i}",
            "state": value,
            "partitions": ["gpu"],
            "gpu_count": 8,
            "gpu_allocated": allocated,
        }
        for i, (value, allocated) in enumerate([(state, allocation), ("mixed", 2)])
    ]
    store.save_snapshot(source["id"], {"nodes": rows})
    data = store.dashboard()
    assert all(node["health"] == "usable" for node in data["nodes"])
    for scope in [
        data["summary"],
        data["summary"]["groups"][source["cluster_id"]],
        data["summary"]["sources"][source["id"]],
    ]:
        summary = scope["nodes"]
        assert summary["allocated"] == allocation + 2
        assert summary["usable"] == 16
        assert summary["unallocated"] == 16 - allocation - 2
        assert summary["on_demand"] == 0
    assert cluster_state(rows, require_partition=True) == "available"


def test_spend_rates_are_scoped_partial_and_never_mix_currencies(store, add_source) -> None:
    source = add_source(name="Cloud A", driver="runpod")
    at = now()

    def instance(name, state="running", price=1.5, currency="USD"):
        return {
            "id": name,
            "source_id": source["id"],
            "name": name,
            "state": state,
            "hourly_cost": price,
            "currency": currency,
            "observed_at": at,
        }

    store.save_snapshot(
        source["id"],
        {
            "instances": [
                instance("usd"),
                instance("eur", price=2, currency="EUR"),
                instance("usd2", state="reported_running", price=0.5),
                instance("free", price=0),
                instance("no-price", price=None),
                instance("stopping", state="desired_stopped", price=99),
                instance("starting", state="desired_running"),
                instance("stopped", state="stopped", price=99),
                instance("no-currency", currency=None),
            ]
        },
    )
    data = store.dashboard()
    spend = data["summary"]["spend"]
    assert spend["applies"] is True
    assert spend["rates"] == {"USD": 2, "EUR": 2}
    assert spend["priced"] == 4
    assert {i["subject"]["id"]: i["reason"]["code"] for i in spend["unpriced"]} == {
        "no-price": "summary_price_missing",
        "starting": "summary_lifecycle_unknown",
        "no-currency": "summary_price_missing",
    }
    assert data["summary"]["sources"][source["id"]]["spend"] == spend
    assert data["summary"]["groups"][source["cluster_id"]]["spend"] == spend
    store.save_instance(machine(hourly_cost=3, currency="USD"))
    assert store.dashboard()["summary"]["spend"]["rates"] == {"USD": 5, "EUR": 2}
    store.save_instance(machine(hourly_cost=3, currency="USD", ssh_status="error"))
    spend = store.dashboard()["summary"]["spend"]
    assert spend["applies"] is True
    assert spend["rates"] == {"USD": 2, "EUR": 2}
    assert spend["unpriced"][-1]["reason"]["code"] == "summary_lifecycle_unknown"


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"stale": True}, "summary_source_stale"),
        ({"last_success": None}, "summary_not_collected"),
        ({"status": "error"}, "summary_source_failed"),
        ({"capabilities": []}, "summary_capability_missing"),
        ({"enabled": False}, None),
    ],
)
def test_spend_excludes_unavailable_sources(changes, reason) -> None:
    source = {
        "id": "cloud",
        "cluster_id": "cloud",
        "name": "Cloud A",
        "kind": "cloud",
        "enabled": True,
        "status": "ready",
        "last_success": now(),
        "capabilities": ["instances"],
        **changes,
    }
    data = {
        "sources": [source],
        "jobs": [],
        "nodes": [],
        "instances": [
            {
                "id": "pod",
                "source_id": "cloud",
                "state": "running",
                "hourly_cost": 2,
                "currency": "USD",
            },
        ],
    }
    spend = summarize(data)["spend"]
    assert spend["applies"] is source["enabled"]
    assert spend["rates"] == {}
    assert spend["priced"] == 0
    assert [item["reason"]["code"] for item in spend["unpriced"]] == ([reason] if reason else [])
    # A never-collected source without any cached rows is still named.
    data["instances"] = []
    assert summarize(data)["spend"] == spend


def test_spend_uses_fresh_twin_before_deduplicating(store, add_source) -> None:
    good = add_source(name="Cloud A", driver="runpod", cluster_id="cloud-a")
    old = add_source(name="Cloud B", driver="runpod", cluster_id="cloud-a", status="error")
    stamp = datetime.now(UTC)
    row = {"id": "cloud-a:pod", "state": "running", "hourly_cost": 2, "currency": "USD"}
    store.save_snapshot(
        good["id"],
        {"instances": [{**row, "source_id": good["id"], "observed_at": stamp.isoformat()}]},
    )
    store.save_snapshot(
        old["id"],
        {
            "instances": [
                {
                    **row,
                    "source_id": old["id"],
                    "observed_at": (stamp + timedelta(minutes=1)).isoformat(),
                    "hourly_cost": 99,
                }
            ]
        },
    )
    data = store.dashboard()
    assert data["summary"]["spend"]["rates"] == {"USD": 2}
    assert data["summary"]["spend"]["priced"] == 1
    assert data["summary"]["groups"]["cloud-a"]["spend"]["rates"] == {"USD": 2}


@pytest.mark.parametrize("hourly_cost", [None, 0, 3])
@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"ssh_status": "error"},
        {"observed_at": None},
        {"monitoring": False, "observed_at": None},
    ],
)
def test_manual_spend_requires_a_typed_price(store, hourly_cost, changes) -> None:
    store.save_instance(machine(hourly_cost=hourly_cost, currency="USD", **changes))
    spend = store.dashboard()["summary"]["spend"]
    if hourly_cost is None:
        assert spend == {"applies": False, "rates": {}, "priced": 0, "unpriced": []}
    elif not changes:
        assert spend == {
            "applies": True,
            "rates": {"USD": hourly_cost},
            "priced": 1,
            "unpriced": [],
        }
    else:
        assert spend["applies"] is True
        assert spend["rates"] == {}
        assert spend["priced"] == 0
        assert spend["unpriced"] == [
            {
                "subject": {"kind": "instance", "id": "manual:dev-box", "name": "dev-box"},
                "reason": {"code": "summary_lifecycle_unknown"},
            }
        ]


@pytest.mark.parametrize("changes", [{}, {"stale": True}, {"status": "error"}])
def test_ssh_source_is_outside_spend_but_cloud_plugins_are_not(changes) -> None:
    source = {
        "id": "source",
        "name": "Example source",
        "cluster_id": "example",
        "kind": "cloud",
        "driver": "ssh",
        "enabled": True,
        "status": "ready",
        "last_success": now(),
        "capabilities": ["instances"],
        **changes,
    }
    data = {
        "sources": [source],
        "jobs": [],
        "nodes": [],
        "instances": [
            {
                "id": "host",
                "source_id": "source",
                "name": "dev-host",
                "state": "running",
                "hourly_cost": None,
            },
        ],
    }
    assert summarize(data)["spend"] == {"applies": False, "rates": {}, "priced": 0, "unpriced": []}
    source["driver"] = "example-cloud-plugin"
    spend = summarize(data)["spend"]
    assert spend["applies"] is source["enabled"]
    assert spend["rates"] == {}
    assert spend["priced"] == 0
    assert len(spend["unpriced"]) == 1
    assert spend["unpriced"][0]["subject"]["kind"] == ("source" if changes else "instance")
    assert spend["unpriced"][0]["reason"]["code"] == (
        "summary_source_stale"
        if changes.get("stale")
        else "summary_source_failed"
        if changes.get("status") == "error"
        else "summary_price_missing"
    )
