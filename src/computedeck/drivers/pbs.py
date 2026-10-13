"""Read-only OpenPBS / PBS Professional collection over SSH.

Own jobs, visible nodes, queue limits and recent failures, all from the JSON output of
``qstat -F json`` and ``pbsnodes -F json``. Commands, options and JSON layout were checked
against the OpenPBS source, not against a live server:

- https://github.com/openpbs/openpbs/blob/master/src/cmds/qstat.c
- https://github.com/openpbs/openpbs/blob/master/src/cmds/qselect.c
- https://github.com/openpbs/openpbs/blob/master/src/cmds/pbsnodes.c
- https://github.com/openpbs/openpbs/blob/master/src/lib/Libjson/cJSON/pbs_cjson.c

GPUs are read from ``ngpus``, the host-level resource PBS sites define for GPU scheduling
(``pbsnodes -S`` reports it by that name). PBS has no built-in GPU resource, so a site that
names it differently gets unknown GPU counts and a ``gpu_count_unknown`` warning.
"""

import json
import re
import shlex
from datetime import datetime, timedelta
from typing import Any, ClassVar, Literal

from ..ssh_config import validate_alias, validate_username
from . import ssh
from .base import (
    EMPTY,
    Batch,
    DriverCheck,
    DriverInfo,
    SourceError,
    integer,
    message,
    now,
    ssh_alias_field,
    username_field,
)

GPU = "ngpus"
# Site-defined resources that may name a GPU model; none of them is a PBS built-in.
MODEL_KEYS = ("gpu_model", "gpu_type", "accelerator_model")

# qstat rejects -F json together with -u ("conflicting options": -u is an alternate-format
# option), so qselect lists the owner's unfinished jobs on the server and qstat reads them.
# The user name arrives as "$1" and is never spliced into the script; set -f keeps array
# ids such as "12[].server" from being globbed; -t expands arrays into their subjobs.
_JOBS_SCRIPT = (
    'set -f; ids=$(qselect -u "$1") || exit 1; [ -z "$ids" ] || exec qstat -f -F json -t $ids'
)
# The remote clock, the server attributes (is job history enabled?), then the user's
# finished jobs (-H: states F and M, history included) last modified in the past 24 hours.
# qselect -t takes [[CC]YY]MMDDhhmm in the server's local time, hence date(1) on the remote.
_HISTORY_SCRIPT = (
    "set -f; now=$(date +%Y-%m-%dT%H:%M:%S) && "
    'since=$(date -d "24 hours ago" +%Y%m%d%H%M) || exit 1; '
    'echo "$now"; qstat -B -f -F json || exit 1; '
    'ids=$(qselect -H -u "$1" -tm.gt."$since") || exit 1; '
    '[ -z "$ids" ] || exec qstat -x -f -F json $ids'
)
NODES_COMMAND = "pbsnodes -a -F json"
QUEUES_COMMAND = "qstat -Q -f -F json"

# Job state letters (src/include/job.h) in the vocabulary the web app understands.
STATES = {
    "Q": "PENDING",
    "H": "PENDING",
    "W": "PENDING",
    "T": "PENDING",
    "R": "RUNNING",
    "E": "COMPLETING",
    "S": "SUSPENDED",
    "U": "SUSPENDED",
}
FINISHED = {"F", "X", "M"}
# Negative exit statuses PBS sets itself (JOB_EXEC_KILL_* in src/include/job.h).
EXIT_STATES = {-29: "TIMEOUT", -27: "OUT_OF_MEMORY", -26: "OUT_OF_MEMORY"}
# pbsnodes states whose PBS name the web app would not recognise as unavailable or busy.
NODE_STATES = {
    "offline": "drain",
    "down": "down",
    "state-unknown": "unknown",
    "stale": "unknown",
    "unresolvable": "down",
    "job-busy": "allocated",
    "job-exclusive": "allocated",
    "resv-exclusive": "reserved",
}
_ENTITY = re.compile(r"\[\s*([ougp])\s*:\s*([^=\]]+?)\s*=\s*([^\]]*?)\s*\]")
_ZERO = re.compile(r"0+(?:\.0+)?\s*[kmgtp]?[bw]?", re.IGNORECASE)


