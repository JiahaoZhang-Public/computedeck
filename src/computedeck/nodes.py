"""Collection on other machines ("nodes"), driven by the hub over SSH.

A source can name a node. The hub then runs ``computedeck collect`` on that machine through
its SSH alias, sends the source on standard input and reads one JSON result. The node uses
its own drivers, SSH configuration, credentials and network (a VPN, a cluster only it can
reach); it needs ComputeDeck installed but no running service, port or token. Results,
history and events stay on the hub.

Request:  {"protocol": 1, "action": "info"}
          or {"protocol": 1, "action": "collect", "source": {...}}
Response: {"protocol": 1, "version": "...", "drivers": [...]}  or  {..., "batch": {...}}
          or {"protocol": 1, "error": {"code": ..., ...}}

The hub checks what it shows: a version is short printable text, drivers are short names, and
an error has a code such as ``ssh_failed``, a text detail of at most 500 characters and short
text or number parameters. Anything else is ``node_bad_response``.
"""

import asyncio
import json
import re
import shlex
import sys
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import drivers
from .drivers import Batch, SourceError, ssh
from .errors import checked, message
from .ssh_config import validate_alias, validate_endpoint
from .versions import core_version, numbers

PROTOCOL = 1
# Fields of a source a node needs to collect it; runtime state stays on the hub.
SOURCE_FIELDS = (
    "id",
    "name",
    "driver",
    "cluster_id",
    "username",
    "ssh_alias",
    "credential",
    "options",
    "enabled",
    "interval_minutes",
)
COMMAND = re.compile(r"[A-Za-z0-9_./~+-]{1,400}")
DRIVER = re.compile(r"[a-z][a-z0-9_-]{0,39}")


class NodeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    ssh_alias: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
    # The command on the node; non-interactive SSH may not load the login PATH.
    command: str = Field(default="computedeck", max_length=500)


def command_parts(command: Any) -> list[str]:
    """The words of a node command; ValueError unless it is a plain path with arguments."""
    parts = command.split() if isinstance(command, str) else []
    if not parts or not all(COMMAND.fullmatch(part) for part in parts):
        raise ValueError("node_command_invalid")
    return parts


def reported_version(value: Any) -> str | None:
    """The ComputeDeck version a node reports, when it is short printable text."""
    if isinstance(value, str) and 0 < len(value) <= 40 and value.isprintable():
        return value
    return None


def reported_drivers(value: Any) -> list[str] | None:
    """The driver names a node reports, when they are a list of short names."""
    if isinstance(value, list) and len(value) <= 200:
        if all(isinstance(name, str) and DRIVER.fullmatch(name) for name in value):
            return value
    return None


def node_record(body: NodeInput, node_id: str) -> dict[str, Any]:
    command_parts(body.command)
    return {
        "id": node_id,
        "name": body.name,
        "ssh_alias": body.ssh_alias,
        "command": body.command,
        "status": "unchecked",
        "version": None,
        "drivers": [],
        "checked_at": None,
        "error": None,
    }


def _remote(node: dict[str, Any]) -> str:
    parts = command_parts(node["command"])
    # A leading ~ must stay unquoted for the remote shell to expand it.
    head = parts[0] if parts[0].startswith("~/") else shlex.quote(parts[0])
    return " ".join([head, *(shlex.quote(part) for part in parts[1:]), "collect"])


async def request(node: dict[str, Any], body: dict[str, Any], seconds: float) -> dict[str, Any]:
    """Send one request to a node and return its response; raise SourceError on failure."""
    try:
        remote = _remote(node)
    except ValueError:
        # Saved before the command was checked, e.g. imported as "".
        raise SourceError("node_command_invalid", node=node["name"]) from None
    try:
        alias = validate_alias(node["ssh_alias"])
    except ValueError as error:
        raise SourceError("node_unreachable", str(error), node=node["name"]) from None
    payload = json.dumps({"protocol": PROTOCOL, **body}).encode()
    try:
        async with asyncio.timeout(seconds):
            output = await ssh.ssh_command(alias, remote, input=payload)
    except TimeoutError:
        raise SourceError("node_timeout", node=node["name"]) from None
    except ssh.SSHError as error:
        detail = str(error)
        code = "node_command_missing" if "not found" in detail else "node_unreachable"
        raise SourceError(code, detail, node=node["name"]) from None
    try:
        response = json.loads(output.strip().splitlines()[-1])
        json.dumps(response, allow_nan=False, ensure_ascii=False).encode("utf-8")
    except (ValueError, UnicodeError, IndexError):
        raise SourceError("node_bad_response", node=node["name"]) from None
    if not isinstance(response, dict) or response.get("protocol") != PROTOCOL:
        raise SourceError("node_protocol", node=node["name"])
    if isinstance(response.get("error"), dict) and response["error"].get("code"):
        # The node chooses the code, detail and parameters the web app shows: only text
        # of the expected shape and size is passed on.
        failure = checked(response["error"])
        if failure is None:
            raise SourceError("node_bad_response", node=node["name"])
        code, detail = failure.pop("code"), failure.pop("detail", None)
        raise SourceError(code, detail, **failure)
    return response


