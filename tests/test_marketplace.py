"""Marketplaces: catalogs are validated, tiers come from where they were added, installs
are pinned and confirmed, and policy.toml is obeyed."""

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import cli, marketplace, versions
from computedeck.marketplace import MarketplaceError
from computedeck.plugins import Plugin

WHEEL = b"PK fake wheel"
WHEEL_SHA = hashlib.sha256(WHEEL).hexdigest()


def catalog(name: str = "lab-tools", **extra: Any) -> dict[str, Any]:
    return {
        "name": name,
        "owner": {"name": "Example Lab"},
        "plugins": [
            {
                "name": "pager",
                "display_name": {"en": "Pager alerts", "zh-CN": "寻呼提醒"},
                "description": {"en": "Sends failed jobs to a pager."},
                "version": "1.2.0",
                "source": {"type": "pypi", "package": "computedeck-pager", "version": "1.2.0"},
                "permissions": [{"en": "posts to the pager service you set"}],
                "requires": ">=0.3",
                "tags": ["alerts"],
                "author": {"name": "Example Lab"},
            },
            {
                "name": "gpu-map",
                "version": "0.1.0",
                "source": {
                    "type": "wheel",
                    "url": "https://downloads.example.com/gpu_map-0.1.0-py3-none-any.whl",
                    "sha256": WHEEL_SHA,
                },
                "requires": ">=9.0",
            },
            {"name": "local-dev", "version": "0.0.1", "source": {"type": "path", "path": "./dev"}},
        ],
        **extra,
    }


def folder_market(tmp_path: Path, data: dict[str, Any] | None = None) -> Path:
    folder = tmp_path / "market"
    (folder / "dev").mkdir(parents=True)
    (folder / marketplace.CATALOG).write_text(json.dumps(data or catalog()))
    return folder


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    return tmp_path / "data"


def test_catalog_sources_must_be_pinned() -> None:
    def bad(source: dict[str, Any]) -> None:
        data = catalog()
        data["plugins"][0]["source"] = source
        with pytest.raises(MarketplaceError):
            marketplace.parse_catalog(json.dumps(data))

    bad({"type": "pypi", "package": "x"})
    bad({"type": "wheel", "url": "https://example.com/x.whl"})
    bad({"type": "wheel", "url": "http://example.com/x.whl", "sha256": WHEEL_SHA})
    bad({"type": "git", "url": "https://example.com/x.git"})
    bad({"type": "path", "path": "../outside"})
    bad({"type": "path", "path": "/abs"})
    with pytest.raises(MarketplaceError):
        marketplace.parse_catalog(json.dumps({**catalog(), "name": "Bad Name"}))
    duplicate = catalog()
    duplicate["plugins"].append(duplicate["plugins"][0])
    with pytest.raises(MarketplaceError):
        marketplace.parse_catalog(json.dumps(duplicate))


def test_sources_are_classified_and_secrets_hidden() -> None:
    assert marketplace.classify("example-lab/plugins") == (
        "git",
        "https://github.com/example-lab/plugins.git",
    )
    assert marketplace.classify("https://example.com/computedeck-marketplace.json")[0] == "url"
    assert marketplace.classify("git@example.com:lab/plugins.git")[0] == "git"
    with pytest.raises(MarketplaceError):
        marketplace.classify("http://example.com/catalog.json")
    assert (
        marketplace.display_source("https://alice:t0ken@git.example.com/lab/plugins.git")
        == "https://git.example.com/lab/plugins.git"
    )


def test_folder_url_and_git_marketplaces(tmp_path: Path, data_dir: Path) -> None:
    record = marketplace.add_marketplace(data_dir, str(folder_market(tmp_path)))
    assert (record["name"], record["kind"], record["tier"]) == ("lab-tools", "path", "local")
    served = marketplace.add_marketplace(
        data_dir,
        "https://plugins.example.com/computedeck-marketplace.json",
        fetch=lambda url: json.dumps(catalog("remote-tools")),
    )
    assert served["tier"] == "community"

    def fake_git(args: list[str]) -> None:
        target = Path(args[-1])
        target.mkdir(parents=True)
        (target / marketplace.CATALOG).write_text(json.dumps(catalog("git-tools")))

    cloned = marketplace.add_marketplace(data_dir, "example-lab/plugins", git=fake_git)
    assert cloned["folder"] == str(data_dir / "marketplaces" / "git-tools")
    assert sorted(marketplace.registry(data_dir)) == ["git-tools", "lab-tools", "remote-tools"]
    with pytest.raises(MarketplaceError, match="already added"):
        marketplace.add_marketplace(
            data_dir,
            "https://other.example.com/computedeck-marketplace.json",
            fetch=lambda url: json.dumps(catalog("remote-tools")),
        )
    marketplace.remove_marketplace(data_dir, "git-tools")
    assert not (data_dir / "marketplaces" / "git-tools").exists()


