"""Resolved SSH hosts count with their scheduler, across all summary scopes."""

import json
import subprocess
import sys
from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest

from computedeck.demo import dashboard
from computedeck.drivers import kubernetes, pbs, slurm, ssh_host
from computedeck.hardware import parse_probe
from computedeck.host_identity import ssh_endpoint
from computedeck.records import InstanceInput, instance_record, keep_instance_probe
from computedeck.summary import summarize
from tests.test_ssh_host import SOURCE, probe_output
from tests.test_summary import machine


@pytest.fixture
def collected(store, add_source):
    source = add_source(capabilities=["jobs", "nodes"])
    nodes = slurm.parse_nodes(
        "NodeName=gpu-01 NodeAddr=192.0.2.31 State=MIXED Partitions=gpu "
        "CfgTRES=gres/gpu=8 AllocTRES=gres/gpu=6",
        source,
    )
    job = {"id": "job-1", "source_id": source["id"], "state": "RUNNING", "gpu_count": 2}
    store.save_snapshot(source["id"], {"nodes": nodes, "jobs": [job]})
    item = machine(
        "console-alias",
        host="unrelated-alias",
        port=22,
        ssh_endpoint={"host": "192.0.2.31", "port": 22},
        gpu_allocated=6,
    )
    store.save_instance(item)
    return source, nodes[0], item


def test_manual_identity_counts_with_cluster_at_every_scope_and_in_history(store, collected):
    source, node, item = collected
    data = store.dashboard()
    assert data["instances"][0]["same_node"] == {
        "id": node["id"],
        "name": "gpu-01",
        "cluster_id": source["cluster_id"],
        "cluster_name": source["name"],
    }
    summary = data["summary"]
    # Own jobs win, not host-visible use or the all-users node allocation (6).
    assert summary["allocated"] == summary["known_allocated"] == 2
    assert summary["nodes"]["allocated"] == 6
    assert summary["groups"]["platform:workstations"]["allocated"] == 0
    assert summary["sources"][source["id"]]["allocated"] == 2
    assert summary["covered"] == 0
    assert data["instances"][0]["gpu_allocated"] == 6
    assert store.manual_instances()[0]["monitoring"] is True
    store.record_history()
    assert store.history(24)[-1]["allocated_gpus"] == 2
    assert store.history_rollups(24)["buckets"][-1]["groups"]
    # A typed price is still an expense; only duplicate GPU measurements are excluded.
    store.save_instance({**item, "hourly_cost": 0.5, "currency": "USD"})
    assert store.dashboard()["summary"]["spend"]["rates"] == {"USD": 0.5}


@pytest.mark.parametrize(
    "changes",
    [
        {"ssh_endpoint": None, "name": "gpu-01", "host": "192.0.2.31"},
        {"ssh_endpoint": {"host": "192.0.2.32", "port": 22}},
        {"ssh_endpoint": {"host": "192.0.2.31", "port": 2200}},
        {"ssh_endpoint": {"host": "gpu-01", "port": 22}},
    ],
)
def test_no_name_endpoint_guess_or_port_forward_match(store, collected, changes):
    _, _, item = collected
    store.save_instance({**item, **changes})
    data = store.dashboard()
    assert not data["instances"][0].get("same_node")
    assert data["summary"]["allocated"] == 8


@pytest.mark.parametrize(
    "change",
    [{"status": "error"}, {"last_success": (datetime.now(UTC) - timedelta(hours=1)).isoformat()}],
)
def test_stale_cluster_does_not_replace_own_allocation_with_host_use(store, collected, change):
    source, _, _ = collected
    store.save_source({**source, **change})
    data = store.dashboard()
    assert data["instances"][0]["same_node"]
    assert data["summary"]["allocated"] is None
    assert data["summary"]["known_allocated"] == 0
    assert [r["subject"]["id"] for r in data["summary"]["unmeasured"]] == [source["id"]]


