"""Read-only Slurm collection over SSH: own jobs, visible nodes, QoS limits, recent failures."""

import asyncio
import math
import re
import shlex
import time
from collections import Counter
from datetime import datetime
from typing import Any, ClassVar, Literal

from ..ssh_config import validate_alias, validate_username
from . import ssh
from .base import (
    EMPTY,
    Batch,
    DriverCheck,
    DriverInfo,
    SourceError,
    cluster_state,
    integer,
    job_time,
    message,
    now,
    number,
    ssh_alias_field,
    username_field,
)

_FIELDS = (
    "JobArrayID",
    "Name",
    "UserName",
    "Account",
    "Partition",
    "QOS",
    "State",
    "NumCPUs",
    "NumNodes",
    "NodeList",
    "TimeUsed",
    "Reason",
    "tres-alloc",
    "tres-per-node",
    "tres-per-job",
    "SubmitTime",
    "StartTime",
)
_HISTORY_FIELDS = (
    "JobID",
    "JobName",
    "User",
    "Account",
    "Partition",
    "QOS",
    "State",
    "AllocTRES",
    "NCPUS",
    "NodeList",
    "Elapsed",
    "End",
    "ExitCode",
    "Timelimit",
)
_FINISHED_FIELDS = (*_HISTORY_FIELDS, "Submit", "Start")
HISTORY_MARKER = "COMPUTEDECK_TERMINAL_HISTORY"

FAILURE_STATES = (
    "FAILED",
    "TIMEOUT",
    "OUT_OF_MEMORY",
    "NODE_FAIL",
    "BOOT_FAIL",
    "DEADLINE",
    "PREEMPTED",
)


def gpu_count(tres: str | None) -> int | None:
    """Read total GPU TRES, preferring the untyped total over its typed breakdown."""
    if tres is None or tres.strip() in EMPTY:
        return None
    # GRES can contain index/socket details with commas: gpu:a100:4(S:0-1).
    text = re.sub(r"\([^)]*\)", "", tres)
    total: int | None = None
    typed: dict[str, int] = {}
    for part in text.split(","):
        match = re.fullmatch(r"(?:gres[/:])?gpu(?::([^:=]+))?[:=](\d+)", part.strip())
        if match:
            kind, count = match.groups()
            if kind:
                typed[kind] = typed.get(kind, 0) + int(count)
            else:
                total = (total or 0) + int(count)
    if total is not None:
        return total
    if typed:
        return sum(typed.values())
    # A valid CPU-only TRES list is evidence of no GPUs. Unrecognized GPU syntax
    # remains unknown rather than silently reporting zero.
    cpu_only = all(re.fullmatch(r"[A-Za-z0-9_/:.-]+=[A-Za-z0-9_.+-]+", p) for p in text.split(","))
    return 0 if cpu_only and "gpu" not in text.lower() else None


def gpu_type(tres: str) -> str | None:
    types = re.findall(r"(?:gres/)?gpu:([^:=,()]+)[:=]\d+", tres)
    return ", ".join(dict.fromkeys(types)) or None


def gpus_tracked(nodes_output: str) -> bool:
    """Whether the cluster accounts GPUs as TRES, so a TRES list without them means none."""
    return re.search(r"(?:^|\s)CfgTRES=\S*gres/gpu", nodes_output, re.M) is not None