def test_policy_limits_marketplaces_and_marks_internal_ones(tmp_path: Path, data_dir: Path) -> None:
    data_dir.mkdir()
    (data_dir / "policy.toml").write_text(
        'allowed_marketplaces = ["https://git.example.com/*"]\n'
        'internal_marketplaces = ["https://git.example.com/lab/*"]\n'
        'blocked_plugins = ["pager@*"]\n'
    )
    with pytest.raises(MarketplaceError, match="not an allowed marketplace"):
        marketplace.add_marketplace(data_dir, str(folder_market(tmp_path)))

    def fake_git(args: list[str]) -> None:
        target = Path(args[-1])
        target.mkdir(parents=True)
        (target / marketplace.CATALOG).write_text(json.dumps(catalog()))

    record = marketplace.add_marketplace(
        data_dir, "https://git.example.com/lab/plugins.git", git=fake_git
    )
    assert record["tier"] == "internal"
    rows = {row["name"]: row for row in marketplace.listing(data_dir)}
    assert rows["pager"]["blocked"] is True
    with pytest.raises(MarketplaceError, match="blocked"):
        marketplace.install(data_dir, "pager", run=lambda c: 0, confirm=lambda s: True)
    (data_dir / "policy.toml").write_text("unknown_key = 1\n")
    with pytest.raises(MarketplaceError):
        marketplace.load_policy(data_dir)


def test_listing_and_finding(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(marketplace, "core_version", lambda: "0.3.0")
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path)))
    rows = {row["name"]: row for row in marketplace.listing(data_dir)}
    assert rows["pager"]["compatible"] is True and rows["gpu-map"]["compatible"] is False
    assert rows["pager"]["command"] == "computedeck plugin install pager@lab-tools"
    assert rows["pager"]["installed_version"] is None
    record, entry = marketplace.find(data_dir, "pager@lab-tools")
    assert entry.source.package == "computedeck-pager"
    with pytest.raises(MarketplaceError, match="No plugin"):
        marketplace.find(data_dir, "absent")


def test_installs_are_confirmed_pinned_and_recorded(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(marketplace, "core_version", lambda: "9.1.0")
    monkeypatch.setattr(marketplace, "installer", lambda: ["installer"])
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path)))
    commands: list[list[str]] = []

    def run(command: list[str]) -> int:
        commands.append(command)
        return 0

    with pytest.raises(MarketplaceError, match="Not installed"):
        marketplace.install(data_dir, "pager", run=run, confirm=lambda summary: False)
    assert commands == []
    summaries: list[str] = []
    marketplace.install(
        data_dir, "pager", run=run, confirm=lambda summary: summaries.append(summary) or True
    )
    assert commands[-1] == ["installer", "computedeck-pager==1.2.0", "--only-binary", ":all:"]
    assert "posts to the pager service you set" in summaries[0]
    assert "with your user's permissions" in summaries[0]
    assert marketplace.installed(data_dir)["pager"]["package"] == "computedeck-pager"

    real = httpx.get

    def fake_get(url: str, **kwargs: Any) -> httpx.Response:
        assert url.endswith("gpu_map-0.1.0-py3-none-any.whl")
        return httpx.Response(200, content=WHEEL)

    monkeypatch.setattr(marketplace.httpx, "get", fake_get)
    marketplace.install(data_dir, "gpu-map", run=run, confirm=lambda summary: True)
    assert commands[-1][1].endswith("gpu_map-0.1.0-py3-none-any.whl")
    monkeypatch.setattr(
        marketplace.httpx, "get", lambda url, **kwargs: httpx.Response(200, content=b"tampered")
    )
    with pytest.raises(MarketplaceError, match="does not match the sha256"):
        marketplace.install(data_dir, "gpu-map", run=run, confirm=lambda summary: True)
    monkeypatch.setattr(marketplace.httpx, "get", real)
    marketplace.uninstall(data_dir, "pager", run=run)
    assert "pager" not in marketplace.installed(data_dir)
    with pytest.raises(MarketplaceError):
        marketplace.uninstall(data_dir, "computedeck", run=run)


