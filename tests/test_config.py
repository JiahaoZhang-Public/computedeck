"""TOML configuration: import/export round trip without runtime state or secrets."""

import tomllib
from pathlib import Path
from typing import Any

import pytest

from computedeck import config
from computedeck.config import ConfigError
from computedeck.store import Store, now

CONFIG = """
language = "zh-CN"
server_name = 'Lab "east" server \\ main'

[[cluster]]
id = "cluster-a"
label = "Cluster A"
ssh_alias = "cluster-a"
interval_minutes = 15

  [[cluster.identity]]
  username = "alice"

  [[cluster.identity]]
  username = "bob"
  interval_minutes = 30
  options = { partition = "gpu", note = "quoted \\"value\\"" }

[[cluster]]
label = "Cluster B"
username = "alice"
ssh_alias = "login.cluster-b"
node = "lab-gateway"
enabled = false

[[node]]
name = "Lab gateway"
id = "lab-gateway"
ssh_alias = "lab-gateway"
command = "~/.local/bin/computedeck"

[[cloud]]
id = "runpod"
label = "RunPod"
credential = "env:RUNPOD_API_KEY"

[[instance]]
platform = "Lab box"
id = "gpu1"
name = "GPU one"
host = "192.0.2.30"
port = 2222
username = "alice"
identity_file = "~/.ssh/id_ed25519"
gpu_count = 2
gpu_type = "RTX 4090"
hourly_cost = 0.5
monitoring = true

[[instance]]
platform = "Lab box"
id = "gpu2"
name = "GPU two"
host = "gpu-two"
existing_alias = true
"""

CONFIG_KEYS = (
    "id",
    "name",
    "driver",
    "cluster_id",
    "username",
    "ssh_alias",
    "credential",
    "enabled",
    "interval_minutes",
)


def open_store(path: Path) -> Store:
    return Store(path / "computedeck.sqlite")


def configuration(store: Store) -> list[dict[str, Any]]:
    return [{key: source[key] for key in CONFIG_KEYS} for source in store.sources()]


def test_import_creates_sources_instances_and_settings(store: Store) -> None:
    assert config.apply(store, CONFIG) == {"sources": 4, "instances": 2, "nodes": 1}
    assert configuration(store) == [
        {
            "id": "cluster-a-alice",
            "name": "Cluster A",
            "driver": "slurm",
            "cluster_id": "cluster-a",
            "username": "alice",
            "ssh_alias": "cluster-a",
            "credential": "",
            "enabled": True,
            "interval_minutes": 15,
        },
        {
            "id": "cluster-a-bob",
            "name": "Cluster A",
            "driver": "slurm",
            "cluster_id": "cluster-a",
            "username": "bob",
            "ssh_alias": "cluster-a",
            "credential": "",
            "enabled": True,
            "interval_minutes": 30,
        },
        {
            "id": "cluster-b-alice",
            "name": "Cluster B",
            "driver": "slurm",
            "cluster_id": "cluster-b",
            "username": "alice",
            "ssh_alias": "login.cluster-b",
            "credential": "",
            "enabled": False,
            "interval_minutes": 10,
        },
        {
            "id": "runpod-runpod",
            "name": "RunPod",
            "driver": "runpod",
            "cluster_id": "runpod",
            "username": "",
            "ssh_alias": "",
            "credential": "env:RUNPOD_API_KEY",
            "enabled": True,
            "interval_minutes": 10,
        },
    ]
    statuses = {source["id"]: source["status"] for source in store.sources()}
    assert statuses["cluster-b-alice"] == "unconfigured"
    assert statuses["cluster-a-alice"] == "ready"
    instances = {row["id"]: row for row in store.manual_instances()}
    assert set(instances) == {"manual:lab-box-gpu1", "manual:lab-box-gpu2"}
    gpu1 = instances["manual:lab-box-gpu1"]
    assert gpu1["port"] == 2222
    assert gpu1["identity_file"] == "~/.ssh/id_ed25519"
    assert gpu1["hourly_cost"] == 0.5
    assert gpu1["monitoring"] is True
    assert gpu1["ssh_alias"] == "cd-lab-box-gpu1"
    assert instances["manual:lab-box-gpu2"]["ssh_alias"] == "gpu-two"
    assert store.settings() == {"language": "zh-CN", "server_name": 'Lab "east" server \\ main'}


