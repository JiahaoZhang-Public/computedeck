"""PBS driver: qstat/pbsnodes JSON parsing and read-only collection over SSH.

Sample outputs are hand-written from the documented JSON layout (OpenPBS qstat.c and
pbsnodes.c) and use fictional data.
"""

import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from computedeck.drivers import pbs, ssh
from computedeck.drivers.base import SourceError

SOURCE: dict[str, Any] = {
    "id": "cluster-a-alice",
    "name": "Cluster A",
    "driver": "pbs",
    "cluster_id": "cluster-a",
    "username": "alice",
    "ssh_alias": "cluster-a",
}
ENVELOPE = {"timestamp": 1767607200, "pbs_version": "23.06.06", "pbs_server": "pbs-server"}


def qstat_job(*drop: str, **changes: Any) -> dict[str, Any]:
    """One job of `qstat -f -F json`: a running two-GPU job unless changed."""
    job: dict[str, Any] = {
        "Job_Name": "train-a",
        "Job_Owner": "alice@login01",
        "resources_used": {
            "cpupercent": 790,
            "cput": "10:31:12",
            "mem": "8123456kb",
            "ncpus": 8,
            "vmem": "9123456kb",
            "walltime": "01:20:00",
        },
        "job_state": "R",
        "queue": "gpu",
        "server": "pbs-server",
        "Account_Name": "lab-a",
        "ctime": "Mon Jan  5 08:00:00 2026",
        "exec_host": "node001/0*8",
        "exec_vnode": "(node001:ncpus=8:ngpus=2:mem=32gb)",
        "Resource_List": {
            "mem": "32gb",
            "ncpus": 8,
            "ngpus": 2,
            "nodect": 1,
            "place": "free",
            "select": "1:ncpus=8:ngpus=2:mem=32gb",
            "walltime": "24:00:00",
        },
        "stime": "Mon Jan  5 08:40:00 2026",
        "euser": "alice",
        "egroup": "lab-a",
        "comment": "Job run at Mon Jan 05 at 08:40 on (node001:ncpus=8:ngpus=2:mem=32gb)",
        "Variable_List": {"PBS_O_HOME": "/home/alice", "PBS_O_WORKDIR": "/home/alice/project"},
    }
    for key in drop:
        job.pop(key)
    job.update(changes)
    return job


def queued(**changes: Any) -> dict[str, Any]:
    job = qstat_job("resources_used", "exec_host", "exec_vnode", "stime", job_state="Q")
    job["comment"] = "Not Running: Insufficient amount of resource: ngpus (R: 4 A: 2 T: 8)"
    job.update(changes)
    return job


def qstat(jobs: dict[str, dict[str, Any]]) -> str:
    return json.dumps({**ENVELOPE, "Jobs": jobs}, indent=4)


def node(name: str, *, state: str = "free", **changes: Any) -> dict[str, Any]:
    """One vnode of `pbsnodes -a -F json`; zero values are absent from resources_assigned."""
    value: dict[str, Any] = {
        "Mom": name,
        "Port": 15002,
        "pbs_version": "23.06.06",
        "ntype": "PBS",
        "state": state,
        "pcpus": 64,
        "resources_available": {
            "arch": "linux",
            "host": name,
            "mem": "515000mb",
            "ncpus": 64,
            "ngpus": 4,
            "vnode": name,
            "gpu_model": "a100",
        },
        "resources_assigned": {},
        "resv_enable": "True",
        "sharing": "default_shared",
        "license": "l",
        "last_state_change_time": 1767600000,
    }
    value.update(changes)
    return value


