"""Slurm driver: squeue/scontrol/sacct parsing and read-only collection over SSH.

All sample outputs are hand-written from the documented formats and use fictional data.
"""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from computedeck import collector, events
from computedeck.drivers import slurm, ssh
from computedeck.drivers.base import SourceError
from computedeck.plugins import Runtime
from computedeck.store import Store

SOURCE: dict[str, Any] = {
    "id": "cluster-a-alice",
    "name": "Cluster A",
    "driver": "slurm",
    "cluster_id": "cluster-a",
    "username": "alice",
    "ssh_alias": "cluster-a",
}


def job_line(**changes: str) -> str:
    """One `squeue -O Field:0|,...` line: every field is followed by a pipe."""
    row = {
        "JobArrayID": "42",
        "Name": "train model",
        "UserName": "alice",
        "Account": "lab-a",
        "Partition": "gpu",
        "QOS": "normal",
        "State": "RUNNING",
        "NumCPUs": "16",
        "NumNodes": "2",
        "NodeList": "node-[01-02]",
        "TimeUsed": "1:20:00",
        "SubmitTime": "2026-01-05T07:00:00+0400",
        "StartTime": "2026-01-05T08:00:00+0400",
        "Reason": "None",
        "tres-alloc": "cpu=16,mem=64G,node=2,billing=16,gres/gpu=8,gres/gpu:a100=8",
        "tres-per-node": "gres/gpu:a100:4",
        "tres-per-job": "N/A",
    }
    if "JobID" in changes:
        changes["JobArrayID"] = changes.pop("JobID")
    row.update(changes)
    return "|".join(row[field] for field in slurm._FIELDS) + "|"


def sacct_line(**changes: str) -> str:
    """One `sacct --parsable2` line: pipe-separated, no trailing pipe."""
    row = {
        "JobID": "1001",
        "JobName": "train-a",
        "User": "alice",
        "Account": "lab-a",
        "Partition": "gpu",
        "QOS": "normal",
        "State": "FAILED",
        "AllocTRES": "billing=16,cpu=16,gres/gpu=4,mem=64G,node=1",
        "NCPUS": "16",
        "NodeList": "node-01",
        "Elapsed": "01:02:03",
        "End": "2026-01-05T10:00:00",
        "ExitCode": "1:0",
        "Timelimit": "02:00:00",
    }
    row.update(changes)
    return "|".join(row[field] for field in slurm._HISTORY_FIELDS)


def terminal_line(**changes: str) -> str:
    return (
        sacct_line(**{"End": "2026-01-05T10:00:00+0400", **changes})
        + "|2026-01-05T08:00:00+0400|2026-01-05T09:00:00+0400"
    )


NODES = (
    "NodeName=node-01 Arch=x86_64 CPUAlloc=16 CPUTot=128 State=MIXED Partitions=gpu,debug "
    "CfgTRES=cpu=128,mem=1000G,billing=128,gres/gpu=8,gres/gpu:a100=8 "
    "AllocTRES=cpu=16,gres/gpu=2,gres/gpu:a100=2\n"
    "NodeName=node-02 CPUAlloc=0 CPUTot=64 State=IDLE Partitions=gpu Gres=gpu:a100:4(S:0-1)\n"
    "NodeName=node-03 CPUAlloc=0 CPUTot=64 State=IDLE Partitions=gpu Gres=gpu:a100:4 AllocTRES=\n"
    "NodeName=node-04 CPUTot=96 State=IDLE+CLOUD+POWERED_DOWN Partitions=(null) "
    "CfgTRES=cpu=96,gres/gpu=8 AllocTRES=\n"
)
PARTITIONS = (
    "PartitionName=gpu AllowGroups=ALL AllowAccounts=ALL AllowQos=normal,long Default=YES\n"
    "PartitionName=debug AllowGroups=ALL AllowAccounts=ALL AllowQos=ALL\n"
)
QOS = """Current Association Manager state

QOS Records

QOS=normal(1)
    UsageRaw=1234.000000
    GrpJobs=N(0) GrpSubmitJobs=N(0) GrpWall=N(0.00)
    GrpTRES=cpu=N(0),mem=N(0),gres/gpu=64(12)
    MaxWallPJ=2880
    MaxTRESPJ=
    MaxJobsPU=4(2) MaxSubmitJobsPU=10(3)
    MaxTRESPU=cpu=N(0),gres/gpu=8(3)
    User Limits
      bob(1002)
        MaxJobsPU=4(4) MaxSubmitJobsPU=10(9)
        MaxTRESPU=cpu=N(64),gres/gpu=8(8)
      alice(1001)
        MaxJobsPU=4(1) MaxSubmitJobsPU=10(2)
        MaxTRESPU=cpu=N(16),gres/gpu=8(2)
QOS=debug(2)
    MaxJobsPU=N(0)
    MaxTRESPU=gres/gpu=N(1)
"""


@pytest.mark.parametrize(
    ("tres", "count"),
    [
        ("gres/gpu=8,gres/gpu:a100=8", 8),
        ("gres/gpu:a100=2,gres/gpu:h100=4", 6),
        ("gpu:a100:4(S:0-1),gpu:h100:2(IDX:0,1)", 6),
        ("gres/gpu:2", 2),
        ("gres:gpu:4", 4),
        ("gres:gpu:a100:2,gres:gpu:h100:4", 6),
        ("cpu=4,mem=8G,node=1", 0),
        ("gres/gpu=0", 0),
        ("gpu:N/A", None),
        ("N/A", None),
        ("", None),
        (None, None),
        ("not reported", None),
    ],
)
def test_gpu_tres_totals_do_not_count_typed_breakdown_twice(
    tres: str | None, count: int | None
) -> None:
    assert slurm.gpu_count(tres) == count


def test_jobs_use_total_tres_then_per_node_and_deduplicate() -> None:
    total = job_line()
    jobs = slurm.parse_jobs(total + "\n" + total + "\n", SOURCE)
    assert len(jobs) == 1
    job = jobs[0]
    # Neither 16 from the typed breakdown nor 16 from per-node × nodes.
    assert job["gpu_count"] == 8
    assert job["gpu_type"] == "a100"
    assert job["id"] == "cluster-a:42"
    assert job["cluster_id"] == "cluster-a"
    assert job["source_id"] == "cluster-a-alice"
    assert job["name"] == "train model"
    assert job["reason"] is None
    assert job["cpu_count"] == 16
    assert job["gpu_utilization"] is None
    assert job["cpu_utilization"] is None
    per_node = job_line(**{"tres-alloc": "N/A", "NumNodes": "3"})
    assert slurm.parse_jobs(per_node, SOURCE)[0]["gpu_count"] == 12
    partial_accounting = job_line(**{"tres-alloc": "cpu=16,node=2"})
    assert slurm.parse_jobs(partial_accounting, SOURCE)[0]["gpu_count"] == 8
    per_job = job_line(
        **{"tres-alloc": "N/A", "tres-per-node": "N/A", "tres-per-job": "gres/gpu:2"}
    )
    assert slurm.parse_jobs(per_job, SOURCE)[0]["gpu_count"] == 2


