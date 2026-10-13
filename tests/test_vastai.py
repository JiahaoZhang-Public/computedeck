"""Vast.ai driver: instance inventory from the REST API without exposing the API key."""

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from computedeck.drivers import vastai
from computedeck.drivers.base import SourceError

TOKEN = "vast-test-secret-token"
SOURCE: dict[str, Any] = {
    "id": "vast-vastai",
    "name": "Vast.ai",
    "driver": "vastai",
    "cluster_id": "vast",
    "username": "",
    "credential": "env:VAST_TEST_TOKEN",
}


def row(**changes: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": 4242,
        "label": "train-1",
        "actual_status": "running",
        "intended_status": "running",
        "cur_state": "running",
        "num_gpus": 2,
        "gpu_name": "RTX 4090",
        "gpu_util": 87.5,
        "cpu_util": 3.2,
        "dph_total": 0.8021,
        "ssh_host": "ssh7.example.test",
        "ssh_port": 10600,
        "public_ipaddr": "203.0.113.7\n",
        "ports": {"22/tcp": [{"HostIp": "0.0.0.0", "HostPort": "40022"}]},
        "image_runtype": "ssh_direct ssh_proxy",
        "jupyter_token": "do-not-return",
        "extra_env": [["SECRET", "do-not-return"]],
        "onstart": "export SECRET=do-not-return",
    }
    result.update(changes)
    return result


def page(rows: list[dict[str, Any]], next_token: str | None = None) -> dict[str, Any]:
    return {
        "success": True,
        "instances_found": len(rows),
        "total_instances": len(rows),
        "label_counts": {},
        "next_token": next_token,
        "instances": rows,
    }


def use_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        vastai.httpx, "AsyncClient", lambda **kwargs: real(transport=transport, **kwargs)
    )
    monkeypatch.setattr(vastai, "PAGE_DELAY", 0)


def test_running_instance_with_direct_ssh_and_no_secret_fields() -> None:
    instance = vastai.parse_instances([row()], SOURCE)[0]
    assert instance["id"] == "vast:4242"
    assert instance["source_id"] == "vast-vastai"
    assert instance["platform"] == "Vast.ai"
    assert instance["name"] == "train-1"
    assert instance["state"] == "running"
    assert instance["gpu_count"] == 2
    assert instance["gpu_type"] == "RTX 4090"
    assert instance["gpu_utilization"] == 87.5
    # Units of cpu_util and mem_usage are undocumented; never interpreted.
    assert instance["cpu_utilization"] is None
    assert instance["memory_utilization"] is None
    assert (instance["host"], instance["port"], instance["username"]) == (
        "203.0.113.7",
        40022,
        "root",
    )
    assert instance["ssh_alias"] == "computedeck-vast-4242"
    assert instance["hourly_cost"] == 0.8021
    assert instance["currency"] == "USD"
    assert instance["ssh_status"] == "unverified"
    assert "do-not-return" not in json.dumps(instance)


def test_proxy_ssh_without_a_mapped_port() -> None:
    proxy = vastai.parse_instances([row(ports=None)], SOURCE)[0]
    assert (proxy["host"], proxy["port"]) == ("ssh7.example.test", 10600)
    # The CLI connects one port higher for Jupyter launch modes.
    jupyter = vastai.parse_instances([row(ports={}, image_runtype="jupyter_direct")], SOURCE)[0]
    assert (jupyter["host"], jupyter["port"]) == ("ssh7.example.test", 10601)
    no_ip = vastai.parse_instances([row(public_ipaddr="")], SOURCE)[0]
    assert no_ip["host"] == "ssh7.example.test"


def test_loading_instance_keeps_a_stable_alias_without_an_endpoint() -> None:
    alias = vastai.parse_instances([row()], SOURCE)[0]["ssh_alias"]
    loading = vastai.parse_instances(
        [row(actual_status=None, ports=None, ssh_host=None, ssh_port=None, label=None)], SOURCE
    )[0]
    assert loading["host"] is None and loading["port"] is None
    assert loading["ssh_alias"] == alias
    assert loading["name"] == "4242"
    assert loading["state"] == "desired_running"


@pytest.mark.parametrize(
    ("actual", "intended", "state"),
    [
        ("running", "running", "running"),
        ("running", "stopped", "running"),
        ("exited", "stopped", "stopped"),
        ("exited", "running", "stopped"),
        ("offline", "running", "unknown"),
        ("unknown", "running", "unknown"),
        (None, "running", "desired_running"),
        ("loading", "running", "desired_running"),
        ("created", "stopped", "desired_stopped"),
        ("loading", None, "unknown"),
        ("something-new", "running", "desired_running"),
    ],
)
def test_actual_status_wins_over_intent(
    actual: str | None, intended: str | None, state: str
) -> None:
    parsed = vastai.parse_instances([row(actual_status=actual, intended_status=intended)], SOURCE)
    assert parsed[0]["state"] == state


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({}, 87.5),
        ({"gpu_util": 0}, 0.0),
        ({"gpu_util": None}, None),
        ({"gpu_util": 250}, None),
        ({"gpu_util": -1}, None),
        ({"gpu_util": "n/a"}, None),
        ({"actual_status": "exited"}, None),
        ({"actual_status": "loading"}, None),
    ],
)
def test_gpu_utilization_only_for_running_measured_values(
    changes: dict[str, Any], expected: float | None
) -> None:
    assert vastai.parse_instances([row(**changes)], SOURCE)[0]["gpu_utilization"] == expected


def test_unknown_values_stay_unknown() -> None:
    instance = vastai.parse_instances(
        [row(num_gpus=None, gpu_name="", dph_total=None, gpu_util=None)], SOURCE
    )[0]
    assert instance["gpu_count"] is None
    assert instance["gpu_type"] is None
    assert instance["hourly_cost"] is None
    assert instance["gpu_utilization"] is None


