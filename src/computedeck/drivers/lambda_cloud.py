"""Lambda Cloud instance discovery through the REST API. Read-only."""

import asyncio
from typing import Any, ClassVar, Literal

import httpx

from .. import credentials
from ..ssh_config import validate_alias, validate_endpoint
from .base import (
    EMPTY,
    Batch,
    DriverCheck,
    DriverInfo,
    SourceError,
    credential_field,
    integer,
    now,
    number,
)

# Without page_size or page_token the response holds every instance and page_token is
# null. Body: {"data": [Instance, ...], "page_token": null}.
# https://docs.lambda.ai/api/cloud#listInstances (OpenAPI: /api/cloud/spec.json)
API = "https://cloud.lambda.ai/api/v1/instances"
COMMAND = "GET /api/v1/instances"

# InstanceStatus: booting, active, unhealthy, terminated, terminating, preempted.
# "unhealthy" and "preempted" are not described further, so their lifecycle stays unknown.
STATES = {
    "active": "running",
    "terminated": "terminated",
    "booting": "desired_running",
    "terminating": "desired_terminated",
}


def _text(value: Any) -> str | None:
    if not isinstance(value, str) or value.strip() in EMPTY:
        return None
    return value.strip()


def _section(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def parse_instances(rows: list[Any], source: dict[str, Any]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for row in rows:
        raw_id = row.get("id") if isinstance(row, dict) else None
        if not isinstance(raw_id, str):
            raise SourceError("unexpected_output", command=COMMAND)
        instance_id = validate_alias(raw_id)
        instance_type = _section(row.get("instance_type"))
        specs = _section(instance_type.get("specs"))
        # "ip" is the public IPv4 address. Lambda's guide connects with
        # ssh ubuntu@<INSTANCE-IP> on the default port.
        # https://docs.lambda.ai/public-cloud/on-demand/connecting-instance/
        host = _text(row.get("ip"))
        endpoint = {
            "host": host,
            "port": 22 if host else None,
            "username": source.get("username") or "ubuntu",
        }
        if host:
            validate_endpoint(endpoint)
        cents = number(instance_type.get("price_cents_per_hour"))
        record_id = f"{source['cluster_id']}:{instance_id}"
        result[record_id] = {
            "id": record_id,
            "source_id": source["id"],
            "platform": source["name"],
            "name": _text(row.get("name")) or instance_id,
            "state": STATES.get(str(row.get("status")), "unknown"),
            "gpu_count": integer(specs.get("gpus")),
            "gpu_type": _text(instance_type.get("gpu_description")),
            # The API reports lifecycle and configuration, never measured utilization.
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            **endpoint,
            # Unique per source, so two accounts that see one instance do not collide.
            "ssh_alias": f"computedeck-{source['cluster_id']}-{instance_id}",
            "identity_file": None,
            # price_cents_per_hour is in US cents.
            "hourly_cost": cents / 100 if cents is not None and cents >= 0 else None,
            "currency": "USD",
            "region": _text(_section(row.get("region")).get("name")),
            "observed_at": observed_at,
            "ssh_status": "unverified",
        }
    return list(result.values())


class LambdaCloudDriver:
    name: ClassVar[str] = "lambda"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cloud"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "Lambda Cloud", "zh-CN": "Lambda Cloud"},
        description={
            "en": "Instances, prices and SSH endpoints from the Lambda Cloud API.",
            "zh-CN": "通过 Lambda Cloud API 读取实例、单价和 SSH 端点。",
        },
        details={
            "en": "Lists instances with an API key that the service on {where} can read. "
            "SSH uses the instance's public IP as user ubuntu.",
            "zh-CN": "使用{where}服务能读取到的 API Key 列出实例。"
            "SSH 使用实例的公网 IP，用户为 ubuntu。",
        },
        fields=[credential_field("env:LAMBDA_API_KEY")],
        checks=[
            DriverCheck(
                capability="instances",
                command="API",
                label={"en": "Instances", "zh-CN": "实例列表"},
            )
        ],
        default_name="Lambda Cloud",
    )

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("credential"):
            raise SourceError("credential_required")
        credentials.validate_reference(source["credential"])

    async def collect(self, source: dict[str, Any]) -> Batch:
        reference = source.get("credential") or ""
        token = await asyncio.to_thread(credentials.resolve, reference)
        if not token:
            raise SourceError("credential_unavailable", reference=reference)
        if any(char.isspace() or ord(char) < 32 for char in token):
            raise SourceError("credential_malformed", reference=reference)
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(API, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as error:
            raise SourceError("request_failed", type(error).__name__) from None
        if response.status_code != 200:
            # Provider error bodies may echo sensitive request details. Do not expose them.
            raise SourceError("http_status", status=response.status_code)
        try:
            body = response.json()
        except ValueError:
            raise SourceError("unexpected_output", command=COMMAND) from None
        rows = body.get("data") if isinstance(body, dict) else None
        # A page token would mean the list is incomplete; it is never sent unrequested.
        if not isinstance(rows, list) or body.get("page_token"):
            raise SourceError("unexpected_output", command=COMMAND)
        return Batch(
            instances=parse_instances(rows, source),
            capabilities=["instances", "ssh_discovery", "ssh_probe"],
        )
