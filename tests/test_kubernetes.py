"""Kubernetes driver: kubectl JSON parsing and read-only collection, locally or over SSH.

All objects are hand-written from the Kubernetes API reference and use fictional data.
"""

import json
import re
import shlex
import stat
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from computedeck import events
from computedeck.drivers import kubernetes, ssh
from computedeck.drivers.base import Batch, SourceError
from computedeck.store import Store
from computedeck.tools import notify

AT = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)
SOURCE: dict[str, Any] = {
    "id": "cluster-a-ml-team",
    "name": "Cluster A",
    "driver": "kubernetes",
    "cluster_id": "cluster-a",
    "username": "ml-team",
    "ssh_alias": "",
    "credential": "",
    "options": {},
}
A100 = "NVIDIA-A100-SXM4-80GB"
H100 = "NVIDIA-H100-80GB-HBM3"
POOL = "cloud.google.com/gke-nodepool"


def ago(**delta: float) -> str:
    return (AT - timedelta(**delta)).isoformat().replace("+00:00", "Z")


def merge(base: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge(result[key], value)
        else:
            result[key] = value
    return result


def container(gpus: str | None = "4", cpu: str | None = "8", **changes: Any) -> dict[str, Any]:
    requests = {key: value for key, value in (("cpu", cpu), ("nvidia.com/gpu", gpus)) if value}
    limits = {"nvidia.com/gpu": gpus} if gpus else {}
    return {"name": "train", "resources": {"requests": requests, "limits": limits}, **changes}


def pod(name: str = "train-a-x7k2p", **changes: Any) -> dict[str, Any]:
    """A running pod of the Job train-a that asks for four GPUs."""
    base = {
        "metadata": {
            "name": name,
            "namespace": "ml-team",
            "labels": {"owner": "alice", "job-name": "train-a"},
            "ownerReferences": [
                {"apiVersion": "batch/v1", "kind": "Job", "name": "train-a", "controller": True}
            ],
        },
        "spec": {
            "nodeName": "gpu-node-01",
            "priorityClassName": "high",
            "containers": [container()],
        },
        "status": {
            "phase": "Running",
            "startTime": ago(hours=1, minutes=30),
            "conditions": [{"type": "PodScheduled", "status": "True"}],
            "containerStatuses": [
                {"name": "train", "state": {"running": {"startedAt": ago(hours=1)}}}
            ],
        },
    }
    return merge(base, changes)


def node(
    name: str,
    gpus: str | None = "8",
    ready: str | None = "True",
    product: str | None = A100,
    **changes: Any,
) -> dict[str, Any]:
    labels = {"kubernetes.io/hostname": name, POOL: "gpu-pool"}
    if product:
        labels["nvidia.com/gpu.product"] = product
    allocatable = {"cpu": "95500m", "memory": "1000Gi", "pods": "110"}
    if gpus is not None:
        allocatable["nvidia.com/gpu"] = gpus
    conditions = [{"type": "Ready", "status": ready}] if ready else []
    base = {
        "metadata": {"name": name, "labels": labels},
        "spec": {},
        "status": {"allocatable": allocatable, "capacity": allocatable, "conditions": conditions},
    }
    return merge(base, changes)


def listing(*items: dict[str, Any]) -> str:
    return json.dumps({"apiVersion": "v1", "kind": "List", "items": list(items)})


# ---------------------------------------------------------------- quantities and requests


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("8", Decimal(8)),
        (4, Decimal(4)),
        ("500m", Decimal("0.5")),
        ("1.5", Decimal("1.5")),
        (".5", Decimal("0.5")),
        ("1.", Decimal(1)),
        ("2k", Decimal(2000)),
        ("16Gi", Decimal(16 * 2**30)),
        ("1e3", Decimal(1000)),
        ("-1", Decimal(-1)),
        ("", None),
        ("eight", None),
        ("8 GPUs", None),
        ("1Zi", None),
        ("1e9999", None),
        ("9" * 70, None),
        (True, None),
        (None, None),
        (1.5, None),
    ],
)
def test_quantities_follow_the_kubernetes_grammar(value: Any, expected: Decimal | None) -> None:
    assert kubernetes.quantity(value) == expected


def test_whole_counts_and_cores_never_invent_values() -> None:
    assert kubernetes.whole(Decimal(4)) == 4
    assert kubernetes.whole(Decimal("0.5")) is None
    assert kubernetes.whole(Decimal(-1)) is None
    assert kubernetes.whole(None) is None
    assert kubernetes.cores(Decimal("7.5")) == 7.5
    assert isinstance(kubernetes.cores(Decimal(8)), int)
    assert kubernetes.cores(None) is None


@pytest.mark.parametrize(
    ("seconds", "text"),
    [(-5, "0:00"), (59, "0:59"), (3600, "1:00:00"), (5400, "1:30:00"), (90061, "1-01:01:01")],
)
def test_elapsed_uses_the_format_the_web_app_parses(seconds: int, text: str) -> None:
    assert kubernetes.elapsed(seconds) == text
    # web/src/domain.ts elapsedSeconds
    assert re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", text)


