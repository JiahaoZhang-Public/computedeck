"""Fictional example data. Never persisted or passed to collectors."""

import math
from datetime import UTC, datetime, timedelta
from typing import Any

from . import attention, drivers
from .drivers.base import cluster_state, node_health
from .summary import fresh, freshness, summarize

_SOURCES = [
    # id, label, driver, cluster_id, username
    ("example:cluster-a-alice", "Cluster A", "slurm", "example:cluster-a", "alice"),
    ("example:cluster-a-bob", "Cluster A", "slurm", "example:cluster-a", "bob"),
    ("example:cluster-b-alice", "Cluster B", "slurm", "example:cluster-b", "alice"),
    ("example:runpod-runpod", "RunPod", "runpod", "example:runpod", ""),
    ("example:cluster-a-carol", "Cluster A", "slurm", "example:cluster-a", "carol"),
    ("example:cluster-c-alice", "Cluster C", "pbs", "example:cluster-c", "alice"),
    ("example:runpod-secondary", "RunPod secondary", "runpod", "example:runpod", ""),
]
_GPU = {"example:cluster-a": "A100 80GB", "example:cluster-b": "H100"}
_JOBS = [
    # source, name, state, gpus, gpu %, cpu %, elapsed
    ("example:cluster-a-alice", "llm-sft / lr sweep", "RUNNING", 4, 86, 62, "12:42:18"),
    ("example:cluster-b-alice", "vit-pretrain / stage 2", "RUNNING", 8, 94, 78, "1-06:12:04"),
    ("example:cluster-a-bob", "speech-asr / eval", "RUNNING", 2, 73, 47, "03:28:51"),
    ("example:cluster-b-alice", "diffusion / fid eval", "RUNNING", 4, None, None, "08:14:32"),
    ("example:cluster-a-alice", "llm-sft / ablation", "PENDING", 4, None, None, "00:00:00"),
    ("example:cluster-b-alice", "rl-agent / rollout", "PENDING", 8, None, None, "00:00:00"),
]


