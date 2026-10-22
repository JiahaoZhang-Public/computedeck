"""Fictional example data. Never persisted or passed to collectors."""

import json
import math
from datetime import UTC, datetime, timedelta
from typing import Any

from . import attention, drivers
from .drivers.aws_ec2 import parse_instances as parse_ec2_instances
from .drivers.base import cluster_state, node_health_fields, requires_partition
from .drivers.runpod import parse_pods
from .drivers.ssh_host import parse_machine
from .history import group_history
from .low_use import low_use
from .summary import fresh, freshness, summarize
from .wait_history import summarize_waits, wait_sample

_SOURCES = [
    # id, label, driver, cluster_id, username
    ("example:cluster-a-alice", "Cluster A", "slurm", "example:cluster-a", "alice"),
    ("example:cluster-a-bob", "Cluster A", "slurm", "example:cluster-a", "bob"),
    ("example:cluster-b-alice", "Cluster B", "slurm", "example:cluster-b", "alice"),
    ("example:runpod-runpod", "RunPod", "runpod", "example:runpod", ""),
    ("example:cluster-a-carol", "Cluster A", "slurm", "example:cluster-a", "carol"),
    ("example:cluster-c-alice", "Cluster C", "pbs", "example:cluster-c", "alice"),
    ("example:runpod-secondary", "RunPod secondary", "runpod", "example:runpod", ""),
    ("example:cluster-d-alice", "Cluster D", "slurm", "example:cluster-d", "alice"),
]
_GPU = {"example:cluster-a": "A100 80GB", "example:cluster-b": "H100"}
_JOBS = [
    # source, name, state, gpus, gpu %, cpu %, elapsed
    ("example:cluster-a-alice", "llm-sft / lr sweep", "RUNNING", 4, 86, 62, "12:42:18"),
    ("example:cluster-b-alice", "vit-pretrain / stage 2", "RUNNING", 8, 94, 78, "1-06:12:04"),
    ("example:cluster-a-bob", "speech-asr / eval", "RUNNING", 2, 73, 47, "03:28:51"),
    ("example:cluster-b-alice", "diffusion / fid eval", "RUNNING", 4, None, None, "08:14:32"),
    ("example:cluster-a-alice", "llm-sft / ablation", "PENDING", 1, None, None, "00:00:00"),
    ("example:cluster-b-alice", "rl-agent / rollout", "PENDING", 16, None, None, "00:00:00"),
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
        "credential": ""
        if cluster
        else (
            "env:RUNPOD_SECONDARY_API_KEY"
            if source_id == "example:runpod-secondary"
            else "env:RUNPOD_API_KEY"
        ),
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
    days, _, clock = elapsed.rpartition("-")
    hours, minutes, seconds = map(int, clock.split(":"))
    started = datetime.fromisoformat(observed) - timedelta(
        days=int(days or 0), hours=hours, minutes=minutes, seconds=seconds
    )
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
        "submitted_at": (started - timedelta(hours=2)).isoformat(),
        "started_at": started.isoformat() if state == "RUNNING" else None,
        "reason": "Priority" if state == "PENDING" else None,
        "gpu_utilization": gpu,
        "cpu_utilization": cpu,
        "memory_utilization": 58 if gpu is not None else None,
        "observed_at": observed,
    }