def parse_jobs(
    output: str, source: dict[str, Any], *, tracked: bool = False
) -> list[dict[str, Any]]:
    jobs: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for line in output.splitlines():
        if not line.strip():
            continue
        delimiter = "\x1f" if "\x1f" in line else "|"
        columns = [column.strip() for column in line.split(delimiter)]
        if columns[-1] == "":
            columns.pop()
        if len(columns) != len(_FIELDS):
            raise SourceError("unexpected_output", command="squeue")
        row = dict(zip(_FIELDS, columns, strict=True))
        if row["UserName"] != source["username"]:
            continue
        count = gpu_count(row["tres-alloc"]) if "gpu" in row["tres-alloc"] else None
        # tres-alloc is already job-wide, including pending requested resources.
        # When GPU accounting is absent, use per-job, then per-node × node count.
        if count is None or "gpu" not in row["tres-alloc"]:
            per_job = gpu_count(row["tres-per-job"])
            if per_job is not None and "gpu" in row["tres-per-job"]:
                count = per_job
            elif "gpu" in row["tres-per-node"]:
                per_node = gpu_count(row["tres-per-node"])
                nodes = integer(row["NumNodes"])
                count = per_node * nodes if per_node is not None and nodes is not None else None
        requests = ",".join(row[key] for key in ("tres-alloc", "tres-per-node", "tres-per-job"))
        if count is None and tracked and "gpu" not in requests.lower():
            # GPUs are accounted, so a job whose resources name none holds none.
            count = gpu_count(row["tres-alloc"])
        array = re.fullmatch(r"(\d+)_(\d+)", row["JobArrayID"])
        job_id = f"{source['cluster_id']}:{row['JobArrayID']}"
        jobs[job_id] = {
            "id": job_id,
            "array_id": array[1] if array else None,
            "array_index": array[2] if array else None,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": row["Name"],
            "user": row["UserName"],
            "account": row["Account"],
            "partition": row["Partition"],
            "qos": row["QOS"],
            "state": row["State"].upper(),
            "gpu_count": count,
            "gpu_type": gpu_type(
                ",".join(row[key] for key in ("tres-alloc", "tres-per-node", "tres-per-job"))
            ),
            "cpu_count": integer(row["NumCPUs"]),
            "node": None if row["NodeList"] in EMPTY | {"None assigned"} else row["NodeList"],
            "elapsed": row["TimeUsed"],
            "submitted_at": job_time(row["SubmitTime"]),
            # squeue's StartTime for a pending job is an estimate, not an actual start.
            "started_at": job_time(row["StartTime"]) if row["State"] != "PENDING" else None,
            "reason": None if row["Reason"] in EMPTY else row["Reason"],
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "observed_at": observed_at,
        }
    return list(jobs.values())


def _key_values(text: str) -> dict[str, str]:
    # Read only known whitespace-separated scontrol key/value fields; preserve
    # empty AllocTRES as distinct from an absent field.
    result: dict[str, str] = {}
    # Reason is free text and may contain strings that look like scheduler fields.
    text = re.split(r"\sReason=", text, maxsplit=1)[0]
    for key, value in re.findall(r"(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=([^\s]*)", text):
        result.setdefault(key, value)
    return result


