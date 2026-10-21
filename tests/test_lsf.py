"""LSF driver: bjobs/bhosts/bqueues JSON, lshosts/blimits tables, read-only collection.

Sample outputs are hand-written from the IBM Spectrum LSF 10.1 command reference and use
fictional data.
"""

import asyncio
import json
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from computedeck.drivers import lsf, ssh
from computedeck.drivers.base import SourceError

SOURCE: dict[str, Any] = {
    "id": "cluster-b-alice",
    "name": "Cluster B",
    "driver": "lsf",
    "cluster_id": "cluster-b",
    "username": "alice",
    "ssh_alias": "cluster-b",
}


def job(**changes: str) -> dict[str, str]:
    """One record of `bjobs -o "<fields>" -json`: a running four-GPU job unless changed."""
    row = {
        "JOBID": "2001",
        "JOBINDEX": "0",
        "JOB_NAME": "train-b",
        "USER": "alice",
        "QUEUE": "gpu",
        "STAT": "RUN",
        "PEND_REASON": "",
        "EXEC_HOST": "4*node001:4*node002",
        "SLOTS": "8",
        "RUN_TIME": "4800 second(s)",
        "PROJ_NAME": "lab-b",
        "GPU_NUM": "4",
        "GPU_ALLOC": "node001:0,1 node002:0,1",
    }
    row.update(changes)
    return row


def output(command: str, records: list[dict[str, str]], count: str = "JOBS") -> str:
    return json.dumps({"COMMAND": command, count: len(records), "RECORDS": records}, indent=2)


def bjobs(*records: dict[str, str]) -> str:
    return output("bjobs", list(records))


def host(name: str, **changes: str) -> dict[str, str]:
    row = {
        "HOST_NAME": name,
        "STATUS": "ok",
        "MAX": "64",
        "NJOBS": "8",
        "NGPUS": "4",
        "NGPUS_ALLOC": "2",
    }
    row.update(changes)
    return row


HOSTS = output(
    "bhosts",
    [
        host("node001", STATUS="closed_Full", NJOBS="64", NGPUS_ALLOC="4"),
        host("node002"),
        host("node003", NJOBS="0", NGPUS="-", NGPUS_ALLOC="-"),
        host("node004", STATUS="unavail", NJOBS="-", NGPUS_ALLOC="-"),
        host("node005", STATUS="closed_Adm", NJOBS="0", NGPUS_ALLOC="0"),
        host("lost_and_found", STATUS="-", MAX="-", NJOBS="0", NGPUS="-", NGPUS_ALLOC="-"),
    ],
    "HOSTS",
)
GPU_INVENTORY = """\
HOST_NAME          gpu_id            gpu_model   gpu_driver   gpu_factor   numa_id   vendor   mig
node001                 0  NVIDIAA100_SXM4_80GB   535.104.05         10.0         0   Nvidia     N
                        1  NVIDIAA100_SXM4_80GB   535.104.05         10.0         0   Nvidia     N
                        2  NVIDIAA100_SXM4_80GB   535.104.05         10.0         1   Nvidia     N
                        3  NVIDIAA100_SXM4_80GB   535.104.05         10.0         1   Nvidia     N
node002                 0  NVIDIAA100_SXM4_80GB   535.104.05         10.0         0   Nvidia     N
                        1  NVIDIAA100_SXM4_80GB   535.104.05         10.0         0   Nvidia     N
                        2  NVIDIAA100_SXM4_80GB   535.104.05         10.0         1   Nvidia     N
                        3  NVIDIAA100_SXM4_80GB   535.104.05         10.0         1   Nvidia     N
node004                 0     NVIDIAH100_PCIe   535.104.05         12.0         0   Nvidia     Y
                        1     NVIDIAH100_PCIe   535.104.05         12.0         0   Nvidia     Y
                        2     NVIDIAH100_PCIe   535.104.05         12.0         1   Nvidia     Y
                        3     NVIDIAH100_PCIe   535.104.05         12.0         1   Nvidia     Y
"""
QUEUES = output(
    "bqueues",
    [
        {"QUEUE_NAME": "gpu", "STATUS": "Open:Active", "MAX_RUNLIMIT": "2880.0 min"},
        {"QUEUE_NAME": "short", "STATUS": "Open:Inact", "MAX_RUNLIMIT": "90.5 min of node001"},
        {"QUEUE_NAME": "normal", "STATUS": "Open:Active", "MAX_RUNLIMIT": "-"},
        {"QUEUE_NAME": "retired", "STATUS": "Closed:Inact", "MAX_RUNLIMIT": "60.0 min"},
    ],
    "QUEUES",
)
LIMITS = """\
INTERNAL RESOURCE LIMITS:

NAME           USERS     QUEUES    HOSTS          PROJECTS   SLOTS      MEM    TMP    SWP    JOBS
user_jobs      alice     gpu       -              -          8/64       -      -      -      2/10
all_jobs       -         -         -              -          120/1000   -      -      -      -

EXTERNAL RESOURCE LIMITS:

NAME           USERS     QUEUES    HOSTS          PROJECTS   ngpus_physical
gpu_per_user   alice     gpu       -              -          4/8
gpu_tighter    alice     gpu       -              -          -/6
gpu_lab        alice     gpu       hostgroup_a/   -          2/4
gpu_global     alice     -         -              -          4/16
gpu_bob        bob       short     -              -          0/2
gpu_pair       alice     normal    -              -          -/0
"""
CLOCK = "2026-01-05T12:00:00"


