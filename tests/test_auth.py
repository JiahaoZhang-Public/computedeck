"""The API token keeps other local users out; the page shell stays public."""

import json
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import auth, cli

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}


@pytest.fixture
def secured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "token")


def test_token_is_created_once_and_private(tmp_path: Path) -> None:
    first = auth.ensure_token(tmp_path)
    assert len(first) >= 40
    assert auth.ensure_token(tmp_path) == first
    mode = stat.S_IMODE((tmp_path / auth.FILE_NAME).stat().st_mode)
    assert mode == 0o600


@pytest.mark.parametrize(
    "content", [b"", b"  \n", b"\xff\xfe\x00garbage", b"short", b"has spaces in the token text"]
)
def test_a_file_without_a_token_is_replaced(
    tmp_path: Path,
    content: bytes,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / auth.FILE_NAME
    path.write_bytes(content)
    path.chmod(0o644)
    assert cli.main(["--data-dir", str(tmp_path), "token"]) == 0
    printed = capsys.readouterr().out.strip()
    assert auth.TOKEN.fullmatch(printed) and len(printed) >= 40
    assert path.read_text().strip() == printed
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert "holds no usable access token" in caplog.text
    assert auth.ensure_token(tmp_path) == printed
    assert not list(tmp_path.glob(f".{auth.FILE_NAME}*"))


def test_loose_permissions_are_tightened(tmp_path: Path) -> None:
    value = auth.ensure_token(tmp_path)
    path = tmp_path / auth.FILE_NAME
    path.chmod(0o644)
    assert auth.ensure_token(tmp_path) == value
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_requests_without_the_token_are_refused(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        refused = client.get("/api/dashboard")
        assert refused.status_code == 401
        assert refused.json()["detail"]["code"] == "token_required"
        assert client.get("/api/dashboard", headers={auth.HEADER: "wrong"}).status_code == 401
        assert client.post("/api/backup", json={}, headers=HEADERS).status_code == 401
        allowed = client.get("/api/dashboard", headers={auth.HEADER: value})
        assert allowed.status_code == 200
        backup = client.post("/api/backup", json={}, headers={**HEADERS, auth.HEADER: value})
        assert backup.status_code == 200


def test_the_token_does_not_replace_the_origin_check(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        foreign = {"Origin": "https://evil.example", "X-ComputeDeck": "1", auth.HEADER: value}
        assert client.post("/api/backup", json={}, headers=foreign).status_code == 403


def test_ping_reports_only_that_a_token_is_needed(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/ping").json() == {"status": "ok", "token_required": True}


def test_auth_can_be_turned_off(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "off")
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/dashboard").status_code == 200
        assert client.get("/api/ping").json()["token_required"] is False
    assert not (tmp_path / auth.FILE_NAME).exists()


@pytest.mark.parametrize(
    ("value", "asked"),
    [(None, False), ("off", False), ("", False), ("token", True), ("ON", True)],
)
def test_the_token_is_asked_for_only_when_turned_on(
    monkeypatch: pytest.MonkeyPatch, value: str | None, asked: bool
) -> None:
    if value is None:
        monkeypatch.delenv("COMPUTEDECK_AUTH", raising=False)
    else:
        monkeypatch.setenv("COMPUTEDECK_AUTH", value)
    assert auth.enabled() is asked


def test_a_misspelt_setting_is_refused_not_read_as_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "tokne")
    with pytest.raises(ValueError, match="off or token"):
        auth.enabled()
    assert cli.main(["--data-dir", str(tmp_path), "token"]) == 2
    assert "COMPUTEDECK_AUTH must be off or token" in capsys.readouterr().err


def test_a_service_without_a_token_opens_directly_and_is_sent_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `connect` reads a token from the server even when that service asks for none.
    sent: list[str] = []
    opened: list[str] = []
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:

        class Connection:
            sock = object()

            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            def request(self, method: str, path: str, body: str | None = None, headers=None):  # type: ignore[no-untyped-def]
                sent.append(f"{method} {path} {body or ''}")
                self.response = client.request(method, path, content=body, headers=headers)

            def getresponse(self):  # type: ignore[no-untyped-def]
                response = self.response

                class Response:
                    status = response.status_code

                    def read(self, limit: int) -> bytes:
                        return response.content[:limit]

                return Response()

            def close(self) -> None:
                pass

        monkeypatch.setattr(auth.http.client, "HTTPConnection", Connection)
        monkeypatch.setattr(cli.webbrowser, "open", opened.append)
        # A wrong token: the listener cannot prove it is that service, so nothing opens.
        assert not cli._open_page(9999, "someone-elses-token", name="c.html")
        assert opened == []
        remote = auth.ensure_token(tmp_path)
        sent.clear()
        assert cli._open_page(9999, remote, next_path="/?remote=1", name="c.html")
    assert opened == ["http://127.0.0.1:9999/?remote=1"]
    assert [request.split("?")[0] for request in sent] == ["GET /api/ping"]
    assert not any(remote in request for request in sent)


def test_a_listener_saying_it_needs_no_token_must_still_prove_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Squatter:
        sock = object()

        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def request(self, *args: object, **kwargs: object) -> None:
            pass

        def getresponse(self):  # type: ignore[no-untyped-def]
            class Response:
                status = 200

                def read(self, limit: int) -> bytes:
                    return json.dumps(
                        {"status": "ok", "token_required": False, "nonce": "a" * 64}
                    ).encode()

            return Response()

        def close(self) -> None:
            pass

    opened: list[str] = []
    monkeypatch.setattr(auth.http.client, "HTTPConnection", Squatter)
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    assert not cli._open_page(9999, "the-real-token", name="c.html")
    assert opened == []


def test_token_command_prints_only_the_token(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["--data-dir", str(tmp_path), "token"]) == 0
    assert capsys.readouterr().out.strip() == (tmp_path / auth.FILE_NAME).read_text().strip()


def test_launcher_form_hands_the_token_to_this_origin_only(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        response = client.post(
            auth.SESSION_PATH,
            data={"token": value, "next": "/?remote=1"},
            headers={"Origin": "null"},
            follow_redirects=False,
        )
        assert response.status_code == 200
        # No cookie: cookies for 127.0.0.1 would also be sent to other users' ports.
        assert "set-cookie" not in response.headers
        assert response.headers["Cache-Control"] == "no-store"
        page = response.text
        assert f'localStorage.setItem("{auth.STORAGE_KEY}",' in page
        assert value not in page
        assert 'location.replace("/?remote=1")' in page


def test_a_cookie_never_authorizes(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        client.cookies.set("computedeck_token", value)
        assert client.get("/api/dashboard").status_code == 401
        assert client.get("/api/dashboard", headers={auth.HEADER: value}).status_code == 200


def test_session_rejects_wrong_tokens_and_unsafe_redirects(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        wrong = client.post(auth.SESSION_PATH, data={"token": "nope"}, follow_redirects=False)
        assert wrong.status_code == 401
        assert "nope" not in wrong.text
        for target in ("https://evil.example/", "//evil.example", "/\\evil"):
            response = client.post(
                auth.SESSION_PATH,
                data={"token": value, "next": target},
                follow_redirects=False,
            )
            assert 'location.replace("/")' in response.text
        breakout = client.post(
            auth.SESSION_PATH,
            data={"token": value, "next": "/</script><script>alert(1)//"},
            follow_redirects=False,
        )
        assert "</script><script>" not in breakout.text


def test_json_session_checks_a_pasted_token(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        assert client.post(auth.SESSION_PATH, json={"token": value}).status_code == 400
        page = client.post(auth.SESSION_PATH, json={"token": value}, headers=HEADERS)
        assert page.status_code == 200
        assert page.json()["token"] != value
        assert (
            client.get("/api/dashboard", headers={auth.HEADER: page.json()["token"]}).status_code
            == 200
        )
        assert "set-cookie" not in page.headers
        wrong = client.post(auth.SESSION_PATH, json={"token": "nope"}, headers=HEADERS)
        assert wrong.status_code == 401


def test_ping_proves_this_service_issued_the_browser_session(tmp_path: Path, secured: None) -> None:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        value = auth.ensure_token(tmp_path)
        session = client.post(auth.SESSION_PATH, json={"token": value}, headers=HEADERS)
        token = session.json()["token"]
        reply = client.get("/api/ping?session_challenge=c1").json()
        assert reply["session_proof"] == auth.browser_proof(token, "c1")
        # The proof neither reveals nor stands in for the session token.
        assert token not in json.dumps(reply)
        proof = {auth.HEADER: reply["session_proof"]}
        assert client.get("/api/dashboard", headers=proof).status_code == 401
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        # A restarted service holds a new session token and cannot prove the old one.
        reply = client.get("/api/ping?session_challenge=c1").json()
        assert reply["session_proof"] != auth.browser_proof(token, "c1")
    # The same vector is checked by the web app in token.test.ts.
    assert auth.browser_proof("session-token", "challenge-1") == (
        "f4e9265b9c298830b23757d96b55463df0b259499a9ece26785c3d0f44ccebfc"
    )


def test_the_web_app_reads_the_key_the_service_writes() -> None:
    source = Path(__file__).parents[1] / "web" / "src" / "token.ts"
    assert f"const KEY = '{auth.STORAGE_KEY}';" in source.read_text()


def test_remote_token_is_read_without_prompts(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    class Done:
        returncode = 0
        stdout = "abc123\n"

    def run(args: list[str], **_: object) -> Done:
        calls.append(args)
        return Done()

    monkeypatch.setattr(cli.subprocess, "run", run)
    assert cli._remote_token("lab-server", "computedeck token") == "abc123"
    assert calls == [["ssh", "-T", "-o", "BatchMode=yes", "--", "lab-server", "computedeck token"]]


def test_unreadable_remote_token_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    class Failed:
        returncode = 127
        stdout = ""

    monkeypatch.setattr(cli.subprocess, "run", lambda *a, **k: Failed())
    assert cli._remote_token("lab-server", "computedeck token") is None


def test_launcher_page_is_private_and_posts_the_token(tmp_path: Path) -> None:
    stale = tmp_path / "open.html"
    stale.write_text("old")
    stale.chmod(0o644)
    path = auth.launcher(tmp_path, 8710, "abc-123_x", next_path="/?remote=1", name="open.html")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    content = path.read_text()
    assert 'action="http://127.0.0.1:8710/api/session"' in content
    assert 'method="post"' in content
    assert 'name="token" value="abc-123_x"' in content
    assert 'name="next" value="/?remote=1"' in content
    assert "?token=" not in content
    assert "old" not in content
