"""Release regressions for diagnostics, credential errors and real SSH cancellation."""

import asyncio
import json
import os
import shlex
import shutil
import signal
import sys
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from computedeck import credentials, doctor, plugins
from computedeck.collector import Collector
from computedeck.drivers import ssh
from computedeck.errors import SourceError
from computedeck.plugins import Runtime
from computedeck.records import SourceInput, source_record
from computedeck.store import Store


@pytest.mark.parametrize("structured", [False, True])
async def test_resolver_failure_does_not_store_secret(
    tmp_path: Path, store: Store, structured: bool
) -> None:
    secret = "fictional-review-credential"

    def resolve(name: str) -> str:
        if structured:
            raise SourceError("request_failed", secret, token=secret)
        raise RuntimeError(f"Credential rejected: {secret}")

    credentials.register("example", resolve)
    source = source_record(
        SourceInput(name="Example cloud", driver="runpod", credential="example:cloud")
    )
    store.save_source(source)
    runtime = Runtime(tmp_path)
    runtime.store = store
    await Collector(runtime).collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    assert saved["error"] == {
        "code": "credential_unavailable",
        "reference": "example:cloud",
    }
    assert secret not in json.dumps(store.dashboard())
    assert secret not in json.dumps(store.events(after=0))


@pytest.mark.parametrize("refused", ["account", "instances"])
async def test_provider_authorization_echo_never_reaches_errors_or_warnings(
    tmp_path: Path, store: Store, monkeypatch: pytest.MonkeyPatch, refused: str
) -> None:
    secret = "fictional-provider-credential"
    monkeypatch.setenv("EXAMPLE_API_KEY", secret)

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == secret
        if refused == "instances" and request.url.path.endswith("/wallet/balance"):
            return httpx.Response(200, json={"code": "Success", "data": {"assets": 1000}})
        return httpx.Response(
            200,
            json={
                "code": request.headers["Authorization"],
                "msg": f"Request rejected: Authorization={request.headers['Authorization']}",
            },
        )

    client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client(**kwargs, transport=httpx.MockTransport(respond)),
    )
    source = source_record(
        SourceInput(name="Example GPUhub", driver="gpuhub", credential="env:EXAMPLE_API_KEY")
    )
    store.save_source(source)
    runtime = Runtime(tmp_path)
    runtime.store = store
    await Collector(runtime).collect(source["id"])
    saved = store.source(source["id"])
    assert saved is not None
    if refused == "account":
        assert saved["error"] == {"code": "provider_refused"}
    else:
        assert saved["error"] is None
        assert saved["warnings"] == [
            {"code": "instances_unavailable", "reason": "provider_refused"}
        ]
    assert secret not in json.dumps(saved)
    assert secret not in json.dumps(store.dashboard())
    assert secret not in json.dumps(store.events(after=0))


async def test_doctor_reports_failed_plugin_import_without_exception_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "fictional-private-import-detail"

    def load() -> None:
        raise ModuleNotFoundError(secret)

    entry = SimpleNamespace(name="example", dist=None, load=load)
    monkeypatch.setattr(
        plugins,
        "entry_points",
        lambda group: [entry] if group == plugins.ENTRY_POINT_GROUP else [],
    )
    rows = await doctor.diagnose(tmp_path, 0)
    assert next(row for row in rows if row["id"] == "plugin:example")["state"] == "failed"
    contexts = plugins.load(plugins.discover(tmp_path), Runtime(tmp_path))
    assert contexts[0].rejected == {
        "code": "plugin_load_failed",
        "detail": "ModuleNotFoundError",
    }
    assert secret not in caplog.text
    assert secret not in json.dumps(rows)


async def test_aws_diagnostics_require_the_local_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    source = {
        "id": "example-aws",
        "driver": "aws-ec2",
        "options": {"region": "us-east-1"},
        "enabled": True,
    }
    monkeypatch.setattr(doctor.shutil, "which", lambda name: None)
    rows = await doctor.source_checks(source)
    assert [(row["id"], row["state"]) for row in rows] == [("command:aws", "failed")]
    monkeypatch.setattr(doctor.shutil, "which", lambda name: "/example/aws")
    rows = await doctor.source_checks(source)
    assert [(row["id"], row["state"]) for row in rows] == [("command:aws", "ok")]


async def test_driver_without_diagnostics_returns_an_explicit_missing_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        doctor.drivers, "get", lambda name: SimpleNamespace(validate=lambda source: None)
    )
    rows = await doctor.source_checks({"driver": "example-driver"})
    assert [(row["id"], row["state"]) for row in rows] == [("connection", "missing")]


@pytest.mark.parametrize("stop", ["cancel", "output"])
async def test_real_ssh_stops_proxy_processes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stop: str
) -> None:
    # No network, real keys or user SSH configuration: the proxy simply sleeps.
    assert shutil.which("ssh"), "OpenSSH is required for the supported release platforms"
    script = tmp_path / "proxy.py"
    pid_file = tmp_path / "proxy.pid"
    script.write_text(
        "import os, sys, time\n"
        "from pathlib import Path\n"
        "Path(sys.argv[1]).write_text(str(os.getpid()))\n"
        "if sys.argv[2] == 'output':\n"
        "    os.write(2, b'x' * 8192)\n"
        "time.sleep(10)\n"
    )
    config = tmp_path / "ssh-config"
    proxy = shlex.join([sys.executable, str(script), str(pid_file), stop])
    config.write_text(
        "Host example-review\n"
        "    HostName localhost\n"
        f"    ProxyCommand {proxy}\n"
        "    IdentityFile none\n"
        "    IdentityAgent none\n"
        "    GlobalKnownHostsFile /dev/null\n"
        "    UserKnownHostsFile /dev/null\n"
    )
    monkeypatch.setattr(ssh, "MAX_ERROR", 1024)
    task = asyncio.create_task(ssh.ssh_command("example-review", "true", ["-F", str(config)]))
    pid = None
    try:
        for _ in range(300):
            if pid_file.exists() and (value := pid_file.read_text()):
                pid = int(value)
                break
            await asyncio.sleep(0.01)
        assert pid is not None, "The isolated SSH proxy did not start"
        if stop == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
        else:
            with pytest.raises(ssh.SSHError, match="more than 1 KiB"):
                await asyncio.wait_for(task, 1)
        async with asyncio.timeout(2):
            while True:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                await asyncio.sleep(0.01)
        assert not ssh._lock("example-review").locked()
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError, ssh.SSHError):
            await task
        if pid is not None:
            with suppress(ProcessLookupError):
                os.kill(pid, signal.SIGKILL)
