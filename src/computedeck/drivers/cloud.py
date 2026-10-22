"""A base for cloud GPU providers. A new provider is a small subclass of CloudDriver.

The base resolves the API key reference, sends it the way the provider expects, maps
HTTP failures to messages that never contain the provider's reply, validates SSH
endpoints, builds the add-source form and returns the instance records the app uses.
A provider only says where its API is and turns its own rows into CloudInstance::

    class ExampleCloud(CloudDriver):
        name = "example-cloud"
        label = {"en": "Example Cloud"}
        base_url = "https://api.example.com"
        key_env = "EXAMPLE_API_KEY"

        async def instances(self, api, source):
            rows = await api.get("/v1/instances")
            return [CloudInstance(id=row["id"], name=row["name"], state=...) for row in rows]
"""

import asyncio
import re
from typing import Any, ClassVar, Literal

import httpx
from pydantic import BaseModel

from .. import credentials
from ..ssh_config import validate_alias, validate_endpoint
from .base import (
    Batch,
    DriverCheck,
    DriverField,
    DriverInfo,
    SourceError,
    credential_field,
    now,
    validate_row,
)

Text = dict[str, str]
State = Literal[
    "running",
    "reported_running",
    "stopped",
    "terminated",
    "desired_running",
    "desired_stopped",
    "desired_terminated",
    "unknown",
]

INSTANCE_LIFECYCLE = {
    "running": "held",
    "reported_running": "held",
    "stopped": "not_held",
    "terminated": "not_held",
    "deleted": "not_held",
    "desired_stopped": "not_held",
    "desired_terminated": "not_held",
    "desired_running": "unknown",
    "unknown": "unknown",
    "missing": "unknown",
}


def instance_lifecycle(state: str | None) -> str:
    """GPU allocation lifecycle, independent of SSH readiness and utilization.

    Mirrored in web/src/domain.ts and checked for parity by tests.
    """
    return INSTANCE_LIFECYCLE.get((state or "").lower(), "unknown")


class CloudInstance(BaseModel):
    """One instance as a provider reports it. Leave what the provider does not say as None."""

    id: str
    name: str
    # Use running/stopped/terminated only for observed states; desired_* when the API
    # reports only what the instance should be doing. reported_running is the provider's
    # normal running report, without an observation of readiness (e.g. RunPod REST).
    state: State = "unknown"
    gpu_count: int | None = None
    gpu_type: str | None = None
    # Price of the whole instance per hour, not per GPU.
    hourly_cost: float | None = None
    # Provider-documented start of the current run, with a timezone.
    started_at: str | None = None
    currency: str = "USD"
    ssh_host: str | None = None
    ssh_port: int | None = None
    ssh_user: str | None = None
    region: str | None = None
    # Only a value the provider measured; never an estimate.
    gpu_utilization: float | None = None


class Account(BaseModel):
    """What a provider says about the account, e.g. its remaining balance."""

    balance: float | None = None
    currency: str = "USD"


def ssh_command(command: str | None) -> tuple[str | None, int | None, str | None]:
    """Host, port and user from a command such as "ssh -p 22345 root@host.example.com"."""
    if not command:
        return None, None, None
    match = re.search(r"(?:^|\s)([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)", command)
    port = re.search(r"(?:^|\s)-p\s*(\d{1,5})(?:\s|$)", command)
    if not match:
        return None, None, None
    return match[2], int(port[1]) if port else 22, match[1]


class Api:
    """HTTP access for one collection: the provider's base URL and key, safe errors."""

    def __init__(self, client: httpx.AsyncClient, label: str) -> None:
        self.client = client
        self.label = label

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.HTTPError as error:
            raise SourceError("request_failed", type(error).__name__) from None
        if response.status_code >= 400:
            # Provider error bodies may echo request details; report the status only.
            raise SourceError("http_status", status=response.status_code)
        try:
            return response.json()
        except ValueError:
            raise SourceError("unexpected_output", command=f"{method} {path}") from None

    async def get(self, path: str, **params: Any) -> Any:
        return await self.request("GET", path, params=params or None)

    async def post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        return await self.request("POST", path, json=body if body is not None else {})


