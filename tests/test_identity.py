"""Identity belongs to groups and survives reordering, restarts and config import."""

from pathlib import Path

import pytest

from computedeck import config, demo
from computedeck.identity import assign_slots, group_keys
from computedeck.records import InstanceInput, SourceInput, instance_record, source_record
from computedeck.store import Store


def source(key: str, user: str = "alice") -> dict:
    return source_record(
        SourceInput(name=key, cluster_id=key, username=user, driver="slurm", enabled=False)
    )


def test_slots_fill_all_six_before_balanced_sharing() -> None:
    # These names collide on their preferred slot.
    keys = [f"cluster-{index * 6}" for index in range(6)]
    slots = assign_slots(keys, {})
    assert set(slots.values()) == set(range(1, 7))
    assert assign_slots(list(reversed(keys)), slots) == slots
    expanded = assign_slots([*keys, "cluster-new"], slots)
    assert {key: expanded[key] for key in keys} == slots
    assert max(list(expanded.values()).count(slot) for slot in range(1, 7)) == 2
    reduced = assign_slots(keys[1:], expanded)
    assert reduced == {key: slots[key] for key in keys[1:]}
    assert assign_slots([*keys[1:], "replacement"], reduced)["replacement"] == slots[keys[0]]


def test_persisted_groups_and_explicit_override(store: Store) -> None:
    for key in ("cluster-a", "cluster-b", "cluster-c", "cluster-d", "cluster-e", "cluster-f"):
        store.save_source(source(key))
    initial = store.identity_slots()
    store.save_source(source("cluster-a", "bob"))
    assert store.identity_slots() == initial
    store.delete_source(source("cluster-a")["id"])
    assert store.identity_slots() == initial
    store.delete_source(source("cluster-a", "bob")["id"])
    kept = {key: slot for key, slot in initial.items() if key != "cluster-a"}
    assert store.identity_slots() == kept
    store.save_source(source("cluster-new"))
    assert store.identity_slots()["cluster-new"] == initial["cluster-a"]
    restarted = Store(store.path)
    assert restarted.identity_slots() == store.identity_slots()
    restarted.db.close()
    store.identity_slots({"cluster-b": 6})
    assert store.dashboard()["identity_slots"]["cluster-b"] == 6


def test_config_round_trip_and_override(store: Store, tmp_path: Path) -> None:
    store.save_source(source("cluster-a"))
    store.save_source(source("cluster-b"))
    config.apply(store, '[identity_slots]\n"cluster-a" = 6\n')
    assert store.identity_slots()["cluster-a"] == 6
    exported = config.export(store)
    target = Store(tmp_path / "target.sqlite")
    config.apply(target, exported)
    assert target.identity_slots() == store.identity_slots()
    assert config.load(exported)["identity_slots"] == store.identity_slots()
    target.db.close()


@pytest.mark.parametrize(
    "value", ["[]", "true", "{ a = 0 }", "{ a = 7 }", "{ a = 1.5 }", "{ a = true }"]
)
def test_invalid_overrides_are_rejected_before_writes(store: Store, value: str) -> None:
    with pytest.raises(config.ConfigError, match="identity_slots"):
        config.apply(store, f"server_name = 'Changed'\nidentity_slots = {value}")
    assert store.settings()["server_name"] != "Changed"


def test_platform_identity_is_separate_from_legacy_route_key(store: Store) -> None:
    cloud = source_record(
        SourceInput(name="RunPod", driver="runpod", cluster_id="pods-a", enabled=False)
    )
    store.save_source(cloud)
    store.save_source({**cloud, "id": "pods-b", "cluster_id": "pods-b"})
    machine = instance_record(
        InstanceInput(platform="RunPod", external_id="box", name="Box", host="example.test")
    )
    store.save_instance(machine)
    assert store.identity_slots().keys() == {"platform:runpod"}
    assert group_keys(store.sources(), [{**machine, "manual": True}]) == ["platform:runpod"]
    store.delete_source(cloud["id"])
    store.delete_source("pods-b")
    assert store.identity_slots().keys() == {"platform:runpod"}
    store.delete_instance(machine["id"])
    assert store.identity_slots() == {}


def test_readonly_old_database_does_not_write_identity(store: Store) -> None:
    store.save_source(source("cluster-a"))
    with store.db:
        store.db.execute("DELETE FROM meta WHERE key='identity_slots'")
    readonly = Store(store.path, readonly=True)
    assert readonly.dashboard()["identity_slots"].keys() == {"cluster-a"}
    assert (
        readonly.db.execute("SELECT value FROM meta WHERE key='identity_slots'").fetchone() is None
    )
    readonly.db.close()


def test_demo_display_states_are_fixed_and_do_not_persist(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COMPUTEDECK_DEMO_NOW", "2026-01-15T14:00:00Z")
    data = demo.dashboard()
    assert data["identity_slots"] == assign_slots(
        group_keys(data["sources"], data["instances"]), {}
    )
    example = data["display_example"]
    assert example == {
        "known": 29,
        "estimate": 41.2,
        "last_known": 2,
        "at": "2026-01-15T13:58:00+00:00",
        "stale_at": "2026-01-15T13:46:00+00:00",
        "qos_at": "2026-01-15T08:00:00+00:00",
        "duration_seconds": 11560,
        "hidden": 31,
        "trace": {
            "rule": {"code": "display_example_rule"},
            "included": ["Cluster A", "Cluster B"],
            "excluded": [{"source": "Cluster C", "reason": {"code": "display_example_missing"}}],
            "as_of": data["updated_at"],
        },
    }
    assert "display_example" not in store.dashboard()
    assert store.identity_slots() == {}


@pytest.mark.parametrize("platform", [None, ""])
def test_legacy_machine_without_platform_keeps_its_data(store: Store, platform: str | None) -> None:
    item = {"id": "manual:legacy", "platform": platform, "gpu_count": 2}
    store.save_instance(item)
    assert store.dashboard()["instances"][0]["gpu_count"] == 2
    assert group_keys([], [{"id": "old", "manual": True}]) == []