@pytest.mark.parametrize("action", ["disabled", "removed", "node_removed", "address_changed"])
def test_removed_or_paused_identity_restores_machine_count(store, collected, action):
    source, node, _ = collected
    if action == "disabled":
        store.save_source({**source, "enabled": False})
    elif action == "removed":
        store.delete_source(source["id"])
    else:
        store.save_snapshot(
            source["id"],
            {
                "nodes": []
                if action == "node_removed"
                else [{**node, "host_addresses": ["192.0.2.99"]}]
            },
        )
    data = store.dashboard()
    assert not data["instances"][0].get("same_node")
    assert data["summary"]["known_allocated"] >= 6


def test_twins_are_one_identity_but_multiple_nodes_are_ambiguous(store, add_source, collected):
    source, node, _ = collected
    twin = add_source(username="bob", capabilities=["jobs", "nodes"])
    assert twin["cluster_id"] == source["cluster_id"]
    store.save_snapshot(twin["id"], {"nodes": [{**node, "source_id": twin["id"]}]})
    assert store.dashboard()["instances"][0]["same_node"]
    other = add_source(name="Cluster B", capabilities=["jobs", "nodes"])
    store.save_snapshot(
        other["id"],
        {
            "nodes": [
                {
                    **node,
                    "source_id": other["id"],
                    "id": "other:gpu-01",
                    "cluster_id": other["cluster_id"],
                }
            ]
        },
    )
    assert not store.dashboard()["instances"][0].get("same_node")


def test_collection_nodes_are_separate_address_spaces(store, collected):
    source, _, _ = collected
    store.save_source({**source, "node": "collector-b"})
    assert not store.dashboard()["instances"][0].get("same_node")


@pytest.mark.parametrize("server_address", ["192.0.2.31", "::ffff:192.0.2.31"])
def test_ssh_source_matches_and_stale_duplicate_does_not_blank_totals(
    store, add_source, collected, server_address
):
    source = add_source(name="Host console", driver="ssh", ssh_alias="console")
    batch = ssh_host.parse_machine(
        probe_output(ssh_connection=f"192.0.2.5 12345 {server_address} 22"), source, "console"
    )
    store.save_snapshot(source["id"], {"instances": batch.instances})
    for status in ("ready", "error"):
        store.save_source({**source, "status": status})
        data = store.dashboard()
        assert all(i.get("same_node") for i in data["instances"])
        assert data["summary"]["allocated"] == 2
        assert data["summary"]["sources"][source["id"]]["allocated"] == 0
        assert not data["summary"]["unmeasured"]


def test_probe_identity_is_cleared_on_endpoint_edit_and_missing_new_reading():
    old = instance_record(
        InstanceInput(
            platform="Workstations",
            external_id="console",
            name="Console",
            host="192.0.2.31",
            username="alice",
        )
    )
    old.update(parse_probe(probe_output(ssh_connection="192.0.2.5 12345 192.0.2.31 22")))
    renamed = {**old, "name": "Renamed"}
    renamed.pop("ssh_endpoint")
    keep_instance_probe(renamed, old)
    assert renamed["ssh_endpoint"] == old["ssh_endpoint"]
    changed = {**renamed, "host": "192.0.2.32"}
    changed.pop("ssh_endpoint")
    keep_instance_probe(changed, old)
    assert "ssh_endpoint" not in changed
    old.update(parse_probe(probe_output()))
    assert old["ssh_endpoint"] is None


