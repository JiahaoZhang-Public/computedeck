"""Lambda Cloud driver: instance inventory from the REST API without exposing the API key."""

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from computedeck.drivers import lambda_cloud
from computedeck.drivers.base import SourceError

TOKEN = "lambda-test-secret-token"
SOURCE: dict[str, Any] = {
    "id": "lambda-lambda",
    "name": "Lambda Cloud",
    "driver": "lambda",
    "cluster_id": "lambda",
    "username": "",
    "credential": "env:LAMBDA_TEST_TOKEN",
}


def instance(**changes: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": "0123456789abcdef0123456789abcdef",
        "name": "train-1",
        "ip": "198.51.100.20",
        "private_ip": "10.0.0.20",
        "status": "active",
        "ssh_key_names": ["example-key"],
        "file_system_names": [],
        "region": {"name": "us-example-1", "description": "Example region"},
        "instance_type": {
            "name": "gpu_8x_example",
            "description": "8x Example GPU",
            "gpu_description": "Example GPU (80 GB SXM)",
            "price_cents_per_hour": 1990,
            "specs": {"vcpus": 208, "memory_gib": 1800, "storage_gib": 24780, "gpus": 8},
            "architecture": "x86_64",
        },
        "hostname": "train-1.example.test",
        "jupyter_token": "do-not-return",
        "jupyter_url": "https://jupyter.example.test/?token=do-not-return",
        "first_healthy": "2026-01-01T00:00:00Z",
        "actions": {},
    }
    result.update(changes)
    return result


def use_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        lambda_cloud.httpx, "AsyncClient", lambda **kwargs: real(transport=transport, **kwargs)
    )


def test_active_instance_with_price_endpoint_and_no_secret_fields() -> None:
    result = lambda_cloud.parse_instances([instance()], SOURCE)[0]
    assert result["id"] == "lambda:0123456789abcdef0123456789abcdef"
    assert result["source_id"] == "lambda-lambda"
    assert result["platform"] == "Lambda Cloud"
    assert result["name"] == "train-1"
    assert result["state"] == "running"
    assert result["gpu_count"] == 8
    assert result["gpu_type"] == "Example GPU (80 GB SXM)"
    assert result["hourly_cost"] == 19.9
    assert result["currency"] == "USD"
    assert result["region"] == "us-example-1"
    assert (result["host"], result["port"], result["username"]) == ("198.51.100.20", 22, "ubuntu")
    assert result["ssh_alias"] == "computedeck-lambda-0123456789abcdef0123456789abcdef"
    assert result["ssh_status"] == "unverified"
    # The API reports lifecycle and configuration, never measured utilization.
    assert result["gpu_utilization"] is None
    assert result["cpu_utilization"] is None
    assert result["memory_utilization"] is None
    assert "do-not-return" not in json.dumps(result)


@pytest.mark.parametrize(
    ("status", "state"),
    [
        ("active", "running"),
        ("booting", "desired_running"),
        ("terminating", "desired_terminated"),
        ("terminated", "terminated"),
        ("unhealthy", "unknown"),
        ("preempted", "unknown"),
        (None, "unknown"),
    ],
)
def test_status_mapping(status: str | None, state: str) -> None:
    assert lambda_cloud.parse_instances([instance(status=status)], SOURCE)[0]["state"] == state


def test_booting_instance_keeps_a_stable_alias_without_an_endpoint() -> None:
    alias = lambda_cloud.parse_instances([instance()], SOURCE)[0]["ssh_alias"]
    booting = lambda_cloud.parse_instances(
        [instance(status="booting", ip=None, name=None)], SOURCE
    )[0]
    assert booting["host"] is None and booting["port"] is None
    assert booting["ssh_alias"] == alias
    assert booting["name"] == "0123456789abcdef0123456789abcdef"


def test_missing_values_stay_unknown_and_zero_gpus_are_reported() -> None:
    bare = instance(instance_type={"name": "unknown"}, region=None)
    result = lambda_cloud.parse_instances([bare], SOURCE)[0]
    assert result["gpu_count"] is None
    assert result["gpu_type"] is None
    assert result["hourly_cost"] is None
    assert result["region"] is None
    cpu_only = instance(
        instance_type={
            "name": "cpu_example",
            "gpu_description": "N/A",
            "price_cents_per_hour": 0,
            "specs": {"gpus": 0},
        }
    )
    result = lambda_cloud.parse_instances([cpu_only], SOURCE)[0]
    # The API states zero GPUs; that is a fact, not a missing value.
    assert result["gpu_count"] == 0
    assert result["gpu_type"] is None
    assert result["hourly_cost"] == 0


