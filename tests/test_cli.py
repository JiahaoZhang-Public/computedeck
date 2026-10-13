"""Command line: configuration import/export, serve defaults, login service and SSH tunnel."""

import os
import plistlib
import stat
import tomllib
from pathlib import Path
from typing import Any

import pytest

from computedeck import app as api
from computedeck import cli, service

CONFIG = """
[[cluster]]
id = "cluster-a"
label = "Cluster A"
username = "alice"
ssh_alias = "cluster-a"

[[instance]]
platform = "Lab box"
id = "gpu1"
name = "GPU one"
host = "192.0.2.30"
"""


@pytest.fixture(autouse=True)
def restore_data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # The CLI sets COMPUTEDECK_DATA_DIR for the process; record it so it is restored.
    monkeypatch.setenv("COMPUTEDECK_DATA_DIR", str(tmp_path / "default-data"))


def test_import_then_export(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source = tmp_path / "computedeck.toml"
    source.write_text(CONFIG, encoding="utf-8")
    data = tmp_path / "data"
    assert cli.main(["--data-dir", str(data), "import", str(source)]) == 0
    assert capsys.readouterr().out == "Imported 1 sources and 1 instances.\n"
    assert (data / "computedeck.sqlite").is_file()
    assert cli.main(["--data-dir", str(data), "export"]) == 0
    exported = tomllib.loads(capsys.readouterr().out)
    assert exported["cluster"][0]["id"] == "cluster-a"
    assert exported["cluster"][0]["identity"][0]["username"] == "alice"
    assert exported["instance"][0]["host"] == "192.0.2.30"


@pytest.mark.parametrize("content", ['[[cluster]]\nlabel = "Cluster A"', None])
def test_failed_import_reports_and_returns_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], content: str | None
) -> None:
    source = tmp_path / "computedeck.toml"
    if content is not None:
        source.write_text(content, encoding="utf-8")
    data = tmp_path / "data"
    assert cli.main(["--data-dir", str(data), "import", str(source)]) == 1
    assert capsys.readouterr().err.startswith("Import failed: ")
    assert cli.main(["--data-dir", str(data), "export"]) == 0
    assert "[[cluster]]" not in capsys.readouterr().out


class Recorder:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, **kwargs: Any) -> bool:
        kwargs.pop("ready", None)
        self.calls.append({**kwargs, "data_dir": os.environ.get("COMPUTEDECK_DATA_DIR")})
        return True


@pytest.mark.parametrize(
    ("argv", "port"),
    [([], 8710), (["serve"], 8710), (["serve", "--port", "9100"], 9100)],
)
def test_serve_is_the_default_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, argv: list[str], port: int
) -> None:
    recorder = Recorder()
    monkeypatch.setattr(api, "serve", recorder)
    assert cli.main(["--data-dir", str(tmp_path / "data"), *argv]) == 0
    assert recorder.calls == [{"port": port, "data_dir": str(tmp_path / "data")}]
    recorder.calls.clear()
    assert cli.main(argv) == 0
    assert recorder.calls[0]["port"] == port