def _source(row: tuple[str, str, str, str, str], observed: str) -> dict[str, Any]:
    source_id, name, driver, cluster_id, username = row
    cluster = driver in {"slurm", "pbs"}
    return {
        "id": source_id,
        "name": name,
        "driver": driver,
        "kind": "cluster" if cluster else "cloud",
        "cluster_id": cluster_id,
        "username": username,
        "ssh_alias": cluster_id.removeprefix("example:") if cluster else "",
        "credential": "" if cluster else "env:RUNPOD_API_KEY",
        "options": {},
        # Cluster B is reachable only from the lab gateway, which collects it.
        "node": "example:lab-gateway" if cluster_id == "example:cluster-b" else "",
        "enabled": True,
        "status": "ready",
        "last_success": observed,
        "last_attempt": observed,
        "next_due_at": (datetime.fromisoformat(observed) + timedelta(minutes=10)).isoformat(),
        "failures": 0,
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
    # A background collection must not hide the age of the previous success.
    sources[1].update(
        status="syncing",
        last_success=(current - timedelta(minutes=8)).isoformat(),
        last_attempt=(current - timedelta(seconds=15)).isoformat(),
        next_due_at=(current - timedelta(seconds=15)).isoformat(),
    )
    # A missing optional command has never worked here: a gap, not a regression.
    sources[1]["capabilities"].remove("history")
    sources[1]["warnings"] = [{"code": "history_unavailable", "detail": "sacct: command not found"}]
    sources[4].update(
        stale=True,
        last_success=(current - timedelta(minutes=47)).isoformat(),
        last_attempt=(current - timedelta(minutes=47)).isoformat(),
        next_due_at=(current - timedelta(minutes=37)).isoformat(),
    )
    sources[5].update(
        status="error",
        stale=True,
        last_success=(current - timedelta(hours=2, minutes=40)).isoformat(),
        # Attempts at 150, 140, 130, 120, 104, 74, 44 and 14 minutes ago.
        last_attempt=(current - timedelta(minutes=14)).isoformat(),
        next_due_at=(current + timedelta(minutes=16)).isoformat(),
        failures=8,
        error={"code": "ssh_failed", "detail": "Permission denied (publickey)."},
        capabilities=["jobs", "nodes", "qos_limits", "history"],
        capabilities_seen=["history", "jobs", "nodes", "qos_limits"],
        qos=[],
    )
    # RunPod raises a failed listing on HTTP 429; it cannot report fresh instances.
    sources[6].update(
        status="error",
        stale=True,
        last_success=(current - timedelta(minutes=25)).isoformat(),
        last_attempt=(current - timedelta(minutes=5)).isoformat(),
        next_due_at=(current + timedelta(minutes=5)).isoformat(),
        failures=2,
        error={"code": "http_status", "status": 429},
        capabilities=["instances", "ssh_discovery", "ssh_probe"],
        capabilities_seen=["instances", "ssh_discovery", "ssh_probe"],
    )
    jobs = [_job(index, spec, observed) for index, spec in enumerate(_JOBS)]
    for job in jobs:
        if job["source_id"] == sources[1]["id"]:
            job["observed_at"] = sources[1]["last_success"]
    jobs.append(
        _job(
            len(_JOBS) + 2,
            ("example:cluster-a-carol", "text-encoder / eval", "RUNNING", 1, 52, 30, "00:42:00"),
            sources[4]["last_success"],
        )
    )
    jobs[-1]["node"] = "a-gpu-02"
    local_current = current.astimezone().replace(tzinfo=None)
    failure = {
        **_job(
            len(_JOBS),
            (
                "example:cluster-a-alice",
                "llm-sft / long context",
                "FAILED",
                4,
                None,
                None,
                "02:11:40",
            ),
            observed,
        ),
        "state": "OUT_OF_MEMORY",
        "end": (local_current - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S"),
        "exit_code": "0:125",
    }
    timeout = {
        **_job(
            len(_JOBS) + 1,
            ("example:cluster-a-alice", "vision / baseline", "TIMEOUT", 2, None, None, "02:00:00"),
            observed,
        ),
        "end": (local_current - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S"),
        "exit_code": "0:0",
    }
    instances = [
        {
            "id": "example:runpod:demo-pod",
            "source_id": "example:runpod-runpod",
            "platform": "RunPod",
            "name": "sd-inference",
            "state": "reported_running",
            "gpu_count": 2,
            "gpu_type": "RTX 4090",
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "host": "192.0.2.10",
            "port": 22010,
            "username": "root",
            "ssh_alias": "computedeck-runpod-demo-pod",
            "identity_file": None,
            "hourly_cost": 0.69,
            "currency": "USD",
            "observed_at": observed,
            # A failed check survives provider listings without changing held GPUs.
            "ssh_status": "error",
            "ssh_error": {"code": "ssh_timeout"},
            "last_probe_attempt": probed,
        },
        {
            "id": "example:manual:lab-workstation-devbox",
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
    instances.append(
        {
            **instances[1],
            "id": "example:manual:lab-workstation-buildbox",
            "external_id": "buildbox",
            "name": "build-box",
            "state": "unknown",
            "gpu_allocated": None,
            "observed_at": None,
            "last_probe_attempt": None,
            "ssh_status": "unverified",
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "host": "192.0.2.21",
            "ssh_alias": "cd-lab-workstation-buildbox",
        }
    )
    instances.append(
        {
            **instances[-1],
            "id": "example:manual:lab-workstation-shortcut",
            "external_id": "shortcut",
            "name": "ssh-shortcut",
            "monitoring": False,
            "host": "192.0.2.22",
            "ssh_alias": "cd-lab-workstation-shortcut",
        }
    )
    nodes: list[dict[str, Any]] = [
        {
            "id": f"{cluster_id}:{cluster_id[-1]}-gpu-{i:02}",
            "source_id": source_id,
            "cluster_id": cluster_id,
            "name": f"{cluster_id[-1]}-gpu-{i:02}",
            "state": "mixed" if i % 3 else "idle",
            "gpu_count": 8 if cluster_id == "example:cluster-b" else 4,
            "gpu_allocated": (4 if cluster_id == "example:cluster-b" else 2) if i % 3 else 0,
            "gpu_type": _GPU[cluster_id],
            "cpu_count": 128,
            "cpu_allocated": 48 if i % 3 else 0,
            "partitions": ["gpu"],
            "observed_at": observed,
        }
        for cluster_id, source_id in [
            ("example:cluster-a", "example:cluster-a-alice"),
            ("example:cluster-b", "example:cluster-b-alice"),
        ]
        for i in range(1, 9)
    ]
    for node in nodes:
        if node["cluster_id"] == "example:cluster-b":
            if node["name"] in {"b-gpu-07", "b-gpu-08"}:
                node.update(
                    state="down*" if node["name"] == "b-gpu-07" else "drained",
                    gpu_allocated=0,
                    cpu_allocated=0,
                )
            elif node["name"] == "b-gpu-02":
                node["gpu_allocated"] = 8  # The 8-GPU running example job is on this node.
        node["health"] = node_health(node["state"])
    for source in sources:
        if source["kind"] == "cluster":
            source["cluster_state"] = cluster_state(
                [n for n in nodes if n["cluster_id"] == source["cluster_id"]]
            )
    history = demo_history(24)
    data = {
        "mode": "demo",
        "sources": sources,
        "jobs": jobs,
        "instances": instances,
        "nodes": nodes,
        "history": history,
        "updated_at": observed,
        "refreshing": True,
        "collecting": [sources[1]["id"]],
        **freshness(sources),
        "recent_failures": [timeout, failure],
        "failure_history_sources": [source["id"] for source in sources if fresh(source, "history")],
        "failure_history_observed_at": min(
            source["last_success"] for source in sources if fresh(source, "history")
        ),
    }

    data["summary"] = summarize(data)
    data["attention"] = attention.derive(
        data, [drivers.describe(name) for name in drivers.names()], now=current
    )
    return data


def events() -> list[dict[str, Any]]:
    """Recent example events, newest first."""
    data = dashboard()
    sources = {source["id"]: source for source in data["sources"]}
    jobs = {job["id"]: job for job in data["jobs"]}
    timeout, oom = data["recent_failures"]
    at = datetime.now(UTC)

    def context(source_id: str) -> dict[str, Any]:
        source = sources[source_id]
        return {
            "source_name": source["name"],
            "cluster_id": source["cluster_id"],
            "username": source["username"],
            "driver": source["driver"],
        }

    rows = [
        (
            "source.failed",
            "example:runpod-secondary",
            15,
            {"error": sources["example:runpod-secondary"]["error"]},
        ),
        ("job.started", "example:cluster-b-alice", 25, {"job": jobs["example:cluster-b:48211"]}),
        (
            "source.failed",
            "example:cluster-c-alice",
            150,
            {"error": sources["example:cluster-c-alice"]["error"]},
        ),
        ("job.failed", timeout["source_id"], 120, {"job": timeout}),
        ("job.failed", oom["source_id"], 300, {"job": oom}),
        (
            "job.ended",
            "example:cluster-a-bob",
            210,
            {"job": {**jobs["example:cluster-a:48212"], "name": "speech-asr / prep"}},
        ),
        ("source.recovered", "example:cluster-b-alice", 390, {}),
        ("source.failed", "example:cluster-b-alice", 420, {"error": {"code": "timeout"}}),
    ]
    rows.sort(key=lambda row: row[2])
    return [
        {
            "id": 100 - index,
            "key": f"example:{index}",
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
            "id": "example:lab-gateway",
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