def test_identity_is_per_cluster_and_username_can_be_overridden() -> None:
    other = {**SOURCE, "id": "vast-team", "username": "user"}
    first = vastai.parse_instances([row()], SOURCE)[0]
    second = vastai.parse_instances([row()], other)[0]
    assert first["id"] == second["id"]
    assert second["username"] == "user"


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "-oProxyCommand=touch"},
        {"id": "4242\nHost *"},
        {"public_ipaddr": "203.0.113.7\nProxyCommand touch /tmp/x"},
        {"ports": None, "ssh_host": "-oProxyCommand=touch"},
    ],
)
def test_unsafe_provider_values_are_rejected(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        vastai.parse_instances([row(**changes)], SOURCE)


@pytest.mark.parametrize("bad", [None, "text", {"label": "no id"}, {"id": True}])
def test_rows_without_an_id_are_unexpected(bad: Any) -> None:
    with pytest.raises(SourceError, match="unexpected_output"):
        vastai.parse_instances([bad], SOURCE)


def test_validate_requires_a_valid_credential_reference() -> None:
    driver = vastai.VastAIDriver()
    driver.validate(SOURCE)
    with pytest.raises(SourceError, match="credential_required"):
        driver.validate({**SOURCE, "credential": ""})
    with pytest.raises(SourceError, match="invalid_credential_reference"):
        driver.validate({**SOURCE, "credential": "VAST_API_KEY"})


def test_driver_description() -> None:
    info = vastai.VastAIDriver.info
    assert vastai.VastAIDriver.name == "vastai"
    assert vastai.VastAIDriver.kind == "cloud"
    assert info.beta is True
    assert [field.key for field in info.fields] == ["credential"]
    assert info.fields[0].default == "env:VAST_API_KEY"
    assert all(text.get("zh-CN") for text in (info.label, info.description, info.details))


async def test_pages_follow_next_token_with_bearer_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "after_token" not in request.url.params:
            return httpx.Response(200, json=page([row()], "cursor-1"))
        return httpx.Response(200, json=page([row(id=4243, label="train-2")]))

    use_transport(monkeypatch, handler)
    batch = await vastai.VastAIDriver().collect(SOURCE)
    assert batch.capabilities == ["instances", "ssh_discovery", "ssh_probe"]
    assert batch.instances is not None
    assert [item["id"] for item in batch.instances] == ["vast:4242", "vast:4243"]
    assert batch.jobs is None and batch.nodes is None
    assert set(batch.snapshot()) == {"instances"}
    assert len(seen) == 2
    for request in seen:
        assert request.method == "GET"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        assert str(request.url).startswith("https://console.vast.ai/api/v1/instances/?")
        assert request.url.params["limit"] == "25"
        assert json.loads(request.url.params["order_by"]) == [{"col": "id", "dir": "asc"}]
    assert seen[1].url.params["after_token"] == "cursor-1"
    assert TOKEN not in json.dumps(batch.model_dump())


async def test_empty_account_is_an_empty_inventory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)
    use_transport(monkeypatch, lambda request: httpx.Response(200, json=page([])))
    batch = await vastai.VastAIDriver().collect(SOURCE)
    assert batch.instances == []


async def test_repeated_cursor_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)
    use_transport(monkeypatch, lambda request: httpx.Response(200, json=page([row()], "same")))
    with pytest.raises(SourceError, match="unexpected_output"):
        await vastai.VastAIDriver().collect(SOURCE)


async def test_inventory_beyond_the_page_limit_is_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)
    monkeypatch.setattr(vastai, "MAX_PAGES", 3)
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json=page([row(id=len(calls))], f"cursor-{len(calls)}"))

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError, match="unexpected_output"):
        await vastai.VastAIDriver().collect(SOURCE)
    assert len(calls) == 3


async def test_http_error_never_returns_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"success": False, "msg": f"bad key {TOKEN}"})

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await vastai.VastAIDriver().collect(SOURCE)
    assert error.value.message() == {"code": "http_status", "status": 401}
    assert TOKEN not in str(error.value)


async def test_transport_error_reports_only_its_type(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"failed for Bearer {TOKEN}", request=request)

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await vastai.VastAIDriver().collect(SOURCE)
    assert error.value.message() == {"code": "request_failed", "detail": "ConnectError"}


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"success": True},
        {"success": False, "instances": []},
        {"success": True, "instances": {}},
        "not json",
    ],
)
async def test_unexpected_response_shape_is_an_error(
    monkeypatch: pytest.MonkeyPatch, body: Any
) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        if isinstance(body, str):
            return httpx.Response(200, text=body)
        return httpx.Response(200, json=body)

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError, match="unexpected_output"):
        await vastai.VastAIDriver().collect(SOURCE)


@pytest.mark.parametrize("value", [f"{TOKEN}\n", f"{TOKEN} extra", f"\x01{TOKEN}"])
async def test_malformed_token_is_not_echoed_or_sent(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("VAST_TEST_TOKEN", value)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("No request should be sent")

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await vastai.VastAIDriver().collect(SOURCE)
    assert error.value.message() == {
        "code": "credential_malformed",
        "reference": "env:VAST_TEST_TOKEN",
    }


async def test_missing_credential_names_only_the_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("VAST_TEST_TOKEN", raising=False)
    with pytest.raises(SourceError) as error:
        await vastai.VastAIDriver().collect(SOURCE)
    assert error.value.message() == {
        "code": "credential_unavailable",
        "reference": "env:VAST_TEST_TOKEN",
    }
