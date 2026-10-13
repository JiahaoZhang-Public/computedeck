"""The built-in example should demonstrate usable planner choices."""

from computedeck.demo import dashboard


def test_demo_has_verified_planner_choices() -> None:
    data = dashboard()
    clusters = [source for source in data["sources"] if source["kind"] == "cluster"]
    assert clusters
    for source in clusters:
        assert {"jobs", "nodes", "qos_limits", "qos_access"} <= set(source["capabilities"])
        assert any(qos["access"] == "verified" for qos in source["qos"])
