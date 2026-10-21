"""The Toolbox: plugins switch on and off, settings are validated, loops follow the switch."""

import asyncio
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck.plugins import Plugin, PluginContext, Runtime, SettingField, run
from computedeck.store import Store

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}


def optional_tool(ticks: list[str] | None = None) -> Plugin:
    def setup(ctx: PluginContext) -> None:
        @ctx.router.get("/ping")
        async def ping() -> dict[str, bool]:
            return {"pong": True}

        async def loop() -> None:
            while True:
                if ticks is not None:
                    ticks.append("tick")
                await asyncio.sleep(0.01)

        ctx.background(loop)
        ctx.health = lambda: {"ready": True}

        def validate(values: dict[str, Any]) -> dict[str, Any]:
            if values.get("limit") is not None and values["limit"] > 100:
                raise ValueError("limit_too_high")
            return values

        ctx.validate_settings(validate)

    return Plugin(
        "tool",
        setup,
        name={"en": "Tool", "zh-CN": "工具"},
        default_enabled=False,
        page="tool",
        settings=(
            SettingField(key="address", label={"en": "Address"}, required=True),
            SettingField(key="limit", label={"en": "Limit"}, kind="number", default=10),
            SettingField(key="mode", label={"en": "Mode"}, kind="select", choices=["a", "b"]),
            SettingField(key="key", label={"en": "Key"}, kind="credential"),
            SettingField(key="loud", label={"en": "Loud"}, kind="boolean", default=False),
        ),
    )


@pytest.fixture
def client(tmp_path: Path) -> Any:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[optional_tool()])) as value:
        yield value


def put(client: TestClient, body: dict[str, Any]) -> Any:
    return client.put("/api/toolbox/tool", json=body, headers=HEADERS)


def test_switching_tool_off_clears_its_acknowledgement(tmp_path: Path) -> None:
    def setup(context: PluginContext) -> None:
        context.health = lambda: {"error": "delivery_failed"}

    plugin = Plugin("tool", setup)
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[plugin])) as client:
        [item] = client.get("/api/dashboard").json()["attention"]
        assert (
            client.put(
                f"/api/attention/{item['key']}", json={"action": "acknowledge"}, headers=HEADERS
            ).status_code
            == 200
        )
        assert client.get("/api/dashboard").json()["attention_count"] == 0
        assert put(client, {"enabled": False}).status_code == 200
        assert client.get("/api/dashboard").json()["attention"] == []
        assert put(client, {"enabled": True}).status_code == 200
        data = client.get("/api/dashboard").json()
        [returned] = data["attention"]
        assert returned["fingerprint"] == item["fingerprint"]
        assert returned["muted"] is None
        assert data["attention_count"] == 1


def test_an_optional_tool_starts_off_and_its_routes_are_closed(client: TestClient) -> None:
    [entry] = client.get("/api/toolbox").json()
    assert entry["enabled"] is False
    assert entry["name"] == {"en": "Tool", "zh-CN": "工具"}
    assert entry["values"] == {
        "address": None,
        "limit": 10,
        "mode": None,
        "key": None,
        "loud": False,
    }
    # Health of a switched-off plugin is not run.
    assert entry["health"] == {}
    response = client.get("/api/plugins/tool/ping")
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "plugin_disabled", "plugin": "tool"}
    assert client.get("/api/health").json()["plugins"]["tool"]["enabled"] is False


def test_settings_are_validated_before_anything_is_saved(client: TestClient) -> None:
    def code(body: dict[str, Any]) -> Any:
        response = put(client, body)
        assert response.status_code == 422, response.text
        return response.json()["detail"]

    assert code({"settings": {"unknown": 1}}) == {"code": "setting_unknown", "setting": "unknown"}
    assert code({"settings": {"limit": "ten"}})["code"] == "setting_invalid"
    assert code({"settings": {"mode": "c"}})["code"] == "setting_invalid"
    assert code({"settings": {"key": "plain-secret"}})["code"] == "setting_invalid"
    assert code({"settings": {"address": "a\nb"}})["code"] == "setting_invalid"
    assert code({"settings": {"limit": 500}})["code"] == "limit_too_high"
    # A required setting must be present before the tool can be switched on.
    assert code({"enabled": True}) == {"code": "setting_required", "setting": "address"}
    assert client.get("/api/toolbox").json()[0]["values"]["limit"] == 10
    saved = put(client, {"settings": {"address": " ops@example.com ", "key": "env:TOOL_KEY"}})
    assert saved.json()["values"]["address"] == "ops@example.com"
    entry = put(client, {"enabled": True}).json()
    assert entry["enabled"] is True and entry["health"] == {"ready": True}
    assert client.get("/api/plugins/tool/ping").json() == {"pong": True}
    assert put(client, {"enabled": False}).json()["enabled"] is False
    assert client.get("/api/plugins/tool/ping").status_code == 404


def test_unknown_tool_is_not_found(client: TestClient) -> None:
    response = client.put("/api/toolbox/absent", json={"enabled": True}, headers=HEADERS)
    assert response.status_code == 404


async def test_loops_run_only_while_the_tool_is_on(store: Store, tmp_path: Path) -> None:
    runtime = Runtime(tmp_path)
    runtime.store = store
    ticks: list[str] = []
    plugin = optional_tool(ticks)
    context = PluginContext(plugin, runtime)
    plugin.setup(context)
    task = asyncio.create_task(run(context, runtime))
    await asyncio.sleep(0.05)
    assert ticks == []
    store.set_plugin_enabled("tool", True)
    context.changed.set()
    await asyncio.sleep(0.05)
    assert ticks
    store.set_plugin_enabled("tool", False)
    context.changed.set()
    await asyncio.sleep(0.05)
    count = len(ticks)
    await asyncio.sleep(0.05)
    assert len(ticks) == count
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_example_events_are_served_in_demo_mode(client: TestClient) -> None:
    rows = client.get("/api/events?demo=true").json()
    assert [row["type"] for row in rows[:5]] == [
        "source.recovered",
        "source.gap",
        "source.failed",
        "job.started",
        "job.finished",
    ]
    assert rows[0]["source_id"] == rows[1]["source_id"] == "example:cluster-d-alice"
    assert rows[0]["at"] == rows[1]["at"]
    assert rows[2]["source_id"] == "example:runpod-secondary"
    assert rows[2]["data"]["error"] == {"code": "http_status", "status": 429}
    assert [row["at"] for row in rows] == sorted((row["at"] for row in rows), reverse=True)
    assert all(row["key"].startswith("example:") for row in rows)
    assert client.get("/api/events").json() == []


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_non_finite_numbers_are_rejected(client: TestClient, value: float) -> None:
    import json

    response = client.put(
        "/api/toolbox/tool",
        content=json.dumps({"settings": {"limit": value}}),
        headers={**HEADERS, "Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert client.get("/api/toolbox").json()[0]["values"]["limit"] == 10
