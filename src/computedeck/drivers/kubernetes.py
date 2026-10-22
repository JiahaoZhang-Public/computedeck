"""Read-only Kubernetes collection with kubectl: GPU pods, GPU nodes, GPU quotas, failures.

One source is one namespace, read with the kubeconfig of the machine that runs kubectl:
the service machine, or an SSH host when an alias is set. Only ``kubectl get`` runs.

Field names follow the Kubernetes API reference:
https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/
https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/node-v1/
https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/resource-quota-v1/
"""

import asyncio
import json
import re
import shlex
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, ClassVar, Literal

from ..host_identity import host_address
from ..ssh_config import validate_alias
from . import ssh
from .base import (
    Batch,
    DriverCheck,
    DriverField,
    DriverInfo,
    SourceError,
    cluster_state,
    integer,
    message,
    now,
    options,
    ssh_alias_field,
    username_field,
)

# Extended resources advertised by the NVIDIA and AMD device plugins.
GPU_RESOURCES = ("nvidia.com/gpu", "amd.com/gpu")
# Node labels naming the GPU model: NVIDIA GPU Feature Discovery, and the AMD node labeller
# with its current and legacy prefix.
# https://github.com/NVIDIA/k8s-device-plugin/blob/main/docs/gpu-feature-discovery/README.md
GPU_PRODUCT_LABELS = (
    "nvidia.com/gpu.product",
    "amd.com/gpu.product-name",
    "beta.amd.com/gpu.product-name",
)
# Node pool labels of common managed Kubernetes services and of Karpenter.
POOL_LABELS = (
    "cloud.google.com/gke-nodepool",
    "eks.amazonaws.com/nodegroup",
    "kubernetes.azure.com/agentpool",
    "karpenter.sh/nodepool",
)
# Kubernetes does not record who created a pod; these conventional labels sometimes do.
OWNER_LABELS = ("owner", "user")
TERMINAL_PHASES = ("Succeeded", "Failed")
HISTORY = timedelta(hours=24)
# One kubectl run. kubectl gives up on the API server first (--request-timeout).
TIMEOUT = 25
REQUEST_TIMEOUT = "--request-timeout=20s"

# A namespace is an RFC 1123 label.
# https://kubernetes.io/docs/concepts/overview/working-with-objects/names/#dns-label-names
_NAMESPACE = re.compile(r"[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?")
# Kubeconfig context names are free text; accept the characters real names use.
_CONTEXT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@/-]{0,252}")
# ssh's own failures, as opposed to the remote command's.
_SSH_MESSAGE = re.compile(
    r"ssh:|Host key verification failed|Permission denied \(|kex_exchange_identification|"
    r"Connection (?:closed|reset|timed out)|channel \d+:|stdio forwarding failed|banner exchange"
)

# Quantity grammar: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/quantity/
_QUANTITY = re.compile(
    r"([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d{1,4})|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?"
)
_SCALE = {
    "": Decimal(1),
    "n": Decimal("1e-9"),
    "u": Decimal("1e-6"),
    "m": Decimal("1e-3"),
    "k": Decimal("1e3"),
    "M": Decimal("1e6"),
    "G": Decimal("1e9"),
    "T": Decimal("1e12"),
    "P": Decimal("1e15"),
    "E": Decimal("1e18"),
    **{f"{prefix}i": Decimal(1024) ** power for power, prefix in enumerate("KMGTPE", 1)},
}
# No quantity may exceed 2^63-1 in magnitude.
_LARGEST = Decimal(2**63 - 1)


def quantity(value: Any) -> Decimal | None:
    """A Kubernetes quantity such as ``"8"``, ``"500m"`` or ``"16Gi"``; ``None`` if unreadable."""
    if isinstance(value, bool) or not isinstance(value, int | str):
        return None
    if isinstance(value, int):
        result = Decimal(value)
    else:
        text = value.strip()
        match = _QUANTITY.fullmatch(text) if len(text) <= 64 else None
        if not match:
            return None
        sign, digits, exponent, suffix = match.groups()
        scale = Decimal(10) ** int(exponent[1:]) if exponent else _SCALE[suffix or ""]
        result = Decimal(digits) * scale * (-1 if sign == "-" else 1)
    return result if abs(result) <= _LARGEST else None


