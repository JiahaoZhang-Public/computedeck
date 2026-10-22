"""The built-in example should demonstrate usable planner choices."""

import re
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from computedeck.demo import dashboard, demo_history, events, nodes
from computedeck.drivers.cloud import instance_lifecycle
from computedeck.store import gpu_allocation, manual_state
from computedeck.summary import RUNNING, fresh


def test_demo_mutes_only_the_named_cluster_and_machine() -> None:
    items = dashboard()["attention"]
    assert {item["key"]: item["muted"]["state"] for item in items if item["muted"]} == {
        "cluster_unavailable:example:cluster-d-alice": "acknowledged",
        "instance_ssh_failed:example:runpod:demo-pod": "snoozed",
    }
    assert all(item["mutable"] for item in items if item["muted"])


def test_demo_has_verified_planner_choices() -> None:
    data = dashboard()
    clusters = [source for source in data["sources"] if source["driver"] == "slurm"]
    assert clusters
    for source in clusters:
        assert {"jobs", "nodes", "qos_limits", "qos_access"} <= set(source["capabilities"])
        assert any(qos["access"] == "verified" for qos in source["qos"])


def test_demo_machine_added_by_hand_is_checked_and_counted() -> None:
    [machine] = [row for row in dashboard()["instances"] if row["name"] == "dev-box"]
    # The state the service would derive from its last check, and GPUs with processes.
    assert machine["state"] == manual_state(machine) == "running"
    assert gpu_allocation(machine) == machine["gpu_allocated"] == 1


def test_demo_pod_is_reported_running_and_holds_its_listed_gpus() -> None:
    [pod] = [row for row in dashboard()["instances"] if row["platform"] == "RunPod"]
    assert pod["state"] == "reported_running"
    assert instance_lifecycle(pod["state"]) == "held"
    assert gpu_allocation(pod) == 2


def test_demo_shows_named_missing_machine_and_unavailable_capacity() -> None:
    data = dashboard()
    assert data["summary"]["unmonitored"] == 1
    assert data["summary"]["allocated"] is None
    assert data["summary"]["known_allocated"] == 25
    assert {row["subject"]["name"] for row in data["summary"]["unmeasured"]} == {
        "build-box",
        "Cluster A · carol",
        "Cluster C · alice",
        "RunPod secondary",
    }
    assert data["summary"]["groups"]["example:cluster-b"]["nodes"]["usable"] == 48
    assert data["summary"]["groups"]["example:cluster-b"]["nodes"]["unavailable"] == 16

    assert data["summary"]["groups"]["example:cluster-b"]["nodes"]["known_usable"] == 48
    for source in data["sources"]:
        if source["driver"] == "slurm":
            assert source["cluster_state"] == (
                "unavailable" if source["cluster_id"] == "example:cluster-d" else "available"
            )
    nodes = {(node["cluster_id"], node["name"]): node for node in data["nodes"]}
    running_gpus: Counter[tuple[str, str]] = Counter()
    for job in data["jobs"]:
        if job["state"] == "RUNNING":
            assert nodes[job["cluster_id"], job["node"]]["health"] == "usable"
            running_gpus[job["cluster_id"], job["node"]] += job["gpu_count"]
    for key, gpus in running_gpus.items():
        assert gpus <= nodes[key]["gpu_count"]
    unavailable = [node for node in data["nodes"] if node["health"] == "unavailable"]
    assert {node["state"] for node in unavailable} == {"down*", "drained", "IDLE", "FUTURE"}
    assert all(node["gpu_allocated"] == 0 for node in unavailable)


def test_demo_collecting_keeps_the_previous_success_age() -> None:
    data = dashboard()
    assert data["refreshing"] is True
    [collecting] = [s for s in data["sources"] if s["id"] in data["collecting"]]
    assert collecting["status"] == "syncing"
    assert collecting["last_attempt"] > collecting["last_success"]
    assert collecting["last_success"] < data["updated_at"]
    oldest = next(s["last_success"] for s in data["sources"] if s["driver"] == "pbs")
    assert data["as_of"] == oldest < collecting["last_success"]
    assert data["behind"] == [
        "example:cluster-a-carol",
        "example:cluster-c-alice",
        "example:runpod-secondary",
    ]
    assert data["failure_history_observed_at"] == data["updated_at"]
    assert all(source["next_due_at"] for source in data["sources"])
    for job in data["jobs"]:
        if job["source_id"] == collecting["id"]:
            assert job["observed_at"] == collecting["last_success"]