async def info(node: dict[str, Any]) -> dict[str, Any]:
    """The version and drivers a node reports; SourceError when it does not answer sensibly."""
    response = await request(node, {"action": "info"}, seconds=30)
    version = reported_version(response.get("version"))
    drivers = reported_drivers(response.get("drivers") or [])
    if drivers is None or (version is None and response.get("version") is not None):
        raise SourceError("node_bad_response", node=node["name"])
    return {"version": version, "drivers": drivers}


async def collect(node: dict[str, Any], source: dict[str, Any]) -> Batch:
    """Collect a source on a node. The node's version mismatch is noted, not fatal."""
    body = {"action": "collect", "source": {key: source.get(key) for key in SOURCE_FIELDS}}
    response = await request(node, body, seconds=115)
    try:
        if not isinstance(response.get("batch"), dict):
            raise ValueError("Missing batch")
        batch = Batch.model_validate(response["batch"])
        batch.validate_rows()
        prefix = f"{source['cluster_id']}:"
        for rows in (batch.jobs, batch.nodes, batch.instances, batch.failures):
            for row in rows or []:
                if not row["id"].startswith(prefix) or row["source_id"] != source["id"]:
                    raise ValueError("Collection row belongs to another source")
                if row.get("cluster_id", source["cluster_id"]) != source["cluster_id"]:
                    raise ValueError("Collection row belongs to another cluster")
                row["cluster_id"] = source["cluster_id"]
                row.pop("manual", None)
        for row in batch.instances or []:
            external_id = validate_alias(row["id"][len(prefix) :])
            # Node-local aliases and identity paths must never select hub SSH settings.
            row["ssh_alias"] = validate_alias(f"computedeck-{source['cluster_id']}-{external_id}")
            row.pop("existing_alias", None)
            row["identity_file"] = None
            if source["driver"] == "ssh_host":
                row.update(host=None, port=None)
            elif row.get("host") or row.get("port"):
                validate_endpoint(row)
    except (ValidationError, ValueError, TypeError, UnicodeError):
        raise SourceError("node_bad_response", node=node["name"]) from None
    remote = reported_version(response.get("version"))
    if remote and numbers(remote)[:2] != numbers(core_version())[:2]:
        batch.warnings.append(
            message("node_version", node=node["name"], version=remote, hub=core_version())
        )
    return batch


# ---- The node side: ``computedeck collect`` ----


def answer(text: str) -> dict[str, Any]:
    """Handle one request read from standard input on a node."""
    return asyncio.run(handle(text))


async def handle(text: str) -> dict[str, Any]:
    """The node's answer to one request."""
    base = {"protocol": PROTOCOL, "version": core_version()}
    try:
        body = json.loads(text)
    except (ValueError, RecursionError):
        # Not JSON, nested too deeply or a number too long to convert.
        return {**base, "error": message("node_bad_request")}
    if not isinstance(body, dict) or body.get("protocol") != PROTOCOL:
        return {**base, "error": message("node_protocol")}
    if body.get("action") == "info":
        return {**base, "drivers": drivers.names(), "python": sys.version.split()[0]}
    if body.get("action") != "collect" or not isinstance(body.get("source"), dict):
        return {**base, "error": message("node_bad_request")}
    source = {key: body["source"].get(key) for key in SOURCE_FIELDS}
    source["options"] = source.get("options") or {}
    try:
        driver = drivers.get(str(source.get("driver")))
        driver.validate(source)
        batch = await asyncio.wait_for(driver.collect(source), timeout=110)
    except SourceError as error:
        return {**base, "error": error.message()}
    except TimeoutError:
        return {**base, "error": message("timeout")}
    except Exception as error:
        return {
            **base,
            "error": message("collection_failed", detail=f"{type(error).__name__}: {error}"[:300]),
        }
    return {**base, "batch": batch.model_dump()}
