"""Adversarial cases use fake listeners and entry points, never real credentials."""

import json
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from computedeck import app, auth, cli, marketplace, plugins, versions
from computedeck.tools import chat


def test_port_squatter_never_receives_persistent_token() -> None:
    requests: list[str] = []

    class Squatter(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok","proof":"fake"}')

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Squatter)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(ValueError, match="did not prove"):
            auth.browser_session(server.server_port, "private-api-token")
        assert len(requests) == 1
        assert "private-api-token" not in requests[0]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_proved_listener_cannot_force_reconnection() -> None:
    requests: list[str] = []

    class ClosingListener(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append(self.path)
            challenge = parse_qs(urlsplit(self.path).query)["challenge"][0]
            self.send_response(200)
            self.end_headers()  # HTTP/1.0 closes even though the proof was valid.
            self.wfile.write(
                json.dumps(
                    {
                        "nonce": "a" * 64,
                        "proof": auth.server_proof("secret", f"{'a' * 64}:{challenge}"),
                    }
                ).encode()
            )

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), ClosingListener)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(ValueError, match="closed the connection"):
            auth.browser_session(server.server_port, "secret")
        assert len(requests) == 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_browser_credential_dies_with_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "token")
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        token = auth.ensure_token(tmp_path)
        response = client.post(
            "/api/session", json={"token": token}, headers={"X-ComputeDeck": "1"}
        )
        session = response.json()["token"]
        assert session != token
        assert client.get("/api/dashboard", headers={auth.HEADER: session}).status_code == 200
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/dashboard", headers={auth.HEADER: session}).status_code == 401
        assert client.get("/api/dashboard", headers={auth.HEADER: token}).status_code == 200


def test_session_rejects_oversized_and_excess_form_fields(tmp_path: Path) -> None:
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.post("/api/session", content=b"x" * 5000).status_code == 413
        response = client.post(
            "/api/session",
            content="a=1&b=2&c=3&d=4&e=5",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        assert response.status_code == 400


@pytest.mark.parametrize("pattern", ["evil", "evil@*", "Evil_Package"])
def test_blocked_entry_point_is_never_imported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pattern: str
) -> None:
    (tmp_path / "policy.toml").write_text(f'blocked_plugins = ["{pattern}"]\n')

    class Distribution:
        metadata = {"Name": "evil-package"}
        version = "1.0"

    class Entry:
        name = "evil"
        dist = Distribution()

        def load(self) -> None:
            pytest.fail("blocked plugin executed during import")

    monkeypatch.setattr(plugins, "entry_points", lambda **kwargs: [Entry()])
    contexts = plugins.load(plugins.discover(tmp_path), plugins.Runtime(tmp_path))
    assert contexts[0].rejected == {"code": "plugin_blocked"}


def evil_package(monkeypatch: pytest.MonkeyPatch, names: list[str], imported: list[str]) -> None:
    """A distribution "Evil.Pkg" whose plugin entry points have the given names."""
    dist = SimpleNamespace(metadata={"Name": "Evil.Pkg"}, version="1.0")

    def entry(name: str) -> SimpleNamespace:
        def load() -> plugins.Plugin:
            imported.append(name)  # the package's top-level code
            return plugins.Plugin(name, lambda ctx: None)

        return SimpleNamespace(name=name, dist=dist, load=load)

    monkeypatch.setattr(plugins, "entry_points", lambda **kwargs: [entry(n) for n in names])


@pytest.mark.parametrize(
    "pattern", ["evil-tool", "Evil_Tool@evil-market", "*@evil-market", "evil.pkg", "helper"]
)
def test_policy_by_catalog_name_marketplace_or_sibling_blocks_the_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pattern: str
) -> None:
    # What `computedeck plugin install evil-tool@evil-market` records: the catalog name is
    # the key, and the package's entry points may be named anything.
    (tmp_path / "installed-plugins.json").write_text(
        json.dumps({"evil-tool": {"marketplace": "evil-market", "package": "Evil.Pkg"}})
    )
    (tmp_path / "policy.toml").write_text(f'blocked_plugins = ["{pattern}"]\n')
    imported: list[str] = []
    evil_package(monkeypatch, ["nice-tool", "helper"], imported)
    contexts = plugins.load(plugins.discover(tmp_path), plugins.Runtime(tmp_path))
    assert imported == []
    assert [context.rejected for context in contexts] == [{"code": "plugin_blocked"}] * 2


def test_blocking_a_built_in_tool_leaves_the_others(tmp_path: Path) -> None:
    (tmp_path / "policy.toml").write_text('blocked_plugins = ["notify"]\n')
    blocked = plugins.policy_check(tmp_path)
    assert blocked(plugins.Plugin("notify", lambda ctx: None, package="computedeck"))
    assert not blocked(plugins.Plugin("chat", lambda ctx: None, package="computedeck"))


def test_unreadable_policy_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "policy.toml").write_bytes(b"\xff\xfe")
    plugin = plugins.Plugin("evil", lambda ctx: pytest.fail("executed"), package="evil")
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[plugin])) as client:
        assert client.get("/api/toolbox").json()[0]["rejected"]["code"] == "plugin_blocked"