@pytest.mark.parametrize("prefix", ["gres/gpu", "gres:gpu"])
def test_jobs_accept_both_squeue_gres_prefixes_without_gpu_accounting(prefix: str) -> None:
    per_node = job_line(**{"tres-alloc": "cpu=16,node=2", "tres-per-node": f"{prefix}:a100:4"})
    job = slurm.parse_jobs(per_node, SOURCE)[0]
    assert job["gpu_count"] == 8
    assert job["gpu_type"] == "a100"
    per_job = job_line(
        **{
            "State": "PENDING",
            "tres-alloc": "cpu=16,node=2",
            "tres-per-node": "N/A",
            "tres-per-job": f"{prefix}:4",
        }
    )
    assert slurm.parse_jobs(per_job, SOURCE)[0]["gpu_count"] == 4


def test_job_gpu_count_without_gpu_accounting_is_unknown() -> None:
    unknown = job_line(**{"tres-alloc": "N/A", "tres-per-node": "N/A"})
    assert slurm.parse_jobs(unknown, SOURCE)[0]["gpu_count"] is None
    unknown_nodes = job_line(**{"tres-alloc": "N/A", "NumNodes": "N/A"})
    assert slurm.parse_jobs(unknown_nodes, SOURCE)[0]["gpu_count"] is None
    cpu_only = job_line(**{"tres-alloc": "cpu=4,mem=8G,node=1", "tres-per-node": "N/A"})
    assert slurm.parse_jobs(cpu_only, SOURCE)[0]["gpu_count"] is None


def test_a_cpu_only_job_holds_no_gpus_where_gpus_are_accounted() -> None:
    assert slurm.gpus_tracked(NODES)
    assert not slurm.gpus_tracked("NodeName=n1 CfgTRES=cpu=64,mem=500G Gres=gpu:4\n")
    cpu_only = job_line(**{"tres-alloc": "cpu=4,mem=8G,node=1", "tres-per-node": "N/A"})
    assert slurm.parse_jobs(cpu_only, SOURCE, tracked=True)[0]["gpu_count"] == 0
    # A request the parser cannot read stays unknown even then.
    unreadable = job_line(**{"tres-alloc": "N/A", "tres-per-node": "N/A"})
    assert slurm.parse_jobs(unreadable, SOURCE, tracked=True)[0]["gpu_count"] is None


def test_pending_is_requested_and_other_users_are_ignored() -> None:
    output = job_line(State="PENDING", NodeList="", Reason="QOSMaxGRESPerUser")
    output += "\n" + job_line(UserName="bob", JobID="43")
    jobs = slurm.parse_jobs(output, SOURCE)
    assert len(jobs) == 1
    assert jobs[0]["state"] == "PENDING"
    assert jobs[0]["gpu_count"] == 8
    assert jobs[0]["node"] is None
    assert jobs[0]["reason"] == "QOSMaxGRESPerUser"
    assert sum(job["gpu_count"] for job in jobs if job["state"] == "RUNNING") == 0


def test_pending_array_elements_are_counted_separately() -> None:
    output = "\n".join(job_line(JobID=f"50_{index}", State="PENDING") for index in range(3))
    assert [job["id"] for job in slurm.parse_jobs(output, SOURCE)] == [
        "cluster-a:50_0",
        "cluster-a:50_1",
        "cluster-a:50_2",
    ]


def test_unexpected_squeue_columns_fail_instead_of_reporting_no_jobs() -> None:
    with pytest.raises(SourceError) as error:
        slurm.parse_jobs("42|train|alice|\n", SOURCE)
    assert error.value.message() == {"code": "unexpected_output", "command": "squeue"}
    assert slurm.parse_jobs("\n  \n", SOURCE) == []


def test_nodes_preserve_unknown_allocation_and_deduplicate() -> None:
    first = NODES.splitlines()[0]
    nodes = slurm.parse_nodes(first + "\n" + NODES, SOURCE)
    assert [node["name"] for node in nodes] == ["node-01", "node-02", "node-03", "node-04"]
    by_name = {node["name"]: node for node in nodes}
    assert by_name["node-01"]["id"] == "cluster-a:node-01"
    assert by_name["node-01"]["gpu_count"] == 8
    assert by_name["node-01"]["gpu_allocated"] == 2
    assert by_name["node-01"]["cpu_count"] == 128
    assert by_name["node-01"]["cpu_allocated"] == 16
    assert by_name["node-01"]["partitions"] == ["gpu", "debug"]
    assert by_name["node-01"]["state"] == "mixed"
    # No AllocTRES field at all: allocation is unknown, not zero.
    assert by_name["node-02"]["gpu_count"] == 4
    assert by_name["node-02"]["gpu_allocated"] is None
    # An empty AllocTRES field is an explicit "nothing allocated".
    assert by_name["node-03"]["gpu_allocated"] == 0
    assert by_name["node-04"]["state"] == "idle+cloud+powered_down"
    assert by_name["node-04"]["partitions"] == []
    assert by_name["node-04"]["gpu_allocated"] == 0


def test_node_capacity_falls_back_to_gres_when_tres_lacks_gpus() -> None:
    line = "NodeName=node-09 CPUTot=64 State=IDLE CfgTRES=cpu=64,mem=500G Gres=gpu:4\n"
    assert slurm.parse_nodes(line, SOURCE)[0]["gpu_count"] == 4
    line = "NodeName=node-10 CPUTot=64 State=IDLE CfgTRES=cpu=64,mem=500G Gres=(null)\n"
    assert slurm.parse_nodes(line, SOURCE)[0]["gpu_count"] == 0