NODES = json.dumps(
    {
        **ENVELOPE,
        "nodes": {
            "node001": node(
                "node001",
                state="job-busy",
                jobs=["1001.pbs-server", "1002.pbs-server"],
                resources_assigned={"mem": "64gb", "ncpus": 64, "ngpus": 4},
            ),
            "node002": node(
                "node002",
                jobs=["1003[1].pbs-server"],
                resources_assigned={"mem": "32gb", "ncpus": 8, "ngpus": 2},
            ),
            "node003": node("node003"),
            "node004": node("node004", state="down,offline"),
            "cpu001": node(
                "cpu001",
                resources_available={"arch": "linux", "host": "cpu001", "ncpus": 128},
                queue="cpu",
            ),
        },
    },
    indent=4,
)
QUEUES = json.dumps(
    {
        **ENVELOPE,
        "Queue": {
            "gpu": {
                "queue_type": "Execution",
                "Priority": 100,
                "total_jobs": 12,
                "state_count": "Transit:0 Queued:4 Held:0 Waiting:0 Running:8 Exiting:0 Begun:0 ",
                "max_run": "[u:PBS_GENERIC=4]",
                "max_queued": "[u:PBS_GENERIC=20]",
                "max_run_res": {"ngpus": "[o:PBS_ALL=64],[u:PBS_GENERIC=8],[u:alice=16]"},
                "resources_max": {"ngpus": 8, "walltime": "48:00:00"},
                "resources_default": {"walltime": "01:00:00"},
                "enabled": "True",
                "started": "True",
            },
            "debug": {
                "queue_type": "Execution",
                "max_user_run": 1,
                "max_user_res": {"ngpus": 1},
                "resources_max": {"walltime": "00:30:00"},
                "enabled": "True",
                "started": "True",
            },
            "workq": {
                "queue_type": "Route",
                "route_destinations": "gpu,debug",
                "enabled": "True",
                "started": "True",
            },
            "retired": {"queue_type": "Execution", "enabled": "False", "started": "True"},
        },
    },
    indent=4,
)
SERVER = {
    **ENVELOPE,
    "Server": {
        "pbs-server": {
            "server_state": "Active",
            "server_host": "pbs-server",
            "scheduling": "True",
            "total_jobs": 120,
            "job_history_enable": "True",
            "job_history_duration": "336:00:00",
        }
    },
}


def finished(**changes: Any) -> dict[str, Any]:
    job = qstat_job(
        job_state="F",
        Exit_status=1,
        obittime="Mon Jan  5 10:00:00 2026",
        mtime="Mon Jan  5 10:00:01 2026",
    )
    job.update(changes)
    return job


def history(
    jobs: dict[str, dict[str, Any]] | None, *, enabled: bool = True, clock: str = ""
) -> str:
    server = json.loads(json.dumps(SERVER))
    if not enabled:
        del server["Server"]["pbs-server"]["job_history_enable"]
    parts = [clock or "2026-01-05T12:00:00", json.dumps(server, indent=4)]
    if jobs is not None:
        parts.append(qstat(jobs))
    return "\n".join(parts) + "\n"


def test_running_job_reads_ngpus_queue_host_and_walltime() -> None:
    jobs = pbs.parse_jobs(qstat({"1001.pbs-server": qstat_job()}), SOURCE)
    assert jobs == [
        {
            "id": "cluster-a:1001",
            "source_id": "cluster-a-alice",
            "cluster_id": "cluster-a",
            "name": "train-a",
            "user": "alice",
            "account": "lab-a",
            "partition": "gpu",
            "qos": "gpu",
            "state": "RUNNING",
            "gpu_count": 2,
            "gpu_type": None,
            "cpu_count": 8,
            "node": "node001",
            "elapsed": "1:20:00",
            "reason": None,
            "gpu_utilization": None,
            "cpu_utilization": None,
            "memory_utilization": None,
            "observed_at": jobs[0]["observed_at"],
        }
    ]
    assert jobs[0]["observed_at"]


def test_pending_jobs_keep_comments_and_blocked_jobs_keep_their_reason() -> None:
    output = qstat(
        {
            "1002.pbs-server": queued(),
            "1003.pbs-server": queued(job_state="H", comment=""),
            "1004.pbs-server": queued(job_state="W", comment=None),
        }
    )
    jobs = {job["id"]: job for job in pbs.parse_jobs(output, SOURCE)}
    pending = jobs["cluster-a:1002"]
    assert pending["state"] == "PENDING"
    assert pending["reason"] == "Insufficient amount of resource: ngpus (R: 4 A: 2 T: 8)"
    assert pending["gpu_count"] == 2
    assert pending["node"] is None
    assert pending["elapsed"] == ""
    assert jobs["cluster-a:1003"]["reason"] == "Held"
    assert jobs["cluster-a:1004"]["reason"] == "BeginTime"


