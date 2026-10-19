"""Fictional example data. Never persisted or passed to collectors."""

import math
from datetime import UTC, datetime, timedelta
from typing import Any

_SOURCES = [
    # id, label, driver, cluster_id, username
    ("cluster-a-alice", "Cluster A", "slurm", "cluster-a", "alice"),
    ("cluster-a-bob", "Cluster A", "slurm", "cluster-a", "bob"),
    ("cluster-b-alice", "Cluster B", "slurm", "cluster-b", "alice"),
    ("runpod-runpod", "RunPod", "runpod", "runpod", ""),
]
_GPU = {"cluster-a": "A100 80GB", "cluster-b": "H100"}
_JOBS = [
    # source, name, state, gpus, gpu %, cpu %, elapsed
    ("cluster-a-alice", "llm-sft / lr sweep", "RUNNING", 4, 86, 62, "12:42:18"),
    ("cluster-b-alice", "vit-pretrain / stage 2", "RUNNING", 8, 94, 78, "1-06:12:04"),
    ("cluster-a-bob", "speech-asr / eval", "RUNNING", 2, 73, 47, "03:28:51"),
    ("cluster-b-alice", "diffusion / fid eval", "RUNNING", 4, None, None, "08:14:32"),
    ("cluster-a-alice", "llm-sft / ablation", "PENDING", 4, None, None, "00:00:00"),
    ("cluster-b-alice", "rl-agent / rollout", "PENDING", 8, None, None, "00:00:00"),
]


def _source(row: tuple[str, str, str, str, str], observed: str) -> dict[str, Any]:
    source_id, name, driver, cluster_id, username = row
    cluster = driver == "slurm"
    return {
        "id": source_id,
        "name": name,
        "driver": driver,
        "kind": "cluster" if cluster else "cloud",
        "cluster_id": cluster_id,
        "username": username,
        "ssh_alias": cluster_id if cluster else "",
        "credential": "" if cluster else "env:RUNPOD_API_KEY",
        "options": {},
        # Cluster B is reachable only from the lab gateway, which collects it.
        "node": "lab-gateway" if cluster_id == "cluster-b" else "",
        "enabled": True,
        "status": "ready",
        "last_success": observed,
        "last_attempt": observed,
        "error": None,
        "stale": False,
        "interval_minutes": 10,
        "capabilities": ["jobs", "nodes", "qos_limits", "qos_access", "history"]
        if cluster
        else ["instances", "ssh_discovery"],
        "warnings": [],
        "qos": [
            {
                "name": name,
                "access": "verified",
                "limits": {"MaxTRESPU": f"gres/gpu={gpus}", "MaxWallPJ": wall},
                "origin": "demo",
            }
            for name, gpus, wall in (
                ("normal", 8, "1440"),
                ("long", 16, "10080"),
                ("debug", 2, "120"),
            )
        ]
        if cluster
        else [],
    }


def _job(index: int, spec: tuple[Any, ...], observed: str) -> dict[str, Any]:
    source_id, name, state, gpus, gpu, cpu, elapsed = spec
    cluster_id = source_id.rsplit("-", 1)[0]
    return {
        "id": f"{cluster_id}:{48210 + index}",
        "source_id": source_id,
        "cluster_id": cluster_id,
        "name": name,
        "user": source_id.rsplit("-", 1)[1],
        "account": "demo-lab",
        "partition": "gpu",
        "qos": "long" if gpus >= 8 else "normal",
        "state": state,
        "gpu_count": gpus,
        "gpu_type": _GPU[cluster_id],
        "cpu_count": gpus * 8,
        "node": f"{cluster_id[-1]}-gpu-{index + 1:02}" if state == "RUNNING" else None,
        "elapsed": elapsed,
        "reason": "QOSMaxGRESPerUser" if state == "PENDING" else None,
        "gpu_utilization": gpu,
        "cpu_utilization": cpu,
        "memory_utilization": 58 if gpu is not None else None,
        "observed_at": observed,
    }


def demo_history(hours: int) -> list[dict[str, Any]]:
    """A smooth fictional trace, one point per 30 minutes, up to 7 days."""
    current = datetime.now(UTC)
    steps = min(hours, 168) * 2
    points = []
    for i in range(steps + 1):
        age = steps - i
        allocated = 14 + (4 if age % 48 < 32 else 0) + (4 if i % 96 > 60 else 0)
        points.append(
            {
                "at": (current - timedelta(minutes=30 * age)).isoformat(),
                "allocated_gpus": allocated,
                "known_allocated_gpus": allocated,
                "unknown_allocation_sources": 0,
                "gpu_utilization": round(64 + 12 * math.sin(i / 6) + 5 * math.cos(i / 2), 1),
                "coverage_count": 12 if age % 48 > 16 else 18,
            }
        )
    return points


