"""The built-in example should demonstrate usable planner choices."""

from computedeck.demo import dashboard
from computedeck.drivers.cloud import instance_lifecycle
from computedeck.store import gpu_allocation, manual_state


def test_demo_has_verified_planner_choices() -> None:
    data = dashboard()
    clusters = [source for source in data["sources"] if source["kind"] == "cluster"]
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
    assert data["summary"]["unmeasured"][0]["subject"]["name"] == "build-box"
    assert data["summary"]["groups"]["cluster-b"]["nodes"]["usable"] == 48
    assert data["summary"]["groups"]["cluster-b"]["nodes"]["unavailable"] == 16

    assert data["summary"]["groups"]["cluster-b"]["nodes"]["known_usable"] == 48
    for source in data["sources"]:
        if source["kind"] == "cluster":
            assert source["cluster_state"] == "available"
    nodes = {(node["cluster_id"], node["name"]): node for node in data["nodes"]}
    for job in data["jobs"]:
        if job["state"] == "RUNNING":
            assert nodes[job["cluster_id"], job["node"]]["health"] == "usable"
    unavailable = [node for node in data["nodes"] if node["health"] == "unavailable"]
    assert {node["state"] for node in unavailable} == {"down*", "drained"}
    assert all(node["gpu_allocated"] == 0 for node in unavailable)


def test_demo_collecting_keeps_the_previous_success_age() -> None:
    data = dashboard()
    assert data["refreshing"] is True
    [collecting] = [s for s in data["sources"] if s["id"] in data["collecting"]]
    assert collecting["status"] == "syncing"
    assert collecting["last_attempt"] > data["as_of"] == collecting["last_success"]
    assert data["as_of"] < data["updated_at"]
    assert data["behind"] == []
    assert data["failure_history_observed_at"] == data["as_of"]
    assert all(source["next_due_at"] for source in data["sources"])
    for job in data["jobs"]:
        if job["source_id"] == collecting["id"]:
            assert job["observed_at"] == collecting["last_success"]