@pytest.mark.parametrize(("state", "reason"), [("H", "Held"), ("W", "BeginTime")])
@pytest.mark.parametrize("comment", [None, "", "Not Running: waiting for resources"])
def test_blocked_states_take_precedence_over_comments(
    state: str, reason: str, comment: str | None
) -> None:
    row = pbs.parse_jobs(
        qstat({"1001.pbs-server": queued(job_state=state, comment=comment)}), SOURCE
    )[0]
    assert row["state"] == "PENDING"
    assert row["reason"] == reason


def test_multi_chunk_jobs_sum_gpus_and_list_every_host() -> None:
    job = qstat_job(
        exec_host="node001/0*8+node002/0*8",
        exec_vnode="(node001:ncpus=8:ngpus=4)+(node002:ncpus=8:ngpus=4)",
        Resource_List={"ncpus": 16, "nodect": 2, "select": "2:ncpus=8:ngpus=4"},
    )
    row = pbs.parse_jobs(qstat({"1005.pbs-server": job}), SOURCE)[0]
    # No job-wide ngpus: the allocated vnodes are summed, not the select chunk once.
    assert row["gpu_count"] == 8
    assert row["node"] == "node001,node002"
    pending = queued(Resource_List={"ncpus": 18, "select": "2:ncpus=8:ngpus=4+1:ncpus=2"})
    assert pbs.parse_jobs(qstat({"1006.pbs-server": pending}), SOURCE)[0]["gpu_count"] == 8


@pytest.mark.parametrize(
    ("resources", "count"),
    [
        ({"ncpus": 4, "select": "1:ncpus=4"}, 0),
        ({"ncpus": 4, "ngpus": 0}, 0),
        ({"ncpus": 4, "naccelerators": 0, "accelerator_memory": "0kb"}, 0),
        # A GPU resource other than ngpus: the count is unknown, never zero.
        ({"ncpus": 4, "select": "1:ncpus=4:gpus=2"}, None),
        ({"ncpus": 4, "gpu_model": "a100"}, None),
        ({"ncpus": 4, "ngpus": "two"}, None),
        ({}, None),
    ],
)
def test_job_gpu_count_unknown_is_not_zero(resources: dict[str, Any], count: int | None) -> None:
    job = qstat_job("exec_vnode", Resource_List=resources)
    assert pbs.job_gpu_count(job) == count


def test_numeric_vnode_names_are_not_chunk_counts() -> None:
    job = qstat_job(Resource_List={"ncpus": 8}, exec_vnode="(12:ncpus=8:ngpus=2)")
    assert pbs.job_gpu_count(job) == 2


def test_array_jobs_count_subjobs_not_the_parent() -> None:
    output = qstat(
        {
            "1010[].pbs-server": qstat_job(job_state="B", array="True"),
            "1010[1].pbs-server": qstat_job(array_id="1010[].pbs-server", array_index=1),
            "1010[2].pbs-server": queued(array_id="1010[].pbs-server", array_index=2),
        }
    )
    jobs = pbs.parse_jobs(output, SOURCE)
    assert [job["id"] for job in jobs] == ["cluster-a:1010[1]", "cluster-a:1010[2]"]
    assert [job["state"] for job in jobs] == ["RUNNING", "PENDING"]


def test_other_users_and_finished_jobs_are_ignored_and_jobs_deduplicate() -> None:
    output = qstat(
        {
            "1001.pbs-server": qstat_job(),
            "1020.pbs-server": qstat_job(Job_Owner="bob@login01", euser="bob"),
            "1021.pbs-server": qstat_job(job_state="F"),
            "1022.pbs-server": qstat_job(job_state="E"),
            "1023.pbs-server": qstat_job(job_state="S"),
        }
    )
    jobs = pbs.parse_jobs(output + "\n" + qstat({"1001.pbs-server": qstat_job()}), SOURCE)
    assert [(job["id"], job["state"]) for job in jobs] == [
        ("cluster-a:1001", "RUNNING"),
        ("cluster-a:1022", "COMPLETING"),
        ("cluster-a:1023", "SUSPENDED"),
    ]


def test_no_jobs_and_unexpected_output() -> None:
    assert pbs.parse_jobs("", SOURCE) == []
    assert pbs.parse_jobs(json.dumps(ENVELOPE), SOURCE) == []
    for output in ("qstat: command not found\n", '{"Jobs": [1, 2]}', "[]"):
        with pytest.raises(SourceError) as error:
            pbs.parse_jobs(output, SOURCE)
        assert error.value.message() == {"code": "unexpected_output", "command": "qstat"}