def test_effective_request_follows_init_and_sidecar_rules() -> None:
    spec = {
        "containers": [container(gpus="2", cpu="4"), container(gpus=None, cpu="500m")],
        "initContainers": [
            container(gpus=None, cpu="8", name="download"),
            container(gpus=None, cpu="1", name="log-agent", restartPolicy="Always"),
        ],
        "overhead": {"cpu": "250m"},
    }
    # max(4 + 0.5 + 1 for app and sidecar containers, 8 for the largest init) + overhead.
    assert kubernetes.pod_request(spec, "cpu") == Decimal("8.25")
    assert kubernetes.pod_gpus(spec) == 2
    limits_only = {"containers": [{"name": "a", "resources": {"limits": {"amd.com/gpu": "2"}}}]}
    assert kubernetes.pod_gpus(limits_only) == 2
    both = {"containers": [container(gpus="1"), limits_only["containers"][0]]}
    assert kubernetes.pod_gpus(both) == 3
    assert kubernetes.pod_gpus({"containers": [container(gpus=None)]}) == 0
    assert kubernetes.pod_gpus({"containers": [container(gpus="two")]}) is None
    assert kubernetes.pod_gpus({"containers": [container(gpus="500m")]}) is None
    assert kubernetes.pod_request({"containers": [container(cpu="lots")]}, "cpu") is None


# ---------------------------------------------------------------- jobs


def test_jobs_map_gpu_pods_to_the_job_shape() -> None:
    labels = {"gpu-node-01": node("gpu-node-01")["metadata"]["labels"]}
    running = pod(spec={"containers": [container(cpu="7500m")]})
    jobs = kubernetes.parse_jobs([running, running], SOURCE, labels, AT)
    assert len(jobs) == 1
    job = jobs[0]
    assert job == {
        "id": "cluster-a:ml-team/train-a-x7k2p",
        "source_id": "cluster-a-ml-team",
        "cluster_id": "cluster-a",
        "name": "train-a",
        "user": "alice",
        "account": "ml-team",
        "partition": "gpu-pool",
        "qos": "high",
        "state": "RUNNING",
        "gpu_count": 4,
        "gpu_type": A100,
        "cpu_count": 7.5,
        "node": "gpu-node-01",
        "elapsed": "1:30:00",
        "reason": None,
        "gpu_utilization": None,
        "cpu_utilization": None,
        "memory_utilization": None,
        "submitted_at": None,
        "started_at": "2026-01-05T10:30:00+00:00",
        "observed_at": job["observed_at"],
    }
    assert job["observed_at"]


def test_pending_pods_explain_why_they_wait() -> None:
    unschedulable = pod(
        "train-b-0",
        metadata={"labels": {"owner": None}, "ownerReferences": []},
        spec={
            "nodeName": None,
            "priorityClassName": None,
            "nodeSelector": {"nvidia.com/gpu.product": H100, POOL: "h100-pool"},
        },
        status={
            "phase": "Pending",
            "startTime": None,
            "containerStatuses": [],
            "conditions": [
                {
                    "type": "PodScheduled",
                    "status": "False",
                    "reason": "Unschedulable",
                    "message": "0/4 nodes are available: 4 Insufficient nvidia.com/gpu. "
                    "preemption: 0/4 nodes are available: 4 No preemption victims found.",
                }
            ],
        },
    )
    pulling = pod(
        "train-c-0",
        spec={"nodeName": "gpu-node-02"},
        status={
            "phase": "Pending",
            "containerStatuses": [
                {"name": "train", "state": {"waiting": {"reason": "ImagePullBackOff"}}}
            ],
        },
    )
    new = pod("train-d-0", spec={"nodeName": None}, status={"phase": "Pending", "conditions": []})
    jobs = {
        job["id"]: job
        for job in kubernetes.parse_jobs([unschedulable, pulling, new], SOURCE, {}, AT)
    }
    waiting = jobs["cluster-a:ml-team/train-b-0"]
    assert waiting["state"] == "PENDING"
    assert (
        waiting["reason"]
        == "Unschedulable: 0/4 nodes are available: 4 Insufficient nvidia.com/gpu."
    )
    assert waiting["node"] is None
    assert waiting["elapsed"] == "0:00"
    # Before scheduling, the node selector names the model and pool asked for.
    assert waiting["gpu_type"] == H100
    assert waiting["partition"] == "h100-pool"
    assert waiting["name"] == "train-b-0"
    assert waiting["user"] is None
    assert waiting["qos"] is None
    bound = jobs["cluster-a:ml-team/train-c-0"]
    assert (bound["state"], bound["reason"], bound["node"]) == (
        "PENDING",
        "ImagePullBackOff",
        "gpu-node-02",
    )
    # No node labels were collected: the model is unknown, not guessed.
    assert bound["gpu_type"] is None
    assert jobs["cluster-a:ml-team/train-d-0"]["reason"] is None


def test_only_unfinished_gpu_pods_are_jobs() -> None:
    pods = [
        pod("cpu-only", spec={"containers": [container(gpus=None)]}),
        pod("done", status={"phase": "Succeeded"}),
        pod("failed", status={"phase": "Failed"}),
        pod("stopping", metadata={"deletionTimestamp": ago(minutes=1)}),
        pod("unreadable", spec={"containers": [container(gpus="many")]}),
        pod("lost", status={"phase": "Unknown", "reason": "NodeLost"}),
        pod(
            "crashing",
            status={
                "containerStatuses": [
                    {"name": "train", "state": {"waiting": {"reason": "CrashLoopBackOff"}}}
                ]
            },
        ),
    ]
    jobs = {job["id"].split("/")[-1]: job for job in kubernetes.parse_jobs(pods, SOURCE, {}, AT)}
    assert set(jobs) == {"stopping", "unreadable", "lost", "crashing"}
    # A terminating pod still holds its GPUs, like a completing Slurm job.
    assert (jobs["stopping"]["state"], jobs["stopping"]["reason"]) == ("COMPLETING", "Terminating")
    # An unreadable GPU request is unknown, never zero.
    assert jobs["unreadable"]["gpu_count"] is None
    assert (jobs["lost"]["state"], jobs["lost"]["reason"]) == ("UNKNOWN", "NodeLost")
    assert (jobs["crashing"]["state"], jobs["crashing"]["reason"]) == (
        "RUNNING",
        "CrashLoopBackOff",
    )