def test_demo_scenario_has_failures_staleness_and_a_capability_gap() -> None:
    data = dashboard()
    sources = {source["id"]: source for source in data["sources"]}
    failing = sources["example:cluster-c-alice"]
    assert failing["driver"] == "pbs"
    assert failing["status"] == "error"
    assert failing["failures"] == 8
    age = (datetime.now(UTC) - datetime.fromisoformat(failing["last_success"])).total_seconds()
    assert 160 * 60 <= age < 161 * 60
    assert failing["stale"] is True
    assert failing["capabilities"] == ["jobs", "nodes", "qos_limits", "history"]
    assert failing["qos"] == []
    assert failing["error"] == {"code": "ssh_failed", "detail": "Permission denied (publickey)."}
    stale = sources["example:cluster-a-carol"]
    assert stale["stale"] is True
    age = (datetime.now(UTC) - datetime.fromisoformat(stale["last_success"])).total_seconds()
    assert 47 * 60 <= age < 48 * 60
    [job] = [j for j in data["jobs"] if j["source_id"] == stale["id"]]
    assert job["observed_at"] == stale["last_success"]
    assert job["id"] in data["summary"]["jobs"]["listed_ids"]
    assert job["id"] not in data["summary"]["jobs"]["current_ids"]
    rate_limited = sources["example:runpod-secondary"]
    assert rate_limited["status"] == "error"
    assert rate_limited["error"] == {"code": "http_status", "status": 429}
    age = (datetime.now(UTC) - datetime.fromisoformat(rate_limited["last_success"])).total_seconds()
    assert 25 * 60 <= age < 26 * 60
    assert rate_limited["stale"] is True
    assert rate_limited["capabilities"] == ["instances", "ssh_discovery", "ssh_probe"]
    for source in (failing, rate_limited):
        assert set(source["capabilities_seen"]) == set(source["capabilities"])
        [item] = [item for item in data["attention"] if item["subject"]["id"] == source["id"]]
        assert item["kind"] == "source_failed"
        assert item["since"] == source["last_success"]
        assert item["observed_at"] == source["last_attempt"]
        [missing] = [
            item for item in data["summary"]["unmeasured"] if item["subject"]["id"] == source["id"]
        ]
        assert missing["reason"]["code"] == "summary_source_failed"
    gap = sources["example:cluster-a-bob"]
    assert "history" not in gap["capabilities"]
    assert gap["warnings"][0]["code"] == "history_unavailable"
    assert gap["id"] not in data["failure_history_sources"]
    assert not any(item["subject"]["id"] == gap["id"] for item in data["attention"])
    assert {failure["state"] for failure in data["recent_failures"]} == {
        "OUT_OF_MEMORY",
        "TIMEOUT",
        "FAILED",
    }
    assert all(failure["end"] and failure["exit_code"] for failure in data["recent_failures"])


def test_demo_ids_are_isolated_and_references_resolve() -> None:
    data = dashboard()
    sources = {source["id"] for source in data["sources"]}
    clusters = {source["cluster_id"] for source in data["sources"]}
    for table in ("sources", "jobs", "nodes", "instances", "recent_failures"):
        for row in data[table]:
            assert row["id"].startswith("example:")
            if "source_id" in row:
                assert row["source_id"] in sources or (
                    row.get("manual") and row["source_id"] == "manual"
                )
            if "cluster_id" in row:
                assert row["cluster_id"] in clusters
    machines = {node["id"] for node in nodes()}
    assert all(identifier.startswith("example:") for identifier in machines)
    assert all(not source["node"] or source["node"] in machines for source in data["sources"])
    rows = events()
    assert all(row["key"].startswith("example:") for row in rows)
    for row in rows:
        if row["type"] in {"service.gap", "change.instance", "change.tool"}:
            assert row["source_id"] is None
            assert "source_name" not in row["data"]
        else:
            assert row["source_id"] in sources
    assert [row["at"] for row in rows] == sorted((row["at"] for row in rows), reverse=True)
    [started] = [row for row in rows if row["type"] == "job.started"]
    assert started["at"] == started["data"]["started_at"] == started["data"]["job"]["started_at"]
    assert datetime.fromisoformat(started["data"]["observed_at"]) - datetime.fromisoformat(
        started["at"]
    ) == timedelta(minutes=5)
    assert {
        row["data"]["job"]["state"]
        for row in rows
        if row["type"] == "job.finished" and row["data"]["outcome"] in {"timeout", "out_of_memory"}
    } == {
        "OUT_OF_MEMORY",
        "TIMEOUT",
    }