def parse_nodes(output: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    nodes: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for line in output.splitlines():
        row = _key_values(line)
        if not row.get("NodeName"):
            if line.strip():
                raise SourceError("unexpected_output", command="scontrol show nodes")
            continue
        name = row["NodeName"]
        capacity = gpu_count(row.get("CfgTRES"))
        if capacity is None or (capacity == 0 and "gpu" in row.get("Gres", "")):
            capacity = gpu_count(row.get("Gres"))
        alloc = row.get("AllocTRES")
        allocated = gpu_count(alloc)
        if alloc == "":
            # An empty AllocTRES: nothing at all is allocated on the node.
            allocated = 0
        elif "gres/gpu" in row.get("CfgTRES", ""):
            # GPUs are accounted, so an allocation that lists none holds none.
            if alloc is not None and "gpu" not in alloc:
                allocated = 0
        elif "gpu" in row.get("Gres", ""):
            # Untracked GPUs: only the GRES usage (scontrol -d) says how many are taken.
            allocated = gpu_count(row.get("GresUsed"))
        node_id = f"{source['cluster_id']}:{name}"
        nodes[node_id] = {
            "id": node_id,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": name,
            "state": row.get("State", "unknown").lower(),
            "gpu_count": capacity,
            "gpu_allocated": allocated,
            "gpu_type": gpu_type(",".join((row.get("Gres", ""), row.get("CfgTRES", "")))),
            "cpu_count": integer(row.get("CPUTot")),
            "cpu_allocated": integer(row.get("CPUAlloc")),
            "partitions": [p for p in row.get("Partitions", "").split(",") if p not in EMPTY],
            "observed_at": observed_at,
        }
    return list(nodes.values())


_LIMITS = ("MaxJobsPU", "MaxSubmitJobsPU", "MaxTRESPU", "MaxTRESPJ", "MaxWallPJ", "GrpTRES")
_USER_LIMITS = ("MaxJobsPU", "MaxSubmitJobsPU", "MaxTRESPU")


def _used(value: str) -> str:
    """The usage in limit(usage): "4(2)" is 2; "cpu=N(8),gres/gpu=8(3)" is cpu=8,gres/gpu=3."""
    if "=" not in value:
        return re.sub(r"^[^(]*\(([^)]*)\)$", r"\1", value)
    return re.sub(r"=[^,(]*\(([^)]*)\)", r"=\1", value)


def _user_block(block: str, username: str) -> str:
    """This login's lines under "User Limits"; other users' usage is never read."""
    lines = block.splitlines()
    pattern = re.compile(rf"^(\s+){re.escape(username)}\(\d+\)\s*$")
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if not match:
            continue
        indent = len(match[1])
        mine = []
        for following in lines[index + 1 :]:
            if len(following) - len(following.lstrip()) <= indent and following.strip():
                break
            mine.append(following)
        return "\n".join(mine)
    return ""


def parse_qos(output: str, username: str = "") -> list[dict[str, Any]]:
    records = re.split(r"(?m)^\s*(?=QOS=)", output)
    result = []
    for block in records:
        fields = _key_values(block)
        name = fields.get("QOS", "").split("(", 1)[0]
        if not name:
            continue
        limits = {}
        for key in _LIMITS:
            value = fields.get(key)
            if value:
                # assoc_mgr shows limit(current usage). Keep only the limit;
                # N means no limit here, not unlimited effective user capacity.
                limit = re.sub(r"\([^)]*\)", "", value)
                limits[key] = None if limit in {"N", "NONE", "UNLIMITED"} else limit
        # Usage that a limit is measured against: the whole QoS for GrpTRES, and this
        # login alone for the per-user limits.
        usage = {}
        if "(" in fields.get("GrpTRES", ""):
            usage["GrpTRES"] = _used(fields["GrpTRES"])
        mine = _key_values(_user_block(block, username)) if username else {}
        for key in _USER_LIMITS:
            if "(" in mine.get(key, ""):
                usage[key] = _used(mine[key])
        result.append(
            {
                "name": name,
                "limits": limits,
                "usage": usage,
                "origin": "scheduler_qos_access_unverified",
            }
        )
    return result


def association_qos(output: str, username: str) -> set[str] | None:
    """Explicit association grants, or None when the controller does not print QOS.

    Upstream Slurm's text formatter omits this field. Never infer permissions from
    QoS definitions, partition policies, default QoS, or another user's records.
    """
    grants: set[str] = set()
    found = False
    for block in re.split(r"(?m)(?=^[ \t]*ClusterName=)", output):
        fields = _key_values(re.split(r"\sComment=", block, maxsplit=1)[0])
        if fields.get("UserName", "").split("(", 1)[0] != username:
            continue
        found = True
        if "QOS" not in fields:
            return None
        for name in fields["QOS"].split(","):
            if name in EMPTY:
                continue
            if name.startswith(("+", "-")):
                return None  # An inheritance delta is not an effective permission list.
            grants.add(name)
    if found or "No associations currently cached" in output:
        return grants
    return None


def association_fairshare(output: str, username: str) -> dict[str, float | None]:
    """The login's account factors from the already collected association output."""
    result: dict[str, float | None] = {}
    for block in re.split(r"(?m)(?=^[ \t]*ClusterName=)", output):
        fields = _key_values(block)
        if fields.get("UserName", "").split("(", 1)[0] != username:
            continue
        account = fields.get("Account")
        if not account:
            continue
        match = re.search(r"SharesRaw/Norm/Level/Factor=\S+/\S+/\S+/(\S+)", block)
        factor = number(match[1]) if match else None
        if factor is not None and not 0 <= factor <= 1:
            factor = None
        # Partition-specific associations must agree before showing one account value.
        result[account] = factor if account not in result or result[account] == factor else None
    return result


def queue_positions(
    output: str, jobs: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]] | None]:
    """Read scheduler order once; retain counts and our job ids only.

    Ahead excludes equal-priority rows earlier in the listing; those form the
    uncertainty range (ties). Held/dependency/limit waits are not in either count.
    """
    partitions = {
        job["id"]: [p.strip() for p in (job.get("partition") or "").split(",") if p.strip()]
        for job in jobs
    }
    own: dict[str, dict[str, dict[str, Any]]] = {job["id"]: {} for job in jobs}
    totals: Counter[str] = Counter()
    priorities: Counter[tuple[str, int]] = Counter()
    cluster = jobs[0]["cluster_id"]
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = [value.strip() for value in line.split("|")]
        if len(fields) != 4:
            raise SourceError("unexpected_output", command="squeue")
        raw_priority, partition, job_id, reason = fields
        priority = integer(raw_priority)
        if (
            priority is None
            or not partition
            or "," in partition
            or not re.fullmatch(r"\d+(?:_\d+)?(?:\+\d+)?", job_id)
        ):
            raise SourceError("unexpected_output", command="squeue")
        if reason not in {"Priority", "Resources"}:
            continue
        key = f"{cluster}:{job_id}"
        if key in own and partition in partitions[key]:
            ties = priorities[partition, priority]
            own[key][partition] = {
                "partition": partition,
                "ahead": totals[partition] - ties,
                "ties": ties,
            }
        totals[partition] += 1
        priorities[partition, priority] += 1
    return {
        key: [own[key][p] for p in parts] if parts and all(p in own[key] for p in parts) else None
        for key, parts in partitions.items()
    }


