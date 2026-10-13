"""GPUhub: account balance and Elastic Deployment containers. Read-only.

API reference: https://docs.gpuhub.com/api-reference/api-authentication (token sent as the
bare Authorization header), api-elastic-deployment (deployment and container lists) and
api-obtain-balances. The API covers Elastic Deployment only; on-demand instances are not
listed by it. api.gpuhub.com is not reachable from every network, while the same API
answers on www.gpuhub.com, so that host is tried next.
"""

import re
from typing import Any, ClassVar

from .base import SourceError, integer, number
from .cloud import Account, Api, CloudDriver, CloudInstance, State, ssh_command

STATES: dict[str, State] = {
    "running": "running",
    "stopped": "stopped",
    "shutdown": "stopped",
    "creating": "desired_running",
    "created": "desired_running",
    "oss_merged": "desired_running",
    "starting": "desired_running",
    "shutting_down": "desired_stopped",
}
MAX_PAGES = 20


def envelope(body: Any) -> Any:
    """The data of a {code, msg, data} reply; a refusal becomes a readable error."""
    if not isinstance(body, dict) or "code" not in body:
        raise SourceError("unexpected_output", command="GPUhub API")
    if body["code"] == "Success":
        return body.get("data")
    if body["code"] == "AuthorizeFailed":
        raise SourceError("credential_rejected")
    text = re.sub(r"[\x00-\x1f]", " ", str(body.get("msg") or ""))[:160]
    raise SourceError("provider_refused", text or None, reply=str(body["code"])[:40])


async def pages(api: Api, path: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for page in range(1, MAX_PAGES + 1):
        data = envelope(await api.post(path, {**body, "page_index": page, "page_size": 100}))
        items = (data or {}).get("list") or []
        rows += [item for item in items if isinstance(item, dict)]
        if not items or page >= (integer((data or {}).get("max_page")) or 1):
            return rows
    # A cut-off list would make the rest look deleted; report it instead.
    raise SourceError("listing_truncated", command="GPUhub API", count=len(rows))


def container_instance(deployment: dict[str, Any], container: dict[str, Any]) -> CloudInstance:
    uuid = str(container.get("uuid") or "")
    info = container.get("info") or {}
    # info also carries the root password; it is never read.
    host, port, user = ssh_command(info.get("ssh_command") if isinstance(info, dict) else None)
    price = number(container.get("price"))
    label = deployment.get("name") or deployment.get("uuid") or "deployment"
    return CloudInstance(
        id=uuid,
        name=f"{label} · {uuid[-8:]}",
        state=STATES.get(str(container.get("status")), "unknown"),
        gpu_count=integer(container.get("gpu_num")),
        gpu_type=container.get("gpu_name") or None,
        hourly_cost=None if price is None else price / 1000,
        ssh_host=host,
        ssh_port=port,
        ssh_user=user,
        region=container.get("data_center") or None,
    )


class GPUHubDriver(CloudDriver):
    name: ClassVar[str] = "gpuhub"
    label: ClassVar[dict[str, str]] = {"en": "GPUhub", "zh-CN": "GPUhub"}
    description: ClassVar[dict[str, str]] = {
        "en": "Account balance and Elastic Deployment containers from the GPUhub API.",
        "zh-CN": "通过 GPUhub API 读取账户余额和弹性部署容器。",
    }
    base_url: ClassVar[str] = "https://api.gpuhub.com"
    fallback_urls: ClassVar[tuple[str, ...]] = ("https://www.gpuhub.com",)
    key_env: ClassVar[str] = "GPUHUB_API_KEY"
    auth_scheme: ClassVar[str] = ""
    beta: ClassVar[bool] = True

    async def account(self, api: Api, source: dict[str, Any]) -> Account:
        data = envelope(await api.post("/api/v1/dev/wallet/balance"))
        assets = number((data or {}).get("assets"))
        # Amounts are in thousandths of a dollar.
        return Account(balance=None if assets is None else assets / 1000)

    async def instances(self, api: Api, source: dict[str, Any]) -> list[CloudInstance]:
        rows = []
        for deployment in await pages(api, "/api/v1/dev/deployment/list", {}):
            if not deployment.get("uuid"):
                continue
            containers = await pages(
                api,
                "/api/v1/dev/deployment/container/list",
                {"deployment_uuid": deployment["uuid"], "released": False},
            )
            rows += [container_instance(deployment, item) for item in containers]
        return rows