def test_every_example_message_code_is_translated() -> None:
    def codes(value):
        if isinstance(value, dict):
            if "code" in value:
                yield value["code"]
            for child in value.values():
                yield from codes(child)
        elif isinstance(value, list):
            for child in value:
                yield from codes(child)

    messages = set(codes([dashboard(), events(), nodes()]))
    assert {"http_status", "ssh_failed", "history_unavailable"} <= messages
    for locale in ("en", "zh-CN"):
        text = (Path(__file__).parents[1] / "web" / "src" / "locales" / f"{locale}.ts").read_text()
        keys = set(re.findall(r"'msg\.([^']+)':", text))
        assert messages <= keys, (locale, messages - keys)


def test_demo_next_attempts_follow_collection_intervals_and_backoff() -> None:
    data = dashboard()
    current = datetime.now(UTC)
    for source in data["sources"]:
        if source["status"] != "syncing":
            attempt = datetime.fromisoformat(source["last_attempt"])
            due = datetime.fromisoformat(source["next_due_at"])
            interval = source["interval_minutes"] * 60
            failures = source["failures"]
            delay = max(interval, min(1800, 60 * 2 ** min(failures, 5))) if failures else interval
            assert due == attempt + timedelta(seconds=delay)
            if failures:
                expected_attempt = datetime.fromisoformat(source["last_success"]) + timedelta(
                    seconds=interval
                )
                for count in range(1, failures):
                    expected_attempt += timedelta(
                        seconds=max(interval, min(1800, 60 * 2 ** min(count, 5)))
                    )
                assert attempt == expected_attempt
            if source["stale"] and not source["error"]:
                assert due < current
            else:
                assert due > current


def test_demo_source_failure_events_match_current_outages_or_recoveries() -> None:
    sources = {source["id"]: source for source in dashboard()["sources"]}
    rows = events()
    for source in sources.values():
        if source["enabled"] and source["error"] and source["last_success"]:
            assert (
                sum(
                    row["type"] == "source.failed" and row["source_id"] == source["id"]
                    for row in rows
                )
                == 1
            )
    for event in rows:
        if event["type"] != "source.failed":
            continue
        source = sources[event["source_id"]]
        at = datetime.fromisoformat(event["at"])
        success = datetime.fromisoformat(source["last_success"])
        attempt = datetime.fromisoformat(source["last_attempt"])
        if source["error"]:
            assert event["data"]["error"] == source["error"]
            assert success < at <= attempt
            assert abs((at - success).total_seconds() - source["interval_minutes"] * 60) < 1
        else:
            # A historical failure precedes a recovery, then subsequent successes.
            assert any(
                row["type"] == "source.recovered"
                and row["source_id"] == source["id"]
                and at < datetime.fromisoformat(row["at"]) <= success
                for row in rows
            )


@pytest.mark.parametrize("timezone", ["UTC0", "UTC-4", "UTC+7"])
def test_demo_finished_job_offset_times_match_events(timezone: str) -> None:
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv("TZ", timezone)
            time.tzset()
            for event in events():
                if event["type"] == "job.finished" and event["data"]["outcome"] != "unknown":
                    end = datetime.fromisoformat(event["data"]["job"]["end"])
                    assert end.tzinfo is not None
                    assert (
                        abs(end.timestamp() - datetime.fromisoformat(event["at"]).timestamp()) < 1
                    )
    finally:
        time.tzset()


def test_demo_failure_coverage_uses_only_fresh_history_sources() -> None:
    data = dashboard()
    covered = [source for source in data["sources"] if fresh(source, "history")]
    assert data["failure_history_sources"] == [source["id"] for source in covered]
    assert data["failure_history_sources"] == [
        "example:cluster-a-alice",
        "example:cluster-b-alice",
        "example:cluster-d-alice",
    ]
    assert not {
        "example:cluster-c-alice",
        "example:cluster-a-carol",
        "example:cluster-a-bob",
    }.intersection(data["failure_history_sources"])
    assert data["failure_history_observed_at"] == min(source["last_success"] for source in covered)