# Successful settings only; changing a source's SSH target or login bypasses its cache.
_QUEUE_CONFIG: dict[tuple[str, str, str], tuple[float, dict[str, str]]] = {}


async def collect_queue(batch: Batch, source: dict[str, Any], associations: str) -> None:
    jobs = [
        job
        for job in batch.jobs or []
        if job["state"] == "PENDING" and job["reason"] in {"Priority", "Resources"}
    ]
    if not jobs:
        return
    for job in jobs:
        job.update(queue=None, fairshare=None, queue_unknown="failed")
    alias, username = source["ssh_alias"], source["username"]
    options = ["-l", username]
    key = (source["id"], alias, username)
    cached = _QUEUE_CONFIG.get(key)
    try:
        if cached and time.monotonic() - cached[0] < 3600:
            config = cached[1]
        else:
            async with asyncio.timeout(15):
                output = await ssh.run(alias, "scontrol show config", options)
            config = dict(
                re.findall(
                    r"(?m)^[ \t]*(PriorityType|PriorityWeightFairShare|PrivateData)"
                    r"[ \t]*=[ \t]*(\S+)[ \t]*$",
                    output,
                )
            )
            if not {"PriorityType", "PrivateData"} <= config.keys():
                raise SourceError("unexpected_output", command="scontrol show config")
            _QUEUE_CONFIG[key] = (time.monotonic(), config)
        weight = number(config.get("PriorityWeightFairShare"))
        if config["PriorityType"] == "priority/multifactor" and weight is not None and weight > 0:
            factors = association_fairshare(associations, username)
            for job in jobs:
                job["fairshare"] = factors.get(job["account"])
        private = config["PrivateData"].lower().split(",")
        if "jobs" in private or "all" in private:
            for job in jobs:
                job["queue_unknown"] = "private_data"
            return
        partitions = sorted(
            {
                p.strip()
                for job in jobs
                for p in (job.get("partition") or "").split(",")
                if p.strip()
            }
        )
        if not partitions:
            return
        command = shlex.join(
            [
                "squeue",
                "-h",
                "--array",
                "--local",
                "-P",
                "-t",
                "PD",
                "-p",
                ",".join(partitions),
                "--sort=-p,i",
                "-o",
                "%Q|%P|%i|%r",
            ]
        )
        async with asyncio.timeout(15):
            positions = queue_positions(await ssh.run(alias, command, options), jobs)
        for job in jobs:
            job["queue"] = positions[job["id"]]
            job["queue_unknown"] = None if job["queue"] is not None else "failed"
        if any(job["queue"] is None for job in jobs):
            batch.warnings.append(message("queue_unavailable"))
    except (RuntimeError, TimeoutError, SourceError):
        # Remote errors may echo other users' job ids. Never persist their text.
        batch.warnings.append(message("queue_unavailable"))


