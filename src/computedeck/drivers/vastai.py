"""Vast.ai instance discovery through the REST API. Read-only."""

import asyncio
import json
from typing import Any, ClassVar, Literal

import httpx

from .. import credentials
from ..ssh_config import validate_alias, validate_endpoint
from .base import (
    Batch,
    DriverCheck,
    DriverInfo,
    SourceError,
    credential_field,
    integer,
    now,
    number,
)

# Keyset pagination, at most 25 rows per page; the last page has next_token null.
# https://docs.vast.ai/api-reference/instances/show-instances
# The official CLI pages the same way, ordered by id:
# https://github.com/vast-ai/vast-cli (vast.py, _fetch_all_instances_v1)
API = "https://console.vast.ai/api/v1/instances/"
COMMAND = "GET /api/v1/instances/"
PAGE_SIZE = 25
# 1000 instances. A longer inventory fails instead of hiding the remainder as missing.
MAX_PAGES = 40
# The endpoint answers 429 "API requests too frequent endpoint threshold=1.0"; the CLI
# waits one second between pages.
PAGE_DELAY = 1.0


def _text(value: Any) -> str | None:
    # The official CLI strips every string field before use.
    return (value.strip() or None) if isinstance(value, str) else None


def _state(row: dict[str, Any]) -> str:
    # actual_status is the observed container state: null while provisioning, "loading"
    # while the image downloads, "running" when ready. "exited" (container stopped),
    # "unknown" (no heartbeat) and "offline" (host disconnected) never reach running.
    # https://docs.vast.ai/api-reference/hello-world
    actual = _text(row.get("actual_status"))
    if actual == "running":
        return "running"
    if actual in {"exited", "stopped"}:
        return "stopped"
    if actual in {"unknown", "offline"}:
        return "unknown"
    # Provisioning or loading: only the requested lifecycle is known.
    return {"running": "desired_running", "stopped": "desired_stopped"}.get(
        str(_text(row.get("intended_status"))), "unknown"
    )


def _endpoint(row: dict[str, Any], username: str) -> dict[str, Any]:
    # Same choice as the official CLI's ssh-url: a mapped 22/tcp port is a direct
    # connection to the public address; otherwise the Vast SSH proxy, whose port is one
    # higher for Jupyter launch modes. The login is root.
    # https://github.com/vast-ai/vast-cli (vast.py, _ssh_url)
    # https://docs.vast.ai/api-reference/hello-world ("ssh root@SSH_HOST -p SSH_PORT")
    host: str | None = None
    port: int | None = None
    ports = row.get("ports")
    direct = ports.get("22/tcp") if isinstance(ports, dict) else None
    if isinstance(direct, list) and direct and isinstance(direct[0], dict):
        host = _text(row.get("public_ipaddr"))
        port = integer(direct[0].get("HostPort"))
    if not (host and port):
        host = _text(row.get("ssh_host"))
        port = integer(row.get("ssh_port"))
        if port and "jupyter" in str(row.get("image_runtype") or ""):
            port += 1
    if not (host and port):
        host, port = None, None
    endpoint = {"host": host, "port": port, "username": username}
    if host:
        validate_endpoint(endpoint)
    return endpoint


def _gpu_utilization(row: dict[str, Any], state: str) -> float | None:
    # gpu_util is reported by the host; the official CLI prints it as a percentage next
    # to the GPU model. Vast.ai does not document its sampling window or how several
    # GPUs are combined, so only plausible readings of running instances are kept.
    value = number(row.get("gpu_util"))
    if state != "running" or value is None or not 0 <= value <= 100:
        return None
    return value