@pytest.mark.parametrize("suffix", ["#", "#branch", "?ref=main", "@main"])
def test_git_source_cannot_hide_commit_in_fragment(suffix: str) -> None:
    with pytest.raises(ValueError):
        marketplace.Source(type="git", url=f"https://example.com/pkg.git{suffix}", sha="a" * 40)


def test_unknown_plugin_cannot_uninstall_dependency(tmp_path: Path) -> None:
    with pytest.raises(marketplace.MarketplaceError, match="not an installed plugin"):
        marketplace.uninstall(tmp_path, "httpx", run=lambda command: pytest.fail(str(command)))


@pytest.mark.parametrize("spec", ["<1.*", ">=9.*", "~=1.*", "~=1"])
def test_unsupported_wildcard_range_is_rejected(spec: str) -> None:
    assert not versions.valid_range(spec)
    with pytest.raises(ValueError):
        versions.satisfies("0.3", spec)


def test_marketplace_urls_hide_password_queries_and_fragments() -> None:
    assert (
        marketplace.display_source("https://user:secret@tail@host/path?token=secret#secret")
        == "https://host/path"
    )
    for source in (
        "HTTPS://user:secret@github.com/o/r.git",
        "Ssh://git:secret@github.com/o/r.git",
        "https://user:p%40secret@github.com/o/r.git",
    ):
        assert "secret" not in marketplace.display_source(source)
    assert marketplace.classify("HTTPS://user:secret@github.com/o/r.git") == (
        "git",
        "https://user:secret@github.com/o/r.git",
    )
    assert marketplace.display_source("git@github.com:o/r.git") == "git@github.com:o/r.git"


def test_marketplace_errors_never_show_url_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import httpx

    def offline(args: list[str]) -> None:
        pytest.fail("no network in tests")

    monkeypatch.setattr(marketplace.httpx, "get", lambda url, **kw: httpx.Response(404))
    with pytest.raises(marketplace.MarketplaceError, match="HTTP 404") as error:
        marketplace.add_marketplace(
            tmp_path, "HTTPS://u:secret@example.invalid/c.json", git=offline
        )
    assert "secret" not in str(error.value)
    assert marketplace._redact(
        "fatal: unable to access 'https://user:secret@tail@example.invalid/r.git?t=secret': 403"
    ) == ("fatal: unable to access 'https://example.invalid/r.git': 403")
    (tmp_path / "policy.toml").write_text('allowed_marketplaces = ["https://other/*"]\n')
    with pytest.raises(marketplace.MarketplaceError, match="not an allowed") as error:
        marketplace.add_marketplace(tmp_path, "https://u:secret@example.invalid/r.git", git=offline)
    assert "secret" not in str(error.value)


def test_broken_registry_is_an_actionable_error(tmp_path: Path) -> None:
    (tmp_path / "marketplaces.json").write_text('{"broken":')
    with pytest.raises(marketplace.MarketplaceError, match="marketplaces.json"):
        marketplace.registry(tmp_path)
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        result = client.get("/api/marketplace")
        assert result.status_code == 200
        assert "marketplaces.json" in result.json()["policy_error"]


def test_active_proof_relay_never_receives_persistent_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "token")
    transmitted: list[str] = []
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        secret = auth.ensure_token(tmp_path)

        class Relay:
            sock = object()

            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def request(
                self, method: str, path: str, body: str | None = None, headers: Any = None
            ) -> None:
                transmitted.append(path + (body or ""))
                self.response = client.request(method, path, content=body, headers=headers)

            def getresponse(self) -> Any:
                response = self.response

                class Response:
                    status = response.status_code

                    def read(self, limit: int) -> bytes:
                        return response.content[:limit]

                return Response()

            def close(self) -> None:
                pass

        monkeypatch.setattr(auth.http.client, "HTTPConnection", Relay)
        session = auth.browser_session(9999, secret)
        assert session != secret
        assert not any(secret in request for request in transmitted)
        assert client.get("/api/dashboard", headers={auth.HEADER: session}).status_code == 200

        # `serve --open` knows its own process: a relay to another service of the same
        # data directory proves the token but not the nonce, and gets no session.
        transmitted.clear()
        opened: list[str] = []
        monkeypatch.setattr(cli.webbrowser, "open", opened.append)
        assert not cli._open_page(9999, secret, name="open.html", nonce="b" * 64)
        assert [path.split("?")[0] for path in transmitted] == ["/api/ping"]
        assert opened == []
        nonce = client.get("/api/ping?challenge=x").json()["nonce"]
        assert cli._open_page(9999, secret, name="open.html", nonce=nonce)
        assert len(opened) == 1


def test_serve_open_without_auth_opens_only_its_own_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    monkeypatch.setattr(auth, "service_nonce", lambda port: "a" * 64)
    assert not cli._open_page(9999, None, name="open.html", nonce="b" * 64)
    assert opened == []
    assert cli._open_page(9999, None, name="open.html", nonce="a" * 64)
    assert opened == ["http://127.0.0.1:9999/"]


