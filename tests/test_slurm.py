"""Slurm driver: squeue/scontrol/sacct parsing and read-only collection over SSH.

All sample outputs are hand-written from the documented formats and use fictional data.
"""

from typing import Any

import pytest

from computedeck.drivers import slurm, ssh
from computedeck.drivers.base import SourceError

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
    }
    row.update(changes)
    return "|".join(row[field] for field in slurm._HISTORY_FIELDS)


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
        if command.startswith("squeue"):
            return job_line(UserName=SOURCE["username"]) + "\n"
        if failure is not None:
            raise failure
        if command == "scontrol -d show nodes -o":
            return NODES
        if command == "scontrol show partition -o":
            return PARTITIONS
        if command == "scontrol show assoc_mgr flags=qos":
            return QOS
        if command.startswith("sacct"):
            return sacct_line() + "\n"
        raise AssertionError(f"Unexpected command: {command}")

    return run


async def test_collect_reads_jobs_nodes_qos_and_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    user = "alice@example.org"
    source = {**SOURCE, "id": "cluster-a-alice-example-org", "username": user}
    calls: list[tuple[str, str, list[str] | None]] = []

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if command.startswith("squeue"):
            calls.append((destination, command, options))
            return job_line(UserName=user, QOS="long") + "\n"
        if command.startswith("sacct"):
            calls.append((destination, command, options))
            return sacct_line(User=user) + "\n"
        return await fake_cluster(calls)(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await slurm.SlurmDriver().collect(source)
    assert batch.capabilities == ["jobs", "nodes", "partition_policy", "qos_limits", "history"]
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
    squeue = next(command for command in commands if command.startswith("squeue"))
    assert f"--user={user}" in squeue
    assert "--array" in squeue
    sacct = next(command for command in commands if command.startswith("sacct"))
    assert f"--user={user}" in sacct
    assert "--allocations" in sacct and "--parsable2" in sacct
    # sacct needs both time bounds when filtering by state.
    assert "--starttime=now-24hours" in sacct and "--endtime=now" in sacct
    assert "--state=" + ",".join(slurm.FAILURE_STATES) in sacct
    # Collection is read-only.
    assert {command.split()[0] for command in commands} == {"squeue", "scontrol", "sacct"}
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
        {"name": "normal", "limits": {}, "origin": "observed_job_access_unverified"}
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
    assert len(calls) == 5
    assert calls[0][2] == ["-l", "alice"]


async def test_malformed_optional_output_becomes_a_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, list[str] | None]] = []
    healthy = fake_cluster(calls)

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if command == "scontrol -d show nodes -o":
            return "garbage\n"
        if command.startswith("sacct"):
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