def test_export_round_trip(store: Store, tmp_path: Path) -> None:
    config.apply(store, CONFIG)
    exported = config.export(store)
    tomllib.loads(exported)
    copy = open_store(tmp_path / "copy")
    assert config.apply(copy, exported) == {"sources": 4, "instances": 2, "nodes": 1}
    assert configuration(copy) == configuration(store)
    assert copy.manual_instances() == store.manual_instances()
    assert copy.settings() == store.settings()
    assert config.export(copy) == exported
    copy.db.close()


def test_options_are_imported_and_exported(store: Store) -> None:
    config.apply(store, CONFIG)
    bob = store.source("cluster-a-bob")
    assert bob is not None
    assert bob["options"] == {"partition": "gpu", "note": 'quoted "value"'}
    assert store.source("cluster-a-alice")["options"] == {}  # type: ignore[index]
    assert 'options = { partition = "gpu", note = "quoted \\"value\\"" }' in config.export(store)


def test_export_writes_a_stored_lone_surrogate_as_a_question_mark(store: Store) -> None:
    config.apply(store, CONFIG)
    bob = store.source("cluster-a-bob")
    assert bob is not None
    # Stored by a version that did not check request text; TOML cannot hold it.
    store.save_source({**bob, "options": {"partition": "gpu\ud800"}})
    exported = config.export(store)
    exported.encode("utf-8")
    assert tomllib.loads(exported)["cluster"][0]["identity"][1]["options"] == {"partition": "gpu?"}


def test_export_contains_no_runtime_state(store: Store) -> None:
    config.apply(store, CONFIG)
    source = store.source("cluster-a-alice")
    assert source is not None
    source.update(
        last_success=now(),
        error={"code": "ssh_failed", "detail": "Permission denied"},
        capabilities=["jobs"],
        warnings=[{"code": "qos_unavailable"}],
    )
    store.save_source(source)
    exported = config.export(store)
    for runtime_key in (
        "last_success",
        "last_attempt",
        "next_due_at",
        "status",
        "error",
        "capabilities",
        "warnings",
        "Permission denied",
        "ssh_status",
        "observed_at",
    ):
        assert runtime_key not in exported
    assert 'credential = "env:RUNPOD_API_KEY"' in exported


def test_reimport_preserves_runtime_state_and_deletes_nothing(store: Store) -> None:
    config.apply(store, CONFIG)
    collected_at = now()
    source = store.source("cluster-a-alice")
    assert source is not None
    source.update(
        last_success=collected_at,
        capabilities=["jobs", "nodes"],
        capabilities_seen=["jobs", "nodes", "history"],
        failures=0,
    )
    store.save_source(source)
    job = {"id": "cluster-a:1", "source_id": "cluster-a-alice", "state": "RUNNING"}
    store.save_snapshot("cluster-a-alice", {"jobs": [job]})
    [gpu1] = [row for row in store.manual_instances() if row["external_id"] == "gpu1"]
    gpu1.update(ssh_status="reachable", observed_at=collected_at, last_probe_attempt=collected_at)
    store.save_instance(gpu1)

    changed = """
[[cluster]]
id = "cluster-a"
label = "Cluster A (renamed)"
ssh_alias = "cluster-a"
interval_minutes = 20

  [[cluster.identity]]
  username = "alice"

[[instance]]
platform = "Lab box"
id = "gpu1"
name = "GPU one"
host = "192.0.2.30"
port = 2222
username = "alice"
identity_file = "~/.ssh/id_ed25519"
gpu_count = 4
"""
    assert config.apply(store, changed) == {"sources": 1, "instances": 1, "nodes": 0}
    saved = store.source("cluster-a-alice")
    assert saved is not None
    assert saved["name"] == "Cluster A (renamed)"
    assert saved["interval_minutes"] == 20
    assert saved["last_success"] == collected_at
    assert saved["capabilities"] == ["jobs", "nodes"]
    assert saved["capabilities_seen"] == ["jobs", "nodes", "history"]
    assert saved["status"] == "ready"
    assert saved["next_due_at"]
    assert [row["id"] for row in store.dashboard()["jobs"]] == ["cluster-a:1"]
    assert len(store.sources()) == 4
    assert len(store.manual_instances()) == 2
    [gpu1] = [row for row in store.manual_instances() if row["external_id"] == "gpu1"]
    assert gpu1["gpu_count"] == 4
    assert gpu1["ssh_status"] == "reachable"
    assert gpu1["observed_at"] == collected_at
    assert gpu1["last_probe_attempt"] == collected_at
    assert store.settings()["language"] == "zh-CN"


