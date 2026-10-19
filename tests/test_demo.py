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
    [machine] = [row for row in dashboard()["instances"] if row.get("manual")]
    # The state the service would derive from its last check, and GPUs with processes.
    assert machine["state"] == manual_state(machine) == "running"
    assert gpu_allocation(machine) == machine["gpu_allocated"] == 1


def test_demo_pod_is_reported_running_and_holds_its_listed_gpus() -> None:
    [pod] = [row for row in dashboard()["instances"] if row["platform"] == "RunPod"]
    assert pod["state"] == "reported_running"
    assert instance_lifecycle(pod["state"]) == "held"
    assert gpu_allocation(pod) == 2