def dashboard() -> dict[str, Any]:
    current = datetime.now(UTC)
    observed = (current - timedelta(minutes=3)).isoformat()
    probed = (current - timedelta(minutes=2)).isoformat()
    sources = [_source(row, observed) for row in _SOURCES]
    jobs = [_job(index, spec, observed) for index, spec in enumerate(_JOBS)]
    failure = {
        **_job(
            len(_JOBS),
            ("cluster-a-alice", "llm-sft / long context", "FAILED", 4, None, None, "02:11:40"),
            observed,
        ),
        "state": "OUT_OF_MEMORY",
        "end": (current - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S"),
        "exit_code": "0:125",
    }
    instances = [
        {
            "id": "runpod:demo-pod",
            "source_id": "runpod-runpod",
            "platform": "RunPod",
            "name": "sd-inference",
            "state": "desired_running",
            "gpu_count": 2,
            "gpu_type": "RTX 4090",
            "gpu_utilization": 68,
            "cpu_utilization": 38,
            "memory_utilization": 42,
            "host": "192.0.2.10",
            "port": 22010,
            "username": "root",
            "ssh_alias": "computedeck-runpod-demo-pod",
            "identity_file": None,
            "hourly_cost": 0.69,
            "currency": "USD",
            "observed_at": observed,
            # Checked after this listing; the next listing keeps the result of the check.
            "ssh_status": "reachable",
            "last_probe_attempt": probed,
        },
        {
            "id": "manual:lab-workstation-devbox",
            "source_id": "manual",
            "platform": "Lab workstation",
            "external_id": "devbox",
            "name": "dev-box",
            # Running while a recent SSH check reached it; GPUs in use have processes.
            "state": "running",
            "gpu_count": 1,
            "gpu_allocated": 1,
            "gpu_type": "RTX 4090",
            "gpu_utilization": 4,
            "gpu_observed_count": 1,
            "cpu_utilization": 12,
            "memory_utilization": 31,
            "metrics_scope": "host_visible",
            "host": "192.0.2.20",
            "port": 22,
            "username": "alice",
            "ssh_alias": "cd-lab-workstation-devbox",
            "identity_file": None,
            "existing_alias": False,
            "hourly_cost": None,
            "currency": "USD",
            "observed_at": observed,
            "ssh_status": "reachable",
            "last_probe_attempt": observed,
            "probe_warnings": [],
            "monitoring": True,
            "manual": True,
        },
    ]
    nodes = [
        {
            "id": f"{cluster_id}:{cluster_id[-1]}-gpu-{i:02}",
            "source_id": source_id,
            "cluster_id": cluster_id,
            "name": f"{cluster_id[-1]}-gpu-{i:02}",
            "state": "mixed" if i % 3 else "idle",
            "gpu_count": 8 if cluster_id == "cluster-b" else 4,
            "gpu_allocated": (4 if cluster_id == "cluster-b" else 2) if i % 3 else 0,
            "gpu_type": _GPU[cluster_id],
            "cpu_count": 128,
            "cpu_allocated": 48 if i % 3 else 0,
            "partitions": ["gpu"],
            "observed_at": observed,
        }
        for cluster_id, source_id in [
            ("cluster-a", "cluster-a-alice"),
            ("cluster-b", "cluster-b-alice"),
        ]
        for i in range(1, 9)
    ]
    history = demo_history(24)
    return {
        "mode": "demo",
        "sources": sources,
        "jobs": jobs,
        "instances": instances,
        "nodes": nodes,
        "history": history,
        "updated_at": observed,
        "refreshing": False,
        "recent_failures": [failure],
        "failure_history_sources": [
            source["id"] for source in sources if source["kind"] == "cluster"
        ],
        "failure_history_observed_at": observed,
    }


def events() -> list[dict[str, Any]]:
    """Recent example events, newest first."""
    data = dashboard()
    jobs = {job["id"]: job for job in data["jobs"]}
    failure = data["recent_failures"][0]
    at = datetime.now(UTC)

    def context(source_id: str) -> dict[str, Any]:
        source = next(item for item in data["sources"] if item["id"] == source_id)
        return {
            "source_name": source["name"],
            "cluster_id": source["cluster_id"],
            "username": source["username"],
            "driver": source["driver"],
        }

    rows = [
        ("job.started", "cluster-b-alice", 25, {"job": jobs["cluster-b:48211"]}),
        ("job.failed", failure["source_id"], 140, {"job": failure}),
        (
            "job.ended",
            "cluster-a-bob",
            210,
            {"job": {**jobs["cluster-a:48212"], "name": "speech-asr / prep"}},
        ),
        ("source.recovered", "cluster-b-alice", 390, {}),
        ("source.failed", "cluster-b-alice", 420, {"error": {"code": "timeout"}}),
    ]
    return [
        {
            "id": 100 - index,
            "key": f"demo:{index}",
            "type": kind,
            "at": (at - timedelta(minutes=minutes)).isoformat(),
            "source_id": source_id,
            "silent": False,
            "data": {**context(source_id), **extra},
        }
        for index, (kind, source_id, minutes, extra) in enumerate(rows)
    ]


def nodes() -> list[dict[str, Any]]:
    """An example collection machine."""
    observed = (datetime.now(UTC) - timedelta(minutes=3)).isoformat()
    return [
        {
            "id": "lab-gateway",
            "name": "Lab gateway",
            "ssh_alias": "lab-gateway",
            "command": "~/.local/bin/computedeck",
            "status": "ok",
            "version": "0.3.0",
            "drivers": ["slurm", "kubernetes", "ssh"],
            "checked_at": observed,
            "last_collected_at": observed,
            "error": None,
        }
    ]
