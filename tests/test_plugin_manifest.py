"""Plugin manifests: version ranges, compatibility, package details and web bundles."""

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import plugins as plugin_host
from computedeck import versions
from computedeck.plugins import PLUGIN_API, Plugin, PluginContext, compatibility

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}


def test_version_ranges() -> None:
    assert versions.satisfies("0.3.0a0", ">=0.3,<0.5")
    assert versions.satisfies("0.4.2", ">=0.3, <0.5")
    assert not versions.satisfies("0.5.0", ">=0.3,<0.5")
    assert versions.satisfies("0.3.7", "==0.3.*")
    assert not versions.satisfies("0.4.0", "==0.3.*")
    assert versions.satisfies("1.4.0", "~=1.2")
    assert not versions.satisfies("2.0", "~=1.2")
    assert versions.satisfies("0.3.2", "~=0.3.1")
    assert not versions.satisfies("0.4.0", "~=0.3.1")
    assert versions.satisfies("9.9", "") and versions.satisfies("9.9", None)
    assert not versions.valid_range(">=0.3,banana")
    with pytest.raises(ValueError):
        versions.satisfies("0.3", "=>0.3")


def plugin(**changes: Any) -> Plugin:
    return replace(Plugin("sample", lambda ctx: None), **changes)


def test_incompatible_plugins_are_explained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(versions, "core_version", lambda: "0.3.0")
    assert compatibility(plugin()) is None
    assert compatibility(plugin(requires=">=0.3,<0.4")) is None
    assert compatibility(plugin(api=PLUGIN_API + 1)) == {
        "code": "plugin_api_newer",
        "api": PLUGIN_API + 1,
        "supported": PLUGIN_API,
    }
    assert compatibility(plugin(requires=">=1.0")) == {
        "code": "plugin_requires_core",
        "requires": ">=1.0",
        "version": "0.3.0",
    }
    assert compatibility(plugin(requires="soon"))["code"] == "plugin_requires_invalid"  # type: ignore[index]
    assert compatibility(plugin(id="Bad Id"))["code"] == "plugin_id_invalid"  # type: ignore[index]
    # A declared but unbuilt web bundle does not stop the plugin; the Toolbox says so.
    assert compatibility(plugin(web=tmp_path)) is None


def test_a_rejected_plugin_is_listed_but_never_set_up(tmp_path: Path) -> None:
    calls: list[str] = []

    def setup(ctx: PluginContext) -> None:
        calls.append("setup")

        @ctx.router.get("/ping")
        async def ping() -> dict[str, bool]:
            return {"pong": True}

    future = Plugin("future", setup, api=PLUGIN_API + 1, version="2.0.0", package="future-tool")
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[future])) as client:
        [entry] = client.get("/api/toolbox").json()
        assert entry["enabled"] is False
        assert entry["rejected"]["code"] == "plugin_api_newer"
        assert entry["version"] == "2.0.0" and entry["package"] == "future-tool"
        assert client.get("/api/plugins/future/ping").status_code == 404
        response = client.put("/api/toolbox/future", json={"enabled": True}, headers=HEADERS)
        assert response.status_code == 422
        assert client.get("/api/health").json()["plugins"]["future"] == {"enabled": False}
    assert calls == []


def test_web_bundles_are_served_per_package(tmp_path: Path) -> None:
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.js").write_text("ComputeDeck.register({ id: 'demo' });\n")
    tools = [
        Plugin("first", lambda ctx: None, web=web, package="demo-tools", version="1.0"),
        Plugin("second", lambda ctx: None, web=web, package="demo-tools", version="1.0"),
    ]
    with TestClient(api.create_app(tmp_path / "data", polling=False, plugins=tools)) as client:
        assert [entry["web"] for entry in client.get("/api/toolbox").json()] == [
            "/plugin-web/demo-tools/",
            "/plugin-web/demo-tools/",
        ]
        script = client.get("/plugin-web/demo-tools/index.js")
        assert script.status_code == 200 and "ComputeDeck.register" in script.text


def test_an_unbuilt_web_bundle_is_noted(tmp_path: Path) -> None:
    tool = Plugin("bare", lambda ctx: None, web=tmp_path / "missing", package="bare-tool")
    with TestClient(api.create_app(tmp_path / "data", polling=False, plugins=[tool])) as client:
        [entry] = client.get("/api/toolbox").json()
    assert entry["web"] is None and entry["rejected"] is None
    assert entry["notes"] == [{"code": "plugin_web_missing"}]


def test_discovery_records_the_installed_package(monkeypatch: pytest.MonkeyPatch) -> None:
    class Dist:
        metadata = {"Name": "computedeck-hello"}
        version = "1.2.3"

    class Entry:
        name = "hello"
        dist = Dist()

        def load(self) -> Plugin:
            return Plugin("hello", lambda ctx: None)

    monkeypatch.setattr(plugin_host, "entry_points", lambda group: [Entry()])
    [found] = plugin_host.discover()
    assert (found.package, found.version) == ("computedeck-hello", "1.2.3")


def test_the_sdk_exports_the_stable_names() -> None:
    from computedeck import sdk

    for name in sdk.__all__:
        assert hasattr(sdk, name), name
    assert sdk.PLUGIN_API == PLUGIN_API