def database_qos(output: str, username: str, cluster: str) -> set[str] | None:
    """Effective grants from sacctmgr's documented parsable association columns."""
    result: set[str] = set()
    for line in output.splitlines():
        if not line.strip():
            continue
        fields = line.rstrip("|").split("|")
        # Keep an empty final QOS column: parsable2 has no extra trailing separator.
        if len(fields) < 5:
            fields = line.split("|")
        if len(fields) != 5:
            return None
        name, _account, user, _partition, qos = (field.strip() for field in fields)
        if user != username or name != cluster:
            continue
        for grant in qos.split(","):
            if grant.startswith(("+", "-")):
                return None
            if grant not in EMPTY:
                result.add(grant)
    return result


def parse_failures(
    output: str, source: dict[str, Any], *, terminal: bool = False
) -> list[dict[str, Any]]:
    """sacct allocations in a failure state. Only terminal accounting records count."""
    fields = _FINISHED_FIELDS if terminal else _HISTORY_FIELDS
    states = (*FAILURE_STATES, "COMPLETED", "CANCELLED") if terminal else FAILURE_STATES
    failures: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for line in output.splitlines():
        if not line.strip():
            continue
        columns = line.split("|")
        if len(columns) != len(fields):
            raise SourceError("unexpected_output", command="sacct")
        row = dict(zip(fields, columns, strict=True))
        state = row["State"].split(" ", 1)[0].rstrip("+").upper()
        if row["User"] != source["username"] or state not in states:
            continue
        if row["End"] in EMPTY:
            continue
        exit_parts = re.fullmatch(r"(\d+):(\d+)", row["ExitCode"])
        array = re.fullmatch(r"(\d+)_(\d+)", row["JobID"])
        job_id = f"{source['cluster_id']}:{row['JobID']}"
        previous = failures.get(job_id)
        # Requeued jobs can appear more than once; keep the latest attempt.
        if previous and (previous["end"] or "") >= row["End"]:
            continue
        failures[job_id] = {
            "id": job_id,
            "array_id": array[1] if array else None,
            "array_index": array[2] if array else None,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": row["JobName"],
            "user": row["User"],
            "account": row["Account"],
            "partition": row["Partition"],
            "qos": row["QOS"],
            "state": state,
            "gpu_count": gpu_count(row["AllocTRES"]) if "gpu" in row["AllocTRES"] else None,
            "gpu_type": gpu_type(row["AllocTRES"]),
            "cpu_count": integer(row["NCPUS"]),
            "node": None if row["NodeList"] in EMPTY | {"None assigned"} else row["NodeList"],
            "elapsed": row["Elapsed"],
            "time_limit": None
            if row["Timelimit"] in EMPTY | {"UNLIMITED", "Partition_Limit"}
            else row["Timelimit"],
            "reason": None,
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "end": job_time(row["End"])
            if terminal
            else re.sub(r"(?:Z|[+-]\d{2}:?\d{2})$", "", row["End"]),
            "ended_at": job_time(row["End"]),
            "exit_status": int(exit_parts[1]) if exit_parts else None,
            "exit_signal": int(exit_parts[2]) if exit_parts else None,
            "submitted_at": job_time(row.get("Submit", "")),
            "started_at": job_time(row.get("Start", "")),
            "exit_code": None if row["ExitCode"] in EMPTY else row["ExitCode"],
            "observed_at": observed_at,
        }
    return sorted(failures.values(), key=lambda job: job["end"] or "", reverse=True)


def _unavailable(code: str, error: BaseException) -> dict[str, Any]:
    # Slurm tools repeat one cause over several lines; the first line says it.
    lines = [line.strip() for line in str(error).splitlines() if line.strip()]
    return message(code, detail=(lines[0] if lines else type(error).__name__)[:180])