def failed(**changes: str) -> dict[str, str]:
    row = job(
        JOBID="2101",
        STAT="EXIT",
        EXIT_CODE="1",
        EXIT_REASON="",
        FINISH_TIME="Jan  5 10:00",
    )
    row.update(changes)
    return row


def history(*records: dict[str, str], clock: str = CLOCK) -> str:
    return f"{clock}\n{bjobs(*records)}\n"


def test_running_job_reads_gpus_hosts_and_run_time() -> None:
    jobs = lsf.parse_jobs(lsf.records(bjobs(job()), "bjobs", empty=True), SOURCE)
    assert jobs == [
        {
            "id": "cluster-b:2001",
            "array_id": None,
            "array_index": None,
            "source_id": "cluster-b-alice",
            "cluster_id": "cluster-b",
            "name": "train-b",
            "user": "alice",
            "account": "lab-b",
            "partition": "gpu",
            "qos": "gpu",
            "state": "RUNNING",
            "gpu_count": 4,
            "gpu_type": None,
            "cpu_count": 8,
            "node": "node001,node002",
            "elapsed": "1:20:00",
            "reason": None,
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "submitted_at": None,
            "started_at": None,
            "observed_at": jobs[0]["observed_at"],
        }
    ]


def parse(*records: dict[str, str]) -> list[dict[str, Any]]:
    return lsf.parse_jobs(lsf.records(bjobs(*records), "bjobs", empty=True), SOURCE)


def test_pending_jobs_keep_the_pending_reason_and_array_elements_count_separately() -> None:
    jobs = parse(
        *(
            job(
                JOBID="2002",
                JOBINDEX=str(index),
                STAT="PEND",
                PEND_REASON="Job's requirements for resource reservation not satisfied",
                EXEC_HOST="",
                RUN_TIME="0 second(s)",
                GPU_NUM="2",
                GPU_ALLOC="-",
            )
            for index in (1, 2, 3)
        )
    )
    assert [row["id"] for row in jobs] == [
        "cluster-b:2002[1]",
        "cluster-b:2002[2]",
        "cluster-b:2002[3]",
    ]
    pending = jobs[0]
    assert pending["state"] == "PENDING"
    assert pending["reason"] == "Job's requirements for resource reservation not satisfied"
    assert pending["gpu_count"] == 2
    assert pending["node"] is None
    assert pending["elapsed"] == "0:00"


@pytest.mark.parametrize(
    ("changes", "count"),
    [
        ({"GPU_NUM": "2"}, 2),
        # Running without a GPU count or a GPU allocation: no GPUs.
        ({"GPU_NUM": "-", "GPU_ALLOC": "-"}, 0),
        ({"GPU_NUM": "", "GPU_ALLOC": ""}, 0),
        # An allocation we cannot count, or a pending job: unknown, never zero.
        ({"GPU_NUM": "-", "GPU_ALLOC": "node001:0"}, None),
        ({"GPU_NUM": "-", "GPU_ALLOC": "-", "STAT": "PEND"}, None),
        ({"GPU_NUM": "many"}, None),
    ],
)
def test_job_gpu_count_unknown_is_not_zero(changes: dict[str, str], count: int | None) -> None:
    assert parse(job(**changes))[0]["gpu_count"] == count


def test_jobs_read_without_gpu_fields_have_unknown_gpus() -> None:
    row = job()
    del row["GPU_NUM"], row["GPU_ALLOC"]
    assert parse(row)[0]["gpu_count"] is None


@pytest.mark.parametrize("reason", ["", "-", "The job was suspended by the user"])
def test_pending_suspension_is_held_regardless_of_comment(reason: str) -> None:
    row = parse(job(STAT="PSUSP", PEND_REASON=reason))[0]
    assert row["state"] == "PENDING"
    assert row["reason"] == "Held"


