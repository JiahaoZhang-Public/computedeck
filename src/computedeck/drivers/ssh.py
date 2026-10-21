"""Strict, non-interactive OpenSSH execution using the user's existing configuration."""

import asyncio
import os
import re
import signal
from contextlib import suppress

# OpenSSH lines that say nothing to the user: banner rules around host-key warnings, and
# the placeholder endpoint it prints when a ProxyCommand or ProxyJump connection fails.
_NOISE = re.compile(r"^[@*=#-]+$|^Connection to UNKNOWN port \d+ ")

# One in-flight command per SSH destination; different destinations run in parallel.
_LOCKS: dict[str, asyncio.Lock] = {}
# Listings of large clusters stay far below this. A command that keeps printing is
# stopped instead of filling the service's memory.
MAX_OUTPUT = 64 * 1024 * 1024
MAX_ERROR = 256 * 1024
REAP_SECONDS = 5


class SSHBusyError(RuntimeError):
    """A non-queued check found the destination's SSH budget occupied."""


class SSHError(RuntimeError):
    """The remote command or connection failed. The message is untranslated remote text."""

    def __init__(self, message: str, returncode: int | None = None) -> None:
        super().__init__(message)
        self.returncode = returncode


def failure_cause(error: BaseException) -> str:
    """Classify OpenSSH diagnostics without guessing a cause for unknown failures."""
    if isinstance(error, SSHError) and error.returncode != 255:
        return "unknown"
    text = str(error).lower()
    if "permission denied" in text or "authentication failed" in text:
        return "authentication"
    if "host key" in text or "remote host identification has changed" in text:
        return "host_key"
    if isinstance(error, TimeoutError) or "timed out" in text or "timeout" in text:
        return "timeout"
    if (
        "no route" in text
        or "network is unreachable" in text
        or "could not resolve hostname" in text
    ):
        return "network"
    if "connection refused" in text:
        return "refused"
    if "connection closed" in text:
        return "closed"
    return "unknown"


def _lock(destination: str) -> asyncio.Lock:
    return _LOCKS.setdefault(destination, asyncio.Lock())


def _kill(process: asyncio.subprocess.Process) -> None:
    # ProxyCommand/ProxyJump children can keep our pipes open after SSH exits.
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)


async def _read(
    stream: asyncio.StreamReader, limit: int, process: asyncio.subprocess.Process, over: list[int]
) -> bytes:
    """Up to ``limit`` bytes. Past it the command is killed and the rest discarded, since
    the process is only reaped once both pipes reach end of file."""
    data = bytearray()
    while chunk := await stream.read(1 << 16):
        if over:
            continue
        if len(data) + len(chunk) > limit:
            over.append(limit)
            _kill(process)
            continue
        data.extend(chunk)
    return bytes(data)


async def _feed(process: asyncio.subprocess.Process, data: bytes | None) -> None:
    if data is None or process.stdin is None:
        return
    try:
        process.stdin.write(data)
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        process.stdin.close()


async def ssh_command(
    destination: str,
    command: str,
    options: list[str] | None = None,
    *,
    wait: bool = True,
    input: bytes | None = None,
) -> str:
    """Run one command; callers set an operation-appropriate asyncio timeout."""
    args = [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "RequestTTY=no",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "RemoteCommand=none",
        *(options or []),
        "--",
        destination,
        command,
    ]
    lock = _lock(destination)
    try:
        # A zero wait also respects callers already queued when the lock is released.
        async with asyncio.timeout(None if wait else 0):
            await lock.acquire()
    except TimeoutError:
        raise SSHBusyError("SSH collection is in progress") from None
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        over: list[int] = []
        try:
            assert process.stdout is not None and process.stderr is not None
            stdout, stderr, _ = await asyncio.gather(
                _read(process.stdout, MAX_OUTPUT, process, over),
                _read(process.stderr, MAX_ERROR, process, over),
                _feed(process, input),
            )
            await process.wait()
        except (TimeoutError, asyncio.CancelledError):
            _kill(process)
            with suppress(TimeoutError):
                await asyncio.wait_for(process.communicate(), REAP_SECONDS)
            raise
    finally:
        lock.release()
    if over:
        size = f"{over[0] >> 20} MiB" if over[0] >= 1 << 20 else f"{over[0] >> 10} KiB"
        raise SSHError(f"The remote command printed more than {size} and was stopped")
    if process.returncode:
        lines = stderr.decode("utf-8", errors="replace").splitlines()
        detail = "\n".join(
            line.strip() for line in lines if line.strip() and not _NOISE.match(line.strip())
        )
        raise SSHError(detail[:300] or "remote command failed", process.returncode)
    return stdout.decode("utf-8", errors="replace")


async def run(destination: str, command: str, options: list[str] | None = None) -> str:
    async with asyncio.timeout(25):
        return await ssh_command(destination, command, options)