def parse_instances(rows: list[Any], source: dict[str, Any]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    observed_at = now()
    username = source.get("username") or "root"
    for row in rows:
        raw_id = row.get("id") if isinstance(row, dict) else None
        if isinstance(raw_id, bool) or not isinstance(raw_id, int | str):
            raise SourceError("unexpected_output", command=COMMAND)
        instance_id = validate_alias(str(raw_id).strip())
        state = _state(row)
        record_id = f"{source['cluster_id']}:{instance_id}"
        result[record_id] = {
            "id": record_id,
            "source_id": source["id"],
            "platform": source["name"],
            "name": _text(row.get("label")) or instance_id,
            "state": state,
            "gpu_count": integer(row.get("num_gpus")),
            "gpu_type": _text(row.get("gpu_name")),
            "gpu_utilization": _gpu_utilization(row, state),
            # cpu_util and mem_usage have undocumented units; not interpreted.
            "cpu_utilization": None,
            "memory_utilization": None,
            **_endpoint(row, username),
            # Unique per source, so two accounts that see one instance do not collide.
            "ssh_alias": f"computedeck-{source['cluster_id']}-{instance_id}",
            "identity_file": None,
            # start_date is not confirmed to reset on restart.
            "started_at": None,
            # Total price per hour, the CLI's $/hr column.
            "hourly_cost": number(row.get("dph_total")),
            "currency": "USD",
            "observed_at": observed_at,
            "ssh_status": "unverified",
        }
    return list(result.values())


async def _token(source: dict[str, Any]) -> str:
    reference = source.get("credential") or ""
    token = await asyncio.to_thread(credentials.resolve, reference)
    if not token:
        raise SourceError("credential_unavailable", reference=reference)
    if any(char.isspace() or ord(char) < 32 for char in token):
        raise SourceError("credential_malformed", reference=reference)
    return token


async def _page(client: httpx.AsyncClient, token: str, params: dict[str, str]) -> dict[str, Any]:
    response = await client.get(API, headers={"Authorization": f"Bearer {token}"}, params=params)
    if response.status_code != 200:
        # Provider error bodies may echo sensitive request details. Do not expose them.
        raise SourceError("http_status", status=response.status_code)
    try:
        data = response.json()
    except ValueError:
        raise SourceError("unexpected_output", command=COMMAND) from None
    if (
        not isinstance(data, dict)
        or data.get("success") is False
        or not isinstance(data.get("instances"), list)
    ):
        raise SourceError("unexpected_output", command=COMMAND)
    return data


class VastAIDriver:
    name: ClassVar[str] = "vastai"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cloud"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "Vast.ai", "zh-CN": "Vast.ai"},
        description={
            "en": "Instances, prices and SSH endpoints from the Vast.ai API.",
            "zh-CN": "通过 Vast.ai API 读取实例、单价和 SSH 端点。",
        },
        details={
            "en": "Lists the account's instances with an API key that the service on {where} "
            "can read. GPU utilization is the value Vast.ai reports for running instances.",
            "zh-CN": "使用{where}服务能读取到的 API Key 列出账户下的实例。"
            "GPU 利用率取自 Vast.ai 为运行中实例报告的数值。",
        },
        fields=[credential_field("env:VAST_API_KEY")],
        checks=[
            DriverCheck(
                capability="instances",
                command="API",
                label={"en": "Instances", "zh-CN": "实例列表"},
            )
        ],
        default_name="Vast.ai",
        beta=True,
    )

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("credential"):
            raise SourceError("credential_required")
        credentials.validate_reference(source["credential"])

    async def collect(self, source: dict[str, Any]) -> Batch:
        token = await _token(source)
        params = {
            "limit": str(PAGE_SIZE),
            "order_by": json.dumps([{"col": "id", "dir": "asc"}]),
        }
        rows: list[Any] = []
        seen: set[str] = set()
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                for page in range(MAX_PAGES):
                    if page:
                        await asyncio.sleep(PAGE_DELAY)
                    data = await _page(client, token, params)
                    rows.extend(data["instances"])
                    next_token = data.get("next_token")
                    if not next_token:
                        break
                    if not isinstance(next_token, str) or next_token in seen:
                        raise SourceError("unexpected_output", command=COMMAND)
                    seen.add(next_token)
                    params["after_token"] = next_token
                else:
                    raise SourceError("unexpected_output", command=COMMAND)
        except httpx.HTTPError as error:
            raise SourceError("request_failed", type(error).__name__) from None
        return Batch(
            instances=parse_instances(rows, source),
            capabilities=["instances", "ssh_discovery", "ssh_probe"],
        )