def test_serve_open_opens_only_this_process_and_says_when_it_did_not_start(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    opened: list[dict[str, Any]] = []
    monkeypatch.setattr(cli, "_open_page", lambda port, token, **kwargs: opened.append(kwargs))

    def started(port: int, ready: Any) -> bool:
        ready("n" * 64)
        return True

    monkeypatch.setattr(api, "serve", started)
    assert cli.main(["--data-dir", str(tmp_path), "serve", "--open"]) == 0
    assert opened == [{"name": "open.html", "nonce": "n" * 64}]
    # The port was taken (perhaps by someone's relay): nothing is opened.
    opened.clear()
    monkeypatch.setattr(api, "serve", lambda port, ready: False)
    assert cli.main(["--data-dir", str(tmp_path), "serve", "--open", "--port", "9100"]) == 1
    assert opened == []
    assert "did not start on 127.0.0.1:9100" in capsys.readouterr().err


def test_linux_login_service(
    monkeypatch: pytest.MonkeyPatch, isolated: Path, tmp_path: Path
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(service.platform, "system", lambda: "Linux")
    monkeypatch.setattr(service, "_run", lambda args, check=True: commands.append(args))
    data = tmp_path / "data"
    assert cli.main(["--data-dir", str(data), "service", "install", "--port", "9100"]) == 0
    unit = (isolated / ".config/systemd/user/computedeck.service").read_text()
    assert "-m computedeck serve --port 9100" in unit
    assert f'Environment="COMPUTEDECK_DATA_DIR={data}"' in unit
    assert 'Environment="COMPUTEDECK_PORT=9100"' in unit
    # Long enough for the service's own limit on stopping, not unbounded.
    assert "TimeoutStopSec=30" in unit
    assert commands == [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "computedeck.service"],
    ]
    commands.clear()
    assert cli.main(["service", "uninstall"]) == 0
    assert not (isolated / ".config/systemd/user/computedeck.service").exists()
    assert commands[0] == ["systemctl", "--user", "disable", "--now", "computedeck.service"]


def test_macos_login_service(
    monkeypatch: pytest.MonkeyPatch, isolated: Path, tmp_path: Path
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(service.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(service, "_run", lambda args, check=True: commands.append(args))
    data = tmp_path / "data"
    assert cli.main(["--data-dir", str(data), "service", "install"]) == 0
    path = isolated / "Library/LaunchAgents/local.computedeck.service.plist"
    with path.open("rb") as stream:
        plist = plistlib.load(stream)
    assert plist["Label"] == "local.computedeck.service"
    assert plist["ProgramArguments"][-4:] == ["computedeck", "serve", "--port", "8710"]
    assert plist["EnvironmentVariables"]["COMPUTEDECK_DATA_DIR"] == str(data)
    assert plist["StandardOutPath"] == "/dev/null"
    assert plist["StandardErrorPath"] == str(data / "startup.log")
    assert (data / "startup.log").stat().st_mode & 0o777 == 0o600
    assert plist["ExitTimeOut"] == 30
    assert [command[:2] for command in commands] == [
        ["launchctl", "bootout"],
        ["launchctl", "bootstrap"],
    ]
    commands.clear()
    assert cli.main(["service", "uninstall"]) == 0
    assert not path.exists()
    assert commands[0][:2] == ["launchctl", "bootout"]


def test_unsupported_platform_service_fails_cleanly(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(service.platform, "system", lambda: "Windows")
    monkeypatch.setattr(service, "_run", lambda args, check=True: pytest.fail("must not run"))
    assert cli.main(["service", "install"]) == 1
    assert "macOS and Linux" in capsys.readouterr().err


class FakeTunnel:
    def __init__(self, args: list[str]) -> None:
        self.args = args
        self.terminated = False

    def poll(self) -> int | None:
        return 0 if self.terminated else None

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def terminate(self) -> None:
        self.terminated = True


def test_connect_forwards_loopback_only_and_stops_tunnel(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    tunnels: list[FakeTunnel] = []
    waits: list[tuple[int, float]] = []

    def wait_for_port(port: int, timeout: float) -> bool:
        waits.append((port, timeout))
        return len(waits) > 1  # Free before the tunnel starts, open afterwards.

    def popen(args: list[str]) -> FakeTunnel:
        tunnels.append(FakeTunnel(args))
        return tunnels[-1]

    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/ssh")
    monkeypatch.setattr(cli, "_wait_for_port", wait_for_port)
    monkeypatch.setattr(cli.subprocess, "Popen", popen)
    monkeypatch.setattr(cli, "_remote_token", lambda host, command: None)
    monkeypatch.setattr(cli.webbrowser, "open", lambda url: pytest.fail("must not open"))
    assert cli.main(["connect", "server.example.org", "--no-browser"]) == 0
    [tunnel] = tunnels
    assert tunnel.args == [
        "ssh",
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        "127.0.0.1:8711:127.0.0.1:8710",
        "--",
        "server.example.org",
    ]
    assert tunnel.terminated
    assert "http://127.0.0.1:8711/?remote=1" in capsys.readouterr().out


def test_connect_opens_the_page_with_the_servers_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waits: list[int] = []
    opened: list[str] = []
    asked: list[tuple[str, str]] = []

    def wait_for_port(port: int, timeout: float) -> bool:
        waits.append(port)
        return len(waits) > 1

    def remote_token(host: str, command: str) -> str:
        asked.append((host, command))
        return "s3cret"

    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/ssh")
    monkeypatch.setattr(cli, "_wait_for_port", wait_for_port)
    monkeypatch.setattr(cli.subprocess, "Popen", lambda args: FakeTunnel(args))
    monkeypatch.setattr(cli, "_remote_token", remote_token)
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    from computedeck import auth

    monkeypatch.setattr(auth, "browser_session", lambda port, token, nonce: "browser-session")
    monkeypatch.delenv("COMPUTEDECK_TOKEN", raising=False)
    assert cli.main(["connect", "server.example.org"]) == 0
    assert asked == [("server.example.org", "computedeck token")]
    # Only a private file path reaches the browser's command line, never the token.
    [uri] = opened
    assert uri.startswith("file://") and "s3cret" not in uri
    page = Path(uri.removeprefix("file://"))
    assert stat.S_IMODE(page.stat().st_mode) == 0o600
    content = page.read_text()
    assert 'action="http://127.0.0.1:8711/api/session"' in content
    assert 'value="browser-session"' in content
    assert "s3cret" not in content
    assert "?token=" not in content


def test_connect_refuses_busy_port_or_missing_ssh(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli.subprocess, "Popen", lambda args: pytest.fail("must not start"))
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert cli.main(["connect", "server.example.org"]) == 1
    assert "OpenSSH client" in capsys.readouterr().err
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/ssh")
    monkeypatch.setattr(cli, "_wait_for_port", lambda port, timeout: True)
    assert cli.main(["connect", "server.example.org", "--local-port", "9200"]) == 1
    assert "9200 is already in use" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv",
    [
        ["serve", "--port", "99999"],
        ["serve", "--port", "0"],
        ["serve", "--port", "abc"],
        ["connect", "server", "--local-port", "99999"],
        ["connect", "server", "--remote-port", "-1"],
        ["service", "install", "--port", "70000"],
    ],
)
def test_a_port_out_of_range_is_a_usage_error(
    argv: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as stopped:
        cli.main(argv)
    assert stopped.value.code == 2
    assert "is not a port number (1-65535)" in capsys.readouterr().err


@pytest.mark.parametrize("argv", [["token"], ["export"], ["serve"], ["import", "x.toml"]])
def test_a_data_directory_that_is_a_file_is_reported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], argv: list[str]
) -> None:
    data = tmp_path / "data"
    data.write_text("not a folder")
    assert cli.main(["--data-dir", str(data), *argv]) == 1
    error = capsys.readouterr().err
    assert error == f"computedeck: the data directory {data} is a file\n"


def test_an_unusable_database_is_reported_in_one_line(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "computedeck.sqlite").write_bytes(b"this is not a database" * 100)
    assert cli.main(["--data-dir", str(data), "export"]) == 1
    assert capsys.readouterr().err == "computedeck: file is not a database\n"


@pytest.mark.parametrize(
    "content", [b'[[cluster]]\nlabel = "\xff\xfe"\n', b"x = " + b"[" * 50000 + b"]" * 50000]
)
def test_an_unreadable_import_file_is_reported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], content: bytes
) -> None:
    source = tmp_path / "computedeck.toml"
    source.write_bytes(content)
    assert cli.main(["--data-dir", str(tmp_path / "data"), "import", str(source)]) == 1
    error = capsys.readouterr().err
    assert error.startswith("Import failed: ") and error.count("\n") == 1


@pytest.mark.parametrize(
    "stdin",
    [
        "[" * 100000 + "]" * 100000,
        '{"protocol": 1, "action": "collect", "source": {"interval_minutes": 1' + "0" * 5000 + "}}",
        None,
    ],
)
def test_collect_answers_a_request_it_cannot_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    stdin: str | None,
) -> None:
    import io
    import json

    stream = (
        io.TextIOWrapper(io.BytesIO(b"\xff\xfe{}"), encoding="utf-8")
        if stdin is None
        else io.StringIO(stdin)
    )
    monkeypatch.setattr("sys.stdin", stream)
    assert cli.main(["--data-dir", str(tmp_path), "collect"]) == 0
    reply = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert reply["error"] == {"code": "node_bad_request"}