def test_job_name_is_the_controller() -> None:
    deployment = pod(
        "notebook-7d9f8c6b5-q2w3e",
        metadata={
            "labels": {"pod-template-hash": "7d9f8c6b5"},
            "ownerReferences": [
                {"kind": "ReplicaSet", "name": "notebook-7d9f8c6b5", "controller": True}
            ],
        },
    )
    bare = pod("debug", metadata={"ownerReferences": []})
    names = [job["name"] for job in kubernetes.parse_jobs([deployment, bare], SOURCE, {}, AT)]
    assert names == ["notebook", "debug"]


# ---------------------------------------------------------------- nodes


def test_nodes_report_allocatable_and_allocation_from_every_namespace() -> None:
    nodes = [
        node("gpu-node-01"),
        node("gpu-node-02", gpus="4"),
        node("gpu-node-03", spec={"unschedulable": True}),
        node("gpu-node-04", ready="False"),
        node("gpu-node-05", ready=None),
        node("cpu-node-01", gpus=None, product=None),
        # The device plugin is not running: the node advertises no GPUs.
        node("gpu-node-06", gpus=None),
        node("gpu-node-07", gpus="lots"),
    ]
    pods = [
        pod("a", spec={"containers": [container(gpus="4", cpu="8")]}),
        pod(
            "b",
            metadata={"namespace": "vision"},
            spec={"containers": [container(gpus="2", cpu="4")]},
        ),
        pod(
            "cpu",
            metadata={"namespace": "web"},
            spec={"containers": [container(gpus=None, cpu="1")]},
        ),
        pod("done", status={"phase": "Succeeded"}),
        pod("queued", spec={"nodeName": None}, status={"phase": "Pending"}),
        pod("unreadable", spec={"nodeName": "gpu-node-03", "containers": [container(gpus="x")]}),
    ]
    result = {item["name"]: item for item in kubernetes.parse_nodes(nodes, pods, SOURCE)}
    assert "cpu-node-01" not in result
    first = result["gpu-node-01"]
    assert first == {
        "id": "cluster-a:gpu-node-01",
        "source_id": "cluster-a-ml-team",
        "cluster_id": "cluster-a",
        "name": "gpu-node-01",
        "state": "ready",
        "gpu_count": 8,
        "gpu_allocated": 6,
        "gpu_type": A100,
        "cpu_count": 95.5,
        "cpu_allocated": 13,
        "partitions": ["gpu-pool"],
        "observed_at": first["observed_at"],
    }
    assert (result["gpu-node-02"]["gpu_allocated"], result["gpu-node-02"]["state"]) == (
        0,
        "ready+idle",
    )
    # One unreadable request makes the node's allocation unknown, not a smaller number.
    assert result["gpu-node-03"]["gpu_allocated"] is None
    assert result["gpu-node-03"]["state"] == "ready+cordoned+drain"
    assert result["gpu-node-04"]["state"] == "not_ready+down"
    assert result["gpu-node-05"]["state"] == "unknown"
    assert result["gpu-node-06"]["gpu_count"] == 0
    assert result["gpu-node-07"]["gpu_count"] is None


@pytest.mark.parametrize(
    ("state", "tone"),
    [
        ("ready", "gray"),
        ("ready+idle", "green"),
        ("ready+cordoned+drain", "red"),
        ("not_ready+down", "red"),
        ("not_ready+down+cordoned+drain", "red"),
        ("unknown", "red"),
    ],
)
def test_node_states_are_coloured_by_the_web_app(state: str, tone: str) -> None:
    # web/src/labels.ts nodeTone
    if re.search(r"down|drain|fail|maint|not_resp|unknown|invalid|\*", state, re.IGNORECASE):
        actual = "red"
    elif re.search(r"idle", state, re.IGNORECASE):
        actual = "green"
    else:
        actual = "gray"
    assert actual == tone


# ---------------------------------------------------------------- quotas


def quota(
    name: str, hard: dict[str, str], used: dict[str, str] | None = None, **spec: Any
) -> dict[str, Any]:
    status = {"hard": hard, **({"used": used} if used is not None else {})}
    return {"metadata": {"name": name}, "spec": {"hard": hard, **spec}, "status": status}


