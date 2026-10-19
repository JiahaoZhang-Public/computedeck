"""One stateless list for badges, diagnosis and plugin consumers."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from computedeck import attention, demo, drivers

NOW = datetime(2026, 10, 19, 12, tzinfo=UTC)
DESCRIPTIONS = [drivers.describe("slurm")]


def source(**changes: Any) -> dict[str, Any]:
    return {
        "id": "cluster-a-alice",
        "name": "Cluster A",
        "username": "alice",
        "cluster_id": "cluster-a",
        "driver": "slurm",
        "enabled": True,
        "status": "ready",
        "last_success": (NOW - timedelta(minutes=3)).isoformat(),
        "last_attempt": (NOW - timedelta(minutes=1)).isoformat(),
        "next_due_at": (NOW + timedelta(minutes=5)).isoformat(),
        "interval_minutes": 10,
        "capabilities": ["jobs", "nodes"],
        "warnings": [],
        **changes,
    }


def derive(sources: list[dict[str, Any]], **kwargs: Any) -> list[dict[str, Any]]:
    return attention.derive({"sources": sources, "instances": []}, DESCRIPTIONS, now=NOW, **kwargs)


@pytest.mark.parametrize(
    ("failures", "stale", "expected"),
    [(0, False, []), (1, False, []), (2, False, ["source_failed"]), (1, True, ["source_failed"])],
)
def test_failure_debounce(failures: int, stale: bool, expected: list[str]) -> None:
    row = source(error={"code": "ssh_timeout"}, failures=failures, stale=stale)
    items = derive([row])
    assert [item["kind"] for item in items] == expected
    if items:
        assert items[0]["since"] == row["last_success"]
        assert items[0]["observed_at"] == row["last_attempt"]
        assert items[0]["next_attempt"] == row["next_due_at"]
        assert items[0]["action"] == "diagnose"
        assert items[0]["details"] == [row["error"]]
    assert derive([{**row, "enabled": False}]) == []
    assert derive([{**row, "stale": False, "error": None, "failures": 0}]) == []


@pytest.mark.parametrize(("minutes", "severity"), [(15, "warn"), (30, "warn"), (31, "error")])
def test_stale_escalates_on_read(minutes: int, severity: str) -> None:
    items = derive(
        [source(stale=True, last_success=(NOW - timedelta(minutes=minutes)).isoformat())]
    )
    assert [(item["kind"], item["severity"]) for item in items] == [("source_stale", severity)]


def test_never_succeeded_failure_uses_attempt_not_an_invented_onset() -> None:
    row = source(last_success=None, failures=2, error={"code": "ssh_failed"})
    item = derive([row])[0]
    assert item["since"] is None
    assert item["observed_at"] == row["last_attempt"]


def test_capability_gaps_regressions_and_all_other_warnings() -> None:
    warnings = [
        {"code": "history_unavailable"},
        {"code": "nodes_unavailable"},
        {"code": "partial_one"},
        {"code": "partial_two"},
    ]
    row = source(capabilities=["jobs"], warnings=warnings)
    items = derive([row])
    assert [item["kind"] for item in items] == ["partial_data"]
    assert items[0]["details"] == warnings[2:]
    row["capabilities_seen"] = ["jobs", "nodes", "history"]
    items = derive([row])
    assert [item["kind"] for item in items] == ["capability_regressed"] * 2 + ["partial_data"]
    assert len({item["key"] for item in items}) == 3
    assert all(item["since"] is None for item in items)
    assert all(item["observed_at"] == row["last_success"] for item in items)
    assert {item["message"]["capability"]: item["message"]["command"] for item in items[:2]} == {
        "nodes": "scontrol",
        "history": "sacct",
    }
    assert {item["message"]["capability"] for item in items[:2]} == {"nodes", "history"}
    assert derive([{**row, "warnings": [], "capabilities": ["jobs", "nodes", "history"]}]) == []


@pytest.mark.parametrize(("state", "severity"), [("degraded", "warn"), ("unavailable", "error")])
def test_cluster_faults_are_current_and_shared_across_logins(state: str, severity: str) -> None:
    row = source(cluster_state=state)
    items = derive([row, {**row, "id": "cluster-a-bob", "username": "bob"}])
    assert [(item["kind"], item["severity"]) for item in items] == [(f"cluster_{state}", severity)]
    assert [item["kind"] for item in derive([{**row, "stale": True}])] == ["source_stale"]
    assert derive([{**row, "capabilities": ["jobs"]}]) == []
    assert items[0]["since"] is None
    assert items[0]["observed_at"] == row["last_success"]


@pytest.mark.parametrize("state", ["unavailable", "degraded"])
@pytest.mark.parametrize(
    ("failures", "stale", "expected"),
    [(1, False, "cluster"), (2, False, "source_failed"), (1, True, "source_failed")],
)
def test_cluster_fault_survives_failure_debounce(
    state: str, failures: int, stale: bool, expected: str
) -> None:
    row = source(
        cluster_state=state,
        status="error",
        error={"code": "ssh_timeout"},
        failures=failures,
        stale=stale,
    )
    [item] = derive([row])
    assert item["kind"] == (f"cluster_{state}" if expected == "cluster" else expected)
    assert item["severity"] == (
        "warn" if expected == "cluster" and state == "degraded" else "error"
    )
    assert derive([{**row, "enabled": False}]) == []
    if expected == "cluster":
        assert item["observed_at"] == row["last_success"]
        assert derive([{**row, "capabilities": ["jobs"]}]) == []
        assert derive([{**row, "last_success": None}]) == []


@pytest.mark.parametrize(
    ("error", "failures", "stale", "expected"),
    [
        (None, 0, False, ["capability_regressed", "partial_data"]),
        ({"code": "ssh_timeout"}, 1, False, ["capability_regressed", "partial_data"]),
        ({"code": "ssh_timeout"}, 2, False, ["source_failed"]),
        ({"code": "ssh_timeout"}, 1, True, ["source_failed"]),
        (None, 0, True, ["source_stale"]),
    ],
)
def test_source_faults_replace_retained_collection_warnings(
    error: dict[str, str] | None, failures: int, stale: bool, expected: list[str]
) -> None:
    row = source(
        capabilities_seen=["history"],
        warnings=[{"code": "history_unavailable"}, {"code": "partitions_unavailable"}],
        error=error,
        failures=failures,
        stale=stale,
    )
    assert [item["kind"] for item in derive([row])] == expected


@pytest.mark.parametrize("reverse", [False, True])
def test_shared_cluster_uses_worst_fresh_login_state(reverse: bool) -> None:
    rows = [
        source(cluster_state="degraded"),
        source(id="cluster-a-bob", username="bob", cluster_state="unavailable"),
    ]
    if reverse:
        rows.reverse()
    [item] = derive(rows)
    assert item["kind"] == "cluster_unavailable"
    assert item["severity"] == "error"
    assert item["subject"]["id"] == "cluster-a-bob"
    rows = [dict(row, stale=True) if row["username"] == "bob" else row for row in rows]
    assert {item["kind"] for item in derive(rows)} == {"source_stale", "cluster_degraded"}


def test_only_stable_failed_ssh_checks_on_monitored_instances() -> None:
    instance = {
        "id": "box",
        "name": "dev-box",
        "ssh_status": "error",
        "ssh_error": {"code": "ssh_failed"},
        "last_probe_attempt": NOW.isoformat(),
    }
    data = {
        "sources": [source(enabled=False)],
        "instances": [
            {**instance, "id": "manual", "manual": True, "monitoring": True},
            {**instance, "id": "provider", "source_id": "cloud"},
            {**instance, "id": "off", "manual": True, "monitoring": False},
            {**instance, "id": "disabled", "source_id": "cluster-a-alice"},
            {**instance, "id": "unchecked", "ssh_status": "unverified"},
        ],
    }
    items = attention.derive(data, DESCRIPTIONS, now=NOW)
    assert [item["subject"]["id"] for item in items] == ["manual", "provider"]
    assert all(item["kind"] == "instance_ssh_failed" for item in items)
    assert all(item["since"] is None for item in items)
    assert all(item["observed_at"] == NOW.isoformat() for item in items)


def test_service_faults_filter_inactive_owners_and_derivation_does_not_mutate() -> None:
    fault = {"at": NOW.isoformat(), "error": "Task failed"}
    loops = {
        key: fault for key in ["collector:schedule", "collector:commit:gone", "off:loop", "on:loop"]
    }
    plugins = {
        "on": {"enabled": True, "error": "Health failed"},
        "off": {"enabled": False, "error": "Old fault"},
    }
    before = deepcopy((loops, plugins))
    items = derive(
        [], loop_errors=loops, plugin_status=plugins, unreadable_rows={"jobs": 2, "nodes": 0}
    )
    assert [item["kind"] for item in items] == [
        "service_loop_failed",
        "service_loop_failed",
        "unreadable_rows",
        "plugin_error",
    ]
    assert [item["action"] for item in items] == ["health", "toolbox", "health", "toolbox"]
    assert all(item["since"] is None for item in items)
    assert [item["observed_at"] for item in items] == [NOW.isoformat(), NOW.isoformat(), None, None]
    assert [item["subject"]["name"] for item in items[:2]] == ["collector:schedule", "on:loop"]
    assert items[2]["message"]["count"] == 2
    assert (loops, plugins) == before
    assert derive([]) == []


def test_demo_attention_shows_failed_check_without_unchecked_churn() -> None:
    data = demo.dashboard()
    assert [item["kind"] for item in data["attention"]] == [
        "source_stale",
        "source_failed",
        "source_failed",
        "instance_ssh_failed",
    ]
    assert data["attention"][-1]["subject"]["id"] == "example:runpod:demo-pod"
    pod = next(row for row in data["instances"] if row["id"] == "example:runpod:demo-pod")
    for metric in ("gpu_utilization", "cpu_utilization", "memory_utilization"):
        assert pod[metric] is None


def test_collector_commit_fault_names_the_source_without_changing_its_id_or_action() -> None:
    row = source()
    key = f"collector:commit:{row['id']}"
    [item] = derive([row], loop_errors={key: {"at": NOW.isoformat(), "error": "Write failed"}})
    assert item["subject"] == {"kind": "service", "id": key, "name": "Cluster A · alice"}
    assert item["message"]["name"] == "Cluster A · alice"
    assert item["action"] == "health"
    assert item["since"] is None
    assert item["observed_at"] == NOW.isoformat()
