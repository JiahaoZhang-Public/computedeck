"""Diagnostics use read-only commands and never return credential values."""

import asyncio
import json
import socket

import pytest
from fastapi.testclient import TestClient

from computedeck import app, cli, credentials, doctor, plugins
from computedeck.drivers import ssh
from computedeck.records import SourceInput, source_record
from computedeck.store import Store


def source(**changes):
    return {
        "id": "cluster-alice",
        "driver": "slurm",
        "ssh_alias": "cluster-a",
        "username": "alice",
        "enabled": True,
        **changes,
    }


@pytest.fixture
def connected(monkeypatch):
    async def config(alias, options):
        assert alias == "cluster-a"
        return {"hostname": "compute.internal.invalid", "port": "22", "proxyjump": "jump-a"}

    calls = []

    async def run(alias, command, options=None):
        calls.append((alias, command, options))
        return "" if command == "true" else "/usr/bin/command\n"

    monkeypatch.setattr(doctor, "ssh_config", config)
    monkeypatch.setattr(doctor.shutil, "which", lambda _: "/usr/bin/ssh")
    monkeypatch.setattr(ssh, "run", run)
    return calls


async def test_batchmode_and_scheduler_commands(connected):
    rows = await doctor.source_checks(source())
    assert all(row["state"] == "ok" for row in rows)
    assert [command for _, command, _ in connected] == [
        "true",
        "command -v squeue",
        "command -v scontrol",
        "command -v sacctmgr",
        "command -v sacct",
    ]
    assert all(options == ["-l", "alice"] for _, _, options in connected)


async def test_misspelled_alias_has_a_specific_fix(monkeypatch, connected):
    async def config(alias, options):
        return {"hostname": "missing-host.invalid", "port": "22"}

    async def unresolved(*args, **kwargs):
        raise socket.gaierror("not found")

    monkeypatch.setattr(doctor, "ssh_config", config)
    monkeypatch.setattr(doctor.asyncio.get_running_loop(), "getaddrinfo", unresolved)
    rows = await doctor.source_checks(source())
    assert rows[-1]["id"] == "ssh_alias"
    assert rows[-1]["state"] == "failed"
    assert "HostName" in rows[-1]["detail"]["en"]
    assert connected == []


async def test_missing_ssh_client_stops_before_connecting(monkeypatch, connected):
    monkeypatch.setattr(doctor.shutil, "which", lambda _: None)
    rows = await doctor.source_checks(source())
    assert rows[0]["state"] == "failed"
    assert "OpenSSH" in rows[0]["detail"]["en"]
    assert connected == []


async def test_failed_login_and_credentials_do_not_echo_secrets(monkeypatch, connected):
    secret = "example-sensitive-value"

    async def fail(*args, **kwargs):
        raise ssh.SSHError(secret)

    monkeypatch.setattr(ssh, "run", fail)
    rows = await doctor.source_checks(source())
    assert rows[-1]["id"] == "ssh_login" and rows[-1]["state"] == "failed"
    assert secret not in json.dumps(rows)
    monkeypatch.setenv("EXAMPLE_API_KEY", secret)
    cloud = {
        "id": "cloud-a",
        "driver": "runpod",
        "credential": "env:EXAMPLE_API_KEY",
        "enabled": True,
    }
    rows = await doctor.source_checks(cloud)
    assert rows[-1]["state"] == "ok"
    assert secret not in json.dumps(rows)
    monkeypatch.setattr(credentials, "resolve", lambda _: (_ for _ in ()).throw(ValueError(secret)))
    rows = await doctor.source_checks(cloud)
    assert rows[-1]["state"] == "failed"
    assert secret not in json.dumps(rows)


async def test_missing_accounting_command_is_optional(monkeypatch, connected):
    async def run(alias, command, options=None):
        if command.endswith("sacct"):
            raise ssh.SSHError("command not found")
        return "/usr/bin/command"

    monkeypatch.setattr(ssh, "run", run)
    rows = await doctor.source_checks(source())
    assert rows[-1]["id"] == "command:sacct"
    assert rows[-1]["state"] == "missing"


def test_local_permissions_and_conflicting_port(tmp_path, monkeypatch):
    tmp_path.chmod(0o755)
    monkeypatch.setattr(doctor.auth, "service_nonce", lambda port: None)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        rows = doctor.local_checks(tmp_path, listener.getsockname()[1])
    assert [row["state"] for row in rows] == ["failed", "failed"]
    assert "chmod 700" in rows[0]["detail"]["en"]
    assert "--port" in rows[1]["detail"]["en"]
    assert tmp_path.stat().st_mode & 0o777 == 0o755


def test_cli_and_web_share_diagnostic_messages(tmp_path, connected, capsys):
    data = tmp_path / "data"
    stored = source_record(
        SourceInput(name="Example cluster", driver="slurm", username="alice", ssh_alias="cluster-a")
    )
    store = Store(data / "computedeck.sqlite")
    store.save_source(stored)
    store.db.close()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    assert (
        cli.main(
            [
                "--data-dir",
                str(data),
                "doctor",
                "--source",
                stored["id"],
                "--port",
                str(port),
                "--json",
            ]
        )
        == 0
    )
    cli_rows = json.loads(capsys.readouterr().out)
    with TestClient(app.create_app(data, polling=False, plugins=[])) as client:
        reply = client.post(
            f"/api/sources/{stored['id']}/check",
            json={},
            headers={"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"},
        )
    assert reply.status_code == 200
    shared = [
        {k: v for k, v in row.items() if k != "source_id"}
        for row in cli_rows
        if row.get("source_id")
    ]
    assert shared == reply.json()


