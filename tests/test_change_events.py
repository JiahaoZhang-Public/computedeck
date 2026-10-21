"""Saved user actions are private to the opt-in Activity feed, without setting values."""

import asyncio
import json
from collections.abc import Iterator
from contextlib import suppress
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import app, config, events, plugins, sdk
from computedeck import store as store_module
from computedeck.store import Store, now
from computedeck.tools import notify

HEADERS = {
    "Origin": "http://127.0.0.1:8710",
    "X-ComputeDeck": "1",
    "Content-Type": "application/json",
}
SOURCE = {"name": "Cluster A", "driver": "slurm", "ssh_alias": "cluster-a", "username": "alice"}
NODE = {"name": "Gateway", "ssh_alias": "gateway", "command": "computedeck"}
INSTANCE = {"name": "Box", "platform": "Lab", "external_id": "box", "host": "192.0.2.1"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    tool = plugins.Plugin(
        "example",
        lambda ctx: None,
        name={"en": "Example"},
        default_enabled=False,
        settings=(plugins.SettingField(key="address", label={"en": "Address"}),),
    )
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[tool])) as value:
        yield value


def changes(client: TestClient) -> list[dict[str, Any]]:
    return client.get("/api/events?include=changes").json()


def test_source_actions_and_unchanged_fields(client: TestClient) -> None:
    source = client.post("/api/sources", json=SOURCE, headers=HEADERS)
    assert source.status_code == 201
    key = source.json()["id"]
    [added] = changes(client)
    assert added["type"] == "change.source"
    assert added["source_id"] == key
    assert added["data"] == {
        "subject_id": key,
        "name": "Cluster A",
        "action": "added",
        "fields": sorted(SOURCE),
    }
    for body, action, fields in [
        ({"enabled": False}, "disabled", ["enabled"]),
        ({"enabled": True}, "enabled", ["enabled"]),
        (
            {
                "name": "Cluster A",
                "interval_minutes": 15,
                "options": {"note": "hidden-value"},
                "credential": "env:EXAMPLE_SECRET",
            },
            "edited",
            ["credential", "interval_minutes", "options"],
        ),
        ({"interval_minutes": 15}, "edited", []),
    ]:
        before = len(changes(client))
        assert client.put(f"/api/sources/{key}", json=body, headers=HEADERS).status_code == 200
        rows = changes(client)
        assert len(rows) == before + 1
        assert rows[0]["data"]["action"] == action
        assert rows[0]["data"]["fields"] == fields
    assert client.delete(f"/api/sources/{key}", headers=HEADERS).status_code == 200
    rows = changes(client)
    assert len(rows) == 6
    assert rows[0]["data"] == {
        "subject_id": key,
        "name": "Cluster A",
        "action": "removed",
        "fields": [],
    }
    raw = json.dumps(rows)
    assert "hidden-value" not in raw and "EXAMPLE_SECRET" not in raw
    assert 'interval_minutes": 15' not in raw
    assert client.get("/api/events").json() == []


@pytest.mark.parametrize(
    "path,body,kind,edit,fields",
    [
        ("nodes", NODE, "change.node", {"ssh_alias": "other-gateway"}, ["ssh_alias"]),
        (
            "instances",
            INSTANCE,
            "change.instance",
            {"host": "192.0.2.2", "identity_file": "~/.ssh/example_key"},
            ["host", "identity_file"],
        ),
    ],
)
def test_machine_actions(
    client: TestClient,
    path: str,
    body: dict[str, Any],
    kind: str,
    edit: dict[str, Any],
    fields: list[str],
) -> None:
    response = client.post(f"/api/{path}", json=body, headers=HEADERS)
    assert response.status_code == 201
    key = response.json()["id"]
    [added] = changes(client)
    assert added["type"] == kind and added["data"]["action"] == "added"
    assert (
        client.put(f"/api/{path}/{key}", json={**body, **edit}, headers=HEADERS).status_code == 200
    )
    rows = changes(client)
    assert len(rows) == 2
    assert rows[0]["data"]["fields"] == fields
    assert client.delete(f"/api/{path}/{key}", headers=HEADERS).status_code == 200
    rows = changes(client)
    assert len(rows) == 3
    assert [row["data"]["action"] for row in rows] == ["removed", "edited", "added"]
    assert all(row["type"] == kind and row["data"]["name"] == body["name"] for row in rows)
    assert all(value not in json.dumps(rows) for value in edit.values())