def demo_history(hours: int, data: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """A smooth fictional trace, one point per 30 minutes, up to 30 days."""
    current = datetime.now(UTC).replace(second=0, microsecond=0)
    data = dashboard() if data is None else data
    summary = data["summary"]
    gaps = [s for s in data["sources"] if s.get("stale") or s.get("error")]
    unprobed = [
        i
        for i in data["instances"]
        if i.get("manual") and i.get("monitoring") and not i.get("observed_at")
    ]
    unknown_machines = [
        i for i in data["instances"] if i.get("gpus") and i.get("gpu_allocated") is None
    ]
    steps = min(hours, 720) * 2
    points: list[dict[str, Any]] = []
    for age in range(steps, -1, -1):
        i = 1440 - age  # Keep periodic terms independent of the requested range.
        allocated = 14 + (4 if age % 48 < 32 else 0) + (4 if i % 96 > 60 else 0)
        at = current - timedelta(minutes=30 * age)
        # Unprobed machines create a gap only after being added. Source gaps start
        # at their last successful collection; the latest point uses the live summary.
        unknown = sum(at >= datetime.fromisoformat(i["added_at"]) for i in unprobed)
        unknown += sum(at >= datetime.fromisoformat(s["last_success"]) for s in gaps)
        unknown += sum(
            at >= datetime.fromisoformat(i["gpus_observed_at"]) for i in unknown_machines
        )
        points.append(
            {
                "at": at.isoformat(),
                "allocated_gpus": None if unknown else allocated,
                "known_allocated_gpus": allocated,
                "unknown_allocation_sources": unknown,
                "gpu_utilization": round(64 + 12 * math.sin(i / 6) + 5 * math.cos(i / 2), 1),
                "coverage_count": 12 if age % 48 > 16 else 18,
            }
        )
    points[-1].update(
        allocated_gpus=summary["allocated"],
        known_allocated_gpus=summary["known_allocated"],
        unknown_allocation_sources=len(summary["unmeasured"]),
    )
    # A fictional upgrade ten days ago and a two-hour collection gap yesterday.
    # Derive breakdowns from each point without changing the fleet trace: groups
    # become unknown at the same gap onsets, and newly added machines appear then.
    source_groups = {source["id"]: source["cluster_id"] for source in data["sources"]}
    for point in points:
        at = datetime.fromisoformat(point["at"])
        age_hours = (current - at).total_seconds() / 3600
        if age_hours <= 240:
            groups = group_history(
                {
                    **data,
                    "instances": [
                        item
                        for item in data["instances"]
                        if not item.get("added_at")
                        or at >= datetime.fromisoformat(item["added_at"])
                    ],
                }
            )
            for group in groups.values():
                group["unknown_allocation_sources"] = 0
            for source in gaps:
                if at >= datetime.fromisoformat(source["last_success"]):
                    groups[source["cluster_id"]]["unknown_allocation_sources"] += 1
            for items, field in ((unprobed, "added_at"), (unknown_machines, "gpus_observed_at")):
                for item in items:
                    if at >= datetime.fromisoformat(item[field]):
                        key = source_groups.get(
                            item["source_id"], f"platform:{item['platform'].strip().lower()}"
                        )
                        groups[key]["unknown_allocation_sources"] += 1
            # Keep single-GPU groups visible; larger groups absorb the variation.
            # Cumulative rounding preserves integer counts and the fleet total.
            fixed = sum(group["known_allocated"] == 1 for group in groups.values())
            known_total = sum(group["known_allocated"] or 0 for group in groups.values()) - fixed
            cumulative = previous = 0
            for group in groups.values():
                if not group["unknown_allocation_sources"] and group["known_allocated"] is None:
                    group["known_allocated"] = 0
                known = group["known_allocated"]
                if known is not None and known > 1:
                    cumulative += known
                    scaled = round(
                        cumulative * (point["known_allocated_gpus"] - fixed) / known_total
                    )
                    group["known_allocated"] = scaled - previous
                    previous = scaled
                group["allocated"] = (
                    None if group["unknown_allocation_sources"] else group["known_allocated"]
                )
            point["by_group"] = groups
    points = [
        p
        for p in points
        if not 26 < (current - datetime.fromisoformat(p["at"])).total_seconds() / 3600 < 28
    ]
    return points


def dashboard() -> dict[str, Any]:
    # Keep example polls stable within a minute, as if these were collected samples.
    current = datetime.now(UTC).replace(second=0, microsecond=0)
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
    # The planner explains a missing run-time limit as unknown, not unlimited.
    next(qos for qos in sources[1]["qos"] if qos["name"] == "debug")["limits"].pop("MaxWallPJ")
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
        # Cluster A waits on an uncollected association cap despite its GPU room.
        if job["name"] == "llm-sft / ablation":
            job["reason"] = "AssocMaxJobsLimit"
        # Cluster B's 16-GPU wait does not fit its GPU room.
        if job["name"] == "rl-agent / rollout":
            job["reason"] = "QOSMaxGRESPerUser"
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
    # One mixed-state sweep occupies one list row, while counts still include every element.
    for index in range(1, 31):
        state = "RUNNING" if index <= 4 else "PENDING" if index < 30 else "SUSPENDED"
        element = _job(
            index,
            (
                "example:cluster-a-alice",
                "vision / parameter sweep",
                state,
                1,
                None,
                None,
                "00:24:00" if state == "RUNNING" else "00:00:00",
            ),
            observed,
        )
        element.update(
            id=f"example:cluster-a:48300_{index}",
            array_id="48300",
            array_index=str(index),
            node=f"a-gpu-{4 + (index - 1) // 2:02}" if state == "RUNNING" else None,
            qos="long",
            reason=("Resources" if index < 25 else "Priority") if state == "PENDING" else None,
        )
        if state == "PENDING":
            # Pending array siblings share priority; earlier elements count as ties.
            element.update(
                queue=[
                    {
                        "partition": "gpu",
                        "ahead": 0,
                        "ties": index - 5,
                    }
                ],
                fairshare=0.12,
                queue_unknown=None,
            )
            # One element disappeared between the own-job and partition queries.
            if index == 29:
                element.update(queue=None, queue_unknown="failed")
        jobs.append(element)
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
        "exit_status": 0,
        "exit_signal": 125,
        "ended_at": (current - timedelta(hours=5)).isoformat(),
    }
    timeout = {
        **_job(
            len(_JOBS) + 1,
            ("example:cluster-a-alice", "vision / baseline", "TIMEOUT", 2, None, None, "02:00:00"),
            observed,
        ),
        "end": (local_current - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S"),
        "exit_code": "0:0",
        "exit_status": 0,
        "exit_signal": 0,
        "ended_at": (current - timedelta(hours=2)).isoformat(),
        "time_limit": "02:00:00",
        "log_path": "/work/vision/logs/train.log",
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
            "started_at": (current - timedelta(hours=76)).isoformat(),
            "seen_running_since": (current - timedelta(hours=4)).isoformat(),
            "currency": "USD",
            "observed_at": observed,
            # A failed check survives provider listings without changing held GPUs.
            "ssh_status": "error",
            "ssh_error": {
                "code": "ssh_authentication",
                "detail": "Permission denied (publickey).",
            },
            "last_probe_attempt": probed,
        },
        {
            "id": "example:manual:lab-workstation-devbox",
            "source_id": "manual",
            "platform": "Lab workstation",
            "external_id": "devbox",
            "name": "dev-box",
            # Running while a recent SSH check reached it; GPU use was measured by that check.
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
            "added_at": (current - timedelta(minutes=45)).isoformat(),
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
    machine_source = _source(
        ("example:lab-server", "Lab server", "ssh", "example:lab-server", "alice"), observed
    )
    machine_source.update(ssh_alias="lab-server", credential="", capabilities=["instances"])
    sources.append(machine_source)
    machine = parse_machine(
        json.dumps(
            {
                "gpu_tool": "nvidia-smi",
                "gpu": "0, GPU-demo-0, NVIDIA L4, 0, 64, 24576\n"
                "1, GPU-demo-1, NVIDIA L4, 80, 16000, 24576\n"
                "2, GPU-demo-2, NVIDIA L4, 25, 8000, 24576\n"
                "3, GPU-demo-3, NVIDIA L4, N/A, N/A, 24576\n",
                "apps": "GPU-demo-1, 4242, 16000\n",
                "owners": "4242 alice\n",
                "user": "alice",
                "cpu_utilization": 20,
                "memory_utilization": 30,
            }
        ),
        machine_source,
        "lab-server",
    )
    machine_source["capabilities"] = machine.capabilities
    assert machine.instances is not None
    machine.instances[0].update(
        observed_at=observed,
        gpus_observed_at=observed,
        last_probe_attempt=observed,
        seen_running_since=(current - timedelta(hours=2)).isoformat(),
    )
    instances.extend(machine.instances)
    runpod_source = next(s for s in sources if s["id"] == "example:runpod-runpod")
    observed_pod = parse_pods(
        [
            {
                "id": "observed-pod",
                "name": "batch-inference",
                "desiredStatus": "RUNNING",
                "gpu": {"count": 1, "displayName": "RTX 4090"},
                "costPerHr": 0.35,
                # lastStartedAt is not reported: only the store's observation window is known.
            }
        ],
        runpod_source,
    )[0]
    observed_pod.update(
        observed_at=observed,
        seen_running_since=(current - timedelta(hours=2)).isoformat(),
        ssh_alias="computedeck-runpod-observed-pod",
    )
    instances.append(observed_pod)
    ec2_source = _source(("example:ec2", "Example EC2", "aws-ec2", "example:ec2", ""), observed)
    ec2_source.update(credential="", options={"region": "us-east-1"})
    sources.append(ec2_source)
    ec2_instance = parse_ec2_instances(
        [
            {
                "Instances": [
                    {
                        "InstanceId": "i-00000000000000001",
                        "InstanceType": "g5.xlarge",
                        "State": {"Name": "running"},
                        "LaunchTime": (current - timedelta(hours=6)).isoformat(),
                        "Tags": [{"Key": "Name", "Value": "gpu-eval"}],
                    }
                ]
            }
        ],
        {"g5.xlarge": (1, "A10G")},
        ec2_source,
    )[0]
    ec2_instance.update(
        observed_at=observed,
        seen_running_since=(current - timedelta(hours=4)).isoformat(),
        ssh_alias="computedeck-ec2-gpu-eval",
    )
    instances.append(ec2_instance)
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
    nodes.extend(
        {
            **nodes[0],
            "id": f"example:cluster-d:d-gpu-{i:02}",
            "name": f"d-gpu-{i:02}",
            "cluster_id": "example:cluster-d",
            "source_id": "example:cluster-d-alice",
            "state": state,
            "gpu_count": 1,
            "gpu_allocated": 0,
            "cpu_allocated": 0,
        }
        for i, state in enumerate(("down*", "drained"), 1)
    )
    nodes.extend(
        {
            **nodes[0],
            "id": f"example:cluster-a:{name}",
            "name": name,
            "state": state,
            "partitions": partitions,
            "gpu_allocated": 0,
            "cpu_allocated": 0,
        }
        for name, state, partitions in [
            ("a-cloud-01", "IDLE+CLOUD+POWERED_DOWN", ["gpu"]),
            ("a-spare-01", "IDLE", []),
            ("a-future-01", "FUTURE", ["gpu"]),
        ]
    )
    source_by_id = {source["id"]: source for source in sources}
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
        node.update(node_health_fields(node, source_by_id[node["source_id"]]))
    for source in sources:
        if source["kind"] == "cluster":
            source["cluster_state"] = cluster_state(
                [n for n in nodes if n["cluster_id"] == source["cluster_id"]],
                require_partition=requires_partition(source),
            )
    array_failures = []
    for index in range(60):
        ended = (current - timedelta(minutes=45 + index)).isoformat()
        array_failures.append(
            {
                **_job(
                    index,
                    ("example:cluster-b-alice", "train-sweep", "FAILED", 1, None, None, "00:10:00"),
                    observed,
                ),
                "id": f"example:cluster-b:48200_{index}",
                "array_id": "48200",
                "array_index": str(index),
                "end": ended,
                "ended_at": ended,
                "exit_code": "0:9" if index == 0 else "1:0",
                "exit_status": 0 if index == 0 else 1,
                "exit_signal": 9 if index == 0 else 0,
            }
        )
    data = {
        "mode": "demo",
        "sources": sources,
        "jobs": jobs,
        "instances": instances,
        "nodes": nodes,
        "history": [],
        "updated_at": observed,
        "refreshing": True,
        "collecting": [sources[1]["id"]],
        **freshness(sources),
        "recent_failures": [timeout, failure, *array_failures],
        "failure_history_sources": [source["id"] for source in sources if fresh(source, "history")],
        "failure_history_observed_at": min(
            source["last_success"] for source in sources if fresh(source, "history")
        ),
    }

    # A typed rental price demonstrates a second currency without mixing totals.
    next(i for i in instances if i["name"] == "dev-box").update(hourly_cost=0.4, currency="EUR")
    data["low_use_settings"] = {"threshold": 10, "window_minutes": 60}
    for item in instances:
        # The monitored, priced workstation has seven real-shaped probe readings.
        readings = (
            [
                {
                    "at": (
                        datetime.fromisoformat(observed) - timedelta(minutes=10 * n)
                    ).isoformat(),
                    "gpu_util": 4,
                    "gpu_util_max": 4,
                    "origin": "probe",
                }
                for n in range(6, -1, -1)
            ]
            if item["name"] == "dev-box"
            else []
        )
        item["low_use"] = low_use(
            item, readings, now=current, interval_minutes=10, threshold=10, window_minutes=60
        )
        item["console_url"] = "https://console.runpod.io" if item["platform"] == "RunPod" else None
    data["summary"] = summarize(data)
    # Accounting-shaped own jobs show a range, a small sample and missing accounting.
    wait_samples = []
    for source, count, gpus in ((sources[0], 12, 1), (sources[2], 3, 16)):
        for index in range(count):
            wait_ended = current - timedelta(days=index + 1)
            wait_started = wait_ended - timedelta(hours=1)
            sample = wait_sample(
                {
                    "id": f"{source['cluster_id']}:wait-{index}",
                    "cluster_id": source["cluster_id"],
                    "user": source["username"],
                    "qos": "normal" if gpus == 1 else "long",
                    "partition": "gpu",
                    "gpu_count": gpus,
                    "submitted_at": (
                        wait_started - timedelta(minutes=10 * (index + 1))
                    ).isoformat(),
                    "started_at": wait_started.isoformat(),
                    "ended_at": wait_ended.isoformat(),
                },
                source,
            )
            assert sample is not None
            wait_samples.append(sample)
    data["wait_history"] = summarize_waits(sources, wait_samples, now=current)
    data["history"] = [
        {k: v for k, v in p.items() if k != "by_group"} for p in demo_history(24, data)
    ]
    data["attention"] = attention.derive(
        data,
        [drivers.describe(name) for name in drivers.names()],
        now=current,
        plugin_status={
            "notify": {
                "enabled": True,
                "delivery_failures": [
                    {
                        "channel": "example:team",
                        "channel_name": "Team alerts",
                        "error_code": "send_timeout",
                        "at": (current - timedelta(minutes=3)).isoformat(),
                    }
                ],
            }
        },
    )
    # Example acknowledgement is isolated from the service's saved state.
    muted = {
        "cluster_unavailable:example:cluster-d-alice": None,
        "instance_ssh_failed:example:runpod:demo-pod": timedelta(hours=1),
    }
    for item in data["attention"]:
        if item["kind"] == "notification_failed":
            item["subject"]["id"] = "example:notify"
            item["key"] = "notification_failed:example:notify:team"
        if item["key"] not in muted:
            continue
        duration = muted[item["key"]]
        item["muted"] = {
            "state": "snoozed" if duration else "acknowledged",
            "at": (current - timedelta(minutes=10)).isoformat(),
            "until": (current + duration).isoformat() if duration else None,
        }
    data["attention_count"] = sum(item["muted"] is None for item in data["attention"])
    return data


def events() -> list[dict[str, Any]]:
    """Recent example events, newest first."""
    data = dashboard()
    sources = {source["id"]: source for source in data["sources"]}
    jobs = {job["id"]: job for job in data["jobs"]}
    timeout, oom = data["recent_failures"][:2]
    at = datetime.now(UTC).replace(second=0, microsecond=0)

    def context(source_id: str | None) -> dict[str, Any]:
        if source_id is None:
            return {}
        source = sources[source_id]
        return {
            "source_name": source["name"],
            "cluster_id": source["cluster_id"],
            "username": source["username"],
            "driver": source["driver"],
        }

    rows: list[tuple[str, str | None, int, dict[str, Any]]] = [
        (
            "change.tool",
            None,
            360,
            {"subject_id": "notify", "name": "Notifications", "action": "on", "fields": []},
        ),
        (
            "change.source",
            "example:cluster-b-alice",
            8,
            {
                "subject_id": "example:cluster-b-alice",
                "name": "Cluster B",
                "action": "edited",
                "fields": ["interval_minutes"],
            },
        ),
        (
            "change.instance",
            None,
            45,
            {
                "subject_id": "example:manual:lab-workstation-buildbox",
                "name": "build-box",
                "action": "added",
                "fields": ["external_id", "host", "name", "platform"],
            },
        ),
        ("source.recovered", "example:cluster-d-alice", 10, {}),
        (
            "source.gap",
            "example:cluster-d-alice",
            10,
            {
                "unobserved_from": (at - timedelta(hours=48)).isoformat(),
                "unobserved_to": (at - timedelta(minutes=10)).isoformat(),
                "failures_checked_from": (at - timedelta(hours=24, minutes=10)).isoformat(),
            },
        ),
        (
            "service.gap",
            None,
            450,
            {
                "from": (at - timedelta(hours=8)).isoformat(),
                "to": (at - timedelta(minutes=450)).isoformat(),
            },
        ),
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
        ("job.finished", timeout["source_id"], 120, {"job": timeout, "outcome": "timeout"}),
        ("job.finished", oom["source_id"], 300, {"job": oom, "outcome": "out_of_memory"}),
        (
            "job.finished",
            "example:cluster-b-alice",
            210,
            {
                "job": {
                    **jobs["example:cluster-b:48211"],
                    "id": "example:cluster-b:48001",
                    "name": "vit-pretrain / prepare",
                    "state": "COMPLETED",
                },
                "outcome": "completed",
            },
        ),
        (
            "job.finished",
            "example:cluster-a-bob",
            90,
            {
                "job": {
                    "id": "example:cluster-a:48000",
                    "name": "data / prepare",
                    "state": "UNKNOWN",
                    "observed_at": (at - timedelta(minutes=120)).isoformat(),
                },
                "outcome": "unknown",
                "outcome_reason": "outcomes_unavailable",
            },
        ),
        ("source.recovered", "example:cluster-b-alice", 390, {}),
        ("source.failed", "example:cluster-b-alice", 420, {"error": {"code": "timeout"}}),
    ]
    for kind, _, minutes, extra in rows:
        if kind == "job.started":
            started = (at - timedelta(minutes=minutes)).isoformat()
            extra.update(
                started_at=started,
                observed_at=(at - timedelta(minutes=minutes - 5)).isoformat(),
            )
            extra["job"]["started_at"] = started
        if kind == "job.finished":
            ended = (at - timedelta(minutes=minutes)).isoformat()
            extra.update(
                ended_at=None if extra["outcome"] == "unknown" else ended,
                observed_at=ended
                if extra["outcome"] == "unknown"
                else (at - timedelta(minutes=minutes - 5)).isoformat(),
            )
            extra["job"].update(
                end=extra["ended_at"],
                exit_code="0:0"
                if extra["outcome"] == "completed"
                else extra["job"].get("exit_code"),
            )
    for index, job in enumerate(data["recent_failures"][2:]):
        rows.append(
            (
                "job.finished",
                job["source_id"],
                45 + index,
                {
                    "job": job,
                    "outcome": "failed",
                    "state": "FAILED",
                    "exit_code": job["exit_code"],
                    "ended_at": job["ended_at"],
                    "observed_at": (at - timedelta(minutes=40)).isoformat(),
                    "since": (at - timedelta(hours=3)).isoformat(),
                },
            )
        )
    for day in range(1, 29):
        rows.append(("source.recovered", "example:cluster-b-alice", day * 1440, {}))
        rows.append(
            (
                "source.failed",
                "example:cluster-b-alice",
                day * 1440 + 10,
                {"error": {"code": "timeout"}},
            )
        )
    rows.sort(key=lambda row: row[2])
    return [
        {
            "id": len(rows) - index,
            "key": f"example:{index}",
            "type": kind,
            "at": (at - timedelta(minutes=minutes)).isoformat(),
            "source_id": source_id,
            "silent": False,
            "data": extra if kind.startswith("change.") else {**context(source_id), **extra},
        }
        for index, (kind, source_id, minutes, extra) in enumerate(rows)
    ]


def nodes() -> list[dict[str, Any]]:
    """An example collection machine."""
    observed = (
        datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(minutes=3)
    ).isoformat()
    return [
        {
            "id": "example:lab-gateway",
            "name": "Lab gateway",
            "ssh_alias": "lab-gateway",
            "command": "~/.local/bin/computedeck",
            "status": "ok",
            "version": "0.6.0",
            "drivers": ["slurm", "kubernetes", "ssh"],
            "checked_at": observed,
            "last_collected_at": observed,
            "error": None,
        }
    ]


def delivery_status(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fictional notification outcomes, isolated from the live delivery log."""
    result = []
    for row in rows:
        group = row.get("group")
        if group:
            children = delivery_status(group["events"])
            statuses = sorted({status for child in children for status in child["delivery"]})
            result.append({**row, "delivery": statuses, "group": {**group, "events": children}})
            continue
        statuses = []
        if row["type"] == "job.finished":
            if row["data"].get("job", {}).get("array_id"):
                statuses = (
                    ["failed", "grouped"]
                    if row["data"]["job"].get("array_index") == "0"
                    else ["grouped"]
                )
            elif row["data"].get("outcome") == "unknown":
                statuses = ["suppressed"]
            else:
                statuses = ["sent"]
        result.append({**row, "delivery": statuses})
    return result
