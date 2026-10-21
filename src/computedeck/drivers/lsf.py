"""Read-only IBM Spectrum LSF collection over SSH.

Own jobs, visible hosts, queue and GPU limits, and recently finished failures. Jobs, hosts
and queues come from ``-o ... -json`` output (LSF 10.1 Fix Pack 2 or later); GPU models and
GPU limits only exist as text tables. Field names were checked against the IBM Spectrum LSF
10.1 command reference, not against a live cluster:

- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bjobs.o.1.html
- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bjobs.d.1.html
- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bhosts.1.html
- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/lshosts.1.html
- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bqueues.1.html
- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/blimits.1.html
- https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_release_notes/lsf_relnotes_cmdout10.1.0.2.html

The GPU fields of ``bjobs -o`` and ``bhosts -o`` are documented without the fix pack that
added them, and their values for jobs and hosts without GPUs are not documented. Releases
that reject them are read without GPU fields; unknown GPU counts stay ``None`` and add a
``gpu_count_unknown`` warning.
"""

import json
import re
import shlex
from collections.abc import Callable
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
    cluster_state,
    integer,
    message,
    now,
    ssh_alias_field,
    username_field,
)
from .pbs import duration

# -o field names (bjobs.o.1.html). JSON keys are the canonical names in upper case.
JOB_FIELDS = (
    "jobid",
    "jobindex",
    "job_name",
    "user",
    "queue",
    "stat",
    "pend_reason",
    "submit_time",
    "start_time",
    "exec_host",
    "slots",
    "run_time",
    "proj_name",
)
HISTORY_FIELDS = (
    "jobid",
    "jobindex",
    "job_name",
    "user",
    "queue",
    "stat",
    "exec_host",
    "slots",
    "run_time",
    "proj_name",
    "exit_code",
    "finish_time",
)
# Optional fields; a release that does not know one of them rejects the whole -o list.
GPU_JOB_FIELDS = ("gpu_num", "gpu_alloc")
HISTORY_EXTRA_FIELDS = ("exit_reason", *GPU_JOB_FIELDS)
HOST_FIELDS = ("host_name", "status", "max", "njobs")
GPU_HOST_FIELDS = ("ngpus", "ngpus_alloc")
QUEUE_FIELDS = ("queue_name", "status", "max_runlimit")
GPU_INVENTORY_COMMAND = "lshosts -gpu -w"
# Remote local time, so finish times without a year can be dated and windowed.
CLOCK = shlex.join(["date", "+%Y-%m-%dT%H:%M:%S%z"])
HISTORY_MARKER = "COMPUTEDECK_LSF_HISTORY"
# Optional configuration read in the existing history SSH call. Failure leaves the
# retention window unknown and must not prevent bjobs from running.
HISTORY_CONFIG = shlex.join(["sh", "-c", "bparams -l 2>/dev/null || true"])

STATES = {
    "PEND": "PENDING",
    "PSUSP": "PENDING",
    "WAIT": "PENDING",
    "RUN": "RUNNING",
    "USUSP": "SUSPENDED",
    "SSUSP": "SUSPENDED",
    "PROV": "CONFIGURING",
    "UNKWN": "UNKNOWN",
}
FINISHED = {"DONE", "EXIT"}
# bhosts statuses whose LSF name the web app would not recognise as unavailable or busy.
HOST_STATES = {
    "closed_full": "allocated",
    "closed_excl": "allocated",
    "closed_cu_excl": "allocated",
    "closed_adm": "drain",
    "closed_lock": "drain",
    "closed_lim": "not_responding",
    "unreach": "not_responding",
    "unavail": "down",
    "unlicensed": "invalid",
}
# Consumer columns of blimits; every other column is a resource limit "used/limit".
CONSUMERS = {"NAME", "USERS", "QUEUES", "HOSTS", "PROJECTS", "APPS", "LIC_PROJECTS", "CLUSTER"}
# GPU limit resources, preferred first: ngpus_physical with LSB_GPU_NEW_SYNTAX, else ngpus.
GPU_LIMITS = ("ngpus_physical", "ngpus")
# bjobs reports an empty selection on stderr; blimits says it has nothing to show.
NO_JOBS = re.compile(r"\bNo (?:unfinished |matching )?jobs? found\b", re.IGNORECASE)
NO_LIMITS = re.compile(r"\bNo resource usage found\b", re.IGNORECASE)
CANCELLED = re.compile(r"\bTERM_(?:FORCE_)?(?:OWNER|ADMIN)\b|\bkilled by owner\b", re.IGNORECASE)
MONTHS = {
    month: number
    for number, month in enumerate(
        ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1
    )
}
_STAMP = re.compile(
    r"\b(" + "|".join(MONTHS) + r")\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+(\d{4}))?"
)


