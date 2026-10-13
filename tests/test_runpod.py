"""RunPod driver: pod inventory from the REST API without exposing the API key."""

import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from computedeck.drivers import cloud, runpod
from computedeck.drivers.base import SourceError

TOKEN = "rp-test-secret-token"
SOURCE: dict[str, Any] = {
    "id": "runpod-runpod",
    "name": "RunPod",
    "driver": "runpod",
    "cluster_id": "runpod",
    "username": "",
    "credential": "env:RUNPOD_TEST_TOKEN",
}


def pod(**changes: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": "pod123abc",
        "name": "training",
        "desiredStatus": "RUNNING",
        "gpu": {"count": 2, "displayName": "A100"},
        "publicIp": "203.0.113.5",
        "portMappings": {"22": 23456},
        "costPerHr": "1.5",
        "env": {"SECRET": "do-not-return"},
        "containerRegistryAuthId": "private-registry-auth",
    }
    result.update(changes)
    return result


def use_transport(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> None:
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        cloud.httpx, "AsyncClient", lambda **kwargs: real(transport=transport, **kwargs)
    )


def test_expected_lifecycle_endpoints_and_no_secret_fields() -> None:
    instance = runpod.parse_pods([pod()], SOURCE)[0]
    assert instance["id"] == "runpod:pod123abc"
    assert instance["source_id"] == "runpod-runpod"
    assert instance["platform"] == "RunPod"
    assert instance["state"] == "desired_running"
    assert instance["ssh_status"] == "unverified"
    assert instance["host"] == "203.0.113.5"
    assert instance["port"] == 23456
    assert instance["username"] == "root"
    assert instance["gpu_count"] == 2
    assert instance["gpu_type"] == "A100"
    assert instance["hourly_cost"] == 1.5
    # The REST API reports intended lifecycle, never measured utilization.
    assert instance["gpu_utilization"] is None
    assert instance["cpu_utilization"] is None
    text = json.dumps(instance)
    assert "do-not-return" not in text
    assert "private-registry-auth" not in text


def test_pod_identity_is_shared_by_identities_of_one_cluster() -> None:
    other_account = {**SOURCE, "id": "runpod-team", "username": "ubuntu"}
    first = runpod.parse_pods([pod()], SOURCE)[0]
    second = runpod.parse_pods([pod()], other_account)[0]
    assert first["id"] == second["id"]
    assert second["username"] == "ubuntu"
    other_cluster = {**SOURCE, "cluster_id": "runpod-b"}
    assert runpod.parse_pods([pod()], other_cluster)[0]["id"] == "runpod-b:pod123abc"


def test_initializing_pod_keeps_a_stable_alias_without_an_endpoint() -> None:
    alias = runpod.parse_pods([pod()], SOURCE)[0]["ssh_alias"]
    initializing = runpod.parse_pods(
        [pod(publicIp=None, portMappings=None, name="new display name")], SOURCE
    )[0]
    assert initializing["host"] is None
    assert initializing["port"] is None
    assert initializing["ssh_alias"] == alias
    assert initializing["name"] == "new display name"
    no_port = runpod.parse_pods([pod(portMappings={"8888": 8888})], SOURCE)[0]
    assert no_port["host"] is None and no_port["port"] is None


def test_gpu_type_fallback_and_unknown_count() -> None:
    without_gpu = pod(machine={"gpuTypeId": "NVIDIA A100"})
    without_gpu.pop("gpu")
    stopped = runpod.parse_pods([without_gpu], SOURCE)[0]
    assert stopped["gpu_type"] == "NVIDIA A100"
    assert stopped["gpu_count"] is None
    assert runpod.parse_pods([pod(gpu={"count": "two"})], SOURCE)[0]["gpu_count"] is None


@pytest.mark.parametrize(
    ("status", "state"),
    [
        ("RUNNING", "desired_running"),
        ("EXITED", "desired_stopped"),
        ("TERMINATED", "desired_terminated"),
        ("STARTING", "unknown"),
        (None, "unknown"),
    ],
)
def test_desired_status_maps_to_expected_lifecycle(status: str | None, state: str) -> None:
    assert runpod.parse_pods([pod(desiredStatus=status)], SOURCE)[0]["state"] == state


def test_a_stop_recorded_long_ago_is_stopped() -> None:
    def state(status: str, change: str) -> str:
        return runpod.parse_pods([pod(desiredStatus=status, lastStatusChange=change)], SOURCE)[0][
            "state"
        ]

    old = "Exited by user: Tue Sep 29 2026 19:16:58 GMT+0000 (Coordinated Universal Time)"
    assert state("EXITED", old) == "stopped"
    assert state("TERMINATED", old.replace("Exited", "Terminated")) == "terminated"
    # A change that may still be under way, or one that cannot be read, stays expected.
    recent = datetime.now(UTC).strftime("Exited by user: %a %b %d %Y %H:%M:%S GMT+0000")
    assert state("EXITED", recent) == "desired_stopped"
    assert state("EXITED", "Exited by user") == "desired_stopped"
    assert state("EXITED", "Exited by user: Tue Sep 31 2026 99:00:00 GMT+0000") == "desired_stopped"
    # A running pod is never inferred to be ready.
    assert state("RUNNING", old.replace("Exited", "Started")) == "desired_running"


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "-oProxyCommand=touch"},
        {"id": "pod\nHost *"},
        {"publicIp": "203.0.113.5\nProxyCommand touch /tmp/x"},
        {"publicIp": "-oProxyCommand=touch"},
    ],
)
def test_unsafe_provider_values_never_reach_ssh(changes: dict[str, Any]) -> None:
    if "id" in changes:
        # An unsafe id is refused; the collection skips that pod and says so.
        with pytest.raises(ValueError):
            runpod.parse_pods([pod(**changes)], SOURCE)
        return
    [instance] = runpod.parse_pods([pod(**changes)], SOURCE)
    # An unsafe address is dropped: the pod is listed without an SSH endpoint.
    assert instance["host"] is None and instance["port"] is None
    assert "ProxyCommand" not in json.dumps(instance)


