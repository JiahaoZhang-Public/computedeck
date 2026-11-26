"""Routes: how this machine reaches a source it cannot reach directly.

A source can name a node, a machine reached by its SSH alias. A node is one of two kinds:

- ``collect``: a collection machine with ComputeDeck installed. It collects the source
  with its own drivers, configuration and credentials (see nodes.py).
- ``jump``: a plain SSH jump host with nothing installed. This machine collects the source
  with its own drivers and credentials, and every SSH connection of that source goes
  through the jump host, as with ``ssh -J``. Only sources that connect over SSH can use it.

When a routed connection fails, the jump host is reached once on its own to tell which hop
failed. The success path never makes that extra connection.
"""

import asyncio
from typing import Any

from . import drivers
from .drivers import ssh
from .errors import SourceError
from .ssh_config import validate_alias

MODES = ("collect", "jump")
# Codes of a failed SSH connection or command, as drivers and ssh.failure_cause name them.
SSH_CODES = frozenset(
    f"ssh_{cause}"
    for cause in ("failed", "timeout", "authentication", "host_key", "network", "refused", "closed")
)


def mode(node: dict[str, Any] | None) -> str:
    """The kind of a node; records stored before jump hosts existed collect."""
    return "jump" if (node or {}).get("mode") == "jump" else "collect"


def jump_alias(node: dict[str, Any] | None) -> str | None:
    """The SSH alias a source's connections go through, when its node is a jump host."""
    return node["ssh_alias"] if node is not None and mode(node) == "jump" else None


def applies(source: dict[str, Any]) -> bool:
    """Whether a source connects over SSH, so that a jump host can carry it."""
    if not source.get("ssh_alias"):
        return False
    try:
        driver = drivers.get(str(source.get("driver")))
    except SourceError:
        return False
    return any(field.key == "ssh_alias" for field in driver.info.fields)


async def reach(node: dict[str, Any]) -> None:
    """Reach the jump host from this machine with a trivial command.

    Raise ``route_unreachable`` when it cannot be reached non-interactively.
    """
    try:
        alias = validate_alias(node["ssh_alias"])
        with ssh.through(None):
            async with asyncio.timeout(25):
                await ssh.ssh_command(alias, "true")
    except ValueError as error:
        raise SourceError("route_unreachable", str(error), node=node["name"]) from None
    except TimeoutError:
        raise SourceError(
            "route_unreachable", "The jump host did not answer in time", node=node["name"]
        ) from None
    except (ssh.SSHError, OSError) as error:
        raise SourceError(
            "route_unreachable", str(error)[:300] or None, node=node["name"]
        ) from None


async def blame(node: dict[str, Any], error: Exception) -> Exception:
    """The error to report for a failure of a source routed through ``node``.

    ``route_unreachable`` when the jump host itself cannot be reached. Otherwise the failure
    lies beyond the jump host: SSH failures keep their code and gain ``via``, the jump host's
    name, so that they are not mistaken for a failure of this machine's own connection.
    """
    try:
        await reach(node)
    except SourceError as unreachable:
        return unreachable
    if isinstance(error, SourceError) and error.code in SSH_CODES:
        return SourceError(error.code, error.detail, **{**error.params, "via": node["name"]})
    if isinstance(error, ssh.SSHError):
        cause = ssh.failure_cause(error)
        code = "ssh_failed" if cause == "unknown" else f"ssh_{cause}"
        return SourceError(code, str(error)[:300] or None, via=node["name"])
    return error
