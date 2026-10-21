"""Collection transitions using fictional scheduler responses and an isolated store."""

from computedeck.collector import Collector
from computedeck.drivers import lsf, slurm, ssh
from computedeck.drivers.base import Batch, cluster_state
from computedeck.plugins import Runtime


async def test_lost_qos_queries_cannot_reuse_a_previous_verified_grant(
    monkeypatch, tmp_path, store, add_source
):
    source = add_source(fresh=False)
    runtime = Runtime(tmp_path)
    runtime.store = store
    collector = Collector(runtime)
    queries_available = True

    async def run(alias, command, options=None):
        if " squeue " in command:
            return ""
        if command == "scontrol -d show nodes -o":
            return "NodeName=g1 State=IDLE CfgTRES=cpu=64,gres/gpu=8 AllocTRES= Partitions=gpu\n"
        if command == "scontrol show partition -o":
            return "PartitionName=gpu AllowQos=ALL\n"
        if command == "scontrol show assoc_mgr flags=qos":
            if queries_available:
                return "QOS=normal(1) MaxTRESPU=gres/gpu=8\n"
            raise ssh.SSHError("Permission denied")
        if command.endswith("flags=assoc"):
            return "ClusterName=cluster-a Account=lab UserName=alice(1001) ID=1\n"
        if command.startswith("sacctmgr"):
            if queries_available:
                return "cluster-a|lab|alice||normal\n"
            raise ssh.SSHError("Database temporarily unavailable")
        if " sacct " in command:
            return ""
        raise AssertionError(command)

    monkeypatch.setattr(ssh, "run", run)
    await collector.collect(source["id"])
    assert store.source(source["id"])["qos"][0]["access"] == "verified"

    queries_available = False
    await collector.collect(source["id"])
    saved = store.source(source["id"])
    assert saved["status"] == "ready"
    assert saved["qos"] == []
    assert "qos_access" not in saved["capabilities"]
    assert "qos_limits" not in saved["capabilities"]
    assert len(store.snapshot(source["id"])["nodes"]) == 1


async def test_retained_qos_metadata_loses_its_permission_claim(
    monkeypatch, tmp_path, store, add_source
):
    source = add_source(
        qos=[{"name": "normal", "access": "verified", "limits": {"MaxTRESPU": "gres/gpu=8"}}]
    )
    runtime = Runtime(tmp_path)
    runtime.store = store

    async def collect(self, source):
        return Batch(jobs=[], capabilities=["jobs"])

    monkeypatch.setattr(slurm.SlurmDriver, "collect", collect)
    await Collector(runtime).collect(source["id"])
    assert store.source(source["id"])["qos"] == [
        {"name": "normal", "access": "unknown", "limits": {"MaxTRESPU": "gres/gpu=8"}}
    ]


def test_invalid_scheduler_nodes_make_the_cluster_unavailable():
    source = {"id": "cluster-a-alice", "cluster_id": "cluster-a", "username": "alice"}
    slurm_nodes = slurm.parse_nodes(
        "NodeName=g1 State=IDLE+INVALID_REG CfgTRES=cpu=64,gres/gpu=8 AllocTRES=", source
    )
    lsf_nodes = lsf.parse_hosts(
        [{"HOST_NAME": "g1", "STATUS": "unlicensed", "NJOBS": "0", "NGPUS": "8"}],
        source,
        None,
    )
    assert cluster_state(slurm_nodes) == "unavailable"
    assert cluster_state(lsf_nodes) == "unavailable"
    assert cluster_state([*slurm_nodes * 9, {"state": "idle"}]) == "degraded"