def test_states_other_users_and_finished_jobs() -> None:
    jobs = parse(
        job(),
        job(JOBID="2003", STAT="PSUSP", PEND_REASON="The job was suspended by the user"),
        job(JOBID="2004", STAT="USUSP"),
        job(JOBID="2005", STAT="DONE"),
        job(JOBID="2006", STAT="EXIT"),
        job(JOBID="2007", USER="bob"),
        job(),
    )
    assert [(row["id"], row["state"]) for row in jobs] == [
        ("cluster-b:2001", "RUNNING"),
        ("cluster-b:2003", "PENDING"),
        ("cluster-b:2004", "SUSPENDED"),
    ]
    assert jobs[1]["reason"] == "Held"


@pytest.mark.parametrize(
    ("value", "seconds"),
    [("4800 second(s)", 4800), ("0 second(s)", 0), ("93784", 93784), ("26:03:04", 93784)],
)
def test_run_time_formats(value: str, seconds: int) -> None:
    assert lsf.run_seconds(value) == seconds
    row = parse(job(RUN_TIME=value))[0]
    assert row["elapsed"] == lsf.duration(seconds)
    assert parse(job(RUN_TIME="-"))[0]["elapsed"] == ""


def test_records_accept_notices_but_not_garbage() -> None:
    notice = "Cannot connect to LSF. Please wait ...\n" + bjobs(job())
    assert len(lsf.records(notice, "bjobs", empty=True)) == 1
    assert lsf.records("", "bjobs", empty=True) == []
    assert lsf.records(bjobs(), "bjobs", empty=True) == []
    for text, empty in (("", False), ("garbage", True), ('{"RECORDS": 3}', True), ("{", True)):
        with pytest.raises(SourceError) as error:
            lsf.records(text, "bjobs", empty=empty)
        assert error.value.message() == {"code": "unexpected_output", "command": "bjobs"}
    with pytest.raises(SourceError, match="unexpected_output"):
        parse(job(JOBID="not-a-number"))


def test_hosts_combine_bhosts_counts_with_the_lshosts_inventory() -> None:
    inventory = lsf.parse_gpu_inventory(GPU_INVENTORY)
    assert {name: len(gpus) for name, gpus in inventory.items()} == {
        "node001": 4,
        "node002": 4,
        "node004": 4,
    }
    rows = lsf.records(HOSTS, "bhosts", empty=False)
    hosts = {item["name"]: item for item in lsf.parse_hosts(rows, SOURCE, inventory)}
    assert list(hosts) == ["node001", "node002", "node003", "node004", "node005"]
    full = hosts["node001"]
    assert full["id"] == "cluster-b:node001"
    assert (full["gpu_count"], full["gpu_allocated"]) == (4, 4)
    assert full["gpu_type"] == "NVIDIAA100_SXM4_80GB"
    assert (full["cpu_count"], full["cpu_allocated"]) == (64, 64)
    assert full["state"] == "allocated"
    assert hosts["node002"]["state"] == "mixed"
    # Not in the GPU inventory and no GPU count: a CPU host with no GPUs.
    assert (hosts["node003"]["gpu_count"], hosts["node003"]["gpu_allocated"]) == (0, 0)
    assert hosts["node003"]["state"] == "idle"
    # Down, with an unknown allocation: unknown, not zero.
    assert hosts["node004"]["state"] == "down"
    assert (hosts["node004"]["gpu_count"], hosts["node004"]["gpu_allocated"]) == (4, None)
    assert hosts["node004"]["gpu_type"] == "NVIDIAH100_PCIe"
    assert hosts["node005"]["state"] == "drain"


def test_hosts_without_any_gpu_source_stay_unknown() -> None:
    rows = [host("node003", NJOBS="3", NGPUS="-", NGPUS_ALLOC="-")]
    item = lsf.parse_hosts(rows, SOURCE, None)[0]
    assert (item["gpu_count"], item["gpu_allocated"], item["gpu_type"]) == (None, None, None)
    rows = [{"HOST_NAME": "node003", "STATUS": "ok", "MAX": "-", "NJOBS": "0"}]
    item = lsf.parse_hosts(rows, SOURCE, None)[0]
    # No jobs on the host: nothing is allocated, whatever its GPU count.
    assert (item["gpu_count"], item["gpu_allocated"], item["cpu_count"]) == (None, 0, None)


