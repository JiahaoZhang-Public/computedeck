"""GPUhub through the cloud base: balance, Elastic Deployment containers, host fallback."""

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from computedeck.drivers import cloud
from computedeck.drivers.base import SourceError
from computedeck.drivers.gpuhub import GPUHubDriver, container_instance

TOKEN = "gh-test-token"
SOURCE: dict[str, Any] = {
    "id": "gpuhub-gpuhub",
    "name": "GPUhub",
    "driver": "gpuhub",
    "cluster_id": "gpuhub",
    "credential": "env:GPUHUB_TEST_TOKEN",
}
CONTAINER = {
    "uuid": "53a677bb3e281b8-f94411a60c-63c24009",
    "status": "running",
    "gpu_name": "RTX 5090",
    "gpu_num": 2,
    "price": 1600,
    "data_center": "Singapore-A",
    "info": {
        "ssh_command": "ssh -p 22345 root@sg-a.example-gpu.com",
        "root_password": "never-show-this",
    },
}


def reply(data: Any, code: str = "Success", msg: str = "") -> httpx.Response:
    return httpx.Response(200, json={"code": code, "msg": msg, "data": data})


def use(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    monkeypatch.setenv("GPUHUB_TEST_TOKEN", TOKEN)
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        cloud.httpx, "AsyncClient", lambda **kwargs: real(transport=transport, **kwargs)
    )


def account_and(handler: Callable[[str, dict[str, Any]], httpx.Response]) -> Callable[..., Any]:
    seen: list[str] = []

    def route(request: httpx.Request) -> httpx.Response:
        # The token goes bare in the Authorization header.
        assert request.headers["Authorization"] == TOKEN
        seen.append(f"{request.url.host}{request.url.path}")
        if request.url.path == "/api/v1/dev/wallet/balance":
            return reply({"assets": 12345, "accumulate": 0, "voucher_balance": 0})
        return handler(request.url.path, json.loads(request.content or b"{}"))

    route.seen = seen  # type: ignore[attr-defined]
    return route


async def test_balance_and_containers_are_collected(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(path: str, body: dict[str, Any]) -> httpx.Response:
        if path.endswith("/deployment/list"):
            return reply({"list": [{"uuid": "dep1", "name": "llm-serve"}], "max_page": 1})
        assert body["deployment_uuid"] == "dep1" and body["released"] is False
        return reply(
            {"list": [CONTAINER, {**CONTAINER, "uuid": "c2", "status": "starting"}], "max_page": 1}
        )

    use(monkeypatch, account_and(handler))
    batch = await GPUHubDriver().collect(SOURCE)
    assert batch.account == {"balance": 12.345, "currency": "USD"}
    assert batch.capabilities == ["account", "instances", "ssh_discovery", "ssh_probe"]
    first, second = batch.instances or []
    assert first["id"] == "gpuhub:53a677bb3e281b8-f94411a60c-63c24009"
    assert first["name"] == "llm-serve · 63c24009"
    assert (first["state"], first["gpu_count"], first["gpu_type"]) == ("running", 2, "RTX 5090")
    assert first["hourly_cost"] == 1.6 and first["region"] == "Singapore-A"
    assert (first["host"], first["port"], first["username"]) == (
        "sg-a.example-gpu.com",
        22345,
        "root",
    )
    assert second["state"] == "desired_running"
    assert "never-show-this" not in json.dumps(batch.model_dump())


async def test_an_account_without_deployment_access_is_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    use(
        monkeypatch,
        account_and(
            lambda path, body: reply(
                None, "BadRequest", "No access permission for the current resource."
            )
        ),
    )
    batch = await GPUHubDriver().collect(SOURCE)
    assert batch.account and batch.account["balance"] == 12.345
    assert batch.instances is None
    [warning] = batch.warnings
    assert warning["code"] == "instances_unavailable" and warning["reason"] == "provider_refused"
    assert "No access permission" in warning["detail"]


async def test_an_unreachable_api_host_falls_back_to_www(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(path: str, body: dict[str, Any]) -> httpx.Response:
        return reply({"list": [], "max_page": 1})

    route = account_and(handler)

    def network(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.gpuhub.com":
            raise httpx.ConnectError("connection reset", request=request)
        return route(request)

    use(monkeypatch, network)
    batch = await GPUHubDriver().collect(SOURCE)
    assert batch.instances == []
    assert all(host.startswith("www.gpuhub.com") for host in route.seen)  # type: ignore[attr-defined]


async def test_a_rejected_token_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    use(monkeypatch, lambda request: reply(None, "AuthorizeFailed", f"bad token {TOKEN}"))
    with pytest.raises(SourceError) as error:
        await GPUHubDriver().collect(SOURCE)
    assert error.value.message() == {"code": "credential_rejected"}


async def test_pages_are_followed_to_the_last(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(path: str, body: dict[str, Any]) -> httpx.Response:
        if path.endswith("/deployment/list"):
            return reply({"list": [{"uuid": f"dep{body['page_index']}"}], "max_page": 3})
        return reply(
            {"list": [{**CONTAINER, "uuid": f"c-{body['deployment_uuid']}"}], "max_page": 1}
        )

    use(monkeypatch, account_and(handler))
    batch = await GPUHubDriver().collect(SOURCE)
    assert [row["id"] for row in batch.instances or []] == [
        "gpuhub:c-dep1",
        "gpuhub:c-dep2",
        "gpuhub:c-dep3",
    ]


async def test_a_listing_longer_than_the_page_cap_is_not_cut_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(path: str, body: dict[str, Any]) -> httpx.Response:
        if path.endswith("/deployment/list"):
            return reply({"list": [{"uuid": f"dep{body['page_index']}"}], "max_page": 25})
        return reply({"list": [CONTAINER], "max_page": 1})

    use(monkeypatch, account_and(handler))
    batch = await GPUHubDriver().collect(SOURCE)
    # The balance is kept; the instance list is reported unreadable, not shortened.
    assert batch.instances is None
    assert batch.warnings[0]["reason"] == "listing_truncated"


def test_unsafe_ids_are_skipped_and_unsafe_endpoints_dropped() -> None:
    unsafe = container_instance({}, {**CONTAINER, "uuid": "-oProxyCommand=x"})
    with pytest.raises(ValueError):
        cloud.instance_record(SOURCE, unsafe, "2026-01-01T00:00:00Z")
    bad_host = container_instance(
        {}, {**CONTAINER, "info": {"ssh_command": "ssh -p 22 root@-oProxyCommand=x"}}
    )
    record = cloud.instance_record(SOURCE, bad_host, "2026-01-01T00:00:00Z")
    assert record["host"] is None


def test_ssh_commands_are_parsed() -> None:
    assert cloud.ssh_command("ssh -p 22345 root@host.example.com") == (
        "host.example.com",
        22345,
        "root",
    )
    assert cloud.ssh_command("ssh ubuntu@203.0.113.9") == ("203.0.113.9", 22, "ubuntu")
    assert cloud.ssh_command("not a command") == (None, None, None)
    assert cloud.ssh_command(None) == (None, None, None)


def test_the_form_comes_from_the_class() -> None:
    info = GPUHubDriver.info
    assert info.label == {"en": "GPUhub", "zh-CN": "GPUhub"}
    assert info.fields[0].key == "credential" and info.fields[0].default == "env:GPUHUB_API_KEY"
    assert info.beta is True
