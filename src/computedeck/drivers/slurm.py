"""Read-only Slurm collection over SSH: own jobs, visible nodes, QoS limits, recent failures."""

import asyncio
import re
import shlex
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
    message,
    now,
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
)
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
        match = re.fullmatch(r"(?:gres/)?gpu(?::([^:=]+))?[:=](\d+)", part.strip())
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
        job_id = f"{source['cluster_id']}:{row['JobArrayID']}"
        jobs[job_id] = {
            "id": job_id,
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


def parse_failures(output: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    """sacct allocations in a failure state. Only terminal accounting records count."""
    failures: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for line in output.splitlines():
        if not line.strip():
            continue
        columns = line.split("|")
        if len(columns) != len(_HISTORY_FIELDS):
            raise SourceError("unexpected_output", command="sacct")
        row = dict(zip(_HISTORY_FIELDS, columns, strict=True))
        state = row["State"].split(" ", 1)[0].rstrip("+").upper()
        if row["User"] != source["username"] or state not in FAILURE_STATES:
            continue
        if row["End"] in EMPTY:
            continue
        job_id = f"{source['cluster_id']}:{row['JobID']}"
        previous = failures.get(job_id)
        # Requeued jobs can appear more than once; keep the latest attempt.
        if previous and previous["end"] >= row["End"]:
            continue
        failures[job_id] = {
            "id": job_id,
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
            "reason": None,
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "end": row["End"],
            "exit_code": None if row["ExitCode"] in EMPTY else row["ExitCode"],
            "observed_at": observed_at,
        }
    return sorted(failures.values(), key=lambda job: job["end"], reverse=True)


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
        batch = Batch(capabilities=["jobs"])
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
            batch.failures = parse_failures(await ssh.run(alias, history, options), source)
            batch.capabilities.append("history")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("history_unavailable", error))
        if qos:
            batch.qos = list(qos.values())
        batch.cluster_state = cluster_state(batch.nodes)
        return batch