class SlurmDriver:
    name: ClassVar[str] = "slurm"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "Slurm cluster", "zh-CN": "Slurm 集群"},
        description={
            "en": "Your jobs, visible nodes and QoS limits, read through SSH.",
            "zh-CN": "通过 SSH 读取你的作业、可见节点和 QoS 上限。",
        },
        details={
            "en": "Read-only Slurm queries through an SSH host alias on {where}. "
            "ProxyJump and keys come from that SSH config.",
            "zh-CN": "通过{where}的 SSH Host 别名只读查询 Slurm。ProxyJump 和密钥沿用该 SSH 配置。",
        },
        fields=[username_field(), ssh_alias_field()],
        checks=[
            DriverCheck(
                capability="jobs",
                command="squeue",
                label={"en": "Your jobs (squeue)", "zh-CN": "你的作业（squeue）"},
            ),
            DriverCheck(
                capability="nodes",
                command="scontrol",
                label={"en": "Visible nodes (scontrol)", "zh-CN": "可见节点（scontrol）"},
                warning="nodes_unavailable",
            ),
            DriverCheck(
                capability="qos_limits",
                command="assoc_mgr",
                label={
                    "en": "QoS limits (scontrol assoc_mgr)",
                    "zh-CN": "QoS 上限（scontrol assoc_mgr）",
                },
                warning="qos_unavailable",
            ),
            DriverCheck(
                capability="qos_access",
                command="association QOS",
                label={"en": "QoS association permissions", "zh-CN": "QoS 关联权限"},
            ),
            DriverCheck(
                capability="history",
                command="sacct",
                label={
                    "en": "Failures in the last 24 h (sacct)",
                    "zh-CN": "24 小时内的失败（sacct）",
                },
                warning="history_unavailable",
            ),
        ],
        name_placeholder="Cluster A",
    )

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("ssh_alias") or not source.get("username"):
            raise SourceError("cluster_connection_required")
        if source["ssh_alias"].startswith("-"):
            raise SourceError("invalid_ssh_alias")

    async def collect(self, source: dict[str, Any]) -> Batch:
        alias = validate_alias(source.get("ssh_alias") or "")
        username = validate_username(source["username"])
        options = ["-l", username]
        # --array expands pending array elements, preventing undercounting a range.
        # squeue's documented field suffix permits unpadded pipe-separated output.
        # https://slurm.schedmd.com/squeue.html
        output_format = ",".join(f"{field}:0\x1f" for field in _FIELDS)
        command = shlex.join(
            [
                "env",
                "SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z",
                "squeue",
                "--noheader",
                "--array",
                "--local",
                f"--user={username}",
                "-O",
                output_format,
            ]
        )
        try:
            job_output = await ssh.run(alias, command, options)
        except ssh.SSHError as error:
            raise SourceError("ssh_failed", str(error)) from None
        except TimeoutError:
            raise SourceError("ssh_timeout") from None
        batch = Batch(capabilities=["jobs"], history_window_seconds=86400)
        node_output = ""
        try:
            # -d adds GresUsed, the only GPU usage of clusters that do not account GPUs.
            node_output = await ssh.run(alias, "scontrol -d show nodes -o", options)
            batch.nodes = parse_nodes(node_output, source)
            batch.capabilities.append("nodes")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("nodes_unavailable", error))
        jobs = batch.jobs = parse_jobs(job_output, source, tracked=gpus_tracked(node_output))
        qos = {
            job["qos"]: {
                "name": job["qos"],
                "limits": {},
                "origin": "observed_job_access_unverified",
            }
            for job in jobs
            if job["qos"] not in EMPTY
        }
        try:
            partitions = await ssh.run(alias, "scontrol show partition -o", options)
            for line in partitions.splitlines():
                for name in _key_values(line).get("AllowQos", "").split(","):
                    if name not in EMPTY | {"ALL"}:
                        qos.setdefault(
                            name,
                            {
                                "name": name,
                                "limits": {},
                                "origin": "partition_policy_access_unverified",
                            },
                        )
            if "PartitionName=" in partitions:
                batch.capabilities.append("partition_policy")
        except (RuntimeError, TimeoutError) as error:
            batch.warnings.append(_unavailable("partitions_unavailable", error))
        try:
            limits = parse_qos(
                await ssh.run(alias, "scontrol show assoc_mgr flags=qos", options), username
            )
            if limits:
                qos.update({item["name"]: item for item in limits})
                batch.capabilities.append("qos_limits")
        except (RuntimeError, TimeoutError) as error:
            batch.warnings.append(_unavailable("qos_unavailable", error))
        grants = None
        associations = ""
        try:
            async with asyncio.timeout(10):
                associations = await ssh.run(
                    alias,
                    shlex.join(
                        ["scontrol", "show", "assoc_mgr", f"users={username}", "flags=assoc"]
                    ),
                    options,
                )
            grants = association_qos(associations, username)
        except (RuntimeError, TimeoutError):
            pass
        await collect_queue(batch, source, associations)
        if grants is None:
            # A database can cover multiple clusters. The controller's cluster name,
            # not the display name or SSH alias, scopes the optional database query.
            clusters = set(re.findall(r"(?m)^[ \t]*ClusterName=([^\s]+)", associations))
            if len(clusters) == 1:
                cluster = clusters.pop()
                command = shlex.join(
                    [
                        "sacctmgr",
                        "--noheader",
                        "--parsable2",
                        "show",
                        "assoc",
                        "where",
                        f"user={username}",
                        f"cluster={cluster}",
                        "format=Cluster,Account,User,Partition,QOS",
                    ]
                )
                try:
                    async with asyncio.timeout(10):
                        grants = database_qos(
                            await ssh.run(alias, command, options), username, cluster
                        )
                except (RuntimeError, TimeoutError):
                    pass
        for name in grants or []:
            qos.setdefault(name, {"name": name, "limits": {}, "origin": "user_association"})
        for entry in qos.values():
            entry["access"] = (
                "unknown"
                if grants is None
                else "verified"
                if entry["name"] in grants
                else "not_associated"
            )
        if grants is not None:
            batch.capabilities.append("qos_access")
        try:
            # Both bounds are required when filtering by state.
            # https://slurm.schedmd.com/sacct.html
            history = shlex.join(
                [
                    "env",
                    "SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z",
                    "sacct",
                    "--noheader",
                    "--parsable2",
                    "--allocations",
                    f"--user={username}",
                    "--starttime=now-24hours",
                    "--endtime=now",
                    "--state=" + ",".join(FAILURE_STATES),
                    "--format=" + ",".join(_HISTORY_FIELDS),
                ]
            )
            minutes = 1440
            if "history" in (source.get("capabilities") or []) and (
                previous := job_time(source.get("last_success") or "")
            ):
                # Keep the five-minute overlap and collection timeout at daily polling.
                minutes = min(
                    1447,
                    max(
                        5,
                        math.ceil(
                            (
                                datetime.fromisoformat(now()) - datetime.fromisoformat(previous)
                            ).total_seconds()
                            / 60
                        )
                        + 5,
                    ),
                )
            terminal = shlex.join(
                [
                    "env",
                    "SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z",
                    "sacct",
                    "--noheader",
                    "--parsable2",
                    "--allocations",
                    f"--user={username}",
                    f"--starttime=now-{minutes}minutes",
                    "--endtime=now",
                    "--state=" + ",".join((*FAILURE_STATES, "COMPLETED", "CANCELLED")),
                    "--format=" + ",".join(_FINISHED_FIELDS),
                ]
            )
            output = await ssh.run(
                alias, f"{history} && echo {HISTORY_MARKER} && {terminal}", options
            )
            failures, marker, finished = output.partition(HISTORY_MARKER)
            if not marker:
                raise SourceError("unexpected_output", command="sacct")
            batch.failures = parse_failures(failures, source)
            batch.finished = parse_failures(finished, source, terminal=True)
            batch.capabilities.append("history")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("history_unavailable", error))
        batch.qos = list(qos.values())
        batch.cluster_state = cluster_state(batch.nodes, require_partition=True)
        return batch