def test_identity_is_per_cluster_and_username_can_be_overridden() -> None:
    other = {**SOURCE, "id": "lambda-team", "username": "admin"}
    first = lambda_cloud.parse_instances([instance()], SOURCE)[0]
    second = lambda_cloud.parse_instances([instance()], other)[0]
    assert first["id"] == second["id"]
    assert second["username"] == "admin"


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "-oProxyCommand=touch"},
        {"id": "abc\nHost *"},
        {"ip": "198.51.100.20\nProxyCommand touch /tmp/x"},
        {"ip": "-oProxyCommand=touch"},
    ],
)
def test_unsafe_provider_values_are_rejected(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        lambda_cloud.parse_instances([instance(**changes)], SOURCE)


@pytest.mark.parametrize("bad", [None, "text", {"name": "no id"}, {"id": 7}])
def test_rows_without_an_id_are_unexpected(bad: Any) -> None:
    with pytest.raises(SourceError, match="unexpected_output"):
        lambda_cloud.parse_instances([bad], SOURCE)


def test_validate_requires_a_valid_credential_reference() -> None:
    driver = lambda_cloud.LambdaCloudDriver()
    driver.validate(SOURCE)
    with pytest.raises(SourceError, match="credential_required"):
        driver.validate({**SOURCE, "credential": ""})
    with pytest.raises(SourceError, match="invalid_credential_reference"):
        driver.validate({**SOURCE, "credential": "LAMBDA_API_KEY"})


def test_driver_description() -> None:
    info = lambda_cloud.LambdaCloudDriver.info
    assert lambda_cloud.LambdaCloudDriver.name == "lambda"
    assert lambda_cloud.LambdaCloudDriver.kind == "cloud"
    assert [field.key for field in info.fields] == ["credential"]
    assert info.fields[0].default == "env:LAMBDA_API_KEY"
    assert all(text.get("zh-CN") for text in (info.label, info.description, info.details))


async def test_request_uses_bearer_token_and_returns_instances(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LAMBDA_TEST_TOKEN", TOKEN)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [instance()], "page_token": None})

    use_transport(monkeypatch, handler)
    batch = await lambda_cloud.LambdaCloudDriver().collect(SOURCE)
    assert batch.capabilities == ["instances", "ssh_discovery", "ssh_probe"]
    assert batch.instances is not None
    assert batch.instances[0]["id"] == "lambda:0123456789abcdef0123456789abcdef"
    assert batch.jobs is None and batch.nodes is None
    assert set(batch.snapshot()) == {"instances"}
    assert len(seen) == 1
    assert seen[0].method == "GET"
    assert seen[0].headers["Authorization"] == f"Bearer {TOKEN}"
    # Unpaged: the whole inventory in one response.
    assert str(seen[0].url) == "https://cloud.lambda.ai/api/v1/instances"
    assert TOKEN not in json.dumps(batch.model_dump())


async def test_empty_account_is_an_empty_inventory(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMBDA_TEST_TOKEN", TOKEN)
    use_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": []}))
    batch = await lambda_cloud.LambdaCloudDriver().collect(SOURCE)
    assert batch.instances == []


async def test_http_error_never_returns_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMBDA_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": f"invalid key {TOKEN}"}})

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await lambda_cloud.LambdaCloudDriver().collect(SOURCE)
    assert error.value.message() == {"code": "http_status", "status": 401}
    assert TOKEN not in str(error.value)


async def test_transport_error_reports_only_its_type(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAMBDA_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(f"failed for Bearer {TOKEN}", request=request)

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await lambda_cloud.LambdaCloudDriver().collect(SOURCE)
    assert error.value.message() == {"code": "request_failed", "detail": "ReadTimeout"}


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"data": {}},
        {"instances": []},
        {"data": [], "page_token": "more"},
        "not json",
    ],
)
async def test_unexpected_response_shape_is_an_error(
    monkeypatch: pytest.MonkeyPatch, body: Any
) -> None:
    monkeypatch.setenv("LAMBDA_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        if isinstance(body, str):
            return httpx.Response(200, text=body)
        return httpx.Response(200, json=body)

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError, match="unexpected_output"):
        await lambda_cloud.LambdaCloudDriver().collect(SOURCE)


@pytest.mark.parametrize("value", [f"{TOKEN}\n", f"{TOKEN} extra", f"\x01{TOKEN}"])
async def test_malformed_token_is_not_echoed_or_sent(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("LAMBDA_TEST_TOKEN", value)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("No request should be sent")

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await lambda_cloud.LambdaCloudDriver().collect(SOURCE)
    assert error.value.message() == {
        "code": "credential_malformed",
        "reference": "env:LAMBDA_TEST_TOKEN",
    }


async def test_missing_credential_names_only_the_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LAMBDA_TEST_TOKEN", raising=False)
    with pytest.raises(SourceError) as error:
        await lambda_cloud.LambdaCloudDriver().collect(SOURCE)
    assert error.value.message() == {
        "code": "credential_unavailable",
        "reference": "env:LAMBDA_TEST_TOKEN",
    }