def _script(script: str, username: str) -> str:
    return shlex.join(["sh", "-c", script, "sh", username])


def _repair(text: str) -> str:
    # Defensive: a value printed with an unescaped backslash (e.g. "\," in Variable_List)
    # would otherwise make the whole job list unreadable.
    return re.sub(
        r"\\(.)",
        lambda match: match.group(0) if match.group(1) in '"\\/bfnrtu' else "\\" + match.group(0),
        text,
        flags=re.DOTALL,
    )


def _decode_all(text: str) -> list[dict[str, Any]]:
    decoder = json.JSONDecoder(strict=False)
    found: list[dict[str, Any]] = []
    index = 0
    while True:
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            return found
        document, index = decoder.raw_decode(text, index)
        if not isinstance(document, dict):
            raise ValueError("not a JSON object")
        found.append(document)


def documents(text: str, command: str) -> list[dict[str, Any]]:
    """Every JSON object printed by ``command``, in order."""
    for attempt in (text, _repair(text)):
        try:
            return _decode_all(attempt)
        except ValueError:
            continue
    raise SourceError("unexpected_output", command=command)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _entries(document: dict[str, Any], key: str, command: str) -> dict[str, dict[str, Any]]:
    value = document.get(key, {})
    if not isinstance(value, dict) or not all(isinstance(item, dict) for item in value.values()):
        raise SourceError("unexpected_output", command=command)
    return value


def _true(value: Any) -> bool:
    return value is True or str(value).strip().lower() in {"true", "t", "1", "y", "yes"}


def _false(value: Any) -> bool:
    return value is False or str(value).strip().lower() in {"false", "f", "0", "n", "no"}


def _nonzero(value: Any) -> bool:
    if value is None or value is False:
        return False
    text = str(value).strip()
    return text not in EMPTY and text.lower() != "false" and not _ZERO.fullmatch(text)


def _gpu_evidence(*mappings: dict[str, Any]) -> bool:
    """A non-zero GPU-like resource other than ``ngpus``: GPUs we cannot count."""
    return any(
        key != GPU and ("gpu" in key.lower() or "accelerator" in key.lower()) and _nonzero(value)
        for mapping in mappings
        for key, value in mapping.items()
    )


def _gpu_model(*mappings: dict[str, Any]) -> str | None:
    models = [
        str(mapping[key])
        for mapping in mappings
        for key in MODEL_KEYS
        if key in mapping and str(mapping[key]) not in EMPTY
    ]
    return ", ".join(dict.fromkeys(models)) or None


def chunks(spec: Any, *, counted: bool = True) -> list[tuple[int, dict[str, str]]]:
    """``select`` (``2:ncpus=8:ngpus=4+1:ncpus=2``) or, with ``counted=False``, ``exec_vnode``
    (``(node001:ncpus=8:ngpus=2)+(node002:ncpus=8:ngpus=2)``) as (count, resources) pairs."""
    if not isinstance(spec, str) or not spec.strip():
        return []
    result = []
    for part in spec.replace("(", "").replace(")", "").split("+"):
        fields = [field.strip() for field in part.split(":") if field.strip()]
        count = 1
        if counted and fields and fields[0].isdigit():
            count = int(fields.pop(0))
        values = {}
        for field in fields:
            key, separator, value = field.partition("=")
            if separator:  # the vnode name of an exec_vnode chunk has no "="
                values[key] = value
        result.append((count, values))
    return result


def job_gpu_count(job: dict[str, Any]) -> int | None:
    """Job-wide ngpus, else the sum over exec_vnode or select chunks; unknown is ``None``."""
    resources = _mapping(job.get("Resource_List"))
    if GPU in resources:
        return integer(resources[GPU])
    selected = chunks(resources.get("select"))
    for parts in (chunks(job.get("exec_vnode"), counted=False), selected):
        if any(GPU in values for _, values in parts):
            counts = [integer(values.get(GPU, 0)) for _, values in parts]
            if any(count is None for count in counts):
                return None
            return sum(n * (gpus or 0) for (n, _), gpus in zip(parts, counts, strict=True))
    if _gpu_evidence(resources, *(values for _, values in selected)):
        return None
    # A resource request that names no GPU resource at all is evidence of no GPUs.
    return 0 if resources else None


