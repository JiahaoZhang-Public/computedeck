"""The built-in example should demonstrate usable planner choices."""

import re
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from computedeck.demo import dashboard, events, nodes
from computedeck.drivers.cloud import instance_lifecycle
from computedeck.store import gpu_allocation, manual_state
from computedeck.summary import fresh


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
    assert data["summary"]["known_allocated"] == 21
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
            assert source["cluster_state"] == "available"
    nodes = {(node["cluster_id"], node["name"]): node for node in data["nodes"]}
    running_gpus: Counter[tuple[str, str]] = Counter()
    for job in data["jobs"]:
        if job["state"] == "RUNNING":
            assert nodes[job["cluster_id"], job["node"]]["health"] == "usable"
            running_gpus[job["cluster_id"], job["node"]] += job["gpu_count"]
    for key, gpus in running_gpus.items():
        assert gpus <= nodes[key]["gpu_count"]
    unavailable = [node for node in data["nodes"] if node["health"] == "unavailable"]
    assert {node["state"] for node in unavailable} == {"down*", "drained"}
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
    assert {failure["state"] for failure in data["recent_failures"]} == {"OUT_OF_MEMORY", "TIMEOUT"}
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
    assert all(row["key"].startswith("example:") and row["source_id"] in sources for row in rows)
    assert [row["at"] for row in rows] == sorted((row["at"] for row in rows), reverse=True)
    assert {row["data"]["job"]["state"] for row in rows if row["type"] == "job.failed"} == {
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
            delay = 30 if source["driver"] == "pbs" else source["interval_minutes"]
            assert due == attempt + timedelta(minutes=delay)
            if source["stale"] and not source["error"]:
                assert due < current
            else:
                assert due > current


def test_demo_source_failure_events_match_current_outages_or_recoveries() -> None:
    sources = {source["id"]: source for source in dashboard()["sources"]}
    rows = events()
    for event in rows:
        if event["type"] != "source.failed":
            continue
        source = sources[event["source_id"]]
        at = datetime.fromisoformat(event["at"])
        success = datetime.fromisoformat(source["last_success"])
        attempt = datetime.fromisoformat(source["last_attempt"])
        if source["error"]:
            assert success < at <= attempt
            assert abs((at - success).total_seconds() - source["interval_minutes"] * 60) < 1
            # Seven retries after the initial failure: 10, 10, 10, 16, 30, 30, 30 min.
            assert abs((attempt - at).total_seconds() - 136 * 60) < 1
        else:
            # A historical failure precedes a recovery, then subsequent successes.
            assert any(
                row["type"] == "source.recovered"
                and row["source_id"] == source["id"]
                and at < datetime.fromisoformat(row["at"]) <= success
                for row in rows
            )


@pytest.mark.parametrize("timezone", ["UTC0", "UTC-4", "UTC+7"])
def test_demo_failed_job_local_end_times_match_events(timezone: str) -> None:
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setenv("TZ", timezone)
            time.tzset()
            for event in events():
                if event["type"] == "job.failed":
                    end = datetime.fromisoformat(event["data"]["job"]["end"])
                    assert end.tzinfo is None
                    assert (
                        abs(end.timestamp() - datetime.fromisoformat(event["at"]).timestamp()) < 1
                    )
    finally:
        time.tzset()


def test_demo_failure_coverage_uses_only_fresh_history_sources() -> None:
    data = dashboard()
    covered = [source for source in data["sources"] if fresh(source, "history")]
    assert data["failure_history_sources"] == [source["id"] for source in covered]
    assert data["failure_history_sources"] == ["example:cluster-a-alice", "example:cluster-b-alice"]
    assert not {
        "example:cluster-c-alice",
        "example:cluster-a-carol",
        "example:cluster-a-bob",
    }.intersection(data["failure_history_sources"])
    assert data["failure_history_observed_at"] == min(source["last_success"] for source in covered)