def test_validate_requires_a_valid_credential_reference() -> None:
    driver = runpod.RunPodDriver()
    driver.validate(SOURCE)
    with pytest.raises(SourceError, match="credential_required"):
        driver.validate({**SOURCE, "credential": ""})
    with pytest.raises(SourceError, match="invalid_credential_reference"):
        driver.validate({**SOURCE, "credential": "RUNPOD_API_KEY"})


async def test_request_uses_bearer_token_and_returns_instances(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RUNPOD_TEST_TOKEN", TOKEN)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[pod()])

    use_transport(monkeypatch, handler)
    batch = await runpod.RunPodDriver().collect(SOURCE)
    assert batch.capabilities == ["instances", "ssh_discovery", "ssh_probe"]
    assert batch.instances is not None and batch.instances[0]["id"] == "runpod:pod123abc"
    assert batch.jobs is None and batch.nodes is None
    assert set(batch.snapshot()) == {"instances"}
    assert seen[0].method == "GET"
    assert seen[0].headers["Authorization"] == f"Bearer {TOKEN}"
    assert str(seen[0].url).startswith("https://rest.runpod.io/v1/pods?")
    assert seen[0].url.params["includeMachine"] == "true"
    assert TOKEN not in json.dumps(batch.model_dump())


async def test_http_error_never_returns_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNPOD_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": f"invalid key {TOKEN}"})

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await runpod.RunPodDriver().collect(SOURCE)
    assert error.value.message() == {"code": "http_status", "status": 403}
    assert TOKEN not in str(error.value)


async def test_transport_error_reports_only_its_type(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNPOD_TEST_TOKEN", TOKEN)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"failed for Bearer {TOKEN}", request=request)

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await runpod.RunPodDriver().collect(SOURCE)
    assert error.value.message() == {"code": "request_failed", "detail": "ConnectError"}
    assert TOKEN not in json.dumps(error.value.message())


async def test_unexpected_response_shape_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNPOD_TEST_TOKEN", TOKEN)
    use_transport(monkeypatch, lambda request: httpx.Response(200, json={"pods": []}))
    with pytest.raises(SourceError, match="unexpected_output"):
        await runpod.RunPodDriver().collect(SOURCE)


@pytest.mark.parametrize("value", [f"{TOKEN}\n", f"{TOKEN} extra", f"\x01{TOKEN}"])
async def test_malformed_token_is_not_echoed_or_sent(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("RUNPOD_TEST_TOKEN", value)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("No request should be sent")

    use_transport(monkeypatch, handler)
    with pytest.raises(SourceError) as error:
        await runpod.RunPodDriver().collect(SOURCE)
    assert error.value.message() == {
        "code": "credential_malformed",
        "reference": "env:RUNPOD_TEST_TOKEN",
    }
    assert TOKEN not in str(error.value)


async def test_missing_credential_names_only_the_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RUNPOD_TEST_TOKEN", raising=False)
    with pytest.raises(SourceError) as error:
        await runpod.RunPodDriver().collect(SOURCE)
    assert error.value.message() == {
        "code": "credential_unavailable",
        "reference": "env:RUNPOD_TEST_TOKEN",
    }


async def test_unavailable_keychain_fails_the_collection(monkeypatch: pytest.MonkeyPatch) -> None:
    import keyring
    from keyring.errors import NoKeyringError

    def get_password(service: str, account: str) -> str | None:
        raise NoKeyringError("no backend")

    monkeypatch.setattr(keyring, "get_password", get_password)
    with pytest.raises(SourceError) as error:
        await runpod.RunPodDriver().collect({**SOURCE, "credential": "keychain:computedeck/runpod"})
    assert error.value.message() == {"code": "keychain_unavailable", "detail": "NoKeyringError"}


def test_null_adjusted_price_uses_known_base_price() -> None:
    [instance] = runpod.parse_pods([pod(adjustedCostPerHr=None)], SOURCE)
    assert instance["hourly_cost"] == 1.5


async def test_stopped_pods_keep_supported_ssh_capabilities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RUNPOD_TEST_TOKEN", TOKEN)
    use_transport(
        monkeypatch,
        lambda request: httpx.Response(
            200,
            json=[
                pod(desiredStatus="EXITED", publicIp=None, portMappings=None, gpu=None, gpuCount=1)
            ],
        ),
    )
    batch = await runpod.RunPodDriver().collect(SOURCE)
    assert batch.capabilities == ["instances", "ssh_discovery", "ssh_probe"]
    assert batch.instances is not None and batch.instances[0]["gpu_count"] == 1


class FakeApi:
    def __init__(self, reply: Any) -> None:
        self.reply = reply

    async def get(self, path: str, **params: Any) -> Any:
        return self.reply


async def test_one_unusable_pod_is_left_out_not_the_whole_listing() -> None:
    pods = [
        pod(id="good1"),
        pod(id="good2"),
        pod(id="odd", costPerHr=-0.01, adjustedCostPerHr=None),
    ]
    batch = await runpod.RunPodDriver()._collect(FakeApi(pods), SOURCE)  # type: ignore[arg-type]
    batch.validate_rows()  # what the collector does before saving
    assert [row["id"] for row in batch.instances or []] == ["runpod:good1", "runpod:good2"]
    assert {"code": "instances_skipped", "count": 1} in batch.warnings
