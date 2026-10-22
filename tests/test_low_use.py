"""Low-use hints never turn a saved measurement or an observation gap into duration."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import ValidationError

from computedeck import attention, demo
from computedeck.drivers.cloud import CloudDriver, provider_console_url
from computedeck.low_use import low_use
from computedeck.records import SettingsInput
from computedeck.store import Store

NOW = datetime.now(UTC)
AddSource = Callable[..., dict[str, Any]]


def readings(ages: list[int], **changes: Any) -> list[dict[str, Any]]:
    return [
        {
            "at": (NOW - timedelta(minutes=age)).isoformat(),
            "gpu_util": 3,
            "gpu_util_max": 4,
            "origin": "source",
            **changes,
        }
        for age in ages
    ]


def evaluate(rows: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
    return low_use(
        {"state": "running"},
        rows,
        now=NOW,
        interval_minutes=10,
        threshold=10,
        window_minutes=60,
        **kwargs,
    )


@pytest.mark.parametrize(
    "ages, state, count",
    [
        ([0], "unknown", 1),
        ([60, 0], "unknown", 1),
        ([60, 50, 40, 30, 20, 10, 0], "low", 7),
        ([60, 40, 20, 0], "low", 4),
        ([60, 40, 19, 0], "unknown", 2),
        ([50, 40, 30, 20, 10, 0], "unknown", 6),
        ([81, 61, 41, 21], "unknown", 0),
    ],
)
def test_coverage_minimum_and_gaps(ages: list[int], state: str, count: int) -> None:
    result = evaluate(readings(ages))
    assert result["state"] == state
    assert result["samples"] == count
    assert result["covered_minutes"] <= ages[0] - ages[-1]


def test_maximum_and_threshold_break_the_streak() -> None:
    rows = readings([60, 50, 40, 30, 20, 10, 0])
    rows[-1]["gpu_util_max"] = 70  # one busy GPU hidden by a low mean
    assert evaluate(rows)["state"] == "busy"
    rows[-1]["gpu_util_max"] = 10  # strict less-than, not <=
    assert evaluate(rows)["state"] == "busy"
    rows[-1]["gpu_util_max"] = 4
    rows[3]["gpu_util"] = 12
    assert evaluate(rows)["samples"] == 3
    assert evaluate(rows)["covered_minutes"] == 20
    assert evaluate(rows)["state"] == "unknown"


def test_provider_origin_and_observed_span() -> None:
    rows = readings([70, 60, 50, 40, 30, 20, 10], gpu_util_max=None, origin="provider")
    result = evaluate(rows)
    assert result["state"] == "low"
    assert result["covered_minutes"] == 60  # never extend to the present
    assert result["origin"] == "provider"
    rows[-1]["origin"] = "probe"
    restarted = evaluate(rows)
    assert restarted["samples"] == 1
    assert restarted["state"] == "unknown"
    assert restarted["origin"] == "probe"
    assert restarted["since"] == rows[-1]["at"]


@pytest.mark.parametrize("state", ["stopped", "missing", "unknown", "desired_running"])
def test_only_held_instances_qualify(state: str) -> None:
    result = low_use(
        {"state": state},
        readings([60, 40, 20, 0]),
        now=NOW,
        interval_minutes=10,
        threshold=10,
        window_minutes=60,
    )
    assert result["state"] == "unknown"
    assert result["reason"] == "not_running"


def listed(source: dict[str, Any], at: str, **changes: Any) -> dict[str, Any]:
    return {
        "id": "example:box",
        "source_id": source["id"],
        "platform": "Example",
        "name": "box",
        "state": "running",
        "gpu_count": 2,
        "gpu_observed_count": 2,
        "gpu_utilization": 3,
        "gpu_utilization_max": 4,
        "host": "192.0.2.1",
        "hourly_cost": 0.6,
        "currency": "USD",
        "observed_at": at,
        **changes,
    }


def fill(store: Store, source: dict[str, Any]) -> dict[str, Any]:
    for reading in readings([60, 50, 40, 30, 20, 10, 0]):
        row = listed(source, reading["at"])
        store.save_snapshot(source["id"], {"instances": [row]})
    return row


@pytest.mark.parametrize("driver, origin", [("vastai", "provider"), ("ssh", "source")])
def test_snapshots_store_actual_readings_only(
    store: Store, add_source: AddSource, driver: str, origin: str
) -> None:
    source = add_source(driver=driver)
    row = fill(store, source)
    result = store.dashboard()["instances"][0]["low_use"]
    assert result["state"] == "low"
    assert result["origin"] == origin
    assert result["samples"] == 7
    store.save_snapshot(source["id"], {"jobs": []})
    store.record_history()
    store.dashboard()
    assert store.db.execute("SELECT count(*) FROM instance_samples").fetchone()[0] == 7
    # Re-saving the same observation never creates extra evidence.
    store.save_snapshot(source["id"], {"instances": [row]})
    assert store.dashboard()["instances"][0]["low_use"]["samples"] == 7
    # An actual collection without measurements breaks coverage.
    store.save_snapshot(source["id"], {"instances": [{**row, "gpu_utilization": None}]})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"


@pytest.mark.parametrize(
    "changes",
    [
        {"state": "stopped"},
        {"state": "desired_running"},
        {"started_at": NOW.isoformat()},
        {"host": "192.0.2.2"},
    ],
)
def test_lifecycle_restart_and_endpoint_changes_break_history(
    store: Store, add_source: AddSource, changes: dict[str, Any]
) -> None:
    source = add_source(driver="vastai")
    row = fill(store, source)
    store.save_snapshot(source["id"], {"instances": [{**row, **changes}]})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"
    store.save_snapshot(source["id"], {"instances": [row]})
    assert store.dashboard()["instances"][0]["low_use"]["samples"] == 1


def test_disappearance_and_disabled_source(store: Store, add_source: AddSource) -> None:
    source = add_source(driver="vastai")
    row = fill(store, source)
    store.save_source({**source, "enabled": False})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"
    store.save_source(source)
    store.save_snapshot(source["id"], {"instances": []})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"
    store.save_snapshot(source["id"], {"instances": [row]})
    assert store.dashboard()["instances"][0]["low_use"]["samples"] == 1


def test_probe_samples_survive_provider_listings_but_not_restarts(
    store: Store, add_source: AddSource
) -> None:
    source = add_source(driver="runpod")
    row = listed(source, NOW.isoformat(), gpu_utilization=None)
    store.save_snapshot(source["id"], {"instances": [row]})
    for reading in readings([60, 50, 40, 30, 20, 10, 0]):
        store.record_instance_sample(row, {**row, "gpu_utilization": 3}, reading["at"])
    store.save_snapshot(source["id"], {"instances": [row]})
    result = store.dashboard()["instances"][0]["low_use"]
    assert (result["state"], result["origin"], result["samples"]) == ("low", "probe", 7)
    store.record_instance_sample(
        row, {**row, "gpu_utilization": 3, "gpu_observed_count": 1}, NOW.isoformat()
    )
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"


def test_prune_seven_days_and_persist_across_reopen(store: Store, add_source: AddSource) -> None:
    source = add_source(driver="vastai")
    fill(store, source)
    store.db.execute(
        "INSERT INTO instance_samples VALUES (?, ?, ?, ?, ?)",
        ("old", (NOW - timedelta(days=8)).isoformat(), 0, None, "provider"),
    )
    store.db.commit()
    store.record_history()
    assert store.db.execute("SELECT count(*) FROM instance_samples").fetchone()[0] == 7
    other = Store(store.path)
    try:
        assert other.dashboard()["instances"][0]["low_use"]["state"] == "low"
    finally:
        other.db.close()


@pytest.mark.parametrize(
    "key, values",
    [
        ("low_use_threshold", [0, 51, 1.5, True, None, "10"]),
        ("low_use_window_minutes", [29, 361, 60.5, False, None, "60"]),
    ],
)
def test_settings_validation(store: Store, key: str, values: list[Any]) -> None:
    for value in values:
        with pytest.raises(ValidationError):
            SettingsInput(**{key: value})
        with pytest.raises(ValueError):
            store.save_settings({key: value})
        # Old or malformed disk values must not bypass the defaults either.
        store.db.execute(
            "INSERT OR REPLACE INTO meta VALUES (?, ?)", (f"setting:{key}", json.dumps(value))
        )
        assert store.settings()[key] == (10 if key == "low_use_threshold" else 60)


def test_settings_recompute_existing_readings(store: Store, add_source: AddSource) -> None:
    fill(store, add_source(driver="vastai"))
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "low"
    store.save_settings({"low_use_threshold": 2, "low_use_window_minutes": 30})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "busy"
    store.save_settings({"low_use_threshold": 50, "low_use_window_minutes": 360})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"


def test_attention_money_acknowledgement_and_resolution() -> None:
    data = demo.dashboard()
    item = next(i for i in data["instances"] if i["name"] == "dev-box")

    def derive(state: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return [
            a
            for a in attention.derive(data, [], now=NOW, state=state)
            if a["kind"] == "instance_low_use"
        ]

    first = derive()[0]
    assert first["severity"] == "warn" and first["mutable"]
    assert first["message"]["cost"] == pytest.approx(0.4)
    state = {
        first["key"]: {"fingerprint": first["fingerprint"], "acknowledged_at": NOW.isoformat()}
    }
    item["low_use"].update(covered_minutes=70, samples=8)
    assert derive(state)[0]["muted"]["state"] == "acknowledged"
    item["hourly_cost"] = None
    assert derive()[0]["message"]["cost"] is None
    item["low_use"]["since"] = (NOW - timedelta(minutes=70)).isoformat()
    assert derive(state)[0]["muted"]["state"] == "acknowledged"
    data["low_use_settings"]["threshold"] = 5
    assert derive(state)[0]["muted"] is None
    for status in ("busy", "unknown"):
        item["low_use"]["state"] = status
        assert derive() == []


def test_console_template_is_optional_and_encoded() -> None:
    assert CloudDriver.console_url is None
    assert (
        provider_console_url("https://example.com/{region}/{id}", "a/b?#", "a b")
        == "https://example.com/a%20b/a%2Fb%3F%23"
    )
    for template in (
        None,
        "http://example.com",
        "javascript:alert(1)",
        "https://example.com/{secret}",
        "https://example.com/{id!r}",
        "https://example.com/{id:10}",
    ):
        assert provider_console_url(template, "box", None) is None


def test_three_readings_are_required_even_with_a_long_interval() -> None:
    for ages, state in [([60, 0], "unknown"), ([60, 30, 0], "low")]:
        result = low_use(
            {"state": "running"},
            readings(ages),
            now=NOW,
            interval_minutes=30,
            threshold=10,
            window_minutes=60,
        )
        assert result["state"] == state


def test_monitored_manual_machine_qualifies_and_monitoring_off_resets_it(store: Store) -> None:
    row = {
        "id": "manual:box",
        "name": "box",
        "manual": True,
        "monitoring": True,
        "state": "unknown",
        "ssh_status": "reachable",
        "observed_at": NOW.isoformat(),
        "gpu_count": 1,
        "gpu_observed_count": 1,
        "gpu_utilization": 2,
        "gpu_utilization_max": 2,
    }
    store.save_instance(row)
    for reading in readings([60, 50, 40, 30, 20, 10, 0]):
        store.record_instance_sample({**row, "state": "running"}, row, reading["at"])
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "low"
    store.save_instance({**row, "monitoring": False})
    assert store.dashboard()["instances"][0]["low_use"]["state"] == "unknown"
    store.save_instance(row)
    assert store.dashboard()["instances"][0]["low_use"]["samples"] == 0


@pytest.mark.parametrize("interval, age, state", [(30, 25, "low"), (5, 11, "unknown")])
def test_ssh_source_interval_applies_when_latest_reading_is_a_probe(
    store: Store, add_source: AddSource, interval: int, age: int, state: str
) -> None:
    source = add_source(driver="ssh", interval_minutes=interval)
    for minutes in range(age + 60, age - 1, -interval):
        row = listed(source, (NOW - timedelta(minutes=minutes)).isoformat())
        store.save_snapshot(source["id"], {"instances": [row]})
    store.record_instance_sample(row, row, row["observed_at"])
    usage = store.dashboard()["instances"][0]["low_use"]
    assert usage["origin"] == "probe"
    assert usage["state"] == state
    if state == "unknown":
        assert usage["reason"] == "stale"
    else:
        assert usage["covered_minutes"] == 60
