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
    [
        (0, False, ["source_failed"]),
        (1, False, ["source_failed"]),
        (2, False, ["source_failed"]),
        (1, True, ["source_failed"]),
    ],
)
def test_failure_is_visible_from_first_attempt(
    failures: int, stale: bool, expected: list[str]
) -> None:
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


def test_queue_warning_does_not_need_attention() -> None:
    assert derive([source(warnings=[{"code": "queue_unavailable"}])]) == []


def test_queue_warning_does_not_reopen_acknowledged_partial_data() -> None:
    row = source(warnings=[{"code": "partial_one"}])
    [item] = derive([row])
    state = saved(item)
    row["warnings"].append({"code": "queue_unavailable"})
    [muted] = derive([row], state=state)
    assert muted["details"] == [{"code": "partial_one"}]
    assert muted["fingerprint"] == item["fingerprint"]
    assert muted["muted"]["state"] == "acknowledged"
    row["warnings"].append({"code": "partial_two"})
    assert derive([row], state=state)[0]["muted"] is None


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
    [(1, False, "source_failed"), (2, False, "source_failed"), (1, True, "source_failed")],
)
def test_source_failure_replaces_retained_cluster_fault(
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
    assert item["severity"] == ("warn" if failures == 1 and not stale else "error")
    assert derive([{**row, "enabled": False}]) == []


@pytest.mark.parametrize(
    ("error", "failures", "stale", "expected"),
    [
        (None, 0, False, ["capability_regressed", "partial_data"]),
        ({"code": "ssh_timeout"}, 1, False, ["source_failed"]),
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
        "cluster_unavailable",
        "instance_ssh_failed",
        "instance_low_use",
        "notification_failed",
    ]
    assert (
        next(item for item in data["attention"] if item["kind"] == "instance_ssh_failed")[
            "subject"
        ]["id"]
        == "example:runpod:demo-pod"
    )
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


def saved(item: dict[str, Any], until: datetime | None = None) -> dict[str, Any]:
    return {
        item["key"]: {
            "fingerprint": item["fingerprint"],
            "acknowledged_at": NOW.isoformat(),
            "snooze_until": until.isoformat() if until else None,
        }
    }


def test_acknowledgement_ignores_names_stderr_and_observation_times() -> None:
    row = source(error={"code": "ssh_failed", "detail": "first stderr"}, failures=2)
    [item] = derive([row])
    state = saved(item)
    before = deepcopy(state)
    row.update(name="Renamed cluster", last_attempt=(NOW + timedelta(minutes=1)).isoformat())
    row["error"]["detail"] = "different stderr"
    [muted] = derive([row], state=state)
    assert muted["fingerprint"] == item["fingerprint"]
    assert muted["muted"] == {"state": "acknowledged", "at": NOW.isoformat(), "until": None}
    row["error"]["code"] = "ssh_timeout"
    assert derive([row], state=state)[0]["muted"] is None
    assert state == before


@pytest.mark.parametrize("snoozed", [False, True])
def test_severity_escalation_reopens_acknowledged_and_snoozed_items(snoozed: bool) -> None:
    row = source(stale=True, last_success=(NOW - timedelta(minutes=20)).isoformat())
    [item] = derive([row])
    state = saved(item, NOW + timedelta(hours=1) if snoozed else None)
    assert derive([row], state=state)[0]["muted"] is not None
    row["last_success"] = (NOW - timedelta(minutes=31)).isoformat()
    [reopened] = derive([row], state=state)
    assert reopened["severity"] == "error"
    assert reopened["muted"] is None
    assert reopened["fingerprint"] != item["fingerprint"]


@pytest.mark.parametrize("seconds,muted", [(-1, False), (0, False), (1, True)])
def test_snooze_expires_on_read(seconds: int, muted: bool) -> None:
    row = source(error={"code": "ssh_failed"})
    [item] = derive([row])
    state = saved(item, NOW + timedelta(seconds=seconds))
    assert (derive([row], state=state)[0]["muted"] is not None) is muted


def test_service_faults_cannot_be_muted_even_with_saved_state() -> None:
    kwargs = {
        "loop_errors": {"collector:schedule": {"error": "failed"}},
        "unreadable_rows": {"sources": 1},
    }
    items = derive([], **kwargs)
    state = {key: value for item in items for key, value in saved(item).items()}
    assert all(item["muted"] is None for item in derive([], state=state, **kwargs))
    assert all(item["mutable"] is False for item in items)


def test_warning_order_is_stable_but_changed_status_reopens() -> None:
    row = source(warnings=[{"code": "one", "status": 429}, {"code": "two"}])
    [item] = derive([row])
    state = saved(item)
    row["warnings"].reverse()
    assert derive([row], state=state)[0]["muted"] is not None
    row["warnings"][1]["status"] = 503
    assert derive([row], state=state)[0]["muted"] is None


def test_demo_contains_acknowledged_and_snoozed_items() -> None:
    data = demo.dashboard()
    assert {item["muted"]["state"] for item in data["attention"] if item["muted"]} == {
        "acknowledged",
        "snoozed",
    }
    assert data["attention_count"] == 5
    assert all(item["mutable"] is True for item in data["attention"])


def test_notification_warning_reopens_for_error_code_but_not_channel_label() -> None:
    def status(code: str = "send_timeout", name: str = "Team") -> dict[str, Any]:
        return {
            "notify": {
                "enabled": True,
                "delivery_failures": [
                    {
                        "channel": "team",
                        "channel_name": name,
                        "error_code": code,
                        "at": NOW.isoformat(),
                    }
                ],
            }
        }

    [item] = derive([], plugin_status=status())
    state = {
        item["key"]: {
            "fingerprint": item["fingerprint"],
            "acknowledged_at": NOW.isoformat(),
            "snooze_until": None,
        }
    }
    [renamed] = derive([], plugin_status=status(name="New name"), state=state)
    assert renamed["muted"]["state"] == "acknowledged"
    [changed] = derive([], plugin_status=status(code="credential_unavailable"), state=state)
    assert changed["muted"] is None