@pytest.mark.parametrize(
    "path,body", [("sources", SOURCE), ("nodes", NODE), ("instances", INSTANCE)]
)
def test_rejected_crud_writes_record_nothing(
    client: TestClient, path: str, body: dict[str, Any]
) -> None:
    assert client.post(f"/api/{path}", json={}, headers=HEADERS).status_code == 422
    assert changes(client) == []
    response = client.post(f"/api/{path}", json=body, headers=HEADERS)
    assert response.status_code == 201
    saved = changes(client)
    key = response.json()["id"]
    for method, suffix, payload, status in [
        ("POST", "", body, 409),
        ("PUT", f"/{key}", {"name": ""}, 422),
        ("PUT", "/missing", {key: value for key, value in body.items() if key != "driver"}, 404),
        ("DELETE", "/missing", None, 404),
    ]:
        result = client.request(method, f"/api/{path}{suffix}", json=payload, headers=HEADERS)
        assert result.status_code == status
        assert changes(client) == saved
    assert client.delete(f"/api/{path}/{key}").status_code == 403
    assert changes(client) == saved


def test_node_in_use_and_source_validation_record_nothing(client: TestClient) -> None:
    node = client.post("/api/nodes", json=NODE, headers=HEADERS).json()
    source = client.post(
        "/api/sources", json={**SOURCE, "node": node["id"]}, headers=HEADERS
    ).json()
    saved = changes(client)
    assert client.delete(f"/api/nodes/{node['id']}", headers=HEADERS).status_code == 409
    for patch in [{"node": "missing"}, {"credential": "plain-secret"}]:
        assert (
            client.put(f"/api/sources/{source['id']}", json=patch, headers=HEADERS).status_code
            == 422
        )
    assert changes(client) == saved


def test_tool_changes_omit_settings_names_and_values(client: TestClient) -> None:
    for index, (body, action) in enumerate(
        [
            ({"enabled": True, "settings": {"address": "private@example.com"}}, "on"),
            ({"settings": {"address": "different@example.com"}}, "settings"),
            ({"enabled": False}, "off"),
        ],
        1,
    ):
        assert client.put("/api/toolbox/example", json=body, headers=HEADERS).status_code == 200
        rows = changes(client)
        assert len(rows) == index
        assert rows[0]["type"] == "change.tool"
        assert rows[0]["data"] == {
            "subject_id": "example",
            "name": "Example",
            "action": action,
            "fields": [],
        }
    saved = changes(client)
    for path, body, status in [
        ("example", {"settings": {"unknown": "secret"}}, 422),
        ("example", {"settings": {"address": []}}, 422),
        ("missing", {"enabled": True}, 404),
    ]:
        assert client.put(f"/api/toolbox/{path}", json=body, headers=HEADERS).status_code == status
    assert changes(client) == saved
    # Language and server-name preferences are intentionally outside this slice.
    assert (
        client.put("/api/settings", json={"language": "zh-CN"}, headers=HEADERS).status_code == 200
    )
    assert changes(client) == saved


def test_import_records_one_summary_and_no_configuration_values(store: Store) -> None:
    text = """
[[cluster]]
label = "Cluster A"
ssh_alias = "login-hidden"
username = "alice"
credential = "env:EXAMPLE_SECRET"
options = { note = "private-option" }
[[node]]
name = "Gateway"
ssh_alias = "gateway-hidden"
[[instance]]
platform = "Lab"
id = "box"
name = "Box"
host = "192.0.2.9"
"""
    for index in (1, 2):
        counts = config.apply(store, text)
        rows = store.recent_events(include_changes=True)
        assert len(rows) == index
        assert rows[0]["type"] == "change.import"
        assert rows[0]["source_id"] is None
        assert rows[0]["data"] == {
            "subject_id": "config",
            "name": "",
            "action": "imported",
            "fields": [],
            "counts": {"sources": 1, "nodes": 1, "instances": 1},
        }
        assert rows[0]["data"]["counts"] == counts
    for bad in ["invalid toml", text.replace("env:EXAMPLE_SECRET", "plain-secret")]:
        with pytest.raises(config.ConfigError):
            config.apply(store, bad)
        assert store.recent_events(include_changes=True) == rows


