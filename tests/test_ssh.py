"""OpenSSH execution: strict arguments, cleanup on timeout and one command per destination."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest

from computedeck.drivers import ssh


class FakeProcess:
    """A subprocess whose output arrives only when the test releases it."""

    def __init__(self, stdout: bytes = b"ok\n", stderr: bytes = b"", returncode: int = 0) -> None:
        self.release = asyncio.Event()
        self.result = (stdout, stderr, returncode)
        self.returncode: int | None = None
        self.stdin = None
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self._writer = asyncio.ensure_future(self._write())

    async def _write(self) -> None:
        await self.release.wait()
        if self.returncode is None:
            self.stdout.feed_data(self.result[0])
            self.stderr.feed_data(self.result[1])
            self.returncode = self.result[2]
        self.stdout.feed_eof()
        self.stderr.feed_eof()

    async def wait(self) -> int:
        await self._writer
        assert self.returncode is not None
        return self.returncode

    async def communicate(self) -> tuple[bytes, bytes]:
        await self.wait()
        return await self.stdout.read(), await self.stderr.read()

    def kill(self) -> None:
        if self.returncode is None:
            self.returncode = -9
        self.release.set()


class FakeSubprocesses:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.started: list[tuple[str, FakeProcess]] = []
        self.calls: list[tuple[str, ...]] = []
        monkeypatch.setattr(asyncio, "create_subprocess_exec", self.create)
        monkeypatch.setattr(ssh, "_kill", lambda process: process.kill())

    async def create(self, *args: str, **kwargs: Any) -> FakeProcess:
        process = FakeProcess()
        self.calls.append(args)
        self.started.append((args[-2], process))
        return process


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_ssh_is_argument_based_strict_and_killed_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    processes = FakeSubprocesses(monkeypatch)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(ssh.ssh_command("cluster-a", "squeue --me", ["-l", "alice"]), 0.05)
    args, process = processes.calls[0], processes.started[0][1]
    assert process.returncode == -9
    assert args[0] == "ssh"
    for option in (
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ClearAllForwardings=yes",
        "RequestTTY=no",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
    ):
        assert option in args
    assert "-T" in args
    # Options precede the destination; "--" stops option parsing for the destination.
    assert args[-5:] == ("-l", "alice", "--", "cluster-a", "squeue --me")
    assert not ssh._lock("cluster-a").locked()


async def test_a_command_that_keeps_printing_is_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ssh, "MAX_OUTPUT", 1000)
    monkeypatch.setattr(ssh, "_kill", lambda process: process.kill())
    process = FakeProcess(stdout=b"x" * 5000)
    process.release.set()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    with pytest.raises(ssh.SSHError, match="more than 0 KiB and was stopped"):
        await ssh.ssh_command("cluster-a", "yes")
    assert not ssh._lock("cluster-a").locked()
    within = FakeProcess(stdout=b"x" * 1000)
    within.release.set()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=within))
    assert len(await ssh.ssh_command("cluster-a", "true")) == 1000


async def test_cancelled_command_kills_process_and_releases_destination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    processes = FakeSubprocesses(monkeypatch)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(ssh.ssh_command("cluster-a.example.org", "sleep 60"), 0.05)
    assert processes.started[0][1].returncode == -9
    assert not ssh._lock("cluster-a.example.org").locked()


async def test_remote_failure_reports_stderr(monkeypatch: pytest.MonkeyPatch) -> None:
    process = FakeProcess(stderr=b"Permission denied (publickey).\n", returncode=255)
    process.release.set()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    with pytest.raises(ssh.SSHError, match=r"Permission denied \(publickey\)\."):
        await ssh.ssh_command("cluster-a", "true")
    proxied = FakeProcess(
        stderr=b"Connection timed out during banner exchange\r\n"
        b"Connection to UNKNOWN port 65535 timed out\r\n",
        returncode=255,
    )
    proxied.release.set()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=proxied))
    with pytest.raises(ssh.SSHError) as failure:
        await ssh.ssh_command("cluster-a", "true")
    assert str(failure.value) == "Connection timed out during banner exchange"
    silent = FakeProcess(returncode=1)
    silent.release.set()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=silent))
    with pytest.raises(ssh.SSHError, match="remote command failed"):
        await ssh.ssh_command("cluster-a", "false")
    assert not ssh._lock("cluster-a").locked()


async def test_different_destinations_run_concurrently(monkeypatch: pytest.MonkeyPatch) -> None:
    processes = FakeSubprocesses(monkeypatch)
    first = asyncio.create_task(ssh.ssh_command("cluster-a.example.org", "hostname"))
    second = asyncio.create_task(ssh.ssh_command("cluster-b.example.org", "hostname"))
    await settle()
    assert [destination for destination, _ in processes.started] == [
        "cluster-a.example.org",
        "cluster-b.example.org",
    ]
    for _, process in processes.started:
        process.release.set()
    assert await asyncio.gather(first, second) == ["ok\n", "ok\n"]


async def test_same_destination_is_serialized(monkeypatch: pytest.MonkeyPatch) -> None:
    processes = FakeSubprocesses(monkeypatch)
    first = asyncio.create_task(ssh.ssh_command("cluster-a.example.org", "squeue"))
    second = asyncio.create_task(ssh.ssh_command("cluster-a.example.org", "sacct"))
    await settle()
    assert len(processes.started) == 1
    processes.started[0][1].release.set()
    assert await first == "ok\n"
    await settle()
    assert len(processes.started) == 2
    processes.started[1][1].release.set()
    assert await second == "ok\n"


async def test_busy_destination_without_wait_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    processes = FakeSubprocesses(monkeypatch)
    running = asyncio.create_task(ssh.ssh_command("cluster-a.example.org", "squeue"))
    await settle()
    with pytest.raises(ssh.SSHBusyError):
        await ssh.ssh_command("cluster-a.example.org", "hostname", wait=False)
    assert len(processes.started) == 1
    # Another destination is not affected.
    other = asyncio.create_task(ssh.ssh_command("cluster-b.example.org", "hostname", wait=False))
    await settle()
    processes.started[-1][1].release.set()
    assert await other == "ok\n"
    processes.started[0][1].release.set()
    assert await running == "ok\n"
    # An idle destination accepts a non-waiting command.
    idle = asyncio.create_task(ssh.ssh_command("cluster-a.example.org", "hostname", wait=False))
    await settle()
    processes.started[-1][1].release.set()
    assert await idle == "ok\n"


async def test_non_waiting_command_does_not_overtake_queued_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    processes = FakeSubprocesses(monkeypatch)
    lock = ssh._lock("cluster-a.example.org")
    await lock.acquire()
    queued = asyncio.create_task(ssh.ssh_command("cluster-a.example.org", "squeue"))
    await settle()
    assert processes.started == []
    lock.release()
    with pytest.raises(ssh.SSHBusyError):
        await ssh.ssh_command("cluster-a.example.org", "hostname", wait=False)
    await settle()
    assert len(processes.started) == 1
    processes.started[0][1].release.set()
    assert await queued == "ok\n"


async def test_run_applies_its_own_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, list[str] | None]] = []

    async def command(
        destination: str, text: str, options: list[str] | None = None, *, wait: bool = True
    ) -> str:
        calls.append((destination, text, options))
        await asyncio.sleep(10)
        return ""

    real_timeout = asyncio.timeout
    delays: list[float | None] = []

    def timeout(delay: float | None) -> asyncio.Timeout:
        delays.append(delay)
        return real_timeout(0.01)

    monkeypatch.setattr(ssh, "ssh_command", command)
    monkeypatch.setattr(ssh.asyncio, "timeout", timeout)
    with pytest.raises(TimeoutError):
        await ssh.run("cluster-a", "squeue", ["-l", "alice"])
    assert calls == [("cluster-a", "squeue", ["-l", "alice"])]
    # Collection commands are always bounded.
    assert len(delays) == 1 and delays[0] is not None and 0 < delays[0] <= 60