def test_uv_installs_ignore_the_plugins_development_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(marketplace.shutil, "which", lambda name: "/usr/bin/uv")
    command = marketplace.installer()
    assert command[:3] == ["uv", "pip", "install"]
    assert "--no-sources" in command


@pytest.mark.parametrize("package", ["h11", "idna", "Typing_Extensions", "annotated.types"])
def test_core_dependencies_are_never_installed_or_uninstalled_as_plugins(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch, package: str
) -> None:
    monkeypatch.setattr(marketplace, "installer", lambda: ["installer"])
    data = catalog()
    data["plugins"][0]["source"] = {"type": "pypi", "package": package, "version": "0.0.1"}
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path, data)))

    def run(command: list[str]) -> int:
        pytest.fail(f"ran {command}")

    with pytest.raises(MarketplaceError, match="part of ComputeDeck"):
        marketplace.install(data_dir, "pager", run=run, confirm=lambda summary: True)
    # A record written before this check existed.
    (data_dir / "installed-plugins.json").write_text(
        json.dumps({"pager": {"marketplace": "lab-tools", "package": package}})
    )
    with pytest.raises(MarketplaceError, match="cannot be uninstalled"):
        marketplace.uninstall(data_dir, "pager", run=run)


def test_a_package_installed_outside_the_marketplace_is_left_alone(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(marketplace, "installer", lambda: ["installer"])
    data = catalog()
    data["plugins"][0]["source"] = {"type": "pypi", "package": "pytest", "version": "0.0.1"}
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path, data)))
    with pytest.raises(MarketplaceError, match="not from a marketplace"):
        marketplace.install(
            data_dir, "pager", run=lambda c: pytest.fail("ran"), confirm=lambda s: True
        )
    assert marketplace.installed(data_dir) == {}


def test_a_path_source_records_its_package_name(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(marketplace, "installer", lambda: ["installer"])
    folder = folder_market(tmp_path)
    (folder / "dev" / "pyproject.toml").write_text('[project]\nname = "computedeck-local-dev"\n')
    marketplace.add_marketplace(data_dir, str(folder))
    marketplace.install(data_dir, "local-dev", run=lambda c: 0, confirm=lambda s: True)
    assert marketplace.installed(data_dir)["local-dev"]["package"] == "computedeck-local-dev"


def test_incompatible_plugins_are_not_installed(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(marketplace, "core_version", lambda: "0.3.0")
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path)))
    with pytest.raises(MarketplaceError, match="needs ComputeDeck >=9.0"):
        marketplace.install(data_dir, "gpu-map", run=lambda c: 0, confirm=lambda s: True)


def test_command_line(tmp_path: Path, data_dir: Path, capsys: pytest.CaptureFixture[str]) -> None:
    base = ["--data-dir", str(data_dir), "plugin"]
    assert cli.main([*base, "marketplace", "add", str(folder_market(tmp_path))]) == 0
    assert cli.main([*base, "search", "pager"]) == 0
    assert cli.main([*base, "info", "pager"]) == 0
    assert cli.main([*base, "install", "absent", "--yes"]) == 1
    out = capsys.readouterr()
    assert "Added lab-tools (local): 3 plugins." in out.out
    assert "pager@lab-tools" in out.out and "Pager alerts" in out.out
    assert "posts to the pager service you set" in out.out
    assert "No plugin named absent" in out.err


@pytest.mark.parametrize(
    ("content", "says"),
    [
        (b'{"name": "\xff\xfe"}', "Cannot read"),
        (b'{"name": "deep", "x": ' + b"[" * 100000 + b"]" * 100000 + b"}", "nested too deeply"),
    ],
)
def test_an_unreadable_catalog_is_reported_in_one_line(
    tmp_path: Path, data_dir: Path, capsys: pytest.CaptureFixture[str], content: bytes, says: str
) -> None:
    file = tmp_path / marketplace.CATALOG
    file.write_bytes(content)
    assert cli.main(["--data-dir", str(data_dir), "plugin", "marketplace", "add", str(file)]) == 1
    error = capsys.readouterr().err
    assert error.startswith("computedeck plugin: ") and says in error and error.count("\n") == 1