def test_invalid_escapes_from_older_releases_are_repaired() -> None:
    output = qstat({"1001.pbs-server": qstat_job()}).replace(
        '"PBS_O_HOME": "/home/alice"', '"PBS_O_HOME": "/home/alice\\,x", "OK": "a\\\\,b"'
    )
    with pytest.raises(json.JSONDecodeError):
        json.loads(output)
    assert pbs.parse_jobs(output, SOURCE)[0]["id"] == "cluster-a:1001"


def test_nodes_read_gpus_and_treat_absent_assignments_as_zero() -> None:
    nodes = {item["name"]: item for item in pbs.parse_nodes(NODES, SOURCE)}
    assert list(nodes) == ["node001", "node002", "node003", "node004", "cpu001"]
    busy = nodes["node001"]
    assert busy["id"] == "cluster-a:node001"
    assert (busy["gpu_count"], busy["gpu_allocated"], busy["gpu_type"]) == (4, 4, "a100")
    assert (busy["cpu_count"], busy["cpu_allocated"]) == (64, 64)
    assert busy["state"] == "allocated"
    assert nodes["node002"]["state"] == "mixed"
    assert nodes["node002"]["gpu_allocated"] == 2
    # Zero values are left out of resources_assigned: nothing assigned, not unknown.
    assert nodes["node003"]["state"] == "idle"
    assert (nodes["node003"]["gpu_allocated"], nodes["node003"]["cpu_allocated"]) == (0, 0)
    assert nodes["node004"]["state"] == "down+drain"
    cpu = nodes["cpu001"]
    assert (cpu["gpu_count"], cpu["gpu_allocated"], cpu["gpu_type"]) == (0, 0, None)
    assert cpu["partitions"] == ["cpu"]


def test_node_states_the_web_app_must_not_count_as_usable() -> None:
    red = re.compile(r"down|drain|fail|maint|not_resp|unknown|invalid|\*", re.IGNORECASE)
    for state in ("offline", "down", "stale", "state-unknown", "unresolvable", "maintenance"):
        output = json.dumps({**ENVELOPE, "nodes": {"node009": node("node009", state=state)}})
        assert red.search(pbs.parse_nodes(output, SOURCE)[0]["state"]), state
    for state in ("free", "job-busy", "job-exclusive", "resv-exclusive", "provisioning"):
        output = json.dumps({**ENVELOPE, "nodes": {"node009": node("node009", state=state)}})
        assert not red.search(pbs.parse_nodes(output, SOURCE)[0]["state"]), state


def test_unknown_node_gpu_resources_stay_unknown() -> None:
    other = node("node010", resources_available={"ncpus": 64, "gpus": 4})
    error_entry = {"Error": "Unknown node"}
    output = json.dumps({**ENVELOPE, "nodes": {"node010": other, "node011": error_entry}})
    nodes = pbs.parse_nodes(output, SOURCE)
    assert [item["name"] for item in nodes] == ["node010"]
    assert (nodes[0]["gpu_count"], nodes[0]["gpu_allocated"]) == (None, None)


def test_unexpected_node_output_is_rejected() -> None:
    for output in ("", "pbsnodes: Server has no node list\n", json.dumps(ENVELOPE)):
        with pytest.raises(SourceError, match="unexpected_output"):
            pbs.parse_nodes(output, SOURCE)


def test_queue_limits_use_the_slurm_keys_the_web_app_reads() -> None:
    queues = {item["name"]: item for item in pbs.parse_queues(QUEUES, "alice")}
    # Routing and disabled queues cannot run jobs.
    assert list(queues) == ["gpu", "debug"]
    assert queues["gpu"]["limits"] == {
        "MaxTRESPU": "gres/gpu=16",  # alice's own entry wins over PBS_GENERIC
        "GrpTRES": "gres/gpu=64",
        "MaxJobsPU": "4",
        "MaxSubmitJobsPU": "20",
        "MaxTRESPJ": "gres/gpu=8",
        "MaxWallPJ": "2880",
    }
    assert queues["debug"]["limits"] == {
        "MaxTRESPU": "gres/gpu=1",
        "MaxJobsPU": "1",
        "MaxWallPJ": "30",
    }
    assert all(item["origin"] == "scheduler_queue_access_unverified" for item in queues.values())
    generic = {item["name"]: item for item in pbs.parse_queues(QUEUES, "bob")}
    assert generic["gpu"]["limits"]["MaxTRESPU"] == "gres/gpu=8"
    # The same expression as qosGpuLimit in web/src/domain.ts.
    match = re.search(r"(?:^|,)gres/gpu(?::[^=,]+)?=(\d+)", queues["gpu"]["limits"]["MaxTRESPU"])
    assert match and match.group(1) == "16"


