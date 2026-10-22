"""Resolved SSH hosts count with their scheduler, across all summary scopes."""

import json
import os
import subprocess
import sys
from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from computedeck.app import create_app
from computedeck.demo import dashboard
from computedeck.drivers import kubernetes, pbs, slurm, ssh_host
from computedeck.hardware import parse_probe
from computedeck.host_identity import ssh_endpoint
from computedeck.records import InstanceInput, instance_record, keep_instance_probe
from computedeck.summary import summarize
from tests.test_api import HEADERS, wait_until_idle
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
        host_name="gpu-01.example.test",
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
        probe_output(ssh_connection=f"192.0.2.5 12345 {server_address} 22", hostname="gpu-01"),
        source,
        "console",
    )
    store.save_snapshot(source["id"], {"instances": batch.instances})
    for status in ("ready", "error"):
        store.save_source({**source, "status": status})
        data = store.dashboard()
        assert all(i.get("same_node") for i in data["instances"])
        assert data["summary"]["allocated"] == 2
        assert data["summary"]["sources"][source["id"]]["allocated"] == 0
        assert not data["summary"]["unmeasured"]


def test_ssh_alias_edit_and_failed_collection_remove_retained_link(
    store, add_source, collected, tmp_path, monkeypatch
):
    source = add_source(name="Host console", driver="ssh", ssh_alias="console")
    batch = ssh_host.parse_machine(
        probe_output(ssh_connection="192.0.2.5 12345 192.0.2.31 22", hostname="gpu-01"),
        source,
        "console",
    )
    store.save_snapshot(source["id"], {"instances": batch.instances})
    assert all(i.get("same_node") for i in store.dashboard()["instances"])

    async def fail(self, edited):
        assert edited["ssh_alias"] == "other-box"
        raise ssh_host.SourceError("ssh_failed")

    monkeypatch.setattr(ssh_host.SSHHostDriver, "collect", fail)
    with TestClient(create_app(tmp_path, polling=False, plugins=[])) as client:
        response = client.put(
            f"/api/sources/{source['id']}", json={"ssh_alias": "other-box"}, headers=HEADERS
        )
        assert response.status_code == 200
        assert response.json()["last_success"] is None
        response = client.post("/api/refresh", json={"source_id": source["id"]}, headers=HEADERS)
        assert response.status_code == 202
        data = wait_until_idle(client)
    retained = next(i for i in data["instances"] if i["source_id"] == source["id"])
    assert retained["ssh_endpoint"] == batch.instances[0]["ssh_endpoint"]
    assert "same_node" not in retained
    failed = next(s for s in data["sources"] if s["id"] == source["id"])
    assert failed["last_success"] is None
    assert failed["status"] == "error"
    missing = data["summary"]["unmeasured"]
    assert [row["subject"]["id"] for row in missing] == [source["id"]]
    assert missing[0]["reason"]["code"] == "summary_source_failed"
    assert data["summary"]["allocated"] is None


@pytest.mark.parametrize("address", ["10.128.0.2", "100.64.0.2", "fd00::2", "192.0.2.31"])
@pytest.mark.parametrize("hostname", ["other-box", None, "", "10.128.0.2"])
def test_shared_network_address_requires_independent_hostname(store, collected, address, hostname):
    source, node, item = collected
    store.save_snapshot(source["id"], {"nodes": [{**node, "host_addresses": [address]}]})
    store.save_instance(
        {**item, "ssh_endpoint": {"host": address, "port": 22}, "host_name": hostname}
    )
    data = store.dashboard()
    assert not data["instances"][0].get("same_node")
    assert data["summary"]["allocated"] == 8
    assert data["summary"]["groups"]["platform:workstations"]["allocated"] == 6
    store.record_history()
    assert store.history(24)[-1]["allocated_gpus"] == 8


@pytest.mark.parametrize("name", ["missing", None])
def test_plugin_node_without_display_name_uses_id(store, collected, name):
    source, node, _ = collected
    node = {**node, "host_names": ["GPU-01.cluster.example.test."]}
    if name == "missing":
        node.pop("name")
    else:
        node["name"] = name
    store.save_snapshot(source["id"], {"nodes": [node]})
    data = store.dashboard()
    assert data["instances"][0]["same_node"]["name"] == node["id"]
    assert data["summary"]["allocated"] == 2


@pytest.mark.parametrize("host_names", [5, True, {"gpu-01": 1}, "gpu-01"])
def test_plugin_node_ignores_non_list_host_names(store, collected, host_names):
    source, node, _ = collected
    node = {**node, "name": "other-box", "host_names": host_names}
    store.save_snapshot(source["id"], {"nodes": [node]})
    data = store.dashboard()
    assert "same_node" not in data["instances"][0]
    assert data["summary"]["allocated"] == 8
    assert data["summary"]["groups"]["platform:workstations"]["allocated"] == 6


@pytest.mark.parametrize("driver", ["slurm", "kubernetes"])
def test_scheduler_hostname_corroborates_address_when_node_name_differs(store, collected, driver):
    source, _, _ = collected
    if driver == "slurm":
        nodes = slurm.parse_nodes(
            "NodeName=display NodeAddr=192.0.2.31 NodeHostName=GPU-01.cluster.example.test "
            "State=MIXED Partitions=gpu CfgTRES=gres/gpu=8 AllocTRES=gres/gpu=6",
            source,
        )
    else:
        nodes = kubernetes.parse_nodes(
            [
                {
                    "metadata": {"name": "display"},
                    "status": {
                        "capacity": {"nvidia.com/gpu": "8"},
                        "allocatable": {"nvidia.com/gpu": "8"},
                        "addresses": [
                            {"type": "InternalIP", "address": "192.0.2.31"},
                            {"type": "Hostname", "address": "GPU-01.cluster.example.test"},
                        ],
                    },
                }
            ],
            [],
            source,
        )
    assert nodes[0]["host_names"] == ["GPU-01.cluster.example.test"]
    store.save_snapshot(source["id"], {"nodes": nodes})
    data = store.dashboard()
    assert data["instances"][0]["same_node"]["name"] == "display"
    assert data["summary"]["allocated"] == 2


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
    old.update(
        parse_probe(probe_output(ssh_connection="192.0.2.5 12345 192.0.2.31 22", hostname="gpu-01"))
    )
    renamed = {**old, "name": "Renamed"}
    renamed.pop("ssh_endpoint")
    renamed.pop("host_name")
    keep_instance_probe(renamed, old)
    assert renamed["ssh_endpoint"] == old["ssh_endpoint"]
    assert renamed["host_name"] == "gpu-01"
    changed = {**renamed, "host": "192.0.2.32"}
    changed.pop("ssh_endpoint")
    changed.pop("host_name")
    keep_instance_probe(changed, old)
    assert "ssh_endpoint" not in changed
    assert "host_name" not in changed
    old.update(parse_probe(probe_output()))
    assert old["ssh_endpoint"] is None
    assert old["host_name"] is None


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
    assert result["host_name"] == os.uname().nodename
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
        return probe_output(ssh_connection="192.0.2.5 12345 192.0.2.31 22", hostname="gpu-01")

    monkeypatch.setattr(ssh, "run", run)
    # A direct hand-added endpoint, while the display name remains different.
    store.save_instance({**item, "host": "192.0.2.31", "username": "alice"})
    await Collector(runtime).probe(item["id"])
    assert calls == ["192.0.2.31"]
    data = store.dashboard()
    assert data["instances"][0]["same_node"]["name"] == "gpu-01"
    assert data["instances"][0]["gpu_allocated"] == 1
    assert data["summary"]["allocated"] == 2