def test_gpu_allocation_follows_what_the_cluster_accounts() -> None:
    accounted = (
        "NodeName=g2 CPUTot=64 State=MIXED CfgTRES=cpu=64,gres/gpu=8 "
        "AllocTRES=cpu=8,mem=32G Gres=gpu:a100:8\n"
    )
    # GPUs are TRES here: CPU-only work holds none, whatever GresUsed is missing.
    assert slurm.parse_nodes(accounted, SOURCE)[0]["gpu_allocated"] == 0
    untracked = "NodeName=g3 CPUTot=64 State=MIXED CfgTRES=cpu=64 AllocTRES=cpu=8 Gres=gpu:a100:8"
    used = untracked + " GresUsed=gpu:a100:3(IDX:0-2)\n"
    assert slurm.parse_nodes(used, SOURCE)[0]["gpu_allocated"] == 3
    assert slurm.parse_nodes(untracked + "\n", SOURCE)[0]["gpu_allocated"] is None


def test_unexpected_node_output_is_rejected() -> None:
    with pytest.raises(SourceError, match="unexpected_output"):
        slurm.parse_nodes("Permission denied\n", SOURCE)


def test_qos_limits_are_not_usage_or_effective_permissions() -> None:
    qos = {item["name"]: item for item in slurm.parse_qos(QOS)}
    assert list(qos) == ["normal", "debug"]
    normal = qos["normal"]["limits"]
    assert normal["MaxJobsPU"] == "4"
    assert normal["MaxSubmitJobsPU"] == "10"
    assert normal["MaxTRESPU"] == "cpu=N,gres/gpu=8"
    assert normal["MaxWallPJ"] == "2880"
    assert normal["GrpTRES"] == "cpu=N,mem=N,gres/gpu=64"
    assert qos["debug"]["limits"]["MaxJobsPU"] is None
    assert all("access_unverified" in item["origin"] for item in qos.values())


def test_qos_usage_is_the_whole_qos_or_this_login_only() -> None:
    qos = {item["name"]: item for item in slurm.parse_qos(QOS, "alice")}
    assert qos["normal"]["usage"] == {
        "GrpTRES": "cpu=0,mem=0,gres/gpu=12",
        "MaxJobsPU": "1",
        "MaxSubmitJobsPU": "2",
        "MaxTRESPU": "cpu=16,gres/gpu=2",
    }
    # Without this login's own lines, no other user's usage stands in for it.
    assert slurm.parse_qos(QOS, "carol")[0]["usage"] == {"GrpTRES": "cpu=0,mem=0,gres/gpu=12"}
    assert slurm.parse_qos(QOS)[0]["usage"] == {"GrpTRES": "cpu=0,mem=0,gres/gpu=12"}


def test_failures_keep_only_own_terminal_failures() -> None:
    output = "\n".join(
        [
            sacct_line(),
            sacct_line(
                JobID="1002",
                JobName="eval-b",
                State="OUT_OF_MEMORY",
                AllocTRES="cpu=8,gres/gpu:a100=2,mem=32G,node=1",
                NCPUS="8",
                NodeList="node-02",
                End="2026-01-05T11:00:00",
                ExitCode="0:125",
            ),
            sacct_line(JobID="1003", State="COMPLETED", ExitCode="0:0"),
            sacct_line(JobID="1004", State="CANCELLED by 1000", ExitCode="0:15"),
            sacct_line(JobID="1005", User="bob", End="2026-01-05T12:00:00"),
            sacct_line(JobID="1006", State="NODE_FAIL", End="Unknown"),
            sacct_line(JobID="1007", State="RUNNING", End="Unknown"),
        ]
    )
    failures = slurm.parse_failures(output + "\n", SOURCE)
    assert [row["id"] for row in failures] == ["cluster-a:1002", "cluster-a:1001"]
    oom, failed = failures
    assert oom["state"] == "OUT_OF_MEMORY"
    assert oom["gpu_count"] == 2
    assert oom["gpu_type"] == "a100"
    assert oom["exit_code"] == "0:125"
    assert oom["end"] == "2026-01-05T11:00:00"
    assert failed["source_id"] == "cluster-a-alice"
    assert failed["cluster_id"] == "cluster-a"
    assert failed["user"] == "alice"
    assert failed["gpu_count"] == 4
    assert failed["cpu_count"] == 16
    assert failed["node"] == "node-01"
    assert failed["gpu_utilization"] is None
    assert failed["observed_at"]


@pytest.mark.parametrize("state", slurm.FAILURE_STATES)
def test_every_failure_state_is_reported(state: str) -> None:
    failures = slurm.parse_failures(sacct_line(State=state), SOURCE)
    assert [row["state"] for row in failures] == [state]


@pytest.mark.parametrize("state", ["COMPLETED", "CANCELLED", "RUNNING", "PENDING", "REQUEUED"])
def test_non_failure_states_are_not_inferred_as_failures(state: str) -> None:
    assert slurm.parse_failures(sacct_line(State=state), SOURCE) == []


@pytest.mark.parametrize("reverse", [False, True])
def test_requeued_job_reports_its_latest_attempt(reverse: bool) -> None:
    attempts = [
        sacct_line(JobID="1010", State="TIMEOUT", End="2026-01-05T08:00:00", ExitCode="0:0"),
        sacct_line(JobID="1010", State="NODE_FAIL", End="2026-01-05T13:00:00", ExitCode="0:0"),
    ]
    if reverse:
        attempts.reverse()
    failures = slurm.parse_failures("\n".join(attempts), SOURCE)
    assert len(failures) == 1
    assert failures[0]["state"] == "NODE_FAIL"
    assert failures[0]["end"] == "2026-01-05T13:00:00"


def test_unexpected_sacct_columns_are_rejected() -> None:
    with pytest.raises(SourceError) as error:
        slurm.parse_failures("1001|train-a|alice|FAILED\n", SOURCE)
    assert error.value.message() == {"code": "unexpected_output", "command": "sacct"}
    assert slurm.parse_failures("", SOURCE) == []


def test_validate_requires_connection_settings() -> None:
    driver = slurm.SlurmDriver()
    driver.validate(SOURCE)
    for changes in ({"ssh_alias": ""}, {"username": ""}):
        with pytest.raises(SourceError, match="cluster_connection_required"):
            driver.validate({**SOURCE, **changes})
    with pytest.raises(SourceError, match="invalid_ssh_alias"):
        driver.validate({**SOURCE, "ssh_alias": "-oProxyCommand"})