def test_demo_queue_waits_show_both_contradictory_and_larger_limit_held_jobs() -> None:
    data = dashboard()
    queued = [job for job in data["jobs"] if job["state"] == "PENDING"]
    assert queued
    limit_held = [
        job for job in queued if job["reason"] in {"QOSMaxGRESPerUser", "AssocMaxJobsLimit"}
    ]
    assert len(limit_held) == 2
    for job in limit_held:
        source = next(source for source in data["sources"] if source["id"] == job["source_id"])
        qos = next(qos for qos in source["qos"] if qos["name"] == job["qos"])
        if job["reason"] == "AssocMaxJobsLimit":
            assert "MaxJobsPU" not in qos["limits"]
        limit = int(qos["limits"]["MaxTRESPU"].removeprefix("gres/gpu="))
        used = sum(
            running["gpu_count"]
            for running in data["jobs"]
            if running["source_id"] == job["source_id"]
            and running["qos"] == job["qos"]
            and running["state"] in RUNNING
        )
        room = max(0, limit - used)
        if job["cluster_id"] == "example:cluster-a":
            assert job["gpu_count"] == 1
            assert room == 4
        else:
            assert job["gpu_count"] > room
    # Ordinary resource and priority waits remain visible alongside limit waits.
    assert {"Priority", "Resources"} <= {job["reason"] for job in queued}


def test_example_all_down_cluster_has_consistent_state_and_capacity() -> None:
    data = dashboard()
    source = next(s for s in data["sources"] if s["cluster_id"] == "example:cluster-d")
    assert fresh(source, "nodes")
    assert source["cluster_state"] == "unavailable"
    summary = data["summary"]["groups"][source["cluster_id"]]["nodes"]
    assert summary["nodes"] == summary["abnormal"] == summary["unavailable"] == 2
    assert summary["usable"] == 0
    assert any(
        item["kind"] == "cluster_unavailable" and item["subject"]["id"] == source["id"]
        for item in data["attention"]
    )


@pytest.mark.parametrize("hours", [24, 168])
def test_example_history_agrees_with_summary_and_observation_gaps(hours: int) -> None:
    data = dashboard()
    summary = data["summary"]
    history = demo_history(hours, data)
    latest = history[-1]
    assert latest["allocated_gpus"] == summary["allocated"]
    assert latest["known_allocated_gpus"] == summary["known_allocated"]
    assert latest["unknown_allocation_sources"] == len(summary["unmeasured"])
    assert history[0]["unknown_allocation_sources"] == 0
    assert history[0]["allocated_gpus"] == history[0]["known_allocated_gpus"]
    unprobed = [
        i
        for i in data["instances"]
        if i.get("manual") and i.get("monitoring") and not i.get("observed_at")
    ]
    for point in history:
        gaps = sum(
            point["at"] >= s["last_success"] for s in data["sources"] if s["stale"] or s["error"]
        )
        gaps += sum(point["at"] >= i["added_at"] for i in unprobed)
        assert point["unknown_allocation_sources"] == gaps
        assert point["allocated_gpus"] == (None if gaps else point["known_allocated_gpus"])


def test_demo_shows_completed_and_unavailable_outcomes() -> None:
    rows = [row for row in events() if row["type"] == "job.finished"]
    assert {row["data"]["outcome"] for row in rows} == {
        "completed",
        "timeout",
        "out_of_memory",
        "unknown",
        "failed",
    }
    unknown = next(row for row in rows if row["data"]["outcome"] == "unknown")
    source = next(
        source for source in dashboard()["sources"] if source["id"] == unknown["source_id"]
    )
    assert "history" not in source["capabilities"]
    assert unknown["data"]["ended_at"] is None
    assert unknown["source_id"] == "example:cluster-a-bob"
    assert unknown["at"] == unknown["data"]["observed_at"]
    completed = next(row for row in rows if row["data"]["outcome"] == "completed")
    source = next(
        source for source in dashboard()["sources"] if source["id"] == completed["source_id"]
    )
    assert "history" in source["capabilities"]
    assert completed["data"]["job"]["source_id"] == source["id"]
    assert completed["data"]["job"]["user"] == source["username"]
    assert completed["data"]["job"]["id"].startswith(source["cluster_id"] + ":")
    for row in rows:
        if row["data"]["ended_at"]:
            assert row["at"] == row["data"]["ended_at"] < row["data"]["observed_at"]


def test_demo_array_has_mixed_states_and_element_counts() -> None:
    data = dashboard()
    elements = [job for job in data["jobs"] if job.get("array_id") == "48300"]
    assert len(elements) == 30
    assert {job["array_index"] for job in elements} == {str(i) for i in range(1, 31)}
    assert Counter(job["state"] for job in elements) == {
        "RUNNING": 4,
        "PENDING": 25,
        "SUSPENDED": 1,
    }
    assert {job["id"] for job in elements} <= set(data["summary"]["jobs"]["listed_ids"])
    assert len(data["summary"]["jobs"]["running_ids"]) >= 4
    assert len(data["summary"]["jobs"]["pending_ids"]) >= 25