@pytest.mark.parametrize(
    "connection, expected",
    [
        ("192.0.2.5 12345 192.0.2.31 22", {"host": "192.0.2.31", "port": 22}),
        ("192.0.2.5 12345 ::ffff:192.0.2.31 22", {"host": "192.0.2.31", "port": 22}),
        ("192.0.2.5 1 ::ffff:127.0.0.1 22", None),
        ("2001:db8::1 12345 2001:db8:0::2 22", {"host": "2001:db8::2", "port": 22}),
        (None, None),
        ("", None),
        ("bad", None),
        ("192.0.2.5 1 localhost 22", None),
        ("192.0.2.5 1 127.0.0.1 22", None),
        ("192.0.2.5 1 fe80::1 22", None),
        ("192.0.2.5 1 0.0.0.0 22", None),
        ("192.0.2.5 1 192.0.2.31 99999", None),
    ],
)
def test_connection_identity(connection, expected):
    assert ssh_endpoint(connection) == expected
    output = probe_output(ssh_connection=connection)
    assert parse_probe(output)["ssh_endpoint"] == expected
    assert ssh_host.parse_machine(output, SOURCE, "alias").instances[0]["ssh_endpoint"] == expected


def test_embedded_probe_reads_only_server_endpoint_from_existing_session():
    connection = "192.0.2.5 12345 192.0.2.31 22"
    done = subprocess.run(
        [sys.executable, "-I", "-c", ssh_host._PROBE],
        env={"PATH": "", "SSH_CONNECTION": connection},
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    result = parse_probe(done.stdout)
    assert result["ssh_endpoint"] == {"host": "192.0.2.31", "port": 22}
    assert "192.0.2.5" not in json.dumps(result)


def test_scheduler_addresses_never_use_display_names():
    node = slurm.parse_nodes("NodeName=192.0.2.31 NodeHostName=192.0.2.31 State=IDLE", SOURCE)[0]
    assert node["host_addresses"] == []
    node = pbs.parse_nodes(
        json.dumps(
            {
                "nodes": {
                    "display": {
                        "state": "free",
                        "Mom": "192.0.2.31",
                        "resources_available": {"ngpus": 4},
                    }
                }
            }
        ),
        SOURCE,
    )[0]
    assert node["host_addresses"] == ["192.0.2.31"]
    node = kubernetes.parse_nodes(
        [
            {
                "metadata": {"name": "display"},
                "status": {
                    "capacity": {"nvidia.com/gpu": "4"},
                    "allocatable": {"nvidia.com/gpu": "4"},
                    "addresses": [
                        {"type": "Hostname", "address": "192.0.2.32"},
                        {"type": "InternalIP", "address": "192.0.2.31"},
                    ],
                },
            }
        ],
        [],
        SOURCE,
    )[0]
    assert node["host_addresses"] == ["192.0.2.31"]


def test_example_is_linked_without_changing_totals_or_spend():
    data = dashboard()
    item = next(i for i in data["instances"] if i["name"] == "node-console")
    assert item["same_node"]["name"] == "a-gpu-01"
    assert item["id"] == "example:manual:lab-workstation-node-console"
    assert item["external_id"] == "node-console"
    assert item["ssh_alias"] == "cd-lab-workstation-node-console"
    without = deepcopy(data)
    without["instances"] = [i for i in without["instances"] if i["id"] != item["id"]]
    assert summarize(without)["known_allocated"] == data["summary"]["known_allocated"] == 27
    assert summarize(without)["spend"] == data["summary"]["spend"]


async def test_on_demand_check_of_linked_machine_still_collects_and_keeps_scheduler_count(
    store, collected, monkeypatch, tmp_path
):
    from computedeck.collector import Collector
    from computedeck.drivers import ssh
    from computedeck.plugins import Runtime

    _, _, item = collected
    runtime = Runtime(tmp_path)
    runtime.store = store
    calls = []

    async def run(destination, command, options):
        calls.append(destination)
        return probe_output(ssh_connection="192.0.2.5 12345 192.0.2.31 22")

    monkeypatch.setattr(ssh, "run", run)
    # A direct hand-added endpoint, while the display name remains different.
    store.save_instance({**item, "host": "192.0.2.31", "username": "alice"})
    await Collector(runtime).probe(item["id"])
    assert calls == ["192.0.2.31"]
    data = store.dashboard()
    assert data["instances"][0]["same_node"]["name"] == "gpu-01"
    assert data["instances"][0]["gpu_allocated"] == 1
    assert data["summary"]["allocated"] == 2