def fake_cluster(
    calls: list[tuple[str, str, list[str] | None]], failure: Exception | None = None
) -> Any:
    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        calls.append((destination, command, options))
        if " squeue " in command:
            return job_line(UserName=SOURCE["username"]) + "\n"
        if failure is not None:
            raise failure
        if command == "scontrol -d show nodes -o":
            return NODES
        if command == "scontrol show partition -o":
            return PARTITIONS
        if command == "scontrol show assoc_mgr flags=qos":
            return QOS
        if command.startswith("scontrol show assoc_mgr users="):
            return (
                "Association Records\n"
                "ClusterName=cluster-a Account=lab UserName=alice(1001) Partition= ID=1\n"
            )
        if command.startswith("sacctmgr"):
            return "cluster-a|lab|alice||normal,debug,long\n"
        if " sacct " in command:
            return sacct_line() + "\n" + slurm.HISTORY_MARKER + "\n" + terminal_line()
        raise AssertionError(f"Unexpected command: {command}")

    return run


@pytest.mark.parametrize("tracked", [True, False])
async def test_collect_passes_gpu_tracking_to_accounting(
    monkeypatch: pytest.MonkeyPatch, tracked: bool
) -> None:
    calls: list[tuple[str, str, list[str] | None]] = []
    fake = fake_cluster(calls)
    tres = "billing=4,cpu=4,mem=16G,node=1"

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if command == "scontrol -d show nodes -o" and not tracked:
            return "NodeName=node-01 CfgTRES=cpu=64 State=IDLE Partitions=gpu Gres=gpu:4\n"
        if " sacct " in command:
            return (
                sacct_line(AllocTRES=tres)
                + "\n"
                + slurm.HISTORY_MARKER
                + "\n"
                + terminal_line(AllocTRES=tres)
            )
        return await fake(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert "history" in batch.capabilities
    assert batch.finished and batch.failures
    assert (
        batch.finished[0]["gpu_count"] == batch.failures[0]["gpu_count"] == (0 if tracked else None)
    )


async def test_collect_reads_jobs_nodes_qos_and_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    user = "alice@example.org"
    source = {**SOURCE, "id": "cluster-a-alice-example-org", "username": user}
    calls: list[tuple[str, str, list[str] | None]] = []

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if " squeue " in command:
            calls.append((destination, command, options))
            return job_line(UserName=user, QOS="long") + "\n"
        if command.startswith("sacctmgr"):
            calls.append((destination, command, options))
            return f"cluster-a|lab|{user}||normal,debug,long\n"
        if " sacct " in command:
            calls.append((destination, command, options))
            return (
                sacct_line(User=user)
                + "\n"
                + slurm.HISTORY_MARKER
                + "\n"
                + terminal_line(User=user)
            )
        return await fake_cluster(calls)(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await slurm.SlurmDriver().collect(source)
    assert batch.history_window_seconds == 86400
    assert batch.capabilities == [
        "jobs",
        "nodes",
        "partition_policy",
        "qos_limits",
        "qos_access",
        "history",
    ]
    assert batch.warnings == []
    assert batch.jobs is not None and batch.jobs[0]["user"] == user
    assert batch.jobs[0]["id"] == "cluster-a:42"
    assert batch.nodes is not None and len(batch.nodes) == 4
    assert batch.failures is not None and [row["id"] for row in batch.failures] == [
        "cluster-a:1001"
    ]
    assert batch.qos is not None
    qos = {item["name"]: item for item in batch.qos}
    assert set(qos) == {"normal", "long", "debug"}
    assert qos["normal"]["limits"]["MaxJobsPU"] == "4"
    assert qos["long"]["origin"] == "observed_job_access_unverified"
    assert set(batch.snapshot()) == {"jobs", "nodes", "failures"}

    assert all(dest == "cluster-a" and opts == ["-l", user] for dest, _, opts in calls)
    commands = [command for _, command, _ in calls]
    squeue = next(command for command in commands if " squeue " in command)
    assert f"--user={user}" in squeue
    assert "--array" in squeue
    assert squeue.startswith("env SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z squeue ")
    assert "SubmitTime" in squeue and "StartTime" in squeue
    sacct = next(command for command in commands if " sacct " in command)
    assert sacct.startswith("env SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z sacct ")
    assert f"--user={user}" in sacct
    assert "--allocations" in sacct and "--parsable2" in sacct
    # sacct needs both time bounds when filtering by state.
    assert "--starttime=now-24hours" in sacct and "--endtime=now" in sacct
    assert "--state=" + ",".join(slurm.FAILURE_STATES) in sacct
    # Collection is read-only.
    assert {command.split()[0] for command in commands} == {
        "env",
        "scontrol",
        "sacctmgr",
    }
    for command in commands:
        assert not {"update", "create", "delete", "sbatch", "scancel"} & set(command.split())


@pytest.mark.parametrize("failure", [ssh.SSHError("Permission denied"), TimeoutError()])
async def test_partial_permissions_keep_supported_data(
    monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    calls: list[tuple[str, str, list[str] | None]] = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, failure))
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.capabilities == ["jobs"]
    assert batch.jobs is not None and batch.jobs[0]["id"] == "cluster-a:42"
    # Not collected is not "none": the stored nodes and failures must survive.
    assert batch.nodes is None
    assert batch.failures is None
    assert batch.instances is None
    assert set(batch.snapshot()) == {"jobs"}
    assert batch.qos == [
        {
            "name": "normal",
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
    assert len(calls) == 6
    assert calls[0][2] == ["-l", "alice"]


async def test_malformed_optional_output_becomes_a_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, list[str] | None]] = []
    healthy = fake_cluster(calls)

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if command == "scontrol -d show nodes -o":
            return "garbage\n"
        if " sacct " in command:
            return "1|2|3\n"
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.nodes is None
    assert batch.failures is None
    assert [warning["code"] for warning in batch.warnings] == [
        "nodes_unavailable",
        "history_unavailable",
    ]
    assert "qos_limits" in batch.capabilities


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
        await slurm.SlurmDriver().collect(SOURCE)
    assert error.value.code == code
    assert len(calls) == 1


async def test_malformed_queue_output_fails_instead_of_reporting_no_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        return "unexpected banner text\n"

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(SourceError, match="unexpected_output"):
        await slurm.SlurmDriver().collect(SOURCE)


@pytest.mark.parametrize(
    "changes",
    [
        {"ssh_alias": "-oProxyCommand=touch"},
        {"ssh_alias": "cluster-a extra"},
        {"username": "alice;id"},
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
        await slurm.SlurmDriver().collect({**SOURCE, **changes})


def test_nodes_report_their_gpu_model_when_the_scheduler_names_it() -> None:
    typed = "NodeName=g1 State=IDLE Gres=gpu:h100:8 CfgTRES=cpu=96,gres/gpu=8 AllocTRES="
    untyped = "NodeName=g2 State=IDLE Gres=gpu:8 CfgTRES=cpu=96,gres/gpu=8 AllocTRES="
    nodes = slurm.parse_nodes(typed + "\n" + untyped, SOURCE)
    assert [node["gpu_type"] for node in nodes] == ["h100", None]


def test_warnings_keep_the_first_line_of_a_repeated_error() -> None:
    from computedeck.drivers.slurm import _unavailable

    error = RuntimeError(
        "sacct: error: _open_persist_conn: failed to open persistent connection\n"
        "sacct: error: Sending PersistInit msg: Connection refused\n"
        "sacct: error: Problem talking to the database: Connection refused\n"
    )
    assert _unavailable("history_unavailable", error) == {
        "code": "history_unavailable",
        "detail": "sacct: error: _open_persist_conn: failed to open persistent connection",
    }


def test_repeated_gres_and_untracked_gpu_allocation() -> None:
    nodes = slurm.parse_nodes(
        "NodeName=g1 State=MIXED Gres=gpu:a100:4(S:0),gpu:a100:4(S:1) "
        "GresUsed=gpu:a100:4(IDX:0-3),gpu:a100:4(IDX:4-7) "
        "CfgTRES=cpu=64 AllocTRES=cpu=64\n"
        "NodeName=g2 State=MIXED Gres=gpu:a100:8 CfgTRES=cpu=64 AllocTRES=cpu=64",
        SOURCE,
    )
    assert nodes[0]["gpu_count"] == nodes[0]["gpu_allocated"] == 8
    assert nodes[1]["gpu_allocated"] is None


def test_node_reason_cannot_override_scheduler_fields() -> None:
    [node] = slurm.parse_nodes(
        "NodeName=g1 State=DOWN+DRAIN CfgTRES=gres/gpu=8 AllocTRES=gres/gpu=8 "
        "Reason=broken State=IDLE CfgTRES=gres/gpu=0 NodeName=fake",
        SOURCE,
    )
    assert (node["name"], node["state"], node["gpu_count"]) == ("g1", "down+drain", 8)


def test_squeue_control_delimiter_preserves_pipes_in_job_names() -> None:
    line = job_line().replace("|", "\x1f").replace("train model", "train|eval")
    assert slurm.parse_jobs(line, SOURCE)[0]["name"] == "train|eval"


def test_array_query_requests_distinct_element_ids() -> None:
    assert slurm._FIELDS[0] == "JobArrayID"
    lines = "\n".join(job_line(JobArrayID=f"1234_{index}") for index in range(10))
    jobs = slurm.parse_jobs(lines, SOURCE)
    assert len(jobs) == 10
    assert sum(job["gpu_count"] for job in jobs) == 80


def test_failed_job_without_gpu_tres_does_not_claim_zero() -> None:
    [job] = slurm.parse_failures(
        sacct_line(AllocTRES="cpu=16,node=1", NodeList="None assigned"), SOURCE
    )
    assert job["gpu_count"] is None
    assert job["node"] is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "Association Records\n"
            "ClusterName=cluster-a Account=lab UserName=alice(1001) Partition= ID=1\n",
            None,
        ),
        (
            "ClusterName=cluster-a Account=lab UserName=alice(1001) QOS=normal,debug\n",
            {"normal", "debug"},
        ),
        ("ClusterName=cluster-a UserName=bob(1002) QOS=admin\n", None),
        ("ClusterName=cluster-a UserName=alice(1001) QOS=\n", set()),
        ("ClusterName=cluster-a UserName=alice(1001) QOS=+normal\n", None),
        ("No associations currently cached in Slurm.\n", set()),
        ("ClusterName=cluster-a UserName=alice(1001) Comment=QOS=admin\n", None),
        ("QOS=admin(1)\n", None),
    ],
)
def test_association_access_requires_explicit_grants(text, expected):
    # Current upstream text omits QOS. Explicit-field examples exercise the requested
    # parser without misrepresenting that omission as an empty permission list.
    assert slurm.association_qos(text, "alice") == expected