class CloudDriver:
    """Subclass and set the class attributes; implement ``instances`` (and ``account``)."""

    kind: ClassVar[Literal["cluster", "cloud"]] = "cloud"
    name: ClassVar[str]
    label: ClassVar[Text]
    description: ClassVar[Text] = {}
    base_url: ClassVar[str]
    # Tried in order when the first cannot be reached (some networks block one host).
    fallback_urls: ClassVar[tuple[str, ...]] = ()
    key_env: ClassVar[str]
    auth_header: ClassVar[str] = "Authorization"
    # "Bearer" sends "Bearer <key>"; "" sends the key alone.
    auth_scheme: ClassVar[str] = "Bearer"
    fields: ClassVar[list[DriverField]] = []
    beta: ClassVar[bool] = False
    info: ClassVar[DriverInfo]

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if "name" not in cls.__dict__:
            return
        label = cls.label.get("en", cls.name)
        cls.info = DriverInfo(
            label=cls.label,
            description=cls.description
            or {
                "en": f"Instances, prices and SSH endpoints from the {label} API.",
                "zh-CN": f"通过 {label} API 读取实例、单价和 SSH 端点。",
            },
            details={
                "en": "Lists instances with an API key that the service on {where} can read. "
                "Nothing is created, started or stopped.",
                "zh-CN": "使用{where}服务能读取到的 API Key 列出实例，"
                "不会创建、启动或停止任何实例。",
            },
            fields=[credential_field(f"env:{cls.key_env}"), *cls.fields],
            checks=[
                DriverCheck(
                    capability="instances",
                    command="API",
                    label={"en": "Instances", "zh-CN": "实例列表"},
                    warning="instances_unavailable",
                )
            ],
            default_name=label,
            beta=cls.beta,
        )

    async def instances(self, api: Api, source: dict[str, Any]) -> list[CloudInstance]:
        raise NotImplementedError

    async def account(self, api: Api, source: dict[str, Any]) -> Account | None:
        """Override to report a balance; None when the provider has no such call."""
        return None

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("credential"):
            raise SourceError("credential_required")
        credentials.validate_reference(source["credential"])

    def headers(self, key: str) -> dict[str, str]:
        value = f"{self.auth_scheme} {key}" if self.auth_scheme else key
        return {self.auth_header: value, "Accept": "application/json"}

    async def collect(self, source: dict[str, Any]) -> Batch:
        reference = source.get("credential") or ""
        key = await asyncio.to_thread(credentials.resolve, reference)
        if not key:
            raise SourceError("credential_unavailable", reference=reference)
        if any(char.isspace() or ord(char) < 32 for char in key):
            raise SourceError("credential_malformed", reference=reference)
        last: SourceError | None = None
        for base in (self.base_url, *self.fallback_urls):
            async with httpx.AsyncClient(
                base_url=base, headers=self.headers(key), timeout=20, follow_redirects=False
            ) as client:
                try:
                    return await self._collect(Api(client, self.name), source)
                except SourceError as error:
                    # Only an unreachable host is worth another address.
                    if error.code != "request_failed":
                        raise
                    last = error
        assert last is not None
        raise last

    async def _collect(self, api: Api, source: dict[str, Any]) -> Batch:
        batch = Batch(capabilities=[])
        account = await self.account(api, source)
        if account is not None:
            batch.account = account.model_dump()
            batch.capabilities.append("account")
        try:
            rows = await self.instances(api, source)
        except SourceError as error:
            # With a balance in hand the account works; say why instances are missing.
            if account is None:
                raise
            batch.warnings.append(
                error.message() | {"code": "instances_unavailable", "reason": error.code}
            )
            return batch
        observed = now()
        batch.instances = []
        skipped = 0
        for row in rows:
            try:
                record = instance_record(source, row, observed)
                validate_row(record, complete=True)
            except ValueError:
                # An id unsafe as an SSH alias, or a value the dashboard cannot use (a
                # negative price), leaves out that instance, not the whole listing.
                skipped += 1
                continue
            batch.instances.append(record)
        if skipped:
            batch.warnings.append({"code": "instances_skipped", "count": skipped})
        batch.capabilities.append("instances")
        # Discovery/probing are supported even when every instance is stopped.
        batch.capabilities += ["ssh_discovery", "ssh_probe"]
        return batch


def instance_record(source: dict[str, Any], row: CloudInstance, observed: str) -> dict[str, Any]:
    """The instance shape the app stores and shows. Raises ValueError for an unsafe id;
    an unsafe SSH endpoint is dropped and the instance kept."""
    instance_id = validate_alias(row.id[:120])
    endpoint: dict[str, Any] = {"host": None, "port": None, "username": None}
    if row.ssh_host and row.ssh_port:
        candidate = {"host": row.ssh_host, "port": row.ssh_port, "username": row.ssh_user or "root"}
        try:
            validate_endpoint(candidate)
            endpoint = candidate
        except ValueError:
            pass
    return {
        "id": f"{source['cluster_id']}:{instance_id}",
        "source_id": source["id"],
        "platform": source["name"],
        "name": row.name or instance_id,
        "state": row.state,
        "gpu_count": row.gpu_count,
        "gpu_type": row.gpu_type,
        "gpu_utilization": row.gpu_utilization,
        "cpu_utilization": None,
        "memory_utilization": None,
        **endpoint,
        # Unique per source, so two accounts that see one instance do not collide.
        "ssh_alias": f"computedeck-{source['cluster_id']}-{instance_id}",
        "identity_file": None,
        "hourly_cost": row.hourly_cost,
        "started_at": row.started_at,
        "currency": row.currency,
        "region": row.region,
        "observed_at": observed,
        "ssh_status": "unverified",
    }