@pytest.mark.parametrize(
    ("value", "user", "limit"),
    [
        ("[u:PBS_GENERIC=8]", "alice", 8),
        ("[u:PBS_GENERIC=8], [u:alice=2]", "alice", 2),
        ("[g:PBS_GENERIC=8],[p:lab-a=4]", "alice", None),
        ("[o:PBS_ALL=100],[u:PBS_GENERIC=8]", None, 100),
        ("[u:PBS_GENERIC=8]", None, None),
        ("", "alice", None),
        (None, "alice", None),
    ],
)
def test_entity_limits(value: str | None, user: str | None, limit: int | None) -> None:
    assert pbs.entity_limit(value, user) == limit


def test_failures_keep_own_non_zero_exits_of_the_last_24_hours() -> None:
    output = history(
        {
            "1101.pbs-server": finished(),
            "1102.pbs-server": finished(
                Job_Name="eval-b",
                Exit_status=-29,
                obittime="Mon Jan  5 11:00:00 2026",
                exec_host="node002/0*4",
                Resource_List={"ncpus": 4, "ngpus": 1, "select": "1:ncpus=4:ngpus=1"},
                exec_vnode="(node002:ncpus=4:ngpus=1)",
            ),
            "1103.pbs-server": finished(Exit_status=-27, obittime="Mon Jan  5 09:00:00 2026"),
            "1104.pbs-server": finished(Exit_status=271, obittime="Mon Jan  5 08:00:00 2026"),
            "1105.pbs-server": finished(Exit_status=0),
            "1106.pbs-server": finished(Job_Owner="bob@login01", euser="bob"),
            "1107.pbs-server": finished(obittime="Sat Jan  3 10:00:00 2026"),
            "1108.pbs-server": finished(obittime=None),
            "1109.pbs-server": finished(job_state="M"),
            # Deleted with qdel while running: SIGTERM, substate 91 (TERMINATED).
            "1110.pbs-server": finished(Exit_status=271, substate=91),
        }
    )
    failures = pbs.parse_failures(output, SOURCE)
    assert [(row["id"], row["state"], row["exit_code"]) for row in failures] == [
        ("cluster-a:1102", "TIMEOUT", "-29"),
        ("cluster-a:1101", "FAILED", "1"),
        ("cluster-a:1103", "OUT_OF_MEMORY", "-27"),
        ("cluster-a:1104", "FAILED", "271"),
    ]
    timeout = failures[0]
    assert timeout["end"] == "2026-01-05T11:00:00"
    assert (timeout["gpu_count"], timeout["cpu_count"], timeout["node"]) == (1, 4, "node002")
    assert timeout["name"] == "eval-b"
    assert timeout["reason"] is None
    assert timeout["observed_at"]


def test_failures_without_job_history_are_unavailable_not_empty() -> None:
    with pytest.raises(SourceError) as error:
        pbs.parse_failures(history(None, enabled=False), SOURCE)
    assert error.value.code == "history_unavailable"
    assert pbs.parse_failures(history(None), SOURCE) == []


@pytest.mark.parametrize("output", ["", "not a date\n{}", "2026-01-05T12:00:00\n", "x\n"])
def test_unexpected_history_output_is_rejected(output: str) -> None:
    with pytest.raises(SourceError, match="unexpected_output"):
        pbs.parse_failures(output, SOURCE)


def test_validate_requires_connection_settings() -> None:
    driver = pbs.PbsDriver()
    driver.validate(SOURCE)
    for changes in ({"ssh_alias": ""}, {"username": ""}):
        with pytest.raises(SourceError, match="cluster_connection_required"):
            driver.validate({**SOURCE, **changes})
    with pytest.raises(SourceError, match="invalid_ssh_alias"):
        driver.validate({**SOURCE, "ssh_alias": "-oProxyCommand"})