def _blank(value: Any) -> bool:
    return str(value if value is not None else "").strip() in EMPTY | {"-"}


def records(text: str, command: str, *, empty: bool) -> list[dict[str, str]]:
    """RECORDS of ``-o ... -json`` output; ``empty`` allows no output at all."""
    start = text.find("{")
    if start < 0:
        if text.strip() or not empty:
            raise SourceError("unexpected_output", command=command)
        return []
    try:
        # Text before the object (e.g. a "please wait" notice) is not part of the data.
        document, _ = json.JSONDecoder(strict=False).raw_decode(text, start)
    except ValueError:
        raise SourceError("unexpected_output", command=command) from None
    rows = document.get("RECORDS") if isinstance(document, dict) else None
    if not isinstance(rows, list):
        raise SourceError("unexpected_output", command=command)
    return [
        {
            str(key).upper(): "" if value is None else str(value).strip()
            for key, value in row.items()
        }
        for row in rows
        if isinstance(row, dict)
    ]


def _job_id(row: dict[str, str], command: str) -> str:
    job_id, index = row.get("JOBID", ""), row.get("JOBINDEX", "")
    if not re.fullmatch(r"\d+(?:\[\d+\])?", job_id):
        raise SourceError("unexpected_output", command=command)
    # Array elements are listed one by one; jobindex is 0 for ordinary jobs.
    return job_id if "[" in job_id or _blank(index) or index == "0" else f"{job_id}[{index}]"


def _hosts(exec_host: str) -> str | None:
    # "4*hostA:2*hostB" or "hostA:hostA:hostB"
    names = [part.split("*")[-1] for part in re.split(r"[:\s]+", exec_host) if part]
    return ",".join(dict.fromkeys(name for name in names if not _blank(name))) or None


def run_seconds(value: str) -> int | None:
    """run_time in seconds ("4800 second(s)"), or hh:mm:ss when LSB_HMS is set."""
    match = re.fullmatch(r"(\d+)(?:\s*second\(s\))?", value.strip())
    if match:
        return int(match.group(1))
    match = re.fullmatch(r"(\d+):(\d{1,2}):(\d{1,2})", value.strip())
    if match:
        hours, minutes, secs = (int(group) for group in match.groups())
        return hours * 3600 + minutes * 60 + secs
    return None


def job_gpu_count(row: dict[str, str], state: str) -> int | None:
    count = integer(row.get("GPU_NUM"))
    if count is not None:
        return count
    # A job that runs with neither a GPU count nor a GPU allocation holds no GPUs.
    if (
        state in {"RUNNING", "SUSPENDED"}
        and _blank(row.get("GPU_NUM"))
        and _blank(row.get("GPU_ALLOC"))
    ):
        return 0
    return None


def _job(row: dict[str, str], state: str, source: dict[str, Any], command: str) -> dict[str, Any]:
    job_id = _job_id(row, command)
    key = f"{source['cluster_id']}:{job_id}"
    array = re.fullmatch(r"(\d+)\[(\d+)\]", job_id)
    if array and int(array[2]) == 0:
        array = None
    elapsed = run_seconds(row.get("RUN_TIME", ""))
    queue = row.get("QUEUE", "")
    return {
        "id": key,
        "array_id": array[1] if array else None,
        "array_index": array[2] if array else None,
        "source_id": source["id"],
        "cluster_id": source["cluster_id"],
        "name": row.get("JOB_NAME", ""),
        "user": row.get("USER", ""),
        "account": "" if _blank(row.get("PROJ_NAME")) else row["PROJ_NAME"],
        # A queue carries LSF's limits, so it is also the job's "qos": the web app compares
        # a limit with the jobs whose qos has the limit's name.
        "partition": queue,
        "qos": queue,
        "state": state,
        "gpu_count": job_gpu_count(row, state) if "GPU_NUM" in row else None,
        "gpu_type": None,
        "cpu_count": integer(row.get("SLOTS")),
        "node": _hosts(row.get("EXEC_HOST", "")),
        "elapsed": duration(elapsed) if elapsed is not None else "",
        "submitted_at": None if _blank(row.get("SUBMIT_TIME")) else row["SUBMIT_TIME"],
        "started_at": (
            row.get("START_TIME")
            if state != "PENDING" and not _blank(row.get("START_TIME"))
            else None
        ),
        "reason": None,
        "gpu_utilization": None,
        "cpu_utilization": None,
        "memory_utilization": None,
    }