def test_reimport_with_a_new_endpoint_drops_old_observations(store: Store) -> None:
    config.apply(store, CONFIG)
    [gpu1] = [row for row in store.manual_instances() if row["external_id"] == "gpu1"]
    gpu1.update(ssh_status="reachable", observed_at=now(), last_probe_attempt=now())
    store.save_instance(gpu1)
    moved = CONFIG.replace('host = "192.0.2.30"', 'host = "192.0.2.31"')
    config.apply(store, moved)
    [gpu1] = [row for row in store.manual_instances() if row["external_id"] == "gpu1"]
    assert gpu1["host"] == "192.0.2.31"
    assert gpu1["ssh_status"] == "unverified"
    assert gpu1["observed_at"] is None
    assert "last_probe_attempt" not in gpu1


def test_cluster_mixing_drivers_is_rejected(store: Store) -> None:
    mixed = """
[[cluster]]
id = "cluster-a"
label = "Cluster A"
username = "alice"
ssh_alias = "cluster-a"

[[cloud]]
id = "cluster-a"
label = "Cluster A cloud"
credential = "env:RUNPOD_API_KEY"
"""
    with pytest.raises(ConfigError, match="cluster-a mixes drivers"):
        config.apply(store, mixed)
    assert store.sources() == []
    config.apply(store, mixed.split("[[cloud]]")[0])
    cloud_only = "[[cloud]]" + mixed.split("[[cloud]]")[1]
    with pytest.raises(ConfigError, match="mixes drivers"):
        config.apply(store, cloud_only)
    assert [source["driver"] for source in store.sources()] == ["slurm"]


@pytest.mark.parametrize(
    ("text", "match"),
    [
        ("not toml = = 1", "Invalid|Expected|expected"),
        ('unknown = "x"', "Unknown top-level keys: unknown"),
        ('language = "xx"', "language"),
        ('cluster = "cluster-a"', "must be a table"),
        ('[[cluster]]\nssh_alias = "cluster-a"', "needs an id or a label"),
        ('[[cluster]]\nlabel = "Cluster A"\nusername = "alice"', "cluster_connection_required"),
        (
            '[[cluster]]\nlabel = "Cluster A"\nusername = "alice;id"\nssh_alias = "cluster-a"',
            "Cluster A",
        ),
        ('[[cluster]]\nlabel = "Cluster A"\ndriver = "no-such-scheduler"', "unknown_driver"),
        ('[[cloud]]\nlabel = "RunPod"\ncredential = "RUNPOD_API_KEY"', "invalid_credential"),
        ('[[cloud]]\nlabel = "RunPod"', "credential_required"),
        ('[[instance]]\nplatform = "Lab"\nid = "a"\nname = "a"\nhost = "-oProxy=x"', "host"),
        ('[[instance]]\nplatform = "Lab"\nid = "a b"\nname = "a"\nhost = "h"', "external_id"),
        # Accepted by the field validators but not by the SSH configuration writer.
        (
            '[[cluster]]\nlabel = "Cluster A"\nusername = "alice"\nssh_alias = "a"\n'
            '[[instance]]\nplatform = "Lab"\nid = "a"\nname = "a"\nhost = "box"\n'
            'identity_file = "keys/id"',
            "SSH endpoints",
        ),
        (
            '[[cluster]]\nlabel = "Cluster A"\nusername = "alice"\nssh_alias = "a"\n'
            '[[instance]]\nplatform = "!!!"\nid = "a"\nname = "a"\nhost = "box"',
            "name_required",
        ),
        ('[[node]]\nname = "n"\nssh_alias = "a"\ncommand = ""', "node_command_invalid"),
        ('[[node]]\nname = "n"\nssh_alias = "a"\ncommand = "  "', "node_command_invalid"),
        # Ids the app could not edit or delete.
        ('[[node]]\nid = "a/b"\nname = "n"\nssh_alias = "a"', "id 'a/b' must be"),
        ('[[node]]\nid = "../x"\nname = "n"\nssh_alias = "a"', "id '../x' must be"),
        ('[[node]]\nid = "ABC"\nname = "n"\nssh_alias = "a"', "id 'ABC' must be"),
        ('[[node]]\nid = 5\nname = "n"\nssh_alias = "a"', "id 5 must be"),
        ('[[cluster]]\nid = "c"\nlabel = "c"\nidentity = 5', "must be a table array"),
        ('[[cluster]]\nid = "c"\nlabel = "c"\nidentity = [5]', "must be a table"),
        ("x = " + "[" * 50000 + "]" * 50000, "nests arrays or tables too deeply"),
    ],
)
def test_invalid_configuration_is_rejected_before_writing(
    store: Store, text: str, match: str
) -> None:
    with pytest.raises(ConfigError, match=match):
        config.apply(store, text)
    assert store.sources() == []
    assert store.manual_instances() == []
    assert store.settings() == {"language": "en", "server_name": None}