def test_driver_info_describes_checks_in_both_languages() -> None:
    info = pbs.PbsDriver.info
    assert info.beta
    assert [check.command for check in info.checks] == ["qstat", "pbsnodes", "qstat -Q", "qstat -x"]
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
        if "qselect -u" in command:
            return outputs.get("jobs", qstat({"1001.pbs-server": qstat_job()}))
        if failure is not None:
            raise failure
        if command == pbs.NODES_COMMAND:
            return outputs.get("nodes", NODES)
        if command == pbs.QUEUES_COMMAND:
            return outputs.get("queues", QUEUES)
        if "qselect -H" in command:
            return outputs.get("history", history({"1101.pbs-server": finished()}))
        raise AssertionError(f"Unexpected command: {command}")

    return run


async def test_collect_reads_jobs_nodes_queues_and_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls))
    batch = await pbs.PbsDriver().collect(SOURCE)
    assert batch.capabilities == ["jobs", "nodes", "qos_limits", "history"]
    assert batch.warnings == []
    assert batch.jobs is not None and [job["id"] for job in batch.jobs] == ["cluster-a:1001"]
    assert batch.nodes is not None and len(batch.nodes) == 5
    assert batch.failures is not None and [row["id"] for row in batch.failures] == [
        "cluster-a:1101"
    ]
    assert batch.qos is not None
    qos = {item["name"]: item for item in batch.qos}
    assert set(qos) == {"gpu", "debug"}
    assert qos["gpu"]["limits"]["MaxTRESPU"] == "gres/gpu=16"
    assert set(batch.snapshot()) == {"jobs", "nodes", "failures"}

    assert all(dest == "cluster-a" and opts == ["-l", "alice"] for dest, _, opts in calls)
    commands = [command for _, command, _ in calls]
    # The user name is an argument of the fixed script, quoted, never part of the script.
    for script in (commands[0], commands[3]):
        assert script.startswith("sh -c 'set -f; ") and script.endswith("' sh alice")
        assert script.count("alice") == 1
    # Collection is read-only.
    words = set(" ".join(commands).replace("'", " ").replace(";", " ").split())
    assert not {"qsub", "qdel", "qalter", "qhold", "qrls", "qmove", "qrerun", "qmgr"} & words


async def test_queued_jobs_without_matching_limits_still_appear_as_observed_queues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    jobs = qstat({"1030.pbs-server": queued(queue="long")})
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, jobs=jobs))
    batch = await pbs.PbsDriver().collect(SOURCE)
    assert batch.qos is not None
    qos = {item["name"]: item for item in batch.qos}
    assert qos["long"] == {
        "name": "long",
        "limits": {},
        "origin": "observed_job_access_unverified",
        "access": "unknown",
    }


async def test_unknown_gpu_counts_add_a_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: Calls = []
    jobs = qstat({"1031.pbs-server": qstat_job("exec_vnode", Resource_List={"gpus": 2})})
    nodes = json.dumps(
        {**ENVELOPE, "nodes": {"node010": node("node010", resources_available={"gpus": 4})}}
    )
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, jobs=jobs, nodes=nodes))
    batch = await pbs.PbsDriver().collect(SOURCE)
    assert batch.jobs is not None and batch.jobs[0]["gpu_count"] is None
    assert batch.warnings == [
        {"code": "gpu_count_unknown", "command": "qstat"},
        {"code": "gpu_count_unknown", "command": "pbsnodes"},
    ]


@pytest.mark.parametrize("failure", [ssh.SSHError("Permission denied"), TimeoutError()])
async def test_partial_permissions_keep_supported_data(
    monkeypatch: pytest.MonkeyPatch, failure: Exception
) -> None:
    calls: Calls = []
    monkeypatch.setattr(ssh, "run", fake_cluster(calls, failure))
    batch = await pbs.PbsDriver().collect(SOURCE)
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
        for code in ("nodes_unavailable", "qos_unavailable", "history_unavailable")
    ]
    assert len(calls) == 4