async def test_incompatible_plugin_and_missing_source_are_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(doctor, "local_checks", lambda *args: [])
    monkeypatch.setattr(
        plugins, "discover", lambda _: [plugins.Plugin("example", lambda ctx: None, api=999)]
    )
    rows = await doctor.diagnose(tmp_path, 8710, "absent")
    assert [row["state"] for row in rows] == ["failed", "failed"]
    assert [row["id"] for row in rows] == ["plugin:example", "source"]


async def test_reports_the_current_step_before_ssh_completes(monkeypatch, connected):
    pending = asyncio.Event()
    observed = []

    async def run(*args):
        await pending.wait()
        return ""

    monkeypatch.setattr(ssh, "run", run)
    task = asyncio.create_task(doctor.source_checks(source(), report=observed.append))
    await asyncio.sleep(0)
    assert observed[-1]["id"] == "ssh_login"
    assert observed[-1]["state"] == "checking"
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.parametrize(
    ("error", "hint"),
    [
        ("Permission denied (publickey).", "Authentication was rejected"),
        ("Host key verification failed.", "Verify the host key"),
        ("Connection timed out", "required VPN"),
        ("Connection refused", "SSH port"),
    ],
)
async def test_ssh_failure_has_specific_safe_repair_guidance(monkeypatch, connected, error, hint):
    async def run(*args):
        raise ssh.SSHError(error + " private-secret-example")

    monkeypatch.setattr(ssh, "run", run)
    result = await doctor.source_checks(source())
    assert hint in result[-1]["detail"]["en"]
    assert "private-secret-example" not in json.dumps(result)
    assert (
        result[-1]["command"]
        == "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -l alice -- cluster-a true"
    )


def test_web_stream_sends_progress_and_a_complete_result(tmp_path, connected):
    stored = source_record(
        SourceInput(name="Example", driver="slurm", username="alice", ssh_alias="cluster-a")
    )
    database = Store(tmp_path / "computedeck.sqlite")
    database.save_source(stored)
    database.db.close()
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        response = client.post(
            f"/api/sources/{stored['id']}/check",
            json={},
            headers={
                "Origin": "http://127.0.0.1:8710",
                "X-ComputeDeck": "1",
                "Accept": "application/x-ndjson",
            },
        )
    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines()]
    assert any(row["state"] == "checking" for event in events for row in event["rows"])
    assert events[-1]["done"] is True
    assert all(row["state"] == "ok" for row in events[-1]["rows"])


def test_interrupted_stream_redacts_errors_and_finishes_pending_steps(tmp_path, monkeypatch):
    stored = source_record(
        SourceInput(name="Example", driver="slurm", username="alice", ssh_alias="cluster-a")
    )
    database = Store(tmp_path / "computedeck.sqlite")
    database.save_source(stored)
    database.db.close()

    async def interrupted(source, node=None, *, report=None):
        report({"id": "login", "state": "checking", "label": {"en": "Login"}, "detail": {}})
        raise RuntimeError("private-secret-example")

    monkeypatch.setattr(doctor, "source_checks", interrupted)
    with TestClient(app.create_app(tmp_path, polling=False, plugins=[])) as client:
        response = client.post(
            f"/api/sources/{stored['id']}/check",
            json={},
            headers={
                "Origin": "http://127.0.0.1:8710",
                "X-ComputeDeck": "1",
                "Accept": "application/x-ndjson",
            },
        )
    assert "private-secret-example" not in response.text
    final = json.loads(response.text.splitlines()[-1])
    assert final["done"] is True
    assert all(row["state"] == "failed" for row in final["rows"])


async def test_closing_stream_cancels_its_check_task(tmp_path, monkeypatch):
    from starlette.requests import Request

    stored = source_record(
        SourceInput(name="Example", driver="slurm", username="alice", ssh_alias="cluster-a")
    )
    database = Store(tmp_path / "computedeck.sqlite")
    database.save_source(stored)
    database.db.close()
    cancelled = asyncio.Event()

    async def waiting(source, node=None, *, report=None):
        report({"id": "login", "state": "checking", "label": {"en": "Login"}, "detail": {}})
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(doctor, "source_checks", waiting)
    application = app.create_app(tmp_path, polling=False, plugins=[])
    async with application.router.lifespan_context(application):
        endpoint = next(
            route.endpoint for route in application.routes if route.name == "check_source_now"
        )
        request = Request({"type": "http", "headers": [(b"accept", b"application/x-ndjson")]})
        response = await endpoint(stored["id"], request)
        await anext(response.body_iterator)
        await response.body_iterator.aclose()
        assert cancelled.is_set()


async def test_a_check_timeout_does_not_claim_the_host_is_unreachable(monkeypatch, connected):
    async def run(*args):
        raise TimeoutError()

    monkeypatch.setattr(ssh, "run", run)
    rows = await doctor.source_checks(source())
    assert "active collection" in rows[-1]["detail"]["en"]
    assert "host is unreachable" not in rows[-1]["detail"]["en"]