def test_demo_failure_details_include_normalized_exits_and_known_limits() -> None:
    from computedeck.demo import events

    failures = dashboard()["recent_failures"]
    assert all(row["ended_at"] and isinstance(row["exit_signal"], int) for row in failures)
    timeout = next(row for row in failures if row["state"] == "TIMEOUT")
    assert timeout["time_limit"] == timeout["elapsed"]
    assert timeout["log_path"]
    assert any(row["data"].get("job", {}).get("exit_signal") == 9 for row in events())
    unknown = next(row["data"] for row in events() if row["data"].get("outcome") == "unknown")
    assert datetime.fromisoformat(unknown["job"]["observed_at"]) < datetime.fromisoformat(
        unknown["observed_at"]
    )


def test_demo_shows_source_and_service_gaps() -> None:
    rows = events()
    [source] = [row for row in rows if row["type"] == "source.gap"]
    [service] = [row for row in rows if row["type"] == "service.gap"]
    data = source["data"]
    assert data["unobserved_from"] < data["failures_checked_from"] < data["unobserved_to"]
    assert data["unobserved_to"] == source["at"]
    assert any(
        row["type"] == "source.recovered"
        and row["source_id"] == source["source_id"]
        and row["at"] == source["at"]
        for row in rows
    )
    assert service["data"]["from"] < service["data"]["to"] == service["at"]
    assert service["source_id"] is None
    for row in rows:
        observed = row["data"].get("observed_at", row["at"])
        assert not service["data"]["from"] < observed < service["data"]["to"]
        if row["source_id"] == source["source_id"]:
            assert not data["unobserved_from"] < observed < data["unobserved_to"]


def test_demo_changes_match_existing_subjects_and_contain_no_setting_values() -> None:
    data = dashboard()
    rows = [row for row in events() if row["type"].startswith("change.")]
    assert len(rows) == 3
    for row in rows:
        assert set(row["data"]) == {"subject_id", "name", "action", "fields"}
        if row["type"] == "change.tool":
            from computedeck.tools.notify import plugin

            assert row["data"] == {
                "subject_id": plugin.id,
                "name": plugin.name["en"],
                "action": "on",
                "fields": [],
            }
            continue
        subjects = data["sources"] if row["type"] == "change.source" else data["instances"]
        subject = next(item for item in subjects if item["id"] == row["data"]["subject_id"])
        assert subject["name"] == row["data"]["name"]
        if row["type"] == "change.source":
            assert row["data"]["action"] == "edited"
            assert row["data"]["fields"] == ["interval_minutes"]
            assert row["source_id"] == subject["id"]
            assert subject["enabled"] is True
            assert not any(
                event["type"] == "source.gap" and event["source_id"] == subject["id"]
                for event in events()
            )
        else:
            assert row["data"]["action"] == "added"
            assert row["data"]["fields"] == ["external_id", "host", "name", "platform"]


def test_array_failure_history_matches_activity_and_coverage() -> None:
    data = dashboard()
    failed = {row["id"]: row for row in data["recent_failures"]}
    array_events = [row for row in events() if row["data"].get("job", {}).get("array_id")]
    assert len(array_events) == 60
    for event in array_events:
        job = failed[event["data"]["job"]["id"]]
        assert job["source_id"] in data["failure_history_sources"]
        assert job["state"] == event["data"]["state"] == "FAILED"
        assert job["end"] == event["data"]["ended_at"]


def test_demo_shows_on_demand_and_partitionless_nodes():
    data = dashboard()
    on_demand = [n for n in data["nodes"] if n["health"] == "on_demand"]
    assert len(on_demand) == 1
    assert on_demand[0]["partitions"] == ["gpu"]
    spare = next(n for n in data["nodes"] if n["name"] == "a-spare-01")
    assert spare["state"] == "IDLE" and spare["partitions"] == []
    assert spare["health_reason"] == "no_partition"
    assert next(n for n in data["nodes"] if n["name"] == "a-future-01")["state"] == "FUTURE"
    summary = data["summary"]["groups"]["example:cluster-a"]["nodes"]
    assert summary["on_demand"] == 4
    assert summary["unavailable"] == 8
    assert summary["usable"] == 32


def test_demo_planner_includes_an_unknown_runtime_limit() -> None:
    source = next(row for row in dashboard()["sources"] if row["id"] == "example:cluster-a-bob")
    debug = next(qos for qos in source["qos"] if qos["name"] == "debug")
    assert "MaxWallPJ" not in debug["limits"]
    assert debug["access"] == "verified"