def test_gpu_quotas_become_limits_the_web_app_reads() -> None:
    quotas = [
        quota(
            "gpu-quota",
            {"requests.nvidia.com/gpu": "8", "requests.cpu": "64"},
            {"requests.nvidia.com/gpu": "3", "requests.cpu": "20"},
        ),
        quota("cpu-only", {"requests.cpu": "64"}, {"requests.cpu": "1"}),
        {
            "metadata": {"name": "high-priority"},
            "spec": {
                "hard": {"requests.nvidia.com/gpu": "4", "limits.nvidia.com/gpu": "2"},
                "scopeSelector": {
                    "matchExpressions": [
                        {"scopeName": "PriorityClass", "operator": "In", "values": ["high"]}
                    ]
                },
            },
        },
        quota("mixed", {"requests.nvidia.com/gpu": "4", "requests.amd.com/gpu": "2"}, {}),
        quota("unreadable", {"requests.nvidia.com/gpu": "many"}),
    ]
    result = {item["name"]: item for item in kubernetes.parse_quotas(quotas)}
    assert list(result) == ["gpu-quota", "high-priority", "mixed", "unreadable"]
    assert result["gpu-quota"] == {
        "name": "gpu-quota",
        "limits": {
            "MaxTRESPU": "gres/gpu=8",
            "UsedTRESPU": "gres/gpu=3",
            "requests.nvidia.com/gpu": "8",
        },
        "origin": "kubernetes_resource_quota",
    }
    # web/src/domain.ts qosGpuLimit
    match = re.search(
        r"(?:^|,)gres/gpu(?::[^=,]+)?=(\d+)", result["gpu-quota"]["limits"]["MaxTRESPU"]
    )
    assert match and match.group(1) == "8"
    scoped = result["high-priority"]["limits"]
    # Every entry applies, so the smaller one binds; usage was never observed.
    assert scoped["MaxTRESPU"] == "gres/gpu=2"
    assert scoped["UsedTRESPU"] is None
    assert scoped["Scopes"] == "PriorityClass In high"
    assert result["mixed"]["limits"]["MaxTRESPU"] == "gres/gpu=6"
    assert result["mixed"]["limits"]["UsedTRESPU"] is None
    assert result["unreadable"]["limits"]["MaxTRESPU"] is None
    assert result["unreadable"]["limits"]["requests.nvidia.com/gpu"] == "many"


# ---------------------------------------------------------------- failures


def terminated(exit_code: int, reason: str, started: str, finished: str) -> dict[str, Any]:
    return {
        "terminated": {
            "exitCode": exit_code,
            "reason": reason,
            "startedAt": started,
            "finishedAt": finished,
            # Termination messages can hold application output; they are never read.
            "message": "secret application output",
        }
    }


def test_failures_cover_failed_pods_and_non_zero_exits_in_24_hours() -> None:
    pods = [
        pod(
            "oom",
            status={
                "phase": "Failed",
                "containerStatuses": [
                    {
                        "name": "train",
                        "state": terminated(137, "OOMKilled", ago(hours=3), ago(hours=2)),
                    }
                ],
            },
        ),
        pod(
            "restarted",
            status={
                "containerStatuses": [
                    {
                        "name": "train",
                        "state": {"running": {"startedAt": ago(minutes=29)}},
                        "lastState": terminated(1, "Error", ago(hours=1), ago(minutes=30)),
                    }
                ]
            },
        ),
        pod(
            "old",
            status={
                "phase": "Failed",
                "containerStatuses": [
                    {"name": "train", "state": terminated(1, "Error", ago(hours=31), ago(hours=30))}
                ],
            },
        ),
        pod(
            "done",
            status={
                "phase": "Succeeded",
                "containerStatuses": [
                    {
                        "name": "train",
                        "state": terminated(0, "Completed", ago(hours=2), ago(hours=1)),
                    }
                ],
            },
        ),
        pod(
            "evicted",
            status={
                "phase": "Failed",
                "reason": "Evicted",
                "containerStatuses": [],
                "conditions": [
                    {"type": "Ready", "status": "False", "lastTransitionTime": ago(hours=5)}
                ],
            },
        ),
        pod(
            "deadline",
            status={
                "phase": "Failed",
                "reason": "DeadlineExceeded",
                "containerStatuses": [
                    {"name": "train", "state": terminated(137, "Error", ago(hours=8), ago(hours=6))}
                ],
            },
        ),
        pod(
            "preempted",
            status={
                "phase": "Failed",
                "conditions": [
                    {
                        "type": "DisruptionTarget",
                        "status": "True",
                        "reason": "PreemptionByScheduler",
                    }
                ],
                "containerStatuses": [
                    {"name": "train", "state": terminated(143, "Error", ago(hours=9), ago(hours=7))}
                ],
            },
        ),
        pod(
            "cpu-only",
            spec={"containers": [container(gpus=None)]},
            status={
                "phase": "Failed",
                "containerStatuses": [
                    {"name": "train", "state": terminated(1, "Error", ago(hours=2), ago(hours=1))}
                ],
            },
        ),
        pod("timeless", status={"phase": "Failed", "conditions": [], "containerStatuses": []}),
    ]
    failures = kubernetes.parse_failures(pods, SOURCE, {}, AT)
    assert [row["id"].split("/")[-1] for row in failures] == [
        "restarted",
        "oom",
        "evicted",
        "deadline",
        "preempted",
    ]
    rows = {row["id"].split("/")[-1]: row for row in failures}
    oom = rows["oom"]
    assert (oom["state"], oom["exit_code"], oom["reason"]) == ("OUT_OF_MEMORY", "137", "OOMKilled")
    assert oom["end"] == (AT - timedelta(hours=2)).isoformat()
    assert oom["elapsed"] == "1:00:00"
    assert oom["gpu_count"] == 4
    assert oom["account"] == "ml-team"
    assert oom["user"] == "alice"
    assert oom["source_id"] == "cluster-a-ml-team"
    assert oom["gpu_utilization"] is None
    restarted = rows["restarted"]
    assert (restarted["state"], restarted["exit_code"], restarted["reason"]) == (
        "FAILED",
        "1",
        "Error",
    )
    evicted = rows["evicted"]
    assert (evicted["state"], evicted["exit_code"], evicted["reason"]) == (
        "FAILED",
        None,
        "Evicted",
    )
    assert evicted["end"] == (AT - timedelta(hours=5)).isoformat()
    assert rows["deadline"]["state"] == "TIMEOUT"
    assert (rows["preempted"]["state"], rows["preempted"]["reason"]) == (
        "PREEMPTED",
        "PreemptionByScheduler",
    )
    assert "secret application output" not in json.dumps(failures)