def test_host_states_the_web_app_must_not_count_as_usable() -> None:
    red = re.compile(r"down|drain|fail|maint|not_resp|unknown|invalid|\*", re.IGNORECASE)
    unusable = ("unavail", "unreach", "closed_Adm", "closed_Lock", "closed_LIM", "unlicensed")
    for status in unusable:
        state = lsf.parse_hosts([host("node009", STATUS=status)], SOURCE, None)[0]["state"]
        assert red.search(state), status
    for status in ("ok", "closed_Full", "closed_Excl", "closed_Busy", "closed_Wind"):
        state = lsf.parse_hosts([host("node009", STATUS=status)], SOURCE, None)[0]["state"]
        assert not red.search(state), status


@pytest.mark.parametrize(
    "text",
    [
        "garbage\n",
        "HOST_NAME gpu_id gpu_model\nnode001 zero A100\n",
        "HOST_NAME gpu_id gpu_model\nnode001 0 Tesla V100\n",
        "HOST_NAME type model\nnode001 X86_64 Intel\n",
    ],
)
def test_unexpected_gpu_inventory_is_rejected(text: str) -> None:
    with pytest.raises(SourceError, match="unexpected_output"):
        lsf.parse_gpu_inventory(text)


def test_queues_keep_open_queues_with_their_run_limit_in_minutes() -> None:
    queues = lsf.parse_queues(lsf.records(QUEUES, "bqueues", empty=False))
    assert queues == [
        {"name": "gpu", "limits": {"MaxWallPJ": "2880"}, "origin": "scheduler_queue"},
        {"name": "short", "limits": {"MaxWallPJ": "91"}, "origin": "scheduler_queue"},
        {"name": "normal", "limits": {}, "origin": "scheduler_queue"},
    ]


def test_limits_keep_only_per_user_limits_of_one_queue() -> None:
    limits = lsf.parse_limits(LIMITS, "alice")
    # The tighter of two GPU limits on one queue wins; host-scoped and global ones are left
    # out because the web app compares a limit only with the jobs of its queue.
    assert limits == {
        "gpu": {"MaxJobsPU": "10", "MaxTRESPU": "gres/gpu=6"},
        "normal": {"MaxTRESPU": "gres/gpu=0"},
    }
    assert lsf.parse_limits(LIMITS, "bob") == {"short": {"MaxTRESPU": "gres/gpu=2"}}
    assert lsf.parse_limits("No resource usage found.\n", "alice") == {}
    assert lsf.parse_limits("", "alice") == {}
    # The same expression as qosGpuLimit in web/src/domain.ts.
    match = re.search(r"(?:^|,)gres/gpu(?::[^=,]+)?=(\d+)", limits["gpu"]["MaxTRESPU"])
    assert match and match.group(1) == "6"
    with pytest.raises(SourceError, match="unexpected_output"):
        lsf.parse_limits("blimits: command not found\n", "alice")


def test_limits_prefer_physical_gpus_over_legacy_ngpus() -> None:
    table = (
        "NAME     USERS  QUEUES  HOSTS  PROJECTS  ngpus  ngpus_physical\n"
        "gpu_cap  alice  gpu     -      -         1/2    1/4\n"
    )
    assert lsf.parse_limits(table, "alice") == {"gpu": {"MaxTRESPU": "gres/gpu=4"}}


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Jan  5 10:00", datetime(2026, 1, 5, 10, 0)),
        ("Jan  5 10:00 L", datetime(2026, 1, 5, 10, 0)),
        ("Jan  5 10:00:30", datetime(2026, 1, 5, 10, 0, 30)),
        ("Jan  5 10:00 2026", datetime(2026, 1, 5, 10, 0)),
        # No year: the latest such date that is not in the future.
        ("Dec 31 23:00", datetime(2025, 12, 31, 23, 0)),
        ("-", None),
        ("", None),
    ],
)
def test_finish_times_without_a_year(value: str, expected: datetime | None) -> None:
    assert lsf.finish_time(value, datetime(2026, 1, 5, 12, 0)) == expected