async def test_association_access_does_not_follow_partition_or_qos_definitions(monkeypatch):
    calls = []
    healthy = fake_cluster(calls)

    async def run(destination, command, options=None):
        if command.startswith("scontrol show assoc_mgr users="):
            return "ClusterName=cluster-a Account=lab UserName=alice(1001) QOS=normal\n"
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert {qos["name"]: qos["access"] for qos in batch.qos} == {
        "normal": "verified",
        "debug": "not_associated",
        "long": "not_associated",
    }


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        (
            "cluster-a|lab|alice||normal,debug\ncluster-b|lab|alice||other\ncluster-a|lab|bob||admin\n",
            {"normal", "debug"},
        ),
        ("cluster-a|lab|alice||\n", set()),
        ("", set()),
        ("bad output", None),
        ("cluster-a|lab|alice||+normal\n", None),
    ],
)
def test_database_grants_are_scoped_to_the_controller_and_login(output, expected):
    assert slurm.database_qos(output, "alice", "cluster-a") == expected


async def test_database_query_failure_keeps_permissions_unknown(monkeypatch):
    healthy = fake_cluster([])

    async def run(destination, command, options=None):
        if command.startswith("sacctmgr"):
            assert "user=alice" in command and "cluster=cluster-a" in command
            raise ssh.SSHError("Accounting unavailable")
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.qos and all(item["access"] == "unknown" for item in batch.qos)
    assert "qos_access" not in batch.capabilities
    assert batch.jobs


def test_job_timestamps_keep_offsets_and_do_not_treat_estimated_starts_as_actual() -> None:
    running = slurm.parse_jobs(job_line(), SOURCE)[0]
    assert running["submitted_at"] == "2026-01-05T07:00:00+04:00"
    assert running["started_at"] == "2026-01-05T08:00:00+04:00"
    pending = slurm.parse_jobs(job_line(State="PENDING"), SOURCE)[0]
    assert pending["started_at"] is None
    unknown = slurm.parse_jobs(job_line(SubmitTime="Unknown", StartTime="N/A"), SOURCE)[0]
    assert unknown["submitted_at"] is None and unknown["started_at"] is None