FORGED = (
    "reads job names\x1b[3A\r\x1b[2Knice-tool 1.0 from lab-tools (internal)\n"
    "\x1b[2K  - read only\x1b]0;ComputeDeck\x07\u009b2K‮evil\x00"
)


def test_plain_removes_escapes_and_controls() -> None:
    assert marketplace.plain(FORGED) == (
        "reads job namesnice-tool 1.0 from lab-tools (internal)   - read onlyevil"
    )
    assert marketplace.plain("a\tb\nc", lines=True) == "a b\nc"
    assert marketplace.plain("中文 – ok") == "中文 – ok"


def test_catalog_text_cannot_rewrite_the_terminal(
    tmp_path: Path, data_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    data = catalog()
    data["plugins"][0].update(
        permissions=[{"en": FORGED}],
        description={"en": FORGED},
        display_name={"en": FORGED},
        author=FORGED,
        homepage=FORGED,
    )
    data["plugins"][0]["tags"] = ["alerts"]
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path, data)))
    summaries: list[str] = []
    with pytest.raises(MarketplaceError, match="Not installed"):
        marketplace.install(
            data_dir, "pager", run=lambda c: 0, confirm=lambda s: summaries.append(s) or False
        )
    base = ["--data-dir", str(data_dir), "plugin"]
    assert cli.main([*base, "search", "alerts"]) == 0
    assert cli.main([*base, "info", "pager"]) == 0
    out = capsys.readouterr().out
    for text in (summaries[0], out):
        assert not any(ord(char) < 32 and char != "\n" for char in text)
        assert "\x1b" not in text and "\u009b" not in text and "‮" not in text
    # Only the lines the command itself writes.
    assert summaries[0].count("\n") == 3


def test_api_lists_marketplaces_without_secrets(tmp_path: Path, data_dir: Path) -> None:
    data_dir.mkdir()
    marketplace.add_marketplace(
        data_dir,
        "https://bob:t0ken@git.example.com/lab/computedeck-marketplace.json",
        fetch=lambda url: json.dumps(catalog()),
    )
    with TestClient(api.create_app(data_dir, polling=False, plugins=[])) as client:
        listed = client.get("/api/marketplace").json()
    assert listed["marketplaces"][0]["source"] == (
        "https://git.example.com/lab/computedeck-marketplace.json"
    )
    assert "t0ken" not in json.dumps(listed)
    assert {row["name"] for row in listed["plugins"]} == {"pager", "gpu-map", "local-dev"}


