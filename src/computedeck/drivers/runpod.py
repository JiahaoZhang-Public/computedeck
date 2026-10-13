"""RunPod pod discovery through the REST API. Read-only."""

import re
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from .base import SourceError, integer, now, number
from .cloud import Api, CloudDriver, CloudInstance, State, instance_record

API = "https://rest.runpod.io/v1/pods"
# e.g. "Exited by user: Tue Sep 29 2026 19:16:58 GMT+0000 (Coordinated Universal Time)"
CHANGED_AT = re.compile(r"(\w{3} \w{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2}) GMT([+-]\d{4})")
SETTLED = timedelta(minutes=10)


def _settled(pod: dict[str, Any]) -> bool:
    """A stop or termination that RunPod recorded long ago has taken effect."""
    match = CHANGED_AT.search(str(pod.get("lastStatusChange") or ""))
    if not match:
        return False
    try:
        changed = datetime.strptime(f"{match[1]} {match[2]}", "%a %b %d %Y %H:%M:%S %z")
    except ValueError:
        return False
    return datetime.now(UTC) - changed > SETTLED


def pod_instance(pod: dict[str, Any], user: str) -> CloudInstance:
    pod_id = str(pod["id"])
    gpu = pod.get("gpu") or {}
    machine = pod.get("machine") or {}
    mappings = pod.get("portMappings")
    port = integer(mappings.get("22")) if isinstance(mappings, dict) else None
    # REST exposes expected lifecycle, not measured readiness or utilization. A stop is
    # trusted once its recorded change is old enough to have finished.
    # https://docs.runpod.io/api-reference/pods/GET/pods
    desired = str(pod.get("desiredStatus"))
    state: State = {
        "RUNNING": "desired_running",
        "EXITED": "stopped" if _settled(pod) else "desired_stopped",
        "TERMINATED": "terminated" if _settled(pod) else "desired_terminated",
    }.get(desired, "unknown")  # type: ignore[assignment]
    return CloudInstance(
        id=pod_id,
        name=pod.get("name") or pod_id,
        state=state,
        # A stopped pod has no "gpu" object; the API still reports gpuCount.
        gpu_count=integer(gpu.get("count"))
        if gpu.get("count") is not None
        else integer(pod.get("gpuCount")),
        gpu_type=(
            gpu.get("displayName")
            or machine.get("gpuDisplayName")
            or (machine.get("gpuType") or {}).get("displayName")
            or machine.get("gpuTypeId")
        ),
        hourly_cost=number(
            pod.get("adjustedCostPerHr")
            if pod.get("adjustedCostPerHr") is not None
            else pod.get("costPerHr")
        ),
        ssh_host=pod.get("publicIp") if port else None,
        ssh_port=port,
        ssh_user=user,
    )


def parse_pods(pods: list[dict[str, Any]], source: dict[str, Any]) -> list[dict[str, Any]]:
    user = source.get("username") or "root"
    observed = now()
    return [instance_record(source, pod_instance(pod, user), observed) for pod in pods]


class RunPodDriver(CloudDriver):
    name: ClassVar[str] = "runpod"
    label: ClassVar[dict[str, str]] = {"en": "RunPod", "zh-CN": "RunPod"}
    description: ClassVar[dict[str, str]] = {
        "en": "Pods, prices and SSH endpoints from the RunPod API.",
        "zh-CN": "通过 RunPod API 读取 Pod、单价和 SSH 端点。",
    }
    base_url: ClassVar[str] = "https://rest.runpod.io"
    key_env: ClassVar[str] = "RUNPOD_API_KEY"

    async def instances(self, api: Api, source: dict[str, Any]) -> list[CloudInstance]:
        pods = await api.get("/v1/pods", includeMachine="true")
        if not isinstance(pods, list):
            raise SourceError("unexpected_output", command="GET /v1/pods")
        user = source.get("username") or "root"
        return [pod_instance(pod, user) for pod in pods if isinstance(pod, dict) and pod.get("id")]