# ---------------------------------------------------------------- collection

FORBIDDEN = (
    'Error from server (Forbidden): {0} is forbidden: User "alice" cannot list resource '
    '"{0}" in API group "" at the cluster scope'
)


def kind(args: list[str]) -> str:
    if "nodes" in args:
        return "nodes"
    if "resourcequotas" in args:
        return "quotas"
    return "all-pods" if "--all-namespaces" in args else "pods"


def cluster() -> dict[str, str]:
    """What kubectl returns for each query; collection uses the real clock."""
    failed_at = datetime.now(UTC) - timedelta(hours=1)
    failed = pod(
        "failed-a",
        status={
            "phase": "Failed",
            "containerStatuses": [
                {
                    "name": "train",
                    "state": terminated(
                        1,
                        "Error",
                        (failed_at - timedelta(hours=1)).isoformat(),
                        failed_at.isoformat(),
                    ),
                }
            ],
        },
    )
    return {
        "pods": listing(pod(), failed),
        "nodes": listing(node("gpu-node-01"), node("cpu-node-01", gpus=None, product=None)),
        "all-pods": listing(pod(), pod("b", metadata={"namespace": "vision"})),
        "quotas": listing(
            quota("gpu-quota", {"requests.nvidia.com/gpu": "8"}, {"requests.nvidia.com/gpu": "4"})
        ),
    }


def fake_kubectl(
    calls: list[list[str]], responses: dict[str, str | Exception] | None = None
) -> Callable[[list[str]], Any]:
    async def run(args: list[str]) -> str:
        calls.append(args)
        response = {**cluster(), **(responses or {})}[kind(args)]
        if isinstance(response, Exception):
            raise response
        return response

    return run


async def test_collect_reads_jobs_nodes_quotas_and_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl(calls))
    source = {**SOURCE, "options": {"context": "alice@cluster-a"}}
    batch = await kubernetes.KubernetesDriver().collect(source)
    assert batch.capabilities == ["jobs", "nodes", "qos_limits", "history"]
    assert batch.warnings == []
    assert batch.jobs is not None and [job["id"] for job in batch.jobs] == [
        "cluster-a:ml-team/train-a-x7k2p"
    ]
    # Node labels give the running pod its model and pool.
    assert batch.jobs[0]["gpu_type"] == A100
    assert batch.jobs[0]["partition"] == "gpu-pool"
    assert batch.nodes is not None and [n["name"] for n in batch.nodes] == ["gpu-node-01"]
    assert batch.nodes[0]["gpu_allocated"] == 8
    assert batch.qos is not None and batch.qos[0]["limits"]["UsedTRESPU"] == "gres/gpu=4"
    assert batch.failures is not None and [row["id"] for row in batch.failures] == [
        "cluster-a:ml-team/failed-a"
    ]
    assert set(batch.snapshot()) == {"jobs", "nodes", "failures"}
    assert [kind(args) for args in calls] == ["pods", "nodes", "all-pods", "quotas"]
    for args in calls:
        assert args[:3] == ["kubectl", "--context=alice@cluster-a", "get"]
        assert args[-3:] == ["-o", "json", "--request-timeout=20s"]
    assert "--namespace=ml-team" in calls[0] and "--namespace=ml-team" in calls[3]
    assert "--field-selector=status.phase!=Succeeded,status.phase!=Failed" in calls[2]
    # Collection is read-only.
    verbs = {args[2] for args in calls}
    assert verbs == {"get"}


async def test_without_context_kubectl_uses_the_current_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl(calls))
    await kubernetes.KubernetesDriver().collect(SOURCE)
    assert all(args[:2] == ["kubectl", "get"] for args in calls)
    assert not any(arg.startswith("--context") for args in calls for arg in args)


@pytest.mark.parametrize(
    ("forbidden", "resource"), [("nodes", "nodes"), ("all-pods", "pods (all namespaces)")]
)
async def test_namespaced_login_keeps_jobs_without_node_data(
    monkeypatch: pytest.MonkeyPatch, forbidden: str, resource: str
) -> None:
    calls: list[list[str]] = []
    failure = kubernetes.KubectlError(FORBIDDEN.format("nodes" if forbidden == "nodes" else "pods"))
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl(calls, {forbidden: failure}))
    batch = await kubernetes.KubernetesDriver().collect(SOURCE)
    # Forbidden is "not collected", never "no nodes" or "nothing allocated".
    assert batch.nodes is None
    assert "nodes" not in batch.capabilities
    assert set(batch.snapshot()) == {"jobs", "failures"}
    assert batch.warnings == [
        {"code": "nodes_unavailable", "detail": f"listing {resource} is forbidden"}
    ]
    assert batch.jobs is not None and batch.jobs[0]["gpu_count"] == 4
    # Node labels still name the model when only the all-namespace pod list is denied.
    assert batch.jobs[0]["gpu_type"] == (None if forbidden == "nodes" else A100)
    assert "alice" not in json.dumps(batch.warnings)
    if forbidden == "nodes":
        assert "all-pods" not in [kind(args) for args in calls]


async def test_missing_quota_access_is_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    failure = kubernetes.KubectlError(FORBIDDEN.format("resourcequotas"))
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl([], {"quotas": failure}))
    batch = await kubernetes.KubernetesDriver().collect(SOURCE)
    assert batch.qos is None
    assert batch.capabilities == ["jobs", "nodes", "history"]
    assert batch.warnings == [
        {"code": "qos_unavailable", "detail": "listing resourcequotas is forbidden"}
    ]