async def test_malformed_optional_output_and_disabled_history_become_warnings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    run = fake_cluster(calls, nodes="garbage\n", history=history(None, enabled=False))
    monkeypatch.setattr(ssh, "run", run)
    batch = await pbs.PbsDriver().collect(SOURCE)
    assert batch.nodes is None
    assert batch.failures is None
    assert batch.warnings == [
        {"code": "nodes_unavailable", "detail": "unexpected_output"},
        {"code": "history_unavailable", "detail": "job_history_enable is not set"},
    ]
    assert "qos_limits" in batch.capabilities


async def test_a_job_that_ends_between_qselect_and_qstat_is_retried_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: Calls = []
    healthy = fake_cluster(calls)

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        if "qselect -u" in command and not any("qselect -u" in c for _, c, _ in calls):
            calls.append((destination, command, options))
            raise ssh.SSHError("qstat: Unknown Job Id 1001.pbs-server")
        return await healthy(destination, command, options)

    monkeypatch.setattr(ssh, "run", run)
    batch = await pbs.PbsDriver().collect(SOURCE)
    assert batch.jobs is not None and len(batch.jobs) == 1
    assert sum("qselect -u" in command for _, command, _ in calls) == 2


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
        await pbs.PbsDriver().collect(SOURCE)
    assert error.value.code == code
    assert len(calls) == 1


async def test_malformed_queue_output_fails_instead_of_reporting_no_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        return "unexpected banner text\n"

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(SourceError, match="unexpected_output"):
        await pbs.PbsDriver().collect(SOURCE)


@pytest.mark.parametrize(
    "changes",
    [
        {"ssh_alias": "-oProxyCommand=touch"},
        {"ssh_alias": "cluster-a extra"},
        {"username": "alice;id"},
        {"username": "alice' sh -c 'id"},
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
        await pbs.PbsDriver().collect({**SOURCE, **changes})


FAKE_TOOL = """#!/bin/sh
echo "$(basename "$0") $*" >> "$LOG"
case "$(basename "$0") $*" in
  "date +%Y-%m-%dT%H:%M:%S") echo 2026-01-05T12:00:00 ;;
  "date -d 24 hours ago +%Y%m%d%H%M") echo 202601041200 ;;
  "qselect -u alice.b") printf '%s\\n' "$QSELECT" ;;
  "qselect -H -u alice.b -tm.gt.202601041200") printf '%s\\n' "$QSELECT" ;;
  "qstat -B -f -F json") echo '{"Server": {}}' ;;
  "qstat "*) echo '{"Jobs": {}}' ;;
  *) exit 3 ;;
esac
"""


@pytest.mark.parametrize("shell", ["sh", "bash", "tcsh"])
@pytest.mark.parametrize("selected", ["", "1001.pbs-server\n1002[3].pbs-server"])
def test_remote_scripts_run_under_common_login_shells(
    tmp_path: Path, shell: str, selected: str
) -> None:
    """The exact command strings sent over SSH, run by a local login shell with fake tools."""
    if shutil.which(shell) is None:
        pytest.skip(f"{shell} is not installed")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("date", "qselect", "qstat"):
        (bin_dir / tool).write_text(FAKE_TOOL)
        (bin_dir / tool).chmod(0o755)
    # A file the id "1002[3].pbs-server" would turn into if the ids were globbed.
    (tmp_path / "10023.pbs-server").write_text("")
    log = tmp_path / "log"
    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "LOG": str(log),
        "QSELECT": selected,
    }
    outputs = []
    for script in (pbs._JOBS_SCRIPT, pbs._HISTORY_SCRIPT):
        command = pbs._script(script, "alice.b")
        result = subprocess.run(
            [shell, "-c", command], cwd=tmp_path, env=env, capture_output=True, text=True
        )
        assert result.returncode == 0, result.stderr
        outputs.append(result.stdout)
    calls = log.read_text().splitlines()
    reads = [call for call in calls if call.startswith(("qstat -f", "qstat -x"))]
    if selected:
        assert reads == [
            "qstat -f -F json -t 1001.pbs-server 1002[3].pbs-server",
            "qstat -x -f -F json 1001.pbs-server 1002[3].pbs-server",
        ]
    else:
        assert reads == []
    # The output framing is what the parsers expect: JSON, or the clock line and JSON.
    assert pbs.parse_jobs(outputs[0], SOURCE) == []
    with pytest.raises(SourceError) as error:
        pbs.parse_failures(outputs[1], SOURCE)
    assert error.value.code == "history_unavailable"