def test_terminal_history_has_offsets_and_keeps_failure_end_unchanged() -> None:
    output = "\n".join(
        [
            terminal_line(State="COMPLETED", JobID="20"),
            terminal_line(State="CANCELLED by 1000", JobID="21"),
            terminal_line(State="BOOT_FAIL", JobID="22"),
            terminal_line(State="DEADLINE", JobID="23"),
        ]
    )
    rows = slurm.parse_failures(output, SOURCE, terminal=True)
    assert {row["state"] for row in rows} == {"COMPLETED", "CANCELLED", "BOOT_FAIL", "DEADLINE"}
    assert all(row["end"] == "2026-01-05T10:00:00+04:00" for row in rows)
    assert rows[0]["submitted_at"] == "2026-01-05T08:00:00+04:00"
    assert rows[0]["started_at"] == "2026-01-05T09:00:00+04:00"
    assert slurm.parse_failures(sacct_line(), SOURCE)[0]["end"] == "2026-01-05T10:00:00"


@pytest.mark.parametrize(
    "minutes,capabilities,window",
    [
        (10, ["history"], 15),
        (1440, ["history"], 1445),
        (1441, ["history"], 1446),
        (3000, ["history"], 1447),
        (10, [], 1440),
        (10, None, 1440),
    ],
)
async def test_terminal_window_overlaps_previous_success_and_is_capped(
    monkeypatch: pytest.MonkeyPatch, minutes: int, capabilities: list[str] | None, window: int
) -> None:
    from datetime import UTC, datetime, timedelta

    clock = datetime.now(UTC)
    monkeypatch.setattr(slurm, "now", lambda: clock.isoformat())
    calls: list[tuple[str, str, list[str] | None]] = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls))
    batch = await slurm.SlurmDriver().collect(
        {
            **SOURCE,
            "last_success": (clock - timedelta(minutes=minutes)).isoformat(),
            "capabilities": capabilities,
        }
    )
    command = next(command for _, command, _ in calls if slurm.HISTORY_MARKER in command)
    assert "\n" not in command
    assert f"--starttime=now-{window}minutes" in command
    assert "--starttime=now-24hours" in command
    assert "env SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z sacct" in command
    assert batch.finished and batch.failures
    assert "finished" not in batch.snapshot()


async def test_upgrade_seeds_full_history_before_an_accounting_outage(
    monkeypatch: pytest.MonkeyPatch,
    store: Store,
    add_source: Callable[..., dict[str, Any]],
    tmp_path: Path,
) -> None:
    clock = datetime.now(UTC)
    for module in (slurm, collector, events):
        monkeypatch.setattr(module, "now", lambda: clock.isoformat())
    source = add_source()
    source.update(
        last_success=(clock - timedelta(minutes=10)).isoformat(), capabilities=["history"]
    )
    store.save_source(source)
    store.save_snapshot(source["id"], {"jobs": []})  # A pre-upgrade snapshot.
    end = (clock - timedelta(hours=3)).isoformat()
    history_calls: list[str] = []
    run = fake_cluster([])

    async def ssh_run(alias: str, command: str, options: list[str] | None = None) -> str:
        if " squeue " in command:
            return ""
        if slurm.HISTORY_MARKER in command:
            history_calls.append(command)
            if len(history_calls) == 2:
                raise SourceError("timeout")
            finished = (
                "\n".join(
                    terminal_line(JobID=job_id, State=state, End=end)
                    for job_id, state in [("1001", "FAILED"), ("1002", "COMPLETED")]
                )
                if "--starttime=now-1440minutes" in command
                else ""
            )
            return sacct_line(End=end[:19]) + "\n" + slurm.HISTORY_MARKER + "\n" + finished
        return await run(alias, command, options)

    monkeypatch.setattr(ssh, "run", ssh_run)
    runtime = Runtime(tmp_path)
    runtime.store = store
    runner = collector.Collector(runtime)
    for _ in range(3):
        await runner.collect(source["id"])
        # Accounting is unavailable, but the scheduler stays awake between collections.
        for _ in range(10):
            clock += timedelta(minutes=1)
            runner._heartbeat()
    assert len(history_calls) == 3
    assert "--starttime=now-1440minutes" in history_calls[0]
    assert "--starttime=now-15minutes" in history_calls[1]
    assert "--starttime=now-1440minutes" in history_calls[2]
    assert len(store.events()) == 2
    assert all(row["silent"] for row in store.events())
    assert store.recent_events() == []


@pytest.mark.parametrize(
    ("job_id", "array_id", "array_index"),
    [
        ("1234_7", "1234", "7"),
        ("1234_0", "1234", "0"),
        ("1234", None, None),
        ("1234+0", None, None),
        ("1234_[1-30]", None, None),
        ("1234_7.batch", None, None),
        ("unknown", None, None),
    ],
)
def test_array_fields_on_queue_and_accounting_rows(
    job_id: str, array_id: str | None, array_index: str | None
) -> None:
    rows = slurm.parse_jobs(job_line(JobArrayID=job_id), SOURCE)
    rows += slurm.parse_failures(sacct_line(JobID=job_id), SOURCE)
    rows += slurm.parse_failures(terminal_line(JobID=job_id), SOURCE, terminal=True)
    assert len(rows) == 3
    for row in rows:
        assert (row["array_id"], row["array_index"]) == (array_id, array_index)


@pytest.mark.parametrize(
    "code,status,signal",
    [
        ("0:9", 0, 9),
        ("127:0", 127, 0),
        ("0:125", 0, 125),
        ("137", None, None),
        ("Unknown", None, None),
    ],
)
def test_failure_exit_fields_and_offset_preserve_raw_end(code, status, signal) -> None:
    [row] = slurm.parse_failures(sacct_line(ExitCode=code, End="2026-01-05T10:00:00+0400"), SOURCE)
    assert (row["exit_code"], row["exit_status"], row["exit_signal"]) == (
        None if code in slurm.EMPTY else code,
        status,
        signal,
    )
    assert row["end"] == "2026-01-05T10:00:00"
    assert row["ended_at"] == "2026-01-05T10:00:00+04:00"
    assert slurm.parse_failures(sacct_line(), SOURCE)[0]["ended_at"] is None


@pytest.mark.parametrize(
    "limit", ["02:00:00", "2-00:00:00", "UNLIMITED", "Partition_Limit", *sorted(slurm.EMPTY)]
)
@pytest.mark.parametrize("terminal", [False, True])
def test_history_time_limit_is_known_or_null(limit, terminal) -> None:
    line = terminal_line if terminal else sacct_line
    [row] = slurm.parse_failures(line(Timelimit=limit), SOURCE, terminal=terminal)
    assert row["time_limit"] == (limit if limit in {"02:00:00", "2-00:00:00"} else None)
    with pytest.raises(SourceError, match="unexpected_output"):
        slurm.parse_failures(line(Timelimit=limit).rsplit("|", 1)[0], SOURCE, terminal=terminal)