def test_failures_keep_own_exits_of_the_last_24_hours() -> None:
    text = history(
        failed(),
        failed(
            JOBID="2102",
            JOB_NAME="eval-c",
            EXIT_CODE="140",
            EXIT_REASON="TERM_RUNLIMIT: job killed after reaching LSF run time limit",
            FINISH_TIME="Jan  5 11:00 L",
            EXEC_HOST="node003",
            SLOTS="4",
            GPU_NUM="-",
        ),
        failed(
            JOBID="2103",
            EXIT_REASON="TERM_MEMLIMIT: job killed after reaching LSF memory usage limit",
            FINISH_TIME="Jan  5 09:00",
        ),
        failed(JOBID="2104", EXIT_REASON="TERM_OWNER: job killed by owner"),
        failed(JOBID="2105", STAT="DONE", EXIT_CODE=""),
        failed(JOBID="2106", USER="bob"),
        failed(JOBID="2107", FINISH_TIME="Jan  3 10:00"),
        failed(JOBID="2108", FINISH_TIME="-"),
        failed(JOBID="2109", JOBINDEX="7", EXIT_CODE="-", FINISH_TIME="Jan  5 08:00"),
    )
    failures = lsf.parse_failures(text, SOURCE)
    assert [(row["id"], row["state"], row["exit_code"]) for row in failures] == [
        ("cluster-b:2102", "TIMEOUT", "140"),
        ("cluster-b:2101", "FAILED", "1"),
        ("cluster-b:2103", "OUT_OF_MEMORY", "1"),
        ("cluster-b:2109[7]", "FAILED", None),
    ]
    timeout = failures[0]
    assert timeout["end"] == "2026-01-05T11:00:00"
    assert (timeout["gpu_count"], timeout["cpu_count"], timeout["node"]) == (None, 4, "node003")
    assert failures[1]["gpu_count"] == 4
    assert timeout["reason"] == "TERM_RUNLIMIT: job killed after reaching LSF run time limit"
    assert timeout["observed_at"]


def test_failure_history_framing() -> None:
    assert lsf.parse_failures("", SOURCE) == []
    assert lsf.parse_failures(f"{CLOCK}\n", SOURCE) == []
    for text in ("not a date\n" + bjobs(failed()), f"{CLOCK}\ngarbage\n"):
        with pytest.raises(SourceError, match="unexpected_output"):
            lsf.parse_failures(text, SOURCE)


def test_validate_requires_connection_settings() -> None:
    driver = lsf.LsfDriver()
    driver.validate(SOURCE)
    for changes in ({"ssh_alias": ""}, {"username": ""}):
        with pytest.raises(SourceError, match="cluster_connection_required"):
            driver.validate({**SOURCE, **changes})
    with pytest.raises(SourceError, match="invalid_ssh_alias"):
        driver.validate({**SOURCE, "ssh_alias": "-oProxyCommand"})


def test_driver_info_describes_checks_in_both_languages() -> None:
    info = lsf.LsfDriver.info
    assert info.beta
    assert [check.command for check in info.checks] == ["bjobs", "bhosts", "limits", "bjobs -d"]
    assert [check.warning for check in info.checks] == [
        None,
        "nodes_unavailable",
        "qos_unavailable",
        "history_unavailable",
    ]
    for text in (info.label, info.description, info.details):
        assert text["en"] and text["zh-CN"]
    assert "{where}" in info.details["en"] and "{where}" in info.details["zh-CN"]


Calls = list[tuple[str, str, list[str] | None]]


def fake_cluster(calls: Calls, failure: Exception | None = None, **outputs: str) -> Any:
    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        calls.append((destination, command, options))
        if command.startswith("bjobs -u"):
            return outputs.get("jobs", bjobs(job()))
        if failure is not None:
            raise failure
        if command.startswith("bhosts"):
            return outputs.get("hosts", HOSTS)
        if command == lsf.GPU_INVENTORY_COMMAND:
            return outputs.get("inventory", GPU_INVENTORY)
        if command.startswith("bqueues"):
            return outputs.get("queues", QUEUES)
        if command.startswith("blimits"):
            return outputs.get("limits", LIMITS)
        if command.startswith("date"):
            return outputs.get("history", history(failed()))
        raise AssertionError(f"Unexpected command: {command}")

    return run


async def test_collect_reads_jobs_hosts_limits_and_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls))
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.capabilities == ["jobs", "nodes", "partition_policy", "qos_limits", "history"]
    # node004 is down with an unknown GPU allocation.
    assert batch.warnings == [{"code": "gpu_count_unknown", "command": "bhosts"}]
    assert batch.jobs is not None and [row["id"] for row in batch.jobs] == ["cluster-b:2001"]
    assert batch.nodes is not None and len(batch.nodes) == 5
    assert batch.failures is not None and [row["id"] for row in batch.failures] == [
        "cluster-b:2101"
    ]
    assert batch.qos is not None
    qos = {item["name"]: item for item in batch.qos}
    assert set(qos) == {"gpu", "short", "normal"}
    assert qos["gpu"] == {
        "name": "gpu",
        "limits": {"MaxWallPJ": "2880", "MaxJobsPU": "10", "MaxTRESPU": "gres/gpu=6"},
        "origin": "scheduler_queue",
        "access": "unknown",
    }
    assert set(batch.snapshot()) == {"jobs", "nodes", "failures"}

    assert all(dest == "cluster-b" and opts == ["-l", "alice"] for dest, _, opts in calls)
    commands = [command for _, command, _ in calls]
    assert commands[0] == (
        "bjobs -u alice -o 'jobid jobindex job_name user queue stat pend_reason "
        "submit_time start_time exec_host "
        "slots run_time proj_name gpu_num gpu_alloc' -json"
    )
    assert "bqueues -u alice -o 'queue_name status max_runlimit' -json" in commands
    assert "blimits -a -w -u alice" in commands
    assert commands[-1].startswith(
        f"{lsf.CLOCK}; {lsf.HISTORY_CONFIG}; echo {lsf.HISTORY_MARKER}; bjobs -d -u alice -o "
    )
    # Collection is read-only.
    words = set(" ".join(commands).replace("'", " ").replace(";", " ").split())
    assert not {"bsub", "bkill", "bmod", "bstop", "bresume", "brequeue", "badmin"} & words


