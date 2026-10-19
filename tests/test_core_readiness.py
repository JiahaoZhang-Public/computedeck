"""Readiness states and public SDK behavior using only fictional examples."""

import json
import logging
import os
import stat
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from computedeck import app, sdk
from computedeck.drivers.base import cluster_state
from computedeck.logging_setup import BACKUPS, MAX_BYTES, ServiceLogHandler
from computedeck.plugins import Runtime
from computedeck.store import Store


@pytest.mark.parametrize(
    ("states", "expected"),
    [
        ([], "unknown"),
        (["down+not_responding"] * 70, "unavailable"),
        (["drain", "offline", "not_ready+cordoned"], "unavailable"),
        (["idle"] + ["down"] * 9, "degraded"),
        (["idle"] + ["down"] * 4, "available"),
        (["idle+cloud+powered_down"], "available"),
        (["unknown"], "unavailable"),
        (["new_scheduler_state"], "unknown"),
    ],
)
def test_cluster_availability(states, expected):
    assert cluster_state([{"state": state} for state in states]) == expected


def test_startup_restricts_an_existing_directory(tmp_path):
    data = tmp_path / "service"
    data.mkdir(mode=0o755)
    with TestClient(app.create_app(data, polling=False, plugins=[])):
        assert stat.S_IMODE(data.stat().st_mode) == 0o700


def test_rotated_logs_remain_private_and_bounded(tmp_path):
    path = tmp_path / "service.log"
    old_mask = os.umask(0o022)
    handler = ServiceLogHandler(path, maxBytes=100, backupCount=BACKUPS)
    try:
        for _ in range(30):
            handler.emit(logging.makeLogRecord({"msg": "example message" * 3, "levelno": 20}))
    finally:
        handler.close()
        os.umask(old_mask)
    files = list(tmp_path.glob("service.log*"))
    assert len(files) == 5
    assert all(stat.S_IMODE(file.stat().st_mode) == 0o600 for file in files)
    assert all(file.stat().st_size <= 100 for file in files)
    assert MAX_BYTES == 5 * 1024 * 1024


def test_service_and_uvicorn_share_the_private_log(tmp_path):
    # Isolated logger configuration must not replace pytest's capture handlers.
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import logging, sys
from pathlib import Path
from computedeck.logging_setup import configure
root = Path(sys.argv[1])
root.mkdir(mode=0o755)
(root / "startup.log").write_text("old startup failure")
(root / "startup.log").chmod(0o644)
configure(root)
logging.getLogger("computedeck").warning("example application warning")
logging.getLogger("uvicorn.error").error("example server failure")
""",
            str(tmp_path / "service"),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    text = (tmp_path / "service/service.log").read_text()
    assert text.count("example application warning") == 1
    assert text.count("example server failure") == 1
    assert "Restricted data directory permissions" in text
    assert (tmp_path / "service/startup.log").stat().st_mode & 0o777 == 0o600


def test_plugin_storage_isolated_persistent_and_transactional(tmp_path):
    runtime = Runtime(tmp_path)
    first = sdk.PluginContext(sdk.Plugin("example-a", lambda ctx: None), runtime)
    second = sdk.PluginContext(sdk.Plugin("example-b", lambda ctx: None), runtime)
    first.set_state("counter", {"count": 2})
    assert second.get_state("counter") is None
    again = sdk.PluginContext(sdk.Plugin("example-a", lambda ctx: None), Runtime(tmp_path))
    assert again.get_state("counter") == {"count": 2}
    with first.database() as db:
        db.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)")
        db.execute("INSERT INTO notes(body) VALUES (?)", ("hello",))
    with pytest.raises(ValueError), first.database() as db:
        db.execute("INSERT INTO notes(body) VALUES (?)", ("rollback",))
        raise ValueError("example failure")
    with first.database() as db:
        assert db.execute("SELECT body FROM notes").fetchall() == [("hello",)]
    assert first.data_dir != second.data_dir
    assert first.data_dir.stat().st_mode & 0o777 == 0o700
    assert (first.data_dir / "storage.sqlite").stat().st_mode & 0o777 == 0o600


def test_sdk_ssh_executor_is_distinct_from_connection_string_parser():
    from computedeck.drivers import ssh

    assert sdk.ssh_command is ssh.ssh_command
    assert sdk.SSHBusyError is ssh.SSHBusyError
    assert sdk.parse_ssh_command("ssh -p 2222 alice@192.0.2.2") == ("192.0.2.2", 2222, "alice")
    assert sdk.now().endswith("+00:00")


def test_readonly_storage_does_not_change_file_permissions(tmp_path):
    path = tmp_path / "state.sqlite"
    Store(path).db.close()
    path.chmod(0o644)
    store = Store(path, readonly=True)
    try:
        assert store.sources() == []
        assert path.stat().st_mode & 0o777 == 0o644
    finally:
        store.db.close()


def test_python_and_frontend_versions_match():
    root = Path(__file__).resolve().parents[1]
    python = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
    package = json.loads((root / "web/package.json").read_text())
    lock = json.loads((root / "web/package-lock.json").read_text())
    assert python == package["version"] == lock["version"] == lock["packages"][""]["version"]


def test_changelog_names_the_current_version():
    root = Path(__file__).resolve().parents[1]
    version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
    assert f"## {version} " in (root / "CHANGELOG.md").read_text()