QUEUE_CONFIG = """Configuration data as of 2026-01-05T10:00:00
PriorityType            = priority/multifactor
PriorityWeightAge       = 1000
PriorityWeightFairShare = 10000
PriorityFlags           =
PrivateData             = none
SlurmctldPort           = 6817
"""
FAIRSHARE = """Association Records
ClusterName=cluster-a Account=lab-a UserName=alice(1001) Partition= ID=1 QOS=normal
    SharesRaw/Norm/Level/Factor=1/0.50/2/0.12
ClusterName=cluster-a Account=lab-b UserName=alice(1001) Partition= ID=2 QOS=normal
    SharesRaw/Norm/Level/Factor=1/0.50/2/0.76
ClusterName=cluster-a Account=lab-a UserName=bob(1002) Partition= ID=3 QOS=normal
    SharesRaw/Norm/Level/Factor=1/0.50/2/0.99
"""


def test_association_fairshare_uses_only_the_login_and_matching_account() -> None:
    assert slurm.association_fairshare(FAIRSHARE, "alice") == {"lab-a": 0.12, "lab-b": 0.76}
    assert slurm.association_fairshare("not available", "alice") == {}
    for factor in ("nan", "inf", "-1", "1.1", "N/A"):
        assert (
            slurm.association_fairshare(FAIRSHARE.replace("0.12", factor), "alice")["lab-a"] is None
        )
    assert slurm.association_fairshare(FAIRSHARE.replace("0.12", "0.00"), "alice")["lab-a"] == 0
    missing = FAIRSHARE.replace("    SharesRaw/Norm/Level/Factor=1/0.50/2/0.12\n", "")
    assert slurm.association_fairshare(missing, "alice")["lab-a"] is None
    conflicting = FAIRSHARE + FAIRSHARE.replace("0.12", "0.32")
    assert slurm.association_fairshare(conflicting, "alice")["lab-a"] is None


def test_queue_positions_follow_each_partition_and_separate_earlier_ties() -> None:
    jobs = slurm.parse_jobs(
        job_line(State="PENDING", Reason="Priority", Partition="gpu,debug"), SOURCE
    )
    output = """900|gpu|900001|Resources
800|gpu|900002|Dependency
800|gpu|900003|QOSMaxGRESPerUser
700|gpu|900004|JobHeldUser
600|gpu|900005|Priority
600|gpu|42|Priority
600|gpu|900006|Priority
100|debug|42|Priority
"""
    assert slurm.queue_positions(output, jobs) == {
        "cluster-a:42": [
            {"partition": "gpu", "ahead": 1, "ties": 1},
            {"partition": "debug", "ahead": 0, "ties": 0},
        ]
    }
    # An omitted partition is unknown, not a partial or zero position.
    assert slurm.queue_positions(output.replace("100|debug|42|Priority", ""), jobs) == {
        "cluster-a:42": None
    }
    assert slurm.queue_positions("", jobs) == {"cluster-a:42": None}
    # Preserve the scheduler's row order, even if priorities alone suggest another order.
    assert (
        slurm.queue_positions(output.replace("900|gpu", "100|gpu"), jobs)["cluster-a:42"][0][
            "ahead"
        ]
        == 1
    )


@pytest.mark.parametrize(
    "output",
    [
        "unrecognized output",
        "oops|gpu|42|Priority",
        "100|gpu,debug|42|Priority",
        "100||42|Priority",
        "100|gpu|not-a-job|Priority",
    ],
)
def test_queue_positions_reject_unrecognized_output(output: str) -> None:
    jobs = slurm.parse_jobs(job_line(State="PENDING", Reason="Priority"), SOURCE)
    with pytest.raises(SourceError, match="unexpected_output"):
        slurm.queue_positions(output, jobs)


