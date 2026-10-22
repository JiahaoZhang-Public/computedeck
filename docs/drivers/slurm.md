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
The planner shows verified and unknown-access choices together in the main table, with
one unchecked-access note per login. Only `not_associated` choices are collapsed.
Unknown access keeps a fitting option at “Possible”; it cannot produce “Likely to start.”
PBS, LSF and Kubernetes report `unknown` access until their own permission checks are
implemented.

Estimates account for the login's eligible queued GPU demand in the same QoS. Held,
dependency, begin-time and array-throttled jobs are left out; unknown demand that could
consume the remaining room prevents a “Likely” estimate. Within each verdict, choices
rank by whether the request fits one node, room after your queue, free GPUs and verified
access. The best-estimate card uses the first row only when it is likely or possible.
These are estimates, not a queue position or a guarantee that Slurm will start the job.

A pending personal-limit wait (for example `QOSMaxGRESPerUser` or
`AssocMaxJobsLimit`) whose known GPU request fits the collected headroom caps a
"Likely" estimate at "Possible". The explanation names the job and reason: the
scheduler may count differently or enforce limits that were not collected. A larger
limit-held job does not trigger this cap, and stale or unknown relevant data is not
treated as proof of a contradiction.
GPU-limit waits only use a known matching job model when any finite per-model cap
exists, because only the requested model's room was checked. Job-count and submit-count
waits (`QOSMaxJobsPerUserLimit`, `QOSMaxSubmitJobPerUserLimit`, `AssocMaxJobsLimit`,
`AssocMaxSubmitJobLimit`) still cap the estimate when QoS count limits are missing or
unlimited. Association limits are separate from QoS `MaxJobsPU` / `MaxSubmitJobsPU`
and are not collected; a wait can also reflect an uncollected partition QoS limit.
Any collected jobs or submit rule already at its limit prevents contradiction evidence.
Zero-GPU GRES waits and CPU-limit waits are not used because their resource headroom
is not evaluated.
CPU-only running jobs do not make model-specific GPU use unknown. Queue reasons
use short translated class labels, with the raw code on hover. Unrecognised reasons remain visible as reported.
Duplicate sources for the same cluster and username merge per QoS, preferring current
QoS-limit data, then current job data, then the latest successful collection.
Jobs from either current source are deduplicated by their newest
observation, even when the retained QoS source's job list is not current. An empty
QoS list does not add a separate row if a twin lists QoS options.
Different usernames retain separate options.

The cluster state describes the visible inventory: all nodes unavailable means `unavailable`;
fewer than 20% available means `degraded`. An empty or uncertain inventory remains `unknown`.
Usable/free GPU counts exclude nodes with no partition and FUTURE/ERROR state tokens.
DYNAMIC_FUTURE is a separate flag and does not make an idle node unavailable.
A partitioned power-saving node with an idle, free or empty base state and no fault
is shown as "Available on demand", with or without CLOUD. Nodes with assigned work
(allocated, mixed, completing or job-busy) remain usable even with power flags,
so their allocations still count while booting or awaiting power-down. On-demand GPUs
are counted separately from usable and unavailable capacity. On-demand nodes count as healthy in the cluster's availability ratio; a
cluster entirely at rest stays available with zero free GPUs. DOWN, reserved or
otherwise faulty nodes keep their unavailable classification, even with power flags.
The node table retains the scheduler's raw state alongside the on-demand label or
"Not in any partition" reason. Where to run counts on-demand GPUs for the requested
model only, with no count shown when the matching count or model is unknown.
Partition `AllowQos` matching is not part of this capacity check; QoS and access checks
still apply separately in Where to run.

References: [scontrol](https://slurm.schedmd.com/scontrol.html),
[sacctmgr](https://slurm.schedmd.com/sacctmgr.html),
[association text formatter](https://github.com/SchedMD/slurm/blob/master/src/scontrol/info_assoc_mgr.c).

## Job requests and times

GPU requests accept both `gres:gpu` and `gres/gpu` forms, including model-specific
counts. The parser uses job-wide GPU TRES first, then per-job requests, then per-node
requests multiplied by the requested node count when GPU accounting is unavailable.
An untyped GPU total takes precedence over its typed breakdown to avoid double counting.
Missing or unrecognised resource information stays unknown; it is not treated as zero.

The `squeue` command runs under `env SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z` and reads
SubmitTime and StartTime. Offset-bearing times can be shown in the viewer's timezone;
older or offset-free output remains explicitly labelled scheduler time. A pending job's
StartTime is an estimate and is never stored as its actual `started_at`. Observed waiting
time stops at the job's last collection, even when that sample becomes stale.

Array elements such as `1234_7` carry `array_id=1234` and `array_index=7` in queue and
accounting rows. Ranges, heterogeneous jobs and job steps are not inferred as elements.
Known limit: a cancellation reported only as an accounting range such as `1234_[5-10]`
is not matched back to individually listed pending elements. Those elements can be
reported as unknown alongside the cancelled range.

## Terminal job history

The 24-hour failure query now also requests offset-bearing times using
`env SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z`. Its additive `ended_at` retains the offset;
the legacy `end` keeps its local-time text without an offset so existing event keys
stay stable. `exit_status` and `exit_signal` split the raw `ExitCode` (`status:signal`),
which is preserved. Missing or unrecognized values stay null. Both accounting queries
read the long-standing `Timelimit` field into `time_limit`; `UNLIMITED`, `Partition_Limit`,
empty and unknown values become null. No `StdOut` or `StdErr` fields are requested.
A second, terminal-state `sacct` query runs in the same SSH call, separated by a marker. It includes
COMPLETED, CANCELLED and all failure states, and reads Submit, Start and End under
`env SLURM_TIME_FORMAT=%Y-%m-%dT%H:%M:%S%z`. Its window starts five minutes before the
previous successful collection, rounded up to minutes and capped at 24 hours plus
seven minutes (five minutes of overlap and the two-minute collection timeout). If the
previous collection lacked history, or the snapshot has no lifecycle baseline after an
upgrade, it reads the full 24 hours instead. The baseline records that history silently
so a later accounting recovery cannot announce pre-upgrade endings again. Both queries
remain read-only.

Terminal records feed lifecycle events without enlarging the retained failure list.
If `sacct` is missing, denied or unavailable, current jobs and nodes can still be collected,
but that collection supplies no failure history. This is an optional capability gap, not
proof that no jobs failed. A source that has never reported accounting resolves departed
jobs as unknown immediately. If accounting worked before, departures wait for a successful
history collection, up to 24 hours during an outage; see [job lifecycle](../metrics.md#job-lifecycle-and-activity).
PBS and LSF use the offset from their existing remote clock for terminal timestamps;
that current offset may differ across a daylight-saving transition. Their legacy
failure-row `end` strings also remain unchanged, with `ended_at` carrying the offset. No extra SSH connection is added.