def test_client_proof_is_domain_separated_and_invalid_after_restart(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "token")
    headers = {"X-ComputeDeck": "1"}
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        secret = auth.ensure_token(tmp_path)
        challenge = "a" * 64
        server = client.get("/api/ping", params={"challenge": challenge}).json()
        body = {"nonce": server["nonce"], "challenge": challenge, "proof": server["proof"]}
        assert client.post("/api/session", json=body, headers=headers).status_code == 401
        body["proof"] = auth.session_proof(secret, f"{server['nonce']}:{challenge}")
        assert client.post("/api/session", json=body, headers=headers).status_code == 200
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.post("/api/session", json=body, headers=headers).status_code == 401


@pytest.mark.parametrize("pattern", ["evil-driver", "evil", "Evil_Package"])
def test_blocked_external_driver_is_never_imported(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    pattern: str,
) -> None:
    from computedeck import drivers

    (tmp_path / "policy.toml").write_text(f'blocked_plugins = ["{pattern}"]\n')

    class Entry:
        name = "evil-driver"
        dist = SimpleNamespace(
            metadata={"Name": "evil-package"},
            entry_points=[SimpleNamespace(name="evil", group="computedeck.plugins")],
        )

        def load(self) -> None:
            pytest.fail("Blocked distribution's driver was imported")

    monkeypatch.setattr(drivers, "entry_points", lambda **kwargs: [Entry()])
    monkeypatch.setattr(drivers, "_loaded", False)
    monkeypatch.setattr(drivers, "_policy_dir", tmp_path)
    monkeypatch.setattr(drivers, "_DRIVERS", drivers._DRIVERS.copy())
    assert "evil-driver" not in drivers.names()


def test_invalid_ssh_file_does_not_break_health(tmp_path: Path) -> None:
    ssh = Path.home() / ".ssh"
    ssh.mkdir()
    (ssh / "config").write_bytes(b"\xff")
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/ssh/config").json()["installed"] is False


def test_malformed_installed_record_is_a_user_error(tmp_path: Path) -> None:
    (tmp_path / "installed-plugins.json").write_text('{"bad": {}}')
    with pytest.raises(marketplace.MarketplaceError, match="invalid package record"):
        marketplace.installed(tmp_path)


def test_named_wheel_requirement_checks_catalog_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from .test_marketplace import catalog, folder_market

    data = catalog()
    entry = data["plugins"][1]
    entry["requires"] = ""
    entry["package"] = "claimed-package"
    marketplace.add_marketplace(tmp_path / "data", str(folder_market(tmp_path, data)))
    wheel = tmp_path / "evil-1-py3-none-any.whl"
    wheel.write_bytes(b"test installer stub")
    monkeypatch.setattr(marketplace, "_download", lambda *args: wheel)
    commands: list[list[str]] = []
    marketplace.install(
        tmp_path / "data",
        "gpu-map",
        run=lambda args: commands.append(args) or 0,
        confirm=lambda text: True,
    )
    assert commands[0][-1] == f"claimed-package @ {wheel.as_uri()}"


def test_testserver_is_not_a_production_host(tmp_path: Path) -> None:
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/ping").status_code == 200
        for host in ("testserver", "evil.example"):
            assert client.get("/api/ping", headers={"Host": host}).status_code == 400


def test_files_the_service_creates_are_private_even_with_a_loose_umask(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "token")
    os.umask(0o022)
    data = tmp_path / "data"
    market = tmp_path / "market"
    market.mkdir()
    (market / marketplace.CATALOG).write_text(json.dumps({"name": "lab", "plugins": []}))
    with TestClient(app.create_app(data, polling=False, plugins=[chat.plugin])) as client:
        headers = {
            auth.HEADER: auth.ensure_token(data),
            "X-ComputeDeck": "1",
            "Origin": "http://127.0.0.1",
        }
        client.put("/api/toolbox/chat", json={"enabled": True}, headers=headers)
        upload = client.post(
            "/api/plugins/chat/attachments?name=a.txt",
            content=b"hello",
            headers={**headers, "Content-Type": "application/octet-stream"},
        )
        assert upload.status_code == 201
        marketplace.add_marketplace(data, str(market))
        auth.launcher(data, 1, "session", name="open.html")
        assert client.post("/api/backup", json={}, headers=headers).status_code == 200
        paths = [data, *data.rglob("*")]
        assert any(path.name == "chat-files" for path in paths)
        for path in paths:
            mode = stat.S_IMODE(path.lstat().st_mode)
            assert mode == (0o700 if path.is_dir() else 0o600), path


def test_the_command_line_makes_new_files_private(tmp_path: Path) -> None:
    os.umask(0o022)
    assert cli.main(["--data-dir", str(tmp_path / "data"), "token"]) == 0
    assert os.umask(0o022) == 0o077
    assert cli.main(["--data-dir", str(tmp_path / "data"), "plugin", "marketplace", "list"]) == 0
    # Not for `plugin`: its installer writes into the shared Python environment.
    assert os.umask(0o022) == 0o022