async def test_older_releases_without_gpu_fields_are_read_without_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    healthy = fake_cluster(calls)

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if "gpu_num" in command or "ngpus" in command:
            calls.append((destination, command, options))
            raise ssh.SSHError("gpu_num: Illegal field name.")
        if command.startswith("bjobs -u"):
            row = job()
            del row["GPU_NUM"], row["GPU_ALLOC"]
            calls.append((destination, command, options))
            return bjobs(row)
        if command.startswith("bhosts"):
            calls.append((destination, command, options))
            records = [host("node003", NGPUS_ALLOC="-")]
            for row in records:
                del row["NGPUS"], row["NGPUS_ALLOC"]
            return output("bhosts", records, "HOSTS")
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.jobs is not None and batch.jobs[0]["gpu_count"] is None
    # lshosts -gpu does not list node003, so it has no GPUs.
    assert batch.nodes is not None and batch.nodes[0]["gpu_count"] == 0
    assert batch.warnings == [{"code": "gpu_count_unknown", "command": "bjobs"}]
    assert "history" in batch.capabilities
    commands = [command for _, command, _ in calls]
    assert sum(command.startswith("bjobs -u") for command in commands) == 2


async def test_no_jobs_and_no_limits_are_empty_results(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: Calls = []
    healthy = fake_cluster(calls)

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        calls.append((destination, command, options))
        if command.startswith("bjobs -u"):
            raise ssh.SSHError("No unfinished job found")
        if command.startswith("date"):
            raise ssh.SSHError("No job found")
        if command.startswith("blimits"):
            raise ssh.SSHError("No resource usage found.")
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.jobs == []
    assert batch.failures == []
    assert batch.capabilities == ["jobs", "nodes", "partition_policy", "qos_limits", "history"]
    commands = [command for _, command, _ in calls]
    # An empty selection is not a reason to retry without the GPU fields.
    assert sum(command.startswith("bjobs -u") for command in commands) == 1


async def test_blimits_falls_back_when_all_and_wide_cannot_be_combined(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    healthy = fake_cluster(calls)

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if command.startswith("blimits -a"):
            calls.append((destination, command, options))
            raise ssh.SSHError("blimits: -a and -w cannot be used together")
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert "qos_limits" in batch.capabilities
    assert "blimits -w -u alice" in [command for _, command, _ in calls]


@pytest.mark.parametrize("failure", [ssh.SSHError("Permission denied"), TimeoutError()])
async def test_partial_permissions_keep_supported_data(
    monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, failure))
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.capabilities == ["jobs"]
    assert batch.nodes is None
    assert batch.failures is None
    assert set(batch.snapshot()) == {"jobs"}
    assert batch.qos == [
        {
            "name": "gpu",
            "limits": {},
            "origin": "observed_job_access_unverified",
            "access": "unknown",
        }
    ]
    detail = str(failure) or type(failure).__name__
    assert batch.warnings == [
        {"code": code, "detail": detail}
        for code in (
            "nodes_unavailable",
            "partitions_unavailable",
            "qos_unavailable",
            "history_unavailable",
        )
    ]


async def test_malformed_optional_output_becomes_a_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    run = fake_cluster(calls, hosts="garbage\n", limits="garbage\n", history="garbage\n")
    monkeypatch.setattr(ssh, "run", run)
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.nodes is None
    assert batch.failures is None
    assert [warning["code"] for warning in batch.warnings] == [
        "nodes_unavailable",
        "qos_unavailable",
        "history_unavailable",
    ]
    assert "partition_policy" in batch.capabilities


async def test_a_failed_gpu_inventory_only_loses_models(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, inventory="garbage\n"))
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.nodes is not None
    hosts = {item["name"]: item for item in batch.nodes}
    assert hosts["node001"]["gpu_count"] == 4 and hosts["node001"]["gpu_type"] is None
    # Without the inventory a "-" GPU count cannot be read as zero.
    assert hosts["node003"]["gpu_count"] is None