@pytest.fixture
def queue_cluster(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    """Optional queue steps on top of the existing normal collection fixture."""
    slurm._QUEUE_CONFIG.clear()
    state: dict[str, Any] = {
        "jobs": job_line(State="PENDING", Reason="Priority"),
        "config": QUEUE_CONFIG,
        "queue": "900|gpu|900001|Resources\n600|gpu|42|Priority\n",
        "associations": FAIRSHARE,
        "commands": [],
    }
    healthy = fake_cluster([])

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        state["commands"].append(command)
        if " squeue " in command:
            return state["jobs"]
        if command == "scontrol show config":
            value = state["config"]
        elif command.startswith("squeue -h"):
            value = state["queue"]
        elif command.startswith("scontrol show assoc_mgr users="):
            value = state["associations"]
        else:
            return await healthy(destination, command, options)
        if isinstance(value, Exception):
            raise value
        return value

    monkeypatch.setattr(ssh, "run", run)
    yield state
    slurm._QUEUE_CONFIG.clear()


async def test_queue_collection_keeps_only_counts_and_own_ids(
    queue_cluster, tmp_path, caplog
) -> None:
    import json
    import shlex

    source = {**SOURCE, "enabled": True, "interval_minutes": 10}
    batch = await slurm.SlurmDriver().collect(source)
    batch.validate_rows()
    assert batch.jobs[0]["queue"] == [{"partition": "gpu", "ahead": 1, "ties": 0}]
    assert batch.jobs[0]["fairshare"] == 0.12
    assert batch.jobs[0]["queue_unknown"] is None
    assert not batch.warnings
    assert "queue_position" not in batch.capabilities
    assert not any(check.warning == "queue_unavailable" for check in slurm.SlurmDriver.info.checks)
    command = next(c for c in queue_cluster["commands"] if c.startswith("squeue -h"))
    assert shlex.split(command) == [
        "squeue",
        "-h",
        "--array",
        "--local",
        "-P",
        "-t",
        "PD",
        "-p",
        "gpu",
        "--sort=-p,i",
        "-o",
        "%Q|%P|%i|%r",
    ]
    store = Store(tmp_path / "queue.sqlite3")
    store.save_snapshot(source["id"], {"jobs": batch.jobs})
    assert "900001" not in json.dumps(batch.model_dump())
    assert store.snapshot(source["id"])["jobs"] == batch.jobs
    assert "900001" not in json.dumps(store.snapshot(source["id"]))
    assert "900001" not in caplog.text


@pytest.mark.parametrize("private", ["jobs", "accounts,jobs", "ALL"])
async def test_private_queue_is_unknown_without_a_query_or_warning(queue_cluster, private) -> None:
    queue_cluster["config"] = QUEUE_CONFIG.replace("none", private)
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.jobs[0]["queue"] is None
    assert batch.jobs[0]["queue_unknown"] == "private_data"
    assert batch.jobs[0]["fairshare"] == 0.12
    assert not any(c.startswith("squeue -h") for c in queue_cluster["commands"])
    assert not batch.warnings


@pytest.mark.parametrize(
    "config",
    [
        "Configuration data as of 2026-01-05T10:00:00\n"
        "PriorityType            = priority/basic\n"
        "PrivateData             = none\n"
        "SlurmctldPort           = 6817\n",
        QUEUE_CONFIG.replace("PriorityWeightFairShare = 10000\n", ""),
        QUEUE_CONFIG.replace("10000", "0"),
        QUEUE_CONFIG.replace("10000", "unknown"),
    ],
)
async def test_fairshare_requires_a_known_active_weight(queue_cluster, config) -> None:
    queue_cluster["config"] = config
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.jobs[0]["fairshare"] is None
    assert batch.jobs[0]["queue"] == [{"partition": "gpu", "ahead": 1, "ties": 0}]
    assert batch.jobs[0]["queue_unknown"] is None
    assert not batch.warnings


@pytest.mark.parametrize(
    "step,value",
    [
        ("queue", ssh.SSHError("900001: private remote diagnostic")),
        ("queue", TimeoutError()),
        ("queue", "malformed 900001 output"),
        ("config", ssh.SSHError("private diagnostic")),
        ("config", TimeoutError()),
        ("config", "not recognized"),
        ("config", QUEUE_CONFIG.replace("PrivateData             = none\n", "")),
        ("config", QUEUE_CONFIG.replace("PriorityType            = priority/multifactor\n", "")),
    ],
)
async def test_optional_queue_failures_are_generic_and_do_not_fail_collection(
    queue_cluster, step, value, caplog
) -> None:
    import json

    queue_cluster[step] = value
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.jobs[0]["queue"] is None
    assert batch.jobs[0]["queue_unknown"] == "failed"
    assert batch.warnings == [{"code": "queue_unavailable"}]
    assert "jobs" in batch.capabilities
    assert "900001" not in json.dumps(batch.model_dump()) + caplog.text
    if step == "config":
        assert not any(c.startswith("squeue -h") for c in queue_cluster["commands"])


@pytest.mark.parametrize("output", ["900|gpu|900001|Priority", "", "100|gpu|42|QOSMaxGRESPerUser"])
async def test_successful_queue_query_without_own_wait_is_unknown_without_warning(
    queue_cluster, output, caplog
) -> None:
    import json

    queue_cluster["queue"] = output
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.jobs[0]["queue"] is None
    assert batch.jobs[0]["queue_unknown"] == "failed"
    assert batch.jobs[0]["fairshare"] == 0.12
    assert not batch.warnings
    assert "jobs" in batch.capabilities
    assert "900001" not in json.dumps(batch.model_dump()) + caplog.text


@pytest.mark.parametrize(
    "state,reason",
    [
        ("RUNNING", "None"),
        ("PENDING", "Dependency"),
        ("PENDING", "QOSMaxGRESPerUser"),
    ],
)
async def test_queue_steps_are_skipped_without_eligible_waits(queue_cluster, state, reason) -> None:
    queue_cluster["jobs"] = job_line(State=state, Reason=reason)
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert "queue" not in batch.jobs[0]
    assert "scontrol show config" not in queue_cluster["commands"]
    assert not any(c.startswith("squeue -h") for c in queue_cluster["commands"])
    assert not batch.warnings


async def test_resources_and_array_elements_get_queue_facts(queue_cluster) -> None:
    queue_cluster["jobs"] = job_line(JobID="42_7", State="PENDING", Reason="Resources")
    queue_cluster["queue"] = "100|gpu|42_7|Resources"
    batch = await slurm.SlurmDriver().collect(SOURCE)
    assert batch.jobs[0]["queue"] == [{"partition": "gpu", "ahead": 0, "ties": 0}]
    assert batch.jobs[0]["fairshare"] == 0.12


async def test_queue_config_cache_expires_and_is_scoped_to_source_and_connection(
    queue_cluster, monkeypatch
) -> None:
    clock = [100.0]
    monkeypatch.setattr(slurm.time, "monotonic", lambda: clock[0])
    await slurm.SlurmDriver().collect(SOURCE)
    clock[0] += 3599
    await slurm.SlurmDriver().collect(SOURCE)
    assert queue_cluster["commands"].count("scontrol show config") == 1
    clock[0] += 1
    await slurm.SlurmDriver().collect(SOURCE)
    await slurm.SlurmDriver().collect({**SOURCE, "id": "another-source"})
    await slurm.SlurmDriver().collect({**SOURCE, "ssh_alias": "another-target"})
    assert queue_cluster["commands"].count("scontrol show config") == 4
    assert sum(c.startswith("squeue -h") for c in queue_cluster["commands"]) == 5


@pytest.mark.parametrize(
    "fields",
    [
        {"queue": "not a list"},
        {"queue": [None]},
        {"queue": [{"partition": "gpu", "ahead": -1, "ties": 0}]},
        {"queue": [{"partition": "gpu", "ahead": 0, "ties": True}]},
        {"queue": [{"partition": None, "ahead": 0, "ties": 0}]},
        {"queue_unknown": "guessed"},
        {"fairshare": "0.12"},
        {"fairshare": True},
        {"fairshare": 1.2},
        {"fairshare": -0.1},
    ],
)
def test_queue_fields_are_validated_before_storage(fields) -> None:
    from computedeck.drivers.base import validate_row

    with pytest.raises(ValueError):
        validate_row({"id": "cluster-a:42", "queue_unknown": None, **fields})


@pytest.mark.parametrize("kind", ["jobs", "nodes", "instances", "failures", "finished"])
def test_plugin_queue_fields_without_slurm_opt_in_remain_compatible(kind, tmp_path) -> None:
    from computedeck.drivers.base import Batch

    row = {
        "id": "cluster-a:42",
        "source_id": "cluster-a-alice",
        "state": "PENDING",
        "queue": "batch",
        "fairshare": 45.0,
    }
    batch = Batch(**{kind: [row]})
    batch.validate_rows()
    assert getattr(batch, kind) == [row]
    # Finished rows are transient; all other row kinds also survive stored snapshots.
    if kind != "finished":
        store = Store(tmp_path / "plugin.sqlite3")
        store.save_snapshot("cluster-a-alice", {kind: getattr(batch, kind)})
        saved = store.snapshot("cluster-a-alice")[kind]
        assert len(saved) == 1
        assert {key: saved[0][key] for key in row} == row