def test_single_node_table_is_a_config_error(store: Store) -> None:
    with pytest.raises(ConfigError, match="table"):
        config.apply(store, '[node]\nname="Gateway"\nssh_alias="gateway"')


def test_import_preserves_existing_collection_error_and_login_names(store: Store) -> None:
    config.apply(store, CONFIG)
    sources = store.sources()
    for index, source in enumerate(sources):
        store.save_source(
            {**source, "name": f"Login {index}", "status": "error", "error": {"code": "timeout"}}
        )
    config.apply(store, config.export(store))
    imported = store.sources()
    assert [source["name"] for source in imported] == [
        f"Login {index}" for index in range(len(sources))
    ]
    assert all(
        source["status"] == "error" and source["error"] == {"code": "timeout"}
        for source in imported
        if source["enabled"]
    )


def test_import_changed_source_connection_clears_capability_history(store: Store) -> None:
    config.apply(store, CONFIG)
    source = store.source("cluster-a-alice")
    assert source is not None
    source.update(
        last_success=now(),
        capabilities=["jobs", "nodes", "history"],
        capabilities_seen=["jobs", "nodes", "history"],
        warnings=[{"code": "partitions_unavailable"}],
        cluster_state="degraded",
    )
    store.save_source(source)
    config.apply(store, CONFIG.replace('ssh_alias = "cluster-a"', 'ssh_alias = "other-cluster"'))
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["ssh_alias"] == "other-cluster"
    assert saved["last_success"] is None
    assert saved["capabilities"] == []
    assert saved["capabilities_seen"] == []
    assert saved["warnings"] == []
    assert saved["cluster_state"] == "unknown"


def test_import_enabled_toggle_preserves_capability_history(store: Store) -> None:
    config.apply(store, CONFIG)
    source = store.source("cluster-a-alice")
    assert source is not None
    source.update(
        last_success=now(),
        capabilities=["jobs"],
        capabilities_seen=["jobs", "history"],
        warnings=[{"code": "partitions_unavailable"}],
        cluster_state="degraded",
    )
    store.save_source(source)
    disabled = CONFIG.replace('ssh_alias = "cluster-a"', 'ssh_alias = "cluster-a"\nenabled = false')
    for content, enabled in [(disabled, False), (CONFIG, True)]:
        current = store.source(source["id"])
        assert current is not None
        store.save_source(
            {**current, "status": "error", "error": {"code": "ssh_timeout"}, "failures": 5}
        )
        config.apply(store, content)
        saved = store.source(source["id"])
        assert saved is not None
        assert saved["enabled"] is enabled
        assert saved["capabilities"] == ["jobs"]
        assert saved["capabilities_seen"] == ["jobs", "history"]
        assert saved["last_success"] == source["last_success"]
        assert saved["warnings"] == source["warnings"]
        assert saved["cluster_state"] == "degraded"
        assert saved["status"] == ("ready" if enabled else "unconfigured")
        assert saved["error"] is None
        assert saved["failures"] == 0


def test_import_enables_configured_source_before_first_collection(store: Store) -> None:
    disabled = CONFIG.replace('ssh_alias = "cluster-a"', 'ssh_alias = "cluster-a"\nenabled = false')
    config.apply(store, disabled)
    source = store.source("cluster-a-alice")
    assert source is not None
    assert source["status"] == "unconfigured"
    config.apply(store, CONFIG)
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["enabled"] is True
    assert saved["status"] == "ready"
    assert saved["error"] is None
    assert saved["failures"] == 0