async def test_namespace_without_gpu_quota_reports_none_not_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl([], {"quotas": listing()}))
    batch = await kubernetes.KubernetesDriver().collect(SOURCE)
    assert batch.qos == []
    assert "qos_limits" in batch.capabilities


async def test_malformed_optional_output_becomes_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        kubernetes, "_local", fake_kubectl([], {"nodes": "not json", "quotas": '{"kind": "List"}'})
    )
    batch = await kubernetes.KubernetesDriver().collect(SOURCE)
    assert batch.nodes is None and batch.qos is None
    assert batch.warnings == [
        {"code": "nodes_unavailable", "detail": "unexpected output"},
        {"code": "qos_unavailable", "detail": "unexpected output"},
    ]


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        (FORBIDDEN.format("pods"), {"code": "kubectl_forbidden", "resource": "pods"}),
        (
            "error: You must be logged in to the server (Unauthorized)",
            {"code": "kubectl_unauthorized"},
        ),
        (
            "Unable to connect to the server: dial tcp 192.0.2.10:6443: i/o timeout",
            {"code": "kubectl_unreachable"},
        ),
        (
            "The connection to the server localhost:8080 was refused - did you specify the "
            "right host or port?",
            {"code": "kubectl_unreachable"},
        ),
        ('error: context "cluster-b" does not exist', {"code": "kube_context_not_found"}),
        ("error: something unexpected https://192.0.2.10/secret", {"code": "kubectl_failed"}),
    ],
)
async def test_namespace_pod_failure_fails_without_raw_text(
    monkeypatch: pytest.MonkeyPatch, stderr: str, expected: dict[str, str]
) -> None:
    calls: list[list[str]] = []
    failure = kubernetes.KubectlError(stderr)
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl(calls, {"pods": failure}))
    with pytest.raises(SourceError) as error:
        await kubernetes.KubernetesDriver().collect(SOURCE)
    # Server responses can name users and endpoints; only the code is passed on.
    assert error.value.message() == expected
    assert len(calls) == 1


async def test_malformed_namespace_pods_fail_instead_of_reporting_no_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(kubernetes, "_local", fake_kubectl([], {"pods": "No resources found"}))
    with pytest.raises(SourceError) as error:
        await kubernetes.KubernetesDriver().collect(SOURCE)
    assert error.value.message() == {"code": "unexpected_output", "command": "kubectl get pods"}


# ---------------------------------------------------------------- over SSH


async def test_remote_collection_quotes_every_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, list[str] | None]] = []
    local = fake_kubectl([])

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        calls.append((destination, command, options))
        return await local(shlex.split(command))

    async def no_local(args: list[str]) -> str:
        raise AssertionError("kubectl must run on the SSH host")

    monkeypatch.setattr(ssh, "run", run)
    monkeypatch.setattr(kubernetes, "_local", no_local)
    source = {**SOURCE, "ssh_alias": "cluster-a", "options": {"context": "alice@cluster-a"}}
    batch = await kubernetes.KubernetesDriver().collect(source)
    assert batch.capabilities == ["jobs", "nodes", "qos_limits", "history"]
    assert {destination for destination, _, _ in calls} == {"cluster-a"}
    # The SSH config chooses the login; the namespace is not an SSH user.
    assert {str(options) for _, _, options in calls} == {"None"}
    all_pods = shlex.split(calls[2][1])
    assert all_pods == [
        "kubectl",
        "--context=alice@cluster-a",
        "get",
        "pods",
        "--all-namespaces",
        "--field-selector=status.phase!=Succeeded,status.phase!=Failed",
        "-o",
        "json",
        "--request-timeout=20s",
    ]
    # The shell sees "!" only inside single quotes.
    assert "'--field-selector=status.phase!=Succeeded,status.phase!=Failed'" in calls[2][1]


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (
            ssh.SSHError("ssh: connect to host cluster-a port 22: Connection refused"),
            {
                "code": "ssh_failed",
                "detail": "ssh: connect to host cluster-a port 22: Connection refused",
            },
        ),
        (
            ssh.SSHError("Host key verification failed."),
            {"code": "ssh_failed", "detail": "Host key verification failed."},
        ),
        (ssh.SSHError(FORBIDDEN.format("pods")), {"code": "kubectl_forbidden", "resource": "pods"}),
        (ssh.SSHError("bash: line 1: kubectl: command not found"), {"code": "kubectl_not_found"}),
        (ssh.SSHError("some remote noise"), {"code": "kubectl_failed"}),
        (TimeoutError(), {"code": "ssh_timeout"}),
    ],
)
async def test_remote_failures_are_classified(
    monkeypatch: pytest.MonkeyPatch, failure: Exception, expected: dict[str, str]
) -> None:
    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        raise failure

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(SourceError) as error:
        await kubernetes.KubernetesDriver().collect({**SOURCE, "ssh_alias": "cluster-a"})
    assert error.value.message() == expected


# ---------------------------------------------------------------- validation


