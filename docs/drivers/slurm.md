# Slurm permissions and availability

Collection reads the current user's jobs, visible nodes, QoS limits and recent failures.
All commands are read-only. Example outputs in the tests use fictional users and clusters.

QoS definitions and partition `AllowQos` values do not prove that a user may use that QoS.
The collector requests `scontrol show assoc_mgr users=<login> flags=assoc` and reads explicit
association grants when present. Upstream Slurm's text formatter omits the association QOS
list in common versions. When that happens, the collector also requests:

```text
sacctmgr --noheader --parsable2 show assoc where user=<login> cluster=<controller-cluster> format=Cluster,Account,User,Partition,QOS
```

The cluster filter comes from the controller, not the dashboard's display name or SSH alias.
Returned records must match both that cluster and the login. This second query needs
slurmdbd; permission failures, timeouts and unrecognized output leave access `unknown`.
Both permission queries have a 10-second timeout. No observed job, default QoS, other user
or other cluster can prove an association grant.

An explicit grant is `verified`; a successfully read effective list that omits a QoS is
`not_associated`. Verification means at least one association grants the QoS. Account,
partition and other scheduling constraints can still prevent a particular job from starting.
The planner shows verified choices by default. Unverified and unassociated choices are in
separate closed sections; unverified access can never produce “Likely to start.” PBS, LSF
and Kubernetes report `unknown` access until their own permission checks are implemented.

The cluster state describes the visible inventory: all nodes unavailable means `unavailable`;
fewer than 20% available means `degraded`. An empty or uncertain inventory remains `unknown`.
Power-saving flags alone do not make a node unavailable. An unavailable cluster is shown as
an outage even if no GPUs are allocated, rather than looking idle.

References: [scontrol](https://slurm.schedmd.com/scontrol.html),
[sacctmgr](https://slurm.schedmd.com/sacctmgr.html),
[association text formatter](https://github.com/SchedMD/slurm/blob/master/src/scontrol/info_assoc_mgr.c).