def whole(value: Decimal | None) -> int | None:
    """A non-negative whole count, such as a number of GPUs."""
    if value is None or value < 0 or value != value.to_integral_value():
        return None
    return int(value)


def cores(value: Decimal | None) -> int | float | None:
    """CPU cores; Kubernetes allows fractions such as 500m."""
    if value is None or value < 0:
        return None
    return int(value) if value == value.to_integral_value() else round(float(value), 3)


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _clean(text: str, limit: int = 200) -> str:
    text = " ".join("".join(char if char.isprintable() else " " for char in text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def elapsed(seconds: float) -> str:
    """Slurm-style [D-][H:]MM:SS, which the web app already sorts and displays."""
    minutes, secs = divmod(max(0, int(seconds)), 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days}-{hours:02d}:{minutes:02d}:{secs:02d}"
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _container_request(container: dict[str, Any], resource: str) -> Decimal | None:
    # A limit without a request is also the request; device plugins allow no overcommit.
    # https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
    resources = _dict(container.get("resources"))
    for kind in ("requests", "limits"):
        values = _dict(resources.get(kind))
        if resource in values:
            return quantity(values[resource])
    return Decimal(0)


def pod_request(spec: dict[str, Any], resource: str) -> Decimal | None:
    """Effective pod request: overhead plus the larger of all long-running containers
    (app and sidecar) and the largest init container. Schedulers and quotas use this.
    https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/#resource-sharing-within-containers
    """
    init = _list(spec.get("initContainers"))
    running = _list(spec.get("containers")) + [
        item for item in init if item.get("restartPolicy") == "Always"
    ]
    overhead = _dict(spec.get("overhead"))
    values = [_container_request(item, resource) for item in running]
    starts = [_container_request(item, resource) for item in init]
    extra = quantity(overhead[resource]) if resource in overhead else Decimal(0)
    if extra is None or any(value is None for value in [*values, *starts]):
        return None
    total = sum((value for value in values if value is not None), Decimal(0))
    largest = max((value for value in starts if value is not None), default=Decimal(0))
    return extra + max(total, largest)


def pod_gpus(spec: dict[str, Any]) -> int | None:
    """GPUs a pod requests, over all GPU vendors; ``None`` when a quantity is unreadable."""
    # MIG slices are GPU resources, but their counts are not physical GPU counts.
    containers = _list(spec.get("containers")) + _list(spec.get("initContainers"))
    if any(
        key.startswith("nvidia.com/mig-")
        for container in containers
        for values in _dict(container.get("resources")).values()
        for key in _dict(values)
    ):
        return None
    total = 0
    for resource in GPU_RESOURCES:
        count = whole(pod_request(spec, resource))
        if count is None:
            return None
        total += count
    return total


def _gpu_type(labels: dict[str, Any]) -> str | None:
    names = [labels[key] for key in GPU_PRODUCT_LABELS if _text(labels.get(key))]
    return ", ".join(dict.fromkeys(names)) or None


def _pool(labels: dict[str, Any]) -> str | None:
    return next((labels[key] for key in POOL_LABELS if _text(labels.get(key))), None)


def _conditions(status: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        item["type"]: item
        for item in _list(status.get("conditions"))
        if isinstance(item.get("type"), str)
    }


def _workload(meta: dict[str, Any], name: str) -> str:
    """The controller's name, e.g. the Job or Deployment, which is what people recognise."""
    owner = next(
        (item for item in _list(meta.get("ownerReferences")) if item.get("controller")), {}
    )
    owner_name = _text(owner.get("name"))
    if not owner_name:
        return name
    # A Deployment's ReplicaSet is named <deployment>-<pod-template-hash>.
    template = _text(_dict(meta.get("labels")).get("pod-template-hash"))
    if owner.get("kind") == "ReplicaSet" and template and owner_name.endswith(f"-{template}"):
        return owner_name[: -len(template) - 1]
    return owner_name


def _waiting_reason(status: dict[str, Any]) -> str | None:
    for item in _list(status.get("initContainerStatuses")) + _list(status.get("containerStatuses")):
        reason = _text(_dict(_dict(item.get("state")).get("waiting")).get("reason"))
        if reason:
            return reason
    return None


def pod_state(pod: dict[str, Any]) -> tuple[str, str | None]:
    """An unfinished pod's state in the scheduler words the web app uses, and why it waits.

    Phases: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-phase
    """
    meta, spec, status = (_dict(pod.get(key)) for key in ("metadata", "spec", "status"))
    phase = status.get("phase")
    if meta.get("deletionTimestamp") and phase in ("Running", "Pending"):
        # Terminating: the pod still holds its node's resources.
        return "COMPLETING", "Terminating"
    if phase == "Running":
        return "RUNNING", _waiting_reason(status)
    if phase == "Pending":
        scheduled = _conditions(status).get("PodScheduled", {})
        if not spec.get("nodeName") and scheduled.get("status") == "False":
            reason = _text(scheduled.get("reason")) or "Unschedulable"
            detail = _text(scheduled.get("message"))
            # The scheduler appends what preemption could do; keep the placement summary.
            if detail:
                reason = f"{reason}: {detail.split(' preemption:', 1)[0]}"
            return "PENDING", _clean(reason)
        return "PENDING", _waiting_reason(status)
    return "UNKNOWN", _text(status.get("reason"))


def _terminations(status: dict[str, Any]) -> list[dict[str, Any]]:
    """Current and previous terminations of every init and app container."""
    result = []
    for item in _list(status.get("initContainerStatuses")) + _list(status.get("containerStatuses")):
        for key in ("state", "lastState"):
            terminated = _dict(_dict(item.get(key)).get("terminated"))
            if terminated:
                result.append(terminated)
    return result


def _exit_code(terminated: dict[str, Any]) -> int | None:
    code = terminated.get("exitCode")
    return code if isinstance(code, int) and not isinstance(code, bool) else None


def _disruption(status: dict[str, Any]) -> str | None:
    """Why Kubernetes ended the pod, e.g. PreemptionByScheduler.
    https://kubernetes.io/docs/concepts/workloads/pods/disruptions/#pod-disruption-conditions
    """
    condition = _conditions(status).get("DisruptionTarget", {})
    return _text(condition.get("reason")) if condition.get("status") == "True" else None


def failed_state(status: dict[str, Any]) -> str:
    """A failed pod's state in the failure words the web app already shows."""
    cause = _disruption(status)
    reason = status.get("reason")
    if any(item.get("reason") == "OOMKilled" for item in _terminations(status)):
        return "OUT_OF_MEMORY"
    if reason == "DeadlineExceeded":  # spec.activeDeadlineSeconds passed
        return "TIMEOUT"
    if cause == "PreemptionByScheduler":
        return "PREEMPTED"
    if cause == "DeletionByPodGC" or reason == "NodeLost":
        return "NODE_FAIL"
    return "FAILED"


def _record(
    pod: dict[str, Any],
    source: dict[str, Any],
    labels_by_node: dict[str, dict[str, Any]],
    observed_at: str,
) -> dict[str, Any] | None:
    """Fields shared by jobs and failures, in the shape of the Slurm driver's jobs."""
    meta, spec = _dict(pod.get("metadata")), _dict(pod.get("spec"))
    name = _text(meta.get("name"))
    if not name:
        return None
    namespace = _text(meta.get("namespace")) or source["username"]
    node = _text(spec.get("nodeName"))
    node_labels = labels_by_node.get(node, {}) if node else {}
    # Before scheduling, a node selector can still name the model or pool asked for.
    selector = _dict(spec.get("nodeSelector"))
    labels = _dict(meta.get("labels"))
    return {
        "id": f"{source['cluster_id']}:{namespace}/{name}",
        "source_id": source["id"],
        "cluster_id": source["cluster_id"],
        "name": _workload(meta, name),
        "user": next((labels[key] for key in OWNER_LABELS if _text(labels.get(key))), None),
        "account": namespace,
        "partition": _pool(node_labels) or _pool(selector),
        "qos": _text(spec.get("priorityClassName")),
        "state": "UNKNOWN",
        "gpu_count": pod_gpus(spec),
        "gpu_type": _gpu_type(node_labels) or _gpu_type(selector),
        "cpu_count": cores(pod_request(spec, "cpu")),
        "node": node,
        "elapsed": "",
        "submitted_at": _text(meta.get("creationTimestamp")) or None,
        "started_at": None,
        "reason": None,
        "gpu_utilization": None,
        "cpu_utilization": None,
        "memory_utilization": None,
        "observed_at": observed_at,
    }


def parse_jobs(
    pods: list[dict[str, Any]],
    source: dict[str, Any],
    labels_by_node: dict[str, dict[str, Any]],
    at: datetime,
) -> list[dict[str, Any]]:
    """Pods that request GPUs and have not finished. Finished pods no longer hold GPUs."""
    jobs: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for pod in pods:
        status = _dict(pod.get("status"))
        if status.get("phase") in TERMINAL_PHASES or pod_gpus(_dict(pod.get("spec"))) == 0:
            continue
        job = _record(pod, source, labels_by_node, observed_at)
        if job is None:
            continue
        job["state"], job["reason"] = pod_state(pod)
        started = _time(status.get("startTime"))
        if job["state"] == "PENDING":
            job["elapsed"] = "0:00"
        elif started:
            job["started_at"] = started.isoformat()
            job["elapsed"] = elapsed((at - started).total_seconds())
        jobs[job["id"]] = job
    return list(jobs.values())


def _failure(pod: dict[str, Any]) -> dict[str, Any] | None:
    """The latest failure of a pod: the pod failed, or a container exited non-zero."""
    status = _dict(pod.get("status"))
    if status.get("phase") == "Succeeded":
        sidecars = {
            item.get("name")
            for item in _list(_dict(pod.get("spec")).get("initContainers"))
            if item.get("restartPolicy") == "Always"
        }
        # Kubernetes terminates native sidecars after the app succeeds. Their
        # resulting SIGTERM exit is not a failed workload.
        status = {
            **status,
            "initContainerStatuses": [
                item
                for item in _list(status.get("initContainerStatuses"))
                if item.get("name") not in sidecars
            ],
        }
    terminations = _terminations(status)
    ended = [(end, item) for item in terminations if (end := _time(item.get("finishedAt")))]
    nonzero = [(end, item) for end, item in ended if _exit_code(item) not in (None, 0)]
    last_end, latest = max(nonzero, key=lambda pair: pair[0], default=(None, {}))
    if status.get("phase") == "Failed":
        ends = [end for end, _ in ended]
        if not ends:
            # Evicted or deleted pods may have no terminated container; use the
            # condition that recorded the failure.
            ends = [
                end
                for item in _conditions(status).values()
                if (end := _time(item.get("lastTransitionTime")))
            ]
        if not ends:
            return None
        return {
            "state": failed_state(status),
            "end": max(ends),
            "exit_code": _exit_code(latest),
            "exit_signal": integer(latest.get("signal")),
            "reason": _text(status.get("reason"))
            or _disruption(status)
            or _text(latest.get("reason")),
            "started": _time(latest.get("startedAt") or status.get("startTime")),
        }
    if last_end is None:
        return None
    return {
        "state": "OUT_OF_MEMORY" if latest.get("reason") == "OOMKilled" else "FAILED",
        "end": last_end,
        "exit_code": _exit_code(latest),
        "exit_signal": integer(latest.get("signal")),
        "reason": _text(latest.get("reason")),
        "started": _time(latest.get("startedAt")),
    }


def parse_failures(
    pods: list[dict[str, Any]],
    source: dict[str, Any],
    labels_by_node: dict[str, dict[str, Any]],
    at: datetime,
) -> list[dict[str, Any]]:
    """GPU pods that failed within 24 hours, newest first. Deleted pods are not visible."""
    failures: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for pod in pods:
        if pod_gpus(_dict(pod.get("spec"))) == 0:
            continue
        failure = _failure(pod)
        if failure is None or failure["end"] < at - HISTORY:
            continue
        job = _record(pod, source, labels_by_node, observed_at)
        if job is None:
            continue
        started = failure["started"]
        deadline = integer(_dict(pod.get("spec")).get("activeDeadlineSeconds"))
        job.update(
            time_limit=elapsed(deadline) if deadline is not None else None,
            state=failure["state"],
            reason=failure["reason"],
            elapsed=elapsed((failure["end"] - started).total_seconds()) if started else "",
            end=failure["end"].isoformat(),
            ended_at=failure["end"].isoformat(),
            exit_status=integer(failure["exit_code"]),
            exit_signal=failure["exit_signal"],
            exit_code=None if failure["exit_code"] is None else str(failure["exit_code"]),
        )
        failures[job["id"]] = job
    return sorted(failures.values(), key=lambda job: job["end"], reverse=True)


def parse_finished(
    pods: list[dict[str, Any]],
    source: dict[str, Any],
    labels_by_node: dict[str, dict[str, Any]],
    at: datetime,
) -> list[dict[str, Any]]:
    terminal = [
        pod for pod in pods if _dict(pod.get("status")).get("phase") in {"Succeeded", "Failed"}
    ]
    rows = parse_failures(
        [pod for pod in terminal if _dict(pod.get("status")).get("phase") == "Failed"],
        source,
        labels_by_node,
        at,
    )
    for pod in terminal:
        status = _dict(pod.get("status"))
        if pod_gpus(_dict(pod.get("spec"))) == 0:
            continue
        if status.get("phase") == "Failed":
            if (
                _failure(pod) is None
                and (job := _record(pod, source, labels_by_node, now())) is not None
            ):
                job.update(state=failed_state(status), end=None, exit_code=None)
                rows.append(job)
            continue
        ends = [end for item in _terminations(status) if (end := _time(item.get("finishedAt")))]
        end = max(ends, default=None)
        if end is not None and end < at - HISTORY:
            continue
        job = _record(pod, source, labels_by_node, now())
        if job is not None:
            job.update(state="COMPLETED", end=end.isoformat() if end else None, exit_code="0")
            rows.append(job)
    return rows


def node_state(node: dict[str, Any], gpu_count: int | None, gpu_allocated: int | None) -> str:
    """Kubernetes words joined with the scheduler words the web app colours by
    (``down``, ``drain``, ``unknown``, ``idle``).

    Ready condition: https://kubernetes.io/docs/reference/node/node-status/#condition
    Cordoned nodes have ``spec.unschedulable``; SchedulingDisabled is only kubectl's wording.
    """
    ready = _conditions(_dict(node.get("status"))).get("Ready", {}).get("status")
    parts = {"True": ["ready"], "False": ["not_ready", "down"]}.get(str(ready), ["unknown"])
    if _dict(node.get("spec")).get("unschedulable") is True:
        parts += ["cordoned", "drain"]
    elif ready == "True" and gpu_count and gpu_allocated == 0:
        parts.append("idle")
    return "+".join(parts)


def parse_nodes(
    nodes: list[dict[str, Any]], pods: list[dict[str, Any]], source: dict[str, Any]
) -> list[dict[str, Any]]:
    """GPU nodes with allocatable GPUs and what pods of every namespace request on them."""
    gpus: dict[str, int | None] = {}
    cpus: dict[str, Decimal | None] = {}
    for pod in pods:
        spec = _dict(pod.get("spec"))
        name = _text(spec.get("nodeName"))
        if not name or _dict(pod.get("status")).get("phase") in TERMINAL_PHASES:
            continue
        gpu, cpu = pod_gpus(spec), pod_request(spec, "cpu")
        previous_gpu, previous_cpu = gpus.get(name, 0), cpus.get(name, Decimal(0))
        gpus[name] = None if gpu is None or previous_gpu is None else previous_gpu + gpu
        cpus[name] = None if cpu is None or previous_cpu is None else previous_cpu + cpu
    result: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for node in nodes:
        meta, status = _dict(node.get("metadata")), _dict(node.get("status"))
        name = _text(meta.get("name"))
        labels = _dict(meta.get("labels"))
        allocatable = status.get("allocatable")
        listed = {**_dict(status.get("capacity")), **_dict(allocatable)}
        mig = any(key.startswith("nvidia.com/mig-") for key in listed)
        if not name or not (
            any(key in listed for key in GPU_RESOURCES) or mig or _gpu_type(labels)
        ):
            continue
        # Allocatable lists every schedulable resource; an absent GPU resource is zero.
        counts = [whole(quantity(_dict(allocatable).get(key, 0))) for key in GPU_RESOURCES]
        capacity = (
            sum(count for count in counts if count is not None)
            if isinstance(allocatable, dict) and None not in counts and not mig
            else None
        )
        allocated = gpus.get(name, 0)
        node_id = f"{source['cluster_id']}:{name}"
        result[node_id] = {
            "id": node_id,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": name,
            "host_addresses": [
                address
                for entry in _list(status.get("addresses"))
                if entry.get("type") in ("InternalIP", "ExternalIP")
                and (address := host_address(entry.get("address")))
            ],
            "state": node_state(node, capacity, allocated),
            "gpu_count": capacity,
            "gpu_allocated": allocated,
            "gpu_type": _gpu_type(labels),
            "cpu_count": cores(quantity(_dict(allocatable).get("cpu"))),
            "cpu_allocated": cores(cpus.get(name, Decimal(0))),
            "partitions": [pool] if (pool := _pool(labels)) else [],
            "observed_at": observed_at,
        }
    return list(result.values())


def _strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def _scopes(spec: dict[str, Any]) -> str | None:
    """A quota with scopes counts only matching pods, e.g. one PriorityClass."""
    scopes = _strings(spec.get("scopes"))
    for item in _list(_dict(spec.get("scopeSelector")).get("matchExpressions")):
        parts = _strings([item.get("scopeName"), item.get("operator")])
        values = ",".join(_strings(item.get("values")))
        scopes.append(" ".join([*parts, values] if values else parts))
    return "; ".join(scope for scope in scopes if scope) or None


def parse_quotas(quotas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ResourceQuotas with a GPU entry, as QoS limits the web app reads.

    The namespace is this source's identity, so a namespace quota is the per-login limit
    the web app reads from ``MaxTRESPU``. ``UsedTRESPU`` is the quota's own usage, which
    also counts admitted pods that have not started. For extended resources such as GPUs
    only ``requests.`` entries are valid; ``limits.`` is read in case a cluster has one.
    https://kubernetes.io/docs/concepts/policy/resource-quotas/#quota-for-extended-resources
    """
    result = []
    for quota in quotas:
        meta, spec, status = (_dict(quota.get(key)) for key in ("metadata", "spec", "status"))
        name = _text(meta.get("name"))
        # status.hard is what the quota controller enforces; spec.hard what was asked for.
        hard = _dict(status.get("hard")) or _dict(spec.get("hard"))
        used = _dict(status.get("used"))
        limits: dict[str, str | None] = {}
        totals: list[int | None] = []
        usage: list[int | None] = []
        for resource in GPU_RESOURCES:
            keys = [key for key in (f"requests.{resource}", f"limits.{resource}") if key in hard]
            if not keys:
                continue
            limits.update({key: str(hard[key]) for key in keys})
            values = [
                (value, key) for key in keys if (value := whole(quantity(hard[key]))) is not None
            ]
            if len(values) < len(keys):
                totals.append(None)
                usage.append(None)
                continue
            # Every entry applies; the smallest one binds.
            value, key = min(values)
            totals.append(value)
            usage.append(whole(quantity(used[key])) if key in used else None)
        if not name or not totals:
            continue
        limit = None if None in totals else sum(value or 0 for value in totals)
        in_use = None if None in usage else sum(value or 0 for value in usage)
        result.append(
            {
                "name": name,
                "limits": {
                    "MaxTRESPU": None if limit is None else f"gres/gpu={limit}",
                    "UsedTRESPU": None if in_use is None else f"gres/gpu={in_use}",
                    **limits,
                    **({"Scopes": scopes} if (scopes := _scopes(spec)) else {}),
                },
                "origin": "kubernetes_resource_quota",
            }
        )
    return result


def _items(output: str, command: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(output)
    except ValueError:
        raise SourceError("unexpected_output", command=command) from None
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise SourceError("unexpected_output", command=command)
    return _list(data["items"])


class KubectlError(Exception):
    """kubectl exited non-zero. The message is its untranslated stderr; never shown."""


async def _local(args: list[str]) -> str:
    """Run kubectl on the service machine without a shell."""
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise SourceError("kubectl_not_found") from None
    except OSError:
        raise SourceError("kubectl_failed") from None
    try:
        async with asyncio.timeout(TIMEOUT):
            stdout, stderr = await process.communicate()
    except (TimeoutError, asyncio.CancelledError) as error:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        if isinstance(error, TimeoutError):
            raise SourceError("kubectl_timeout") from None
        raise
    if process.returncode:
        raise KubectlError(stderr.decode("utf-8", errors="replace"))
    return stdout.decode("utf-8", errors="replace")


def kubectl_error(text: str, resource: str) -> SourceError:
    """A translatable code for kubectl's stderr. Server responses are never passed on."""
    lower = text.lower()
    if "forbidden" in lower:
        return SourceError("kubectl_forbidden", resource=resource)
    if "unauthorized" in lower or "must be logged in" in lower:
        return SourceError("kubectl_unauthorized")
    if "context" in lower and ("does not exist" in lower or "not found" in lower):
        return SourceError("kube_context_not_found")
    if "command not found" in lower or "kubectl: not found" in lower:
        return SourceError("kubectl_not_found")
    if "unable to connect to the server" in lower or "connection to the server" in lower:
        return SourceError("kubectl_unreachable")
    return SourceError("kubectl_failed")


def _remote_error(text: str, resource: str) -> SourceError:
    error = kubectl_error(text, resource)
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if error.code == "kubectl_failed" and _SSH_MESSAGE.match(first):
        # ssh's own message, like the Slurm driver reports; never the remote command's.
        return SourceError("ssh_failed", _clean(first, 160))
    return error


async def kubectl(source: dict[str, Any], args: list[str], resource: str) -> str:
    """One read-only ``kubectl get``, locally or through the source's SSH alias."""
    context = options(source).get("context")
    command = [
        "kubectl",
        *([f"--context={context}"] if context else []),
        *args,
        "-o",
        "json",
        REQUEST_TIMEOUT,
    ]
    alias = source.get("ssh_alias")
    if alias:
        try:
            return await ssh.run(validate_alias(alias), shlex.join(command))
        except ssh.SSHError as error:
            raise _remote_error(str(error), resource) from None
        except TimeoutError:
            raise SourceError("ssh_timeout") from None
    try:
        return await _local(command)
    except KubectlError as error:
        raise kubectl_error(str(error), resource) from None


_DETAILS = {
    "kubectl_unauthorized": "credentials rejected",
    "kubectl_unreachable": "API server unreachable",
    "kube_context_not_found": "kube context not found",
    "kubectl_not_found": "kubectl not found",
    "kubectl_timeout": "kubectl timed out",
    "ssh_timeout": "SSH timed out",
    "ssh_failed": "SSH failed",
    "unexpected_output": "unexpected output",
}


def _warning(code: str, error: SourceError) -> dict[str, Any]:
    if error.code == "kubectl_forbidden":
        detail = f"listing {error.params.get('resource')} is forbidden"
    else:
        detail = error.detail or _DETAILS.get(error.code, "kubectl failed")
    return message(code, detail=detail)


class KubernetesDriver:
    name: ClassVar[str] = "kubernetes"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "Kubernetes", "zh-CN": "Kubernetes"},
        description={
            "en": "GPU pods, GPU nodes and GPU quotas of one namespace, read with kubectl.",
            "zh-CN": "通过 kubectl 读取一个命名空间的 GPU Pod、GPU 节点和 GPU 配额。",
        },
        details={
            "en": "Read-only kubectl get … -o json with the kubeconfig on {where}, or on an "
            "SSH host when an alias is set. Needs list access to pods and resourcequotas in "
            "the namespace; listing nodes and pods in all namespaces is optional.",
            "zh-CN": "使用{where}上的 kubeconfig（填写 SSH 别名时为该主机上的）只读执行 "
            "kubectl get … -o json。需要该命名空间内 pods 和 resourcequotas 的 list 权限；"
            "列出 nodes 和全部命名空间的 pods 是可选的。",
        },
        fields=[
            username_field(
                label={"en": "Namespace", "zh-CN": "命名空间"},
                placeholder="ml-team",
                hint={
                    "en": "The Kubernetes namespace to read. Two namespaces of one cluster "
                    "are two sources.",
                    "zh-CN": "要读取的 Kubernetes 命名空间。同一集群的两个命名空间是两个数据源。",
                },
                pattern="[a-z0-9]([a-z0-9\\-]*[a-z0-9])?",
            ),
            ssh_alias_field(
                required=False,
                hint={
                    "en": "Optional. A Host in ~/.ssh/config on {where} that has kubectl and "
                    "a kubeconfig. Leave empty to run kubectl on {where}.",
                    "zh-CN": "可选。{where} ~/.ssh/config 里的 Host，该主机需有 kubectl 和 "
                    "kubeconfig。留空则在{where}上运行 kubectl。",
                },
            ),
            DriverField(
                key="context",
                label={"en": "Kube context", "zh-CN": "Kube 上下文"},
                hint={
                    "en": "Optional. A context of that kubeconfig; empty uses its current context.",
                    "zh-CN": "可选。该 kubeconfig 中的上下文；留空使用当前上下文。",
                },
                placeholder="cluster-a",
                pattern="[A-Za-z0-9][A-Za-z0-9._:@\\/\\-]*",
            ),
        ],
        checks=[
            DriverCheck(
                capability="jobs",
                command="get pods",
                label={"en": "GPU pods (get pods)", "zh-CN": "GPU Pod（get pods）"},
            ),
            DriverCheck(
                capability="nodes",
                command="get nodes",
                label={
                    "en": "GPU nodes (get nodes, get pods -A)",
                    "zh-CN": "GPU 节点（get nodes、get pods -A）",
                },
                warning="nodes_unavailable",
            ),
            DriverCheck(
                capability="qos_limits",
                command="resourcequota",
                label={
                    "en": "GPU quotas (get resourcequota)",
                    "zh-CN": "GPU 配额（get resourcequota）",
                },
                warning="qos_unavailable",
            ),
            DriverCheck(
                capability="history",
                command="failed pods",
                label={"en": "Failed pods in the last 24 h", "zh-CN": "24 小时内失败的 Pod"},
                warning="history_unavailable",
            ),
        ],
        name_placeholder="Cluster A",
        beta=True,
    )

    def validate(self, source: dict[str, Any]) -> None:
        namespace = source.get("username") or ""
        if not namespace:
            raise SourceError("namespace_required")
        if not isinstance(namespace, str) or not _NAMESPACE.fullmatch(namespace):
            raise SourceError("invalid_namespace", namespace=str(namespace)[:80])
        alias = source.get("ssh_alias") or ""
        if alias:
            try:
                validate_alias(alias)
            except (ValueError, TypeError):
                raise SourceError("invalid_ssh_alias") from None
        context = options(source).get("context") or ""
        if context and (not isinstance(context, str) or not _CONTEXT.fullmatch(context)):
            raise SourceError("invalid_kube_context", context=str(context)[:80])

    async def collect(self, source: dict[str, Any]) -> Batch:
        self.validate(source)
        namespace = source["username"]
        pods = _items(
            await kubectl(source, ["get", "pods", f"--namespace={namespace}"], "pods"),
            "kubectl get pods",
        )
        batch = Batch(capabilities=["jobs"])
        labels_by_node: dict[str, dict[str, Any]] = {}
        try:
            nodes = _items(await kubectl(source, ["get", "nodes"], "nodes"), "kubectl get nodes")
            labels_by_node = {
                name: _dict(_dict(node.get("metadata")).get("labels"))
                for node in nodes
                if (name := _text(_dict(node.get("metadata")).get("name")))
            }
            # Allocation needs every namespace's pods; a namespaced login usually cannot
            # list them, and then node allocation is unknown, never zero.
            running = await kubectl(
                source,
                [
                    "get",
                    "pods",
                    "--all-namespaces",
                    # https://kubernetes.io/docs/concepts/overview/working-with-objects/field-selectors/
                    "--field-selector=status.phase!=Succeeded,status.phase!=Failed",
                ],
                "pods (all namespaces)",
            )
            batch.nodes = parse_nodes(
                nodes, _items(running, "kubectl get pods --all-namespaces"), source
            )
            batch.capabilities.append("nodes")
        except SourceError as error:
            batch.warnings.append(_warning("nodes_unavailable", error))
        at = datetime.now(UTC)
        batch.jobs = parse_jobs(pods, source, labels_by_node, at)
        try:
            quotas = await kubectl(
                source, ["get", "resourcequotas", f"--namespace={namespace}"], "resourcequotas"
            )
            batch.qos = parse_quotas(_items(quotas, "kubectl get resourcequotas"))
            batch.capabilities.append("qos_limits")
        except SourceError as error:
            batch.warnings.append(_warning("qos_unavailable", error))
        batch.failures = parse_failures(pods, source, labels_by_node, at)
        batch.finished = parse_finished(pods, source, labels_by_node, at)
        batch.capabilities.append("history")
        batch.cluster_state = cluster_state(batch.nodes)
        for entry in batch.qos or []:
            entry["access"] = "unknown"
        return batch