def test_validate_requires_a_safe_namespace_and_context() -> None:
    driver = kubernetes.KubernetesDriver()
    driver.validate(SOURCE)
    driver.validate({**SOURCE, "ssh_alias": "cluster-a", "options": {"context": "alice@cluster-a"}})
    driver.validate({**SOURCE, "options": {"context": "arn:example:cluster/cluster-a"}})
    with pytest.raises(SourceError, match="namespace_required"):
        driver.validate({**SOURCE, "username": ""})
    for namespace in (
        "ML-Team",
        "-ml",
        "ml-",
        "ml_team",
        "ml.team",
        "a" * 64,
        "ml-team;id",
        "ml team",
    ):
        with pytest.raises(SourceError) as error:
            driver.validate({**SOURCE, "username": namespace})
        assert error.value.message() == {"code": "invalid_namespace", "namespace": namespace}
    for context in ("-oops", "--kubeconfig=/tmp/x", "a b", "a;id", "$(id)", "a\nb"):
        with pytest.raises(SourceError, match="invalid_kube_context"):
            driver.validate({**SOURCE, "options": {"context": context}})
    for alias in ("-oProxyCommand=touch", "cluster-a extra", ".hidden"):
        with pytest.raises(SourceError, match="invalid_ssh_alias"):
            driver.validate({**SOURCE, "ssh_alias": alias})


@pytest.mark.parametrize(
    "changes",
    [
        {"username": "ml-team;id"},
        {"username": "--all-namespaces"},
        {"options": {"context": "--kubeconfig=/tmp/x"}},
        {"ssh_alias": "-oProxyCommand=touch"},
    ],
)
async def test_unsafe_settings_are_rejected_before_kubectl(
    monkeypatch: pytest.MonkeyPatch, changes: dict[str, Any]
) -> None:
    async def never(*args: Any) -> str:
        raise AssertionError("kubectl must not run")

    monkeypatch.setattr(kubernetes, "_local", never)
    monkeypatch.setattr(ssh, "run", never)
    with pytest.raises(SourceError):
        await kubernetes.KubernetesDriver().collect({**SOURCE, **changes})


# ---------------------------------------------------------------- local process


def script(directory: Path, body: str, name: str = "kubectl") -> Path:
    directory.mkdir(exist_ok=True)
    path = directory / name
    path.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


async def test_local_kubectl_runs_without_a_shell(tmp_path: Path) -> None:
    echo = script(tmp_path / "bin", 'for arg in "$@"; do printf "%s\\n" "$arg"; done')
    output = await kubernetes._local([str(echo), "get", "pods", "--context=a b;$(id)"])
    assert output.splitlines() == ["get", "pods", "--context=a b;$(id)"]


async def test_local_kubectl_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    failing = script(tmp_path / "bin", f"echo '{FORBIDDEN.format('pods')}' >&2; exit 1")
    with pytest.raises(kubernetes.KubectlError, match="Forbidden"):
        await kubernetes._local([str(failing)])
    with pytest.raises(SourceError, match="kubectl_not_found"):
        await kubernetes._local([str(tmp_path / "missing" / "kubectl")])
    monkeypatch.setattr(kubernetes, "TIMEOUT", 0.2)
    slow = script(tmp_path / "bin", "exec sleep 5", name="slow")
    with pytest.raises(SourceError, match="kubectl_timeout"):
        await kubernetes._local([str(slow)])


async def test_collect_runs_kubectl_from_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = tmp_path / "calls"
    script(tmp_path / "bin", f'echo "$*" >> "{log}"; echo \'{{"items": []}}\'')
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}:/usr/bin:/bin")
    batch = await kubernetes.KubernetesDriver().collect(SOURCE)
    assert (batch.jobs, batch.nodes, batch.qos, batch.failures) == ([], [], [], [])
    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 4 and all(line.startswith("get ") for line in lines)


# ---------------------------------------------------------------- description


def test_driver_describes_its_form_and_checks() -> None:
    info = kubernetes.KubernetesDriver.info
    assert kubernetes.KubernetesDriver.name == "kubernetes"
    assert kubernetes.KubernetesDriver.kind == "cluster"
    fields = {field.key: field for field in info.fields}
    assert list(fields) == ["username", "ssh_alias", "context"]
    assert fields["username"].identity and fields["username"].required
    assert fields["username"].label["en"] == "Namespace"
    assert fields["username"].placeholder == "ml-team"
    assert not fields["ssh_alias"].required
    assert "{where}" in fields["ssh_alias"].hint["en"]
    assert not fields["context"].required
    assert [check.capability for check in info.checks] == ["jobs", "nodes", "qos_limits", "history"]
    assert [check.warning for check in info.checks] == [
        None,
        "nodes_unavailable",
        "qos_unavailable",
        "history_unavailable",
    ]
    texts = [info.label, info.description, info.details]
    texts += [check.label for check in info.checks]
    texts += [field.label for field in info.fields] + [field.hint for field in info.fields]
    assert all(set(text) == {"en", "zh-CN"} for text in texts)
    pattern = fields["username"].pattern
    assert pattern and re.fullmatch(pattern, "ml-team") and not re.fullmatch(pattern, "ML-team")


def test_mig_pods_and_nodes_remain_visible_without_claiming_physical_gpu_counts() -> None:
    workload = pod(
        spec={
            "containers": [
                {"name": "train", "resources": {"limits": {"nvidia.com/mig-1g.5gb": "1"}}}
            ]
        }
    )
    [job] = kubernetes.parse_jobs([workload], SOURCE, {}, AT)
    assert job["gpu_count"] is None
    machine = node(
        "gpu-node-01",
        gpus=None,
        product=None,
        status={"allocatable": {"nvidia.com/mig-1g.5gb": "7"}},
    )
    [record] = kubernetes.parse_nodes([machine], [workload], SOURCE)
    assert record["gpu_count"] is None
    assert record["gpu_allocated"] is None


def test_successful_pod_sidecar_shutdown_is_not_a_failure() -> None:
    workload = pod(
        spec={"initContainers": [{"name": "sidecar", "restartPolicy": "Always"}]},
        status={
            "phase": "Succeeded",
            "initContainerStatuses": [
                {
                    "name": "sidecar",
                    "state": {"terminated": {"exitCode": 143, "finishedAt": ago(minutes=1)}},
                }
            ],
        },
    )
    assert kubernetes.parse_failures([workload], SOURCE, {}, AT) == []