@pytest.mark.parametrize(
    ("failure", "code"),
    [(ssh.SSHError("Connection refused"), "ssh_failed"), (TimeoutError(), "ssh_timeout")],
)
async def test_queue_failure_fails_the_collection(
    monkeypatch: pytest.MonkeyPatch, failure: Exception, code: str
) -> None:
    calls = []

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        calls.append(command)
        raise failure

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(SourceError) as error:
        await lsf.LsfDriver().collect(SOURCE)
    assert error.value.code == code
    # A failed connection is tried once more without the optional GPU fields.
    assert len(calls) == (2 if code == "ssh_failed" else 1)


async def test_malformed_queue_output_fails_instead_of_reporting_no_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        return "unexpected banner text\n"

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(SourceError, match="unexpected_output"):
        await lsf.LsfDriver().collect(SOURCE)


@pytest.mark.parametrize(
    "changes",
    [
        {"ssh_alias": "-oProxyCommand=touch"},
        {"ssh_alias": "cluster-b extra"},
        {"username": "alice;id"},
        {"username": "alice' -u 'all"},
        {"username": "-oProxyCommand=true"},
    ],
)
async def test_unsafe_connection_settings_are_rejected_before_ssh(
    monkeypatch: pytest.MonkeyPatch, changes: dict[str, str]
) -> None:
    async def run(*args: Any) -> str:
        raise AssertionError("SSH must not run")

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(ValueError):
        await lsf.LsfDriver().collect({**SOURCE, **changes})


FAKE_TOOL = """#!/bin/sh
for arg in "$@"; do printf '<%s>' "$arg" >> "$LOG"; done
echo >> "$LOG"
case "$(basename "$0")" in
  date) echo 2026-01-05T12:00:00 ;;
  bjobs) echo '{"COMMAND":"bjobs","JOBS":0,"RECORDS":[]}' ;;
esac
"""