def parse_jobs(rows: list[dict[str, str]], source: dict[str, Any]) -> list[dict[str, Any]]:
    """``bjobs -u <user> -o ... -json``: unfinished jobs, one record per array element."""
    jobs: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for row in rows:
        stat = row.get("STAT", "").upper()
        if row.get("USER") != source["username"] or stat in FINISHED:
            continue
        state = STATES.get(stat, stat or "UNKNOWN")
        job = _job(row, state, source, "bjobs")
        if stat == "PSUSP":
            job["reason"] = "Held"
        elif state == "PENDING" and not _blank(row.get("PEND_REASON")):
            job["reason"] = row["PEND_REASON"]
        job["observed_at"] = observed_at
        jobs[job["id"]] = job
    return list(jobs.values())


def parse_gpu_inventory(output: str) -> dict[str, list[str]]:
    """``lshosts -gpu -w``: one line per GPU; the host name only on its first GPU."""
    header: list[str] | None = None
    host: str | None = None
    result: dict[str, list[str]] = {}
    for line in output.splitlines():
        tokens = line.split()
        if not tokens:
            continue
        if tokens[0] == "HOST_NAME":
            header = [token.lower() for token in tokens]
            continue
        if header is None or not {"host_name", "gpu_id", "gpu_model"} <= set(header):
            raise SourceError("unexpected_output", command="lshosts -gpu")
        if line[0].isspace() and host is not None:
            tokens = [host, *tokens]
        if len(tokens) != len(header):
            raise SourceError("unexpected_output", command="lshosts -gpu")
        row = dict(zip(header, tokens, strict=True))
        if not row["gpu_id"].isdigit():
            raise SourceError("unexpected_output", command="lshosts -gpu")
        host = row["host_name"]
        result.setdefault(host, []).append(row["gpu_model"])
    return result


def _host_state(status: str, jobs: int | None) -> str:
    state = status.strip().lower()
    if state == "ok":
        return "ok" if jobs is None else "mixed" if jobs else "idle"
    return HOST_STATES.get(state, state or "unknown")


def parse_hosts(
    rows: list[dict[str, str]], source: dict[str, Any], inventory: dict[str, list[str]] | None
) -> list[dict[str, Any]]:
    """``bhosts -o ... -json``. ``inventory`` is the GPU list of ``lshosts -gpu``, if read."""
    hosts: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for row in rows:
        name = row.get("HOST_NAME", "")
        if not name:
            raise SourceError("unexpected_output", command="bhosts")
        if name == "lost_and_found":
            continue
        jobs = integer(row.get("NJOBS"))
        capacity = integer(row.get("NGPUS"))
        if capacity is None and _blank(row.get("NGPUS")) and inventory is not None:
            # lshosts -gpu lists every GPU LSF detected; a host it omits has none.
            capacity = len(inventory.get(name, []))
        allocated = integer(row.get("NGPUS_ALLOC"))
        if allocated is None and _blank(row.get("NGPUS_ALLOC")) and (capacity == 0 or jobs == 0):
            allocated = 0
        models = inventory.get(name, []) if inventory else []
        host_id = f"{source['cluster_id']}:{name}"
        hosts[host_id] = {
            "id": host_id,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "name": name,
            "state": _host_state(row.get("STATUS", ""), jobs),
            "gpu_count": capacity,
            "gpu_allocated": allocated,
            "gpu_type": ", ".join(dict.fromkeys(models)) or None,
            # LSF counts job slots, not CPUs: MAX is the slot limit, NJOBS the tasks placed.
            "cpu_count": integer(row.get("MAX")),
            "cpu_allocated": jobs,
            "partitions": [],
            "observed_at": observed_at,
        }
    return list(hosts.values())


def run_limit_minutes(value: str) -> int | None:
    """RUNLIMIT in minutes, e.g. "1440.0 min" (possibly followed by the reference host)."""
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(?:\s*min\b.*)?", value.strip())
    if not match:
        return None
    minutes = float(match.group(1))
    return int(minutes) if minutes.is_integer() else int(minutes) + 1