def test_fractional_cpu_counts_are_valid_collection_rows() -> None:
    from computedeck.drivers.base import Batch

    workload = pod(spec={"containers": [container(cpu="500m")]})
    jobs = kubernetes.parse_jobs([workload], SOURCE, {}, AT)
    assert jobs[0]["cpu_count"] == 0.5
    Batch(jobs=jobs).validate_rows()


def test_terminal_pods_include_success_but_not_running_container_failures() -> None:
    pods = [
        pod(
            "done",
            status={
                "phase": "Succeeded",
                "containerStatuses": [
                    {"state": terminated(0, "Completed", ago(hours=1), ago(minutes=5))}
                ],
            },
        ),
        pod(
            "failed",
            status={
                "phase": "Failed",
                "containerStatuses": [
                    {"state": terminated(137, "OOMKilled", ago(hours=1), ago(minutes=5))}
                ],
            },
        ),
        pod(
            "restarting",
            status={
                "phase": "Running",
                "containerStatuses": [
                    {"lastState": terminated(1, "Error", ago(hours=1), ago(minutes=5))}
                ],
            },
        ),
    ]
    rows = kubernetes.parse_finished(pods, SOURCE, {}, AT)
    assert {row["state"] for row in rows} == {"COMPLETED", "OUT_OF_MEMORY"}
    assert len(rows) == 2
    assert all(row["end"].endswith("+00:00") for row in rows)
    assert len(kubernetes.parse_failures(pods, SOURCE, {}, AT)) == 2


@pytest.mark.parametrize("held", [False, True])
@pytest.mark.parametrize("terminal", [False, True])
def test_deleted_pod_uses_last_observed_container_failure(
    monkeypatch: pytest.MonkeyPatch, store: Store, held: bool, terminal: bool
) -> None:
    at = datetime.now(UTC)
    monkeypatch.setattr(events, "now", lambda: at.isoformat())
    pods = [
        pod(
            status={
                "containerStatuses": [
                    {
                        "lastState": terminated(
                            137,
                            "OOMKilled",
                            (at - timedelta(hours=1)).isoformat(),
                            (at - timedelta(minutes=5)).isoformat(),
                        )
                    }
                ]
            }
        )
    ]
    running = Batch(
        jobs=kubernetes.parse_jobs(pods, SOURCE, {}, at),
        failures=kubernetes.parse_failures(pods, SOURCE, {}, at),
        finished=kubernetes.parse_finished(pods, SOURCE, {}, at),
        capabilities=["history"],
    )
    assert running.finished == []
    assert (
        events.collected(
            SOURCE, {"jobs": running.jobs, "lifecycle_pending": []}, running, first=False
        )
        == []
    )
    old = running.snapshot()
    if held:
        old["lifecycle_pending"], old["jobs"] = old["jobs"], []
    deleted = Batch(jobs=[], failures=[], finished=[], capabilities=["history"])
    if terminal:
        deleted.finished = [{**running.failures[0], "state": "COMPLETED", "exit_code": "0"}]
    store.add_events(events.collected(SOURCE, old, deleted, first=False))
    store.add_events(events.collected(SOURCE, deleted.snapshot(), deleted, first=False))
    [row] = store.recent_events()
    assert row["data"]["outcome"] == ("completed" if terminal else "out_of_memory")
    assert row["data"]["outcome_reason"] is None
    assert events.for_handler(row, None)["type"] == ("job.ended" if terminal else "job.failed")
    assert notify.matches(notify.migrate_rule({"events": ["job.failed"]}), row) == (not terminal)


def test_kubernetes_jobs_do_not_infer_arrays_from_names() -> None:
    [job] = kubernetes.parse_jobs([pod("1234_7")], SOURCE, {}, AT)
    assert job.get("array_id") is None
    assert job.get("array_index") is None


@pytest.mark.parametrize("signal", [None, 9])
@pytest.mark.parametrize("code", [137, -1])
def test_failure_exit_status_does_not_infer_a_signal_from_137(signal, code) -> None:
    state = terminated(code, "Error", ago(hours=3), ago(hours=2))
    if signal is not None:
        state["terminated"]["signal"] = signal
    workload = pod(
        "killed",
        status={"phase": "Failed", "containerStatuses": [{"name": "train", "state": state}]},
    )
    [row] = kubernetes.parse_failures([workload], SOURCE, {}, AT)
    assert (row["exit_code"], row["exit_status"], row["exit_signal"]) == (
        str(code),
        code if code >= 0 else None,
        signal,
    )
    assert row["reason"] == "Error"
    assert row["ended_at"] == row["end"]


@pytest.mark.parametrize("deadline,limit", [(None, None), (7200, "2:00:00"), (90061, "1-01:01:01")])
def test_failure_time_limit_uses_pod_deadline(deadline, limit) -> None:
    workload = pod(
        "train",
        status={
            "phase": "Failed",
            "containerStatuses": [
                {"name": "train", "state": terminated(1, "Error", ago(hours=3), ago(hours=2))}
            ],
        },
    )
    if deadline is not None:
        workload["spec"]["activeDeadlineSeconds"] = deadline
    for parse in (kubernetes.parse_failures, kubernetes.parse_finished):
        [row] = parse([workload], SOURCE, {}, AT)
        assert row["time_limit"] == limit
        assert row.get("log_path") is None