def test_a_catalog_saved_by_an_older_version_marks_only_its_marketplace(
    tmp_path: Path, data_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    marketplace.add_marketplace(data_dir, str(folder_market(tmp_path)))
    old = tmp_path / "old"
    old.mkdir()
    (old / marketplace.CATALOG).write_text(json.dumps(catalog("old-lab")))
    marketplace.add_marketplace(data_dir, str(old))
    # As saved by a version whose checks were looser than this one's.
    markets = json.loads((data_dir / "marketplaces.json").read_text())
    markets["old-lab"]["catalog"]["plugins"][0]["requires"] = ">=0.2.*"
    markets["old-lab"]["catalog"]["plugins"].append({"name": "only-old", "version": "x"})
    (data_dir / "marketplaces.json").write_text(json.dumps(markets))

    assert {row["marketplace"] for row in marketplace.listing(data_dir)} == {"lab-tools"}
    with TestClient(api.create_app(data_dir, polling=False, plugins=[])) as client:
        listed = client.get("/api/marketplace").json()
    assert listed["policy_error"] is None
    by_name = {market["name"]: market for market in listed["marketplaces"]}
    assert by_name["lab-tools"]["error"] is None and by_name["lab-tools"]["plugins"] == 3
    assert by_name["old-lab"]["plugins"] == 0
    assert "The saved catalog of old-lab is not valid" in by_name["old-lab"]["error"]
    assert "computedeck plugin marketplace update old-lab" in by_name["old-lab"]["error"]
    assert {row["marketplace"] for row in listed["plugins"]} == {"lab-tools"}

    base = ["--data-dir", str(data_dir), "plugin"]
    assert cli.main([*base, "search"]) == 0
    out = capsys.readouterr()
    assert "pager@lab-tools" in out.out and "old-lab" not in out.out
    assert out.err.count("\n") == 1 and "old-lab is not valid" in out.err
    assert cli.main([*base, "marketplace", "list"]) == 0
    out = capsys.readouterr()
    assert "unreadable" in out.out and "lab-tools" in out.out
    assert cli.main([*base, "info", "only-old"]) == 1
    assert "old-lab is not valid" in capsys.readouterr().err
    assert cli.main([*base, "info", "pager@old-lab"]) == 1
    assert "old-lab is not valid" in capsys.readouterr().err
    assert cli.main([*base, "info", "pager@lab-tools"]) == 0
    # Reading the catalog again repairs it.
    assert cli.main([*base, "marketplace", "update", "old-lab"]) == 0
    assert marketplace.problems(data_dir) == {}


def test_policy_blocks_installed_plugins_at_startup(data_dir: Path) -> None:
    data_dir.mkdir()
    (data_dir / "policy.toml").write_text('blocked_plugins = ["computedeck-pager"]\n')
    blocked = Plugin("pager", lambda ctx: None, package="computedeck-pager", version="1.2.0")
    with TestClient(api.create_app(data_dir, polling=False, plugins=[blocked])) as client:
        [entry] = client.get("/api/toolbox").json()
    assert entry["rejected"] == {"code": "plugin_blocked"}
    (data_dir / "policy.toml").write_text("not = [valid\n")
    with TestClient(api.create_app(data_dir, polling=False, plugins=[blocked])) as client:
        [entry] = client.get("/api/toolbox").json()
    # A policy that cannot be read blocks every plugin not shipped with the core.
    assert entry["rejected"] == {"code": "plugin_blocked"}


def test_core_version_is_known() -> None:
    assert versions.numbers(versions.core_version())


def test_the_toolbox_shows_where_each_plugin_came_from(
    tmp_path: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(marketplace, "installer", lambda: ["installer"])
    folder = folder_market(tmp_path)
    (folder / "dev" / "pyproject.toml").write_text('[project]\nname = "computedeck-local-dev"\n')
    marketplace.add_marketplace(data_dir, str(folder))
    marketplace.install(data_dir, "local-dev", run=lambda c: 0, confirm=lambda s: True)
    plugins = [
        Plugin("notify-like", lambda ctx: None, package="computedeck"),
        Plugin("local-dev", lambda ctx: None, package="computedeck-local-dev"),
        Plugin("side", lambda ctx: None, package="computedeck-side"),
    ]
    with TestClient(api.create_app(data_dir, polling=False, plugins=plugins)) as client:
        origins = {row["id"]: row["origin"] for row in client.get("/api/toolbox").json()}
    assert origins["notify-like"] == {"kind": "builtin"}
    assert origins["local-dev"] == {
        "kind": "marketplace",
        "plugin": "local-dev",
        "marketplace": "lab-tools",
        "tier": "local",
    }
    assert origins["side"] == {"kind": "direct"}


def test_tools_are_listed_while_the_installed_list_cannot_be_read(
    data_dir: Path, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture
) -> None:
    data_dir.mkdir()
    (data_dir / "installed-plugins.json").write_text('{"x": 5}')
    plugins = [
        Plugin("notify-like", lambda ctx: None, package="computedeck"),
        Plugin("side", lambda ctx: None, package="computedeck-side"),
    ]
    with TestClient(api.create_app(data_dir, polling=False, plugins=plugins)) as client:
        response = client.get("/api/toolbox")
    assert response.status_code == 200
    tools = {row["id"]: row for row in response.json()}
    assert tools["notify-like"]["origin"] == {"kind": "builtin"}
    assert tools["notify-like"]["notes"] == []
    assert tools["side"]["origin"] == {"kind": "unknown"}
    assert tools["side"]["notes"] == [
        {
            "code": "plugin_origin_unknown",
            "detail": "installed-plugins.json contains an invalid package record.",
        }
    ]
    assert cli.main(["--data-dir", str(data_dir), "plugin", "list"]) == 0
    out = capsys.readouterr()
    assert "built in" in out.out
    assert out.err == (
        "computedeck plugin: installed-plugins.json contains an invalid package record.\n"
    )
    # Logged in one line: the message says what is wrong, a traceback would bury it.
    assert "Plugin policy cannot be read" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)