@pytest.mark.parametrize("shell", ["sh", "bash", "tcsh"])
def test_history_command_runs_under_common_login_shells(tmp_path: Path, shell: str) -> None:
    """The clock and bjobs -d command line, run by a local login shell with fake tools."""
    if shutil.which(shell) is None:
        pytest.skip(f"{shell} is not installed")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("date", "bjobs"):
        (bin_dir / tool).write_text(FAKE_TOOL)
        (bin_dir / tool).chmod(0o755)
    log = tmp_path / "log"
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "LOG": str(log)}
    query = lsf._formatted("bjobs", "-d", "-u", "alice.b")
    command = f"{lsf.CLOCK}; {query(lsf.HISTORY_FIELDS)}"
    result = subprocess.run(
        [shell, "-c", command], cwd=tmp_path, env=env, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert log.read_text().splitlines() == [
        "<+%Y-%m-%dT%H:%M:%S%z>",
        "<-d><-u><alice.b><-o><" + " ".join(lsf.HISTORY_FIELDS) + "><-json>",
    ]
    assert lsf.parse_failures(result.stdout, SOURCE) == []


async def test_history_without_gpu_fields_keeps_exit_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def quiet(alias: str, command: str, options: list[str], no_jobs: Any) -> str:
        calls.append(command)
        if "gpu_num" in command:
            raise ssh.SSHError("gpu_num: Illegal field name")
        return "history with exit_reason"

    monkeypatch.setattr(lsf, "_quiet", quiet)
    result = await lsf._with_optional(
        "cluster-a",
        lambda fields: " ".join(fields),
        lsf.HISTORY_FIELDS,
        lsf.HISTORY_EXTRA_FIELDS,
        [],
    )
    assert result == "history with exit_reason"
    assert "exit_reason" in calls[-1] and "gpu_num" not in calls[-1]


def test_job_times_preserve_scheduler_text_without_inventing_a_timezone() -> None:
    running = parse(job(SUBMIT_TIME="Jan 5 08:00", START_TIME="Jan 5 09:00"))[0]
    assert running["submitted_at"] == "Jan 5 08:00"
    assert running["started_at"] == "Jan 5 09:00"
    pending = parse(job(STAT="PEND", START_TIME="Jan 5 13:00"))[0]
    assert pending["started_at"] is None


def test_terminal_outcomes_use_remote_offset_without_changing_failure_rows() -> None:
    text = history(
        failed(JOBID="1", STAT="DONE", EXIT_CODE="0"),
        failed(JOBID="2", EXIT_REASON="TERM_OWNER: job killed by owner"),
        failed(JOBID="3", EXIT_REASON="TERM_MEMLIMIT"),
        clock="2026-01-05T12:00:00+0400",
    )
    rows = lsf.parse_failures(text, SOURCE, terminal=True)
    assert {row["state"] for row in rows} == {"COMPLETED", "CANCELLED", "OUT_OF_MEMORY"}
    assert all(row["end"].endswith("+04:00") for row in rows)
    assert lsf.parse_failures(text, SOURCE)[0]["end"] == "2026-01-05T10:00:00"


@pytest.mark.parametrize(
    ("job_id", "index", "array_id", "array_index"),
    [
        ("2002", "1", "2002", "1"),
        ("2002[7]", "7", "2002", "7"),
        ("2002", "0", None, None),
        ("2002[0]", "0", None, None),
        ("2002", "-", None, None),
        ("2002", "1-30", None, None),
    ],
)
def test_array_fields_on_queue_and_history_rows(
    job_id: str, index: str, array_id: str | None, array_index: str | None
) -> None:
    rows = parse(job(JOBID=job_id, JOBINDEX=index))
    text = f"{CLOCK}\n" + bjobs(failed(JOBID=job_id, JOBINDEX=index))
    rows += lsf.parse_failures(text, SOURCE)
    rows += lsf.parse_failures(text, SOURCE, terminal=True)
    assert len(rows) == 3
    for row in rows:
        assert (row["array_id"], row["array_index"]) == (array_id, array_index)


@pytest.mark.parametrize("code,status", [("1", 1), ("127", 127), ("137", 137), ("-", None)])
def test_failure_exit_fields_and_reason(code, status) -> None:
    [row] = lsf.parse_failures(
        history(
            failed(EXIT_CODE=code, EXIT_REASON="TERM_MEMLIMIT"), clock="2026-01-05T12:00:00+04:00"
        ),
        SOURCE,
    )
    assert row["exit_status"] == status
    assert row["exit_signal"] is None
    assert row["reason"] == "TERM_MEMLIMIT"
    assert row["end"] == "2026-01-05T10:00:00"
    assert row["ended_at"] == "2026-01-05T10:00:00+04:00"


@pytest.mark.parametrize(
    "config,window",
    [
        ("    CLEAN_PERIOD = 3600 (seconds)\n", 3600),
        ("CLEAN_PERIOD = 172800 (seconds)\n", 86400),
        ("CLEAN_PERIOD = 0 (seconds)\n", 0),
        ("", None),
        ("CLEAN_PERIOD = unknown\n", None),
        ("CLEAN_PERIOD = -1\n", None),
    ],
)
async def test_history_window_uses_readable_clean_period(
    monkeypatch: pytest.MonkeyPatch, config: str, window: int | None
) -> None:
    clock, _, rows = history(failed()).partition("\n")
    framed = f"{clock}\n{config}{lsf.HISTORY_MARKER}\n{rows}"
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, history=framed))
    batch = await lsf.LsfDriver().collect(SOURCE)
    assert batch.history_window_seconds == window
    assert "history" in batch.capabilities
    assert batch.failures and batch.failures[0]["id"] == "cluster-b:2101"
    # Configuration rides on the existing history request, without another SSH call.
    assert len([command for _, command, _ in calls if "bparams" in command]) == 1
    assert len(calls) == 6


@pytest.mark.parametrize("shell", ["sh", "bash", "tcsh"])
@pytest.mark.parametrize("config_available", [True, False])
async def test_history_config_is_optional_under_login_shells(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shell: str, config_available: bool
) -> None:
    if shutil.which(shell) is None:
        pytest.skip(f"{shell} is not installed")
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls))
    await lsf.LsfDriver().collect(SOURCE)
    command = calls[-1][1]
    for tool in ("date", "bjobs", "bparams"):
        script = FAKE_TOOL
        if tool == "bparams":
            script = (
                '#!/bin/sh\necho "    CLEAN_PERIOD = 3600 (seconds)"\n'
                if config_available
                else '#!/bin/sh\necho "permission denied" >&2\nexit 1\n'
            )
        (tmp_path / tool).write_text(script)
        (tmp_path / tool).chmod(0o755)
    result = await asyncio.to_thread(
        subprocess.run,
        [shell, "-c", command],
        cwd=tmp_path,
        env={"PATH": f"{tmp_path}:/usr/bin:/bin", "LOG": str(tmp_path / "log")},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert lsf.HISTORY_MARKER in result.stdout
    assert (
        "CLEAN_PERIOD" in result.stdout if config_available else "CLEAN_PERIOD" not in result.stdout
    )
    assert (
        lsf.parse_failures(
            result.stdout.splitlines()[0]
            + "\n"
            + result.stdout.split(lsf.HISTORY_MARKER + "\n")[1],
            SOURCE,
        )
        == []
    )