def _owned(job: dict[str, Any], username: str) -> bool:
    user = username.split("@", 1)[0]
    owner = str(job.get("Job_Owner", ""))
    return owner == username or owner.split("@", 1)[0] == user or job.get("euser") == user


def _short_id(job_id: str) -> str:
    # "1234[5].server" -> "1234[5]"; the cluster id already scopes the server.
    return job_id.split(".", 1)[0]


def _hosts(exec_host: Any) -> str | None:
    if not isinstance(exec_host, str):
        return None
    names = [part.split("/", 1)[0].strip() for part in exec_host.split("+")]
    return ",".join(dict.fromkeys(name for name in names if name and name not in EMPTY)) or None


def seconds(value: Any) -> int | None:
    """A PBS duration: seconds, or [hours:]minutes:seconds with unbounded hours."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return integer(value)
    match = re.fullmatch(r"\s*(?:(\d+):)?(\d+):(\d{1,2})\s*", str(value or ""))
    if match:
        hours, minutes, secs = (int(group or 0) for group in match.groups())
        return hours * 3600 + minutes * 60 + secs
    return integer(str(value).strip()) if str(value or "").strip().isdigit() else None


def duration(total: int) -> str:
    """Slurm's elapsed-time layout ([D-]H:MM:SS or M:SS), which the web app parses."""
    days, rest = divmod(total, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f"{days}-{hours:02d}:{minutes:02d}:{secs:02d}"
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _elapsed(job: dict[str, Any]) -> str:
    used = seconds(_mapping(job.get("resources_used")).get("walltime"))
    return duration(used) if used is not None else ""


def _reason(job: dict[str, Any], letter: str) -> str | None:
    comment = str(job.get("comment") or "").strip()
    if comment.startswith("Not Running:"):
        comment = comment[len("Not Running:") :].strip()
    if comment and comment not in EMPTY:
        return comment
    return "Held" if letter == "H" else None


def _job(job_id: str, job: dict[str, Any], state: str, source: dict[str, Any]) -> dict[str, Any]:
    resources = _mapping(job.get("Resource_List"))
    queue = str(job.get("queue") or "")
    key = f"{source['cluster_id']}:{_short_id(job_id)}"
    return {
        "id": key,
        "source_id": source["id"],
        "cluster_id": source["cluster_id"],
        "name": str(job.get("Job_Name") or ""),
        "user": str(job.get("Job_Owner") or "").split("@", 1)[0] or str(job.get("euser") or ""),
        "account": str(job.get("Account_Name") or ""),
        # PBS has no QoS. Queues carry the limits, so a job's queue is also its "qos":
        # the web app compares a limit with the jobs whose qos has the limit's name.
        "partition": queue,
        "qos": queue,
        "state": state,
        "gpu_count": job_gpu_count(job),
        "gpu_type": _gpu_model(
            resources, *(values for _, values in chunks(resources.get("select")))
        ),
        "cpu_count": integer(resources.get("ncpus")),
        "node": _hosts(job.get("exec_host")),
        "elapsed": _elapsed(job),
        "reason": None,
        "gpu_utilization": None,
        "cpu_utilization": None,
        "memory_utilization": None,
    }


def parse_jobs(output: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    """``qstat -f -F json -t`` of the user's unfinished jobs; empty output means none."""
    jobs: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for document in documents(output, "qstat"):
        for job_id, job in _entries(document, "Jobs", "qstat").items():
            # With -t an array appears as its parent ("12[]") and its subjobs; count subjobs.
            if "[]" in job_id or not _owned(job, source["username"]):
                continue
            letter = str(job.get("job_state", "")).strip().upper()
            if letter in FINISHED:
                continue
            state = STATES.get(letter, letter or "UNKNOWN")
            row = _job(job_id, job, state, source)
            row["reason"] = _reason(job, letter) if state == "PENDING" else None
            row["observed_at"] = observed_at
            jobs[row["id"]] = row
    return list(jobs.values())


def node_gpu_count(available: dict[str, Any]) -> int | None:
    if GPU in available:
        return integer(available[GPU])
    if not available or _gpu_evidence(available):
        return None
    return 0


def _assigned(assigned: dict[str, Any], resource: str, capacity: int | None) -> int | None:
    # pbsnodes -F json leaves zero values out of resources_assigned (pbsnodes.c
    # encode_to_json, pbs_cjson.c pbs_json_insert_parsed), so absent means none assigned.
    if resource in assigned:
        return integer(assigned[resource])
    return 0 if capacity is not None else None


def _node_state(raw: Any, busy: bool) -> str:
    states = []
    for token in str(raw or "").lower().split(","):
        token = token.strip()
        if not token:
            continue
        state = ("mixed" if busy else "idle") if token == "free" else NODE_STATES.get(token, token)
        if state not in states:
            states.append(state)
    return "+".join(states) or "unknown"


def parse_nodes(output: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    """``pbsnodes -a -F json``. One entry per vnode."""
    parsed = documents(output, "pbsnodes")
    if len(parsed) != 1 or "nodes" not in parsed[0]:
        raise SourceError("unexpected_output", command="pbsnodes")
    nodes: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for name, node in _entries(parsed[0], "nodes", "pbsnodes").items():
        if "state" not in node and "resources_available" not in node:
            continue  # pbsnodes reports a per-node query error in place of attributes
        available = _mapping(node.get("resources_available"))
        assigned = _mapping(node.get("resources_assigned"))
        capacity = node_gpu_count(available)
        cpus = integer(available.get("ncpus"))
        allocated = _assigned(assigned, GPU, capacity)
        cpu_allocated = _assigned(assigned, "ncpus", cpus)
        busy = bool(node.get("jobs")) or bool(cpu_allocated) or bool(allocated)
        node_id = f"{source['cluster_id']}:{name}"
        nodes[node_id] = {
            "id": node_id,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": name,
            "state": _node_state(node.get("state"), busy),
            "gpu_count": capacity,
            "gpu_allocated": allocated,
            "gpu_type": _gpu_model(available),
            "cpu_count": cpus,
            "cpu_allocated": cpu_allocated,
            "partitions": [str(node["queue"])] if str(node.get("queue") or "") else [],
            "observed_at": observed_at,
        }
    return list(nodes.values())


def entity_limit(value: Any, user: str | None) -> int | None:
    """A limit such as ``[o:PBS_ALL=64],[u:PBS_GENERIC=8],[u:alice=16]``.

    ``user`` picks the user's own entry before the generic one; ``None`` picks the overall
    (``o:PBS_ALL``) limit. Group and project entries cannot be matched to a login.
    """
    entries = _ENTITY.findall(str(value or ""))
    if user is None:
        values = [limit for kind, name, limit in entries if kind == "o" and name == "PBS_ALL"]
    else:
        values = [limit for kind, name, limit in entries if kind == "u" and name == user] or [
            limit for kind, name, limit in entries if kind == "u" and name == "PBS_GENERIC"
        ]
    return integer(values[0]) if values else None


def queue_limits(queue: dict[str, Any], username: str) -> dict[str, str | None]:
    """A queue's limits in the keys the web app reads from Slurm QoS records."""
    user = username.split("@", 1)[0]
    run_res = _mapping(queue.get("max_run_res"))
    maximum = _mapping(queue.get("resources_max"))
    limits: dict[str, str | None] = {}
    gpus = entity_limit(run_res.get(GPU), user)
    if gpus is None:  # the older per-user form of the same limit
        gpus = integer(_mapping(queue.get("max_user_res")).get(GPU))
    if gpus is not None:
        limits["MaxTRESPU"] = f"gres/gpu={gpus}"
    overall = entity_limit(run_res.get(GPU), None)
    if overall is not None:
        limits["GrpTRES"] = f"gres/gpu={overall}"
    jobs = entity_limit(queue.get("max_run"), user)
    if jobs is None:
        jobs = integer(queue.get("max_user_run"))
    if jobs is not None:
        limits["MaxJobsPU"] = str(jobs)
    submitted = entity_limit(queue.get("max_queued"), user)
    if submitted is not None:
        limits["MaxSubmitJobsPU"] = str(submitted)
    per_job = integer(maximum.get(GPU))
    if per_job is not None:
        limits["MaxTRESPJ"] = f"gres/gpu={per_job}"
    wall = seconds(maximum.get("walltime"))
    if wall is not None:
        limits["MaxWallPJ"] = str(-(-wall // 60))  # minutes, as Slurm reports MaxWallPJ
    return limits


def parse_queues(output: str, username: str) -> list[dict[str, Any]]:
    """Enabled, started execution queues from ``qstat -Q -f -F json``."""
    parsed = documents(output, "qstat -Q")
    if len(parsed) != 1:
        raise SourceError("unexpected_output", command="qstat -Q")
    result = []
    for name, queue in _entries(parsed[0], "Queue", "qstat -Q").items():
        if str(queue.get("queue_type", "")).strip().lower() != "execution":
            continue
        if _false(queue.get("enabled")) or _false(queue.get("started")):
            continue
        result.append(
            {
                "name": name,
                "limits": queue_limits(queue, username),
                # Queue ACLs are not evaluated; the user may not be allowed to submit here.
                "origin": "scheduler_queue_access_unverified",
            }
        )
    return result


def pbs_time(value: Any) -> datetime | None:
    """qstat prints times through ctime(3): ``Mon Jan  5 10:00:00 2026``, server-local."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(" ".join(value.split()), "%a %b %d %H:%M:%S %Y")
    except ValueError:
        return None


def _exit_status(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        return None


def parse_failures(output: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    """Finished jobs with a non-zero exit status that ended in the last 24 hours."""
    clock, _, rest = output.partition("\n")
    try:
        remote_now = datetime.fromisoformat(clock.strip())
    except ValueError:
        raise SourceError("unexpected_output", command="qstat -x") from None
    parsed = documents(rest, "qstat -x")
    if not parsed or "Server" not in parsed[0]:
        raise SourceError("unexpected_output", command="qstat -x")
    servers = _entries(parsed[0], "Server", "qstat -x").values()
    # Without job history qselect -H selects nothing and exits 0 (qselect.c), which
    # would read as "no failures"; report history as unavailable instead.
    if not any(_true(server.get("job_history_enable")) for server in servers):
        raise SourceError("history_unavailable", "job_history_enable is not set")
    since = remote_now - timedelta(hours=24)
    failures: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for document in parsed[1:]:
        for job_id, job in _entries(document, "Jobs", "qstat -x").items():
            if not _owned(job, source["username"]):
                continue
            if str(job.get("job_state", "")).strip().upper() not in {"F", "X"}:
                continue
            code = _exit_status(job.get("Exit_status"))
            end = pbs_time(job.get("obittime"))
            if not code or end is None or end < since:
                continue
            # Substate 91 (TERMINATED) is a job deleted with qdel; walltime and memory
            # kills keep their own exit codes and still count.
            if _exit_status(job.get("substate")) == 91 and code not in EXIT_STATES:
                continue
            row = _job(job_id, job, EXIT_STATES.get(code, "FAILED"), source)
            row.update(end=end.isoformat(), exit_code=str(code), observed_at=observed_at)
            failures[row["id"]] = row
    return sorted(failures.values(), key=lambda job: job["end"], reverse=True)


def _unavailable(code: str, error: BaseException) -> dict[str, Any]:
    return message(code, detail=str(error)[:180] or type(error).__name__)


def _unknown_gpus(rows: list[dict[str, Any]], *keys: str) -> bool:
    return any(row[key] is None for row in rows for key in keys)


class PbsDriver:
    name: ClassVar[str] = "pbs"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "PBS cluster", "zh-CN": "PBS 集群"},
        description={
            "en": "Your jobs, visible nodes and queue limits on OpenPBS or PBS Professional, "
            "read through SSH.",
            "zh-CN": "通过 SSH 读取 OpenPBS 或 PBS Professional 上你的作业、可见节点和队列上限。",
        },
        details={
            "en": "Read-only qselect, qstat and pbsnodes queries with JSON output, through an "
            "SSH host alias on {where}. ProxyJump and keys come from that SSH config. GPUs are "
            "read from the ngpus resource; failures need job history on the server.",
            "zh-CN": "通过{where}的 SSH Host 别名只读调用 qselect、qstat 和 pbsnodes（JSON 输出）。"
            "ProxyJump 和密钥沿用该 SSH 配置。GPU 数量读取 ngpus 资源；"
            "失败记录需要服务器开启作业历史。",
        },
        fields=[username_field(), ssh_alias_field()],
        checks=[
            DriverCheck(
                capability="jobs",
                command="qstat",
                label={"en": "Your jobs (qstat)", "zh-CN": "你的作业（qstat）"},
            ),
            DriverCheck(
                capability="nodes",
                command="pbsnodes",
                label={"en": "Visible nodes (pbsnodes)", "zh-CN": "可见节点（pbsnodes）"},
                warning="nodes_unavailable",
            ),
            DriverCheck(
                capability="qos_limits",
                command="qstat -Q",
                label={"en": "Queue limits (qstat -Q)", "zh-CN": "队列上限（qstat -Q）"},
                warning="qos_unavailable",
            ),
            DriverCheck(
                capability="history",
                command="qstat -x",
                label={
                    "en": "Failures in the last 24 h (qstat -x)",
                    "zh-CN": "24 小时内的失败（qstat -x）",
                },
                warning="history_unavailable",
            ),
        ],
        name_placeholder="Cluster A",
        beta=True,
    )

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("ssh_alias") or not source.get("username"):
            raise SourceError("cluster_connection_required")
        if source["ssh_alias"].startswith("-"):
            raise SourceError("invalid_ssh_alias")

    async def _jobs(self, alias: str, username: str, options: list[str]) -> str:
        command = _script(_JOBS_SCRIPT, username)
        try:
            return await ssh.run(alias, command, options)
        except ssh.SSHError as error:
            # A job can finish between qselect and qstat; qstat then exits non-zero.
            if "unknown job id" not in str(error).lower():
                raise
        return await ssh.run(alias, command, options)

    async def collect(self, source: dict[str, Any]) -> Batch:
        alias = validate_alias(source.get("ssh_alias") or "")
        username = validate_username(source["username"])
        options = ["-l", username]
        try:
            jobs = parse_jobs(await self._jobs(alias, username, options), source)
        except ssh.SSHError as error:
            raise SourceError("ssh_failed", str(error)) from None
        except TimeoutError:
            raise SourceError("ssh_timeout") from None
        batch = Batch(jobs=jobs, capabilities=["jobs"])
        if _unknown_gpus(jobs, "gpu_count"):
            batch.warnings.append(message("gpu_count_unknown", command="qstat"))
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
            batch.nodes = parse_nodes(await ssh.run(alias, NODES_COMMAND, options), source)
            batch.capabilities.append("nodes")
            if _unknown_gpus(batch.nodes, "gpu_count", "gpu_allocated"):
                batch.warnings.append(message("gpu_count_unknown", command="pbsnodes"))
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("nodes_unavailable", error))
        try:
            queues = parse_queues(await ssh.run(alias, QUEUES_COMMAND, options), username)
            qos.update({queue["name"]: queue for queue in queues})
            batch.capabilities.append("qos_limits")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("qos_unavailable", error))
        try:
            history = await ssh.run(alias, _script(_HISTORY_SCRIPT, username), options)
            batch.failures = parse_failures(history, source)
            batch.capabilities.append("history")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("history_unavailable", error))
        if qos:
            batch.qos = list(qos.values())
        return batch