def test_store_visibility_limits_and_no_merge(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    stamp = now()
    monkeypatch.setattr(store_module, "now", lambda: stamp)
    for index in range(3):
        store.add_events(
            [
                {
                    "key": f"job:{index}",
                    "type": "job.started",
                    "at": stamp,
                    "data": {"job": {"id": str(index)}},
                }
            ]
        )
        store.add_change("change.source", "cluster-a", "Cluster A", "disabled", ["enabled"])
        store.add_change("change.source", "cluster-a", "Cluster A", "enabled", ["enabled"])
    all_rows = store.recent_events(include_changes=True)
    assert len(all_rows) == 9 and len({row["key"] for row in all_rows}) == 9
    assert [row["type"] for row in store.recent_events(2)] == ["job.started", "job.started"]
    assert [row["id"] for row in store.recent_events(2)] == [7, 4]
    assert len(store.recent_event_collections(1)) == 3
    assert len(store.recent_event_collections(2, include_changes=True)) == 2
    grouped = events.group_events(store.recent_event_collections(10, include_changes=True))
    assert len(grouped) == 7
    assert sum("group" in row for row in grouped) == 1
    assert all("group" not in row for row in grouped if row["type"].startswith("change."))


@pytest.mark.parametrize("demo", [False, True])
def test_api_visibility_applies_to_plain_grouped_and_id_reads(
    client: TestClient, demo: bool
) -> None:
    client.post("/api/sources", json=SOURCE, headers=HEADERS)
    for group in (0, 1):
        query = f"demo={str(demo).lower()}&group={group}&limit=200"
        default = client.get(f"/api/events?{query}").json()
        assert all(not row["type"].startswith("change.") for row in default)
        included = client.get(f"/api/events?{query}&include=changes").json()
        change_rows = [row for row in included if row["type"].startswith("change.")]
        assert change_rows
        for row in change_rows:
            assert client.get(f"/api/events?{query}&id={row['id']}").json() == []
            assert client.get(f"/api/events?{query}&id={row['id']}&include=changes").json() == [row]
        limited = client.get(f"/api/events?{query.replace('limit=200', 'limit=1')}").json()
        assert limited == default[:1]


async def test_changes_never_reach_any_plugin_subscription(store: Store, tmp_path: Path) -> None:
    assert not set(events.CHANGE_TYPES) & set(sdk.EVENT_TYPES)
    assert not set(events.CHANGE_TYPES) & set(notify.NOTIFY_TYPES)
    runtime = plugins.Runtime(tmp_path)
    runtime.store = store
    context = plugins.PluginContext(plugins.Plugin("watcher", lambda ctx: None), runtime)
    seen: list[str] = []
    delivered = asyncio.Event()

    async def handle(event: dict[str, Any]) -> None:
        seen.append(event["type"])
        if len(seen) == 2:
            delivered.set()

    for types in (None, sdk.EVENT_TYPES, events.CHANGE_TYPES):
        context.on_event(handle, types)
    store.set_plugin_cursor(context.id, 0)
    for kind in (*events.CHANGE_TYPES, "change.future"):
        store.add_change(kind, "example", "Example", "edited", [])
        with pytest.raises(ValueError, match="event_type_unknown"):
            notify.check_rule(
                notify.RuleInput(name="Example", events=[kind], channels=["example"]), {"example"}
            )
    store.add_events([{"key": "after", "type": "job.started"}])
    task = asyncio.create_task(plugins.deliver(context, poll=0.001))
    try:
        await asyncio.wait_for(delivered.wait(), timeout=2)
        assert store.plugin_cursor(context.id) == store.last_event_id()
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert seen == ["job.started", "job.started"]