def parse_queues(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Open queues that accept jobs from the user (``bqueues -u``), with their run limit."""
    result = []
    for row in rows:
        name = row.get("QUEUE_NAME", "")
        if not name:
            raise SourceError("unexpected_output", command="bqueues")
        if not row.get("STATUS", "").lower().startswith("open"):
            continue
        limits: dict[str, str | None] = {}
        minutes = run_limit_minutes(row.get("MAX_RUNLIMIT") or row.get("RUNLIMIT") or "")
        if minutes is not None:
            # Minutes, as Slurm reports MaxWallPJ. LSF scales RUNLIMIT by the CPU factor
            # of the execution host, so this is the limit on a reference host.
            limits["MaxWallPJ"] = str(minutes)
        result.append({"name": name, "limits": limits, "origin": "scheduler_queue"})
    return result


def _limit(value: str) -> int | None:
    match = re.fullmatch(r"(?:[\d.]+|-)/(\d+(?:\.0+)?)", value)
    return integer(match.group(1)) if match else None


def parse_limits(output: str, username: str) -> dict[str, dict[str, str]]:
    """Per-user GPU and job limits of single queues, from ``blimits -u <user>``.

    Limits that span several queues, hosts, projects or applications are left out: the web
    app compares a limit only with the jobs of the queue it is named after.
    """
    result: dict[str, dict[str, str]] = {}
    header: list[str] | None = None
    for line in output.splitlines():
        tokens = line.split()
        if not tokens or NO_LIMITS.search(line):
            continue
        if tokens[0] == "NAME":
            header = tokens
            continue
        if line.rstrip().endswith(":"):  # INTERNAL / EXTERNAL RESOURCE LIMITS:
            header = None
            continue
        if header is None:
            raise SourceError("unexpected_output", command="blimits")
        if len(tokens) != len(header):
            continue  # a value with spaces cannot be aligned with its column
        row = dict(zip(header, tokens, strict=True))
        queue = row.get("QUEUES", "-")
        # Hosts, projects, applications: "-" means the limit is not narrowed by them.
        scoped = [
            row[column] for column in header if column in CONSUMERS - {"NAME", "USERS", "QUEUES"}
        ]
        if (
            row.get("USERS") != username
            or queue in {"-", "all"}
            or any(char in queue for char in "*/")
            or any(value != "-" for value in scoped)
        ):
            continue
        by_name = {column.lower(): row[column] for column in header if column not in CONSUMERS}
        limits = result.setdefault(queue, {})
        gpus = next(
            (limit for name in GPU_LIMITS if (limit := _limit(by_name.get(name, ""))) is not None),
            None,
        )
        for key, value in (("MaxTRESPU", gpus), ("MaxJobsPU", _limit(by_name.get("jobs", "")))):
            if value is None:
                continue
            previous = integer(re.sub(r"^gres/gpu=", "", limits.get(key, "")))
            value = min(value, previous) if previous is not None else value
            limits[key] = f"gres/gpu={value}" if key == "MaxTRESPU" else str(value)
    return {queue: limits for queue, limits in result.items() if limits}


def finish_time(value: str, remote_now: datetime) -> datetime | None:
    """``Jan  5 10:00`` (no year unless configured) as a remote-local time not in the future."""
    match = _STAMP.search(value)
    if not match:
        return None
    month, day, hour, minute, second, year = match.groups()
    years = [int(year)] if year else [remote_now.year, remote_now.year - 1]
    for candidate in years:
        try:
            stamp = datetime(
                candidate,
                MONTHS[month],
                int(day),
                int(hour),
                int(minute),
                int(second or 0),
                tzinfo=remote_now.tzinfo,
            )
        except ValueError:
            continue
        # Allow for a clock difference between bjobs and date(1), not for a year.
        if year or stamp <= remote_now + timedelta(days=1):
            return stamp
    return None


def _failure_state(reason: str) -> str:
    if "TERM_RUNLIMIT" in reason.upper():
        return "TIMEOUT"
    if "TERM_MEMLIMIT" in reason.upper():
        return "OUT_OF_MEMORY"
    return "FAILED"


def parse_failures(
    output: str, source: dict[str, Any], *, terminal: bool = False
) -> list[dict[str, Any]]:
    """``date; bjobs -d``: the user's EXIT jobs that finished in the last 24 hours.

    ``bjobs -d`` only keeps jobs for CLEAN_PERIOD (lsb.params, one hour by default), so the
    window is the shorter of the two. Jobs killed by their owner or an administrator are
    cancellations, not failures.
    """
    if not output.strip():
        return []
    clock, _, rest = output.partition("\n")
    try:
        remote_now = datetime.fromisoformat(clock.strip())
    except ValueError:
        raise SourceError("unexpected_output", command="bjobs -d") from None
    since = remote_now - timedelta(hours=24)
    failures: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for row in records(rest, "bjobs -d", empty=True):
        reason = row.get("EXIT_REASON", "")
        states = {"EXIT", "DONE"} if terminal else {"EXIT"}
        if row.get("USER") != source["username"] or row.get("STAT", "").upper() not in states:
            continue
        if CANCELLED.search(reason) and not terminal:
            continue
        end = finish_time(row.get("FINISH_TIME", ""), remote_now)
        if end is None or end < since:
            continue
        state = (
            "COMPLETED"
            if row.get("STAT", "").upper() == "DONE"
            else "CANCELLED"
            if CANCELLED.search(reason)
            else _failure_state(reason)
        )
        job = _job(row, state, source, "bjobs -d")
        job.update(
            end=(end if terminal else end.replace(tzinfo=None)).isoformat(),
            ended_at=end.isoformat() if end.tzinfo else None,
            exit_code=None if _blank(row.get("EXIT_CODE")) else row["EXIT_CODE"],
            exit_status=integer(row.get("EXIT_CODE")),
            exit_signal=None,
            reason=None if _blank(reason) else reason,
            observed_at=observed_at,
        )
        failures[job["id"]] = job
    return sorted(failures.values(), key=lambda job: job["end"], reverse=True)


async def _quiet(alias: str, command: str, options: list[str], empty: re.Pattern[str]) -> str:
    """Run ``command``; an error that only says nothing matched is an empty result."""
    try:
        return await ssh.run(alias, command, options)
    except ssh.SSHError as error:
        if empty.search(str(error)):
            return ""
        raise


async def _with_optional(
    alias: str,
    build: Callable[[tuple[str, ...]], str],
    fields: tuple[str, ...],
    extra: tuple[str, ...],
    options: list[str],
) -> str:
    """Output with the optional fields, or without them when the release rejects them.

    Records then lack those keys, which the parsers read as unknown.
    """
    try:
        return await _quiet(alias, build((*fields, *extra)), options, NO_JOBS)
    except ssh.SSHError:
        pass
    if "exit_reason" in extra:
        try:
            return await _quiet(alias, build((*fields, "exit_reason")), options, NO_JOBS)
        except ssh.SSHError:
            pass
    return await _quiet(alias, build(fields), options, NO_JOBS)


def _formatted(command: str, *args: str) -> Callable[[tuple[str, ...]], str]:
    def build(fields: tuple[str, ...]) -> str:
        return shlex.join([command, *args, "-o", " ".join(fields), "-json"])

    return build


def _unavailable(code: str, error: BaseException) -> dict[str, Any]:
    return message(code, detail=str(error)[:180] or type(error).__name__)


def _unknown_gpus(rows: list[dict[str, Any]], *keys: str) -> bool:
    return any(row[key] is None for row in rows for key in keys)


class LsfDriver:
    name: ClassVar[str] = "lsf"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "LSF cluster", "zh-CN": "LSF 集群"},
        description={
            "en": "Your jobs, visible hosts and queue limits on IBM Spectrum LSF, "
            "read through SSH.",
            "zh-CN": "通过 SSH 读取 IBM Spectrum LSF 上你的作业、可见主机和队列上限。",
        },
        details={
            "en": "Read-only bjobs, bhosts, lshosts, bqueues, blimits and bparams queries through "
            "an SSH host alias on {where}. ProxyJump and keys come from that SSH config. "
            "Needs LSF 10.1 Fix Pack 2 or later for JSON output.",
            "zh-CN": "通过{where}的 SSH Host 别名只读调用 bjobs、bhosts、lshosts、"
            "bqueues、blimits 和 bparams。ProxyJump 和密钥沿用该 SSH 配置。"
            "JSON 输出需要 LSF 10.1 Fix Pack 2 或更高版本。",
        },
        fields=[username_field(), ssh_alias_field()],
        checks=[
            DriverCheck(
                capability="jobs",
                command="bjobs",
                label={"en": "Your jobs (bjobs)", "zh-CN": "你的作业（bjobs）"},
            ),
            DriverCheck(
                capability="nodes",
                command="bhosts",
                label={"en": "Visible hosts (bhosts)", "zh-CN": "可见主机（bhosts）"},
                warning="nodes_unavailable",
            ),
            DriverCheck(
                capability="qos_limits",
                command="limits",
                label={
                    "en": "Queue and GPU limits (bqueues, blimits)",
                    "zh-CN": "队列和 GPU 上限（bqueues、blimits）",
                },
                warning="qos_unavailable",
            ),
            DriverCheck(
                capability="history",
                command="bjobs -d",
                label={
                    "en": "Recent failures (bjobs -d)",
                    "zh-CN": "最近的失败（bjobs -d）",
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

    async def collect(self, source: dict[str, Any]) -> Batch:
        alias = validate_alias(source.get("ssh_alias") or "")
        username = validate_username(source["username"])
        options = ["-l", username]
        jobs_query = _formatted("bjobs", "-u", username)
        try:
            output = await _with_optional(alias, jobs_query, JOB_FIELDS, GPU_JOB_FIELDS, options)
            jobs = parse_jobs(records(output, "bjobs", empty=True), source)
        except ssh.SSHError as error:
            raise SourceError("ssh_failed", str(error)) from None
        except TimeoutError:
            raise SourceError("ssh_timeout") from None
        batch = Batch(jobs=jobs, capabilities=["jobs"])
        if _unknown_gpus(jobs, "gpu_count"):
            batch.warnings.append(message("gpu_count_unknown", command="bjobs"))
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
            output = await _with_optional(
                alias, _formatted("bhosts"), HOST_FIELDS, GPU_HOST_FIELDS, options
            )
            rows = records(output, "bhosts", empty=False)
            try:
                inventory: dict[str, list[str]] | None = parse_gpu_inventory(
                    await ssh.run(alias, GPU_INVENTORY_COMMAND, options)
                )
            except (RuntimeError, TimeoutError, SourceError):
                inventory = None  # GPU models are optional; counts fall back to unknown
            batch.nodes = parse_hosts(rows, source, inventory)
            batch.capabilities.append("nodes")
            if _unknown_gpus(batch.nodes, "gpu_count", "gpu_allocated"):
                batch.warnings.append(message("gpu_count_unknown", command="bhosts"))
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("nodes_unavailable", error))
        try:
            queues_query = _formatted("bqueues", "-u", username)(QUEUE_FIELDS)
            queues = parse_queues(
                records(await ssh.run(alias, queues_query, options), "bqueues", empty=False)
            )
            qos.update({queue["name"]: queue for queue in queues})
            batch.capabilities.append("partition_policy")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("partitions_unavailable", error))
        try:
            try:
                # The synopsis lists -a (limits without running jobs) apart from -w (no
                # truncation); try both, then the wide listing of limits in use.
                output = await _quiet(
                    alias, shlex.join(["blimits", "-a", "-w", "-u", username]), options, NO_LIMITS
                )
            except ssh.SSHError:
                output = await _quiet(
                    alias, shlex.join(["blimits", "-w", "-u", username]), options, NO_LIMITS
                )
            for name, limits in parse_limits(output, username).items():
                entry = qos.setdefault(
                    name,
                    {"name": name, "limits": {}, "origin": "scheduler_limit_access_unverified"},
                )
                entry["limits"] = {**entry["limits"], **limits}
            batch.capabilities.append("qos_limits")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("qos_unavailable", error))
        try:
            history_query = _formatted("bjobs", "-d", "-u", username)
            output = await _with_optional(
                alias,
                lambda fields: (
                    f"{CLOCK}; {HISTORY_CONFIG}; echo {HISTORY_MARKER}; {history_query(fields)}"
                ),
                HISTORY_FIELDS,
                HISTORY_EXTRA_FIELDS,
                options,
            )
            clock, _, rest = output.partition("\n")
            config, marker, history = rest.partition(HISTORY_MARKER + "\n")
            if marker:
                period = re.search(
                    r"(?m)^\s*CLEAN_PERIOD\s*=\s*(\d+)\s*(?:\(seconds\))?\s*$", config
                )
                if period:
                    batch.history_window_seconds = min(86400, int(period[1]))
                output = f"{clock}\n{history}"
            batch.failures = parse_failures(output, source)
            batch.finished = parse_failures(output, source, terminal=True)
            batch.capabilities.append("history")
        except (RuntimeError, TimeoutError, SourceError) as error:
            batch.warnings.append(_unavailable("history_unavailable", error))
        if qos:
            batch.qos = list(qos.values())
        batch.cluster_state = cluster_state(batch.nodes)
        for entry in batch.qos or []:
            entry["access"] = "unknown"
        return batch
