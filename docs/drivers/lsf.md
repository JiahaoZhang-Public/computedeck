# LSF driver (`lsf`, beta)

Reads your jobs, the visible hosts, queue and GPU limits and recent failures from an IBM Spectrum LSF cluster over SSH. Every command is a read-only query; nothing is submitted, changed or killed.

The driver is marked beta: it was written against the IBM Spectrum LSF 10.1 command reference and has not yet been run against a live LSF cluster (see [Versions](#versions)). In particular, the values LSF prints in its GPU fields for jobs and hosts without GPUs are not documented.

## Requirements

- An SSH host alias and a login name, exactly as for the Slurm driver: a `Host` in `~/.ssh/config` on the machine running ComputeDeck, with the host key already accepted. Connections are non-interactive.
- LSF 10.1 Fix Pack 2 or later, which added `-json` to `bjobs`, `bhosts` and `bqueues`.
- For GPU numbers: LSF GPU support, so that `bjobs -o gpu_num`, `bhosts -o ngpus` and `lshosts -gpu` report GPUs. Releases that reject the GPU fields are read without them and show unknown GPU numbers.
- `date` on the cluster (any POSIX `date`).

## Configuration

```toml
[[cluster]]
id = "cluster-d"
label = "Cluster D"
driver = "lsf"

  [[cluster.identity]]
  username = "alice"
  ssh_alias = "cluster-d"
```

## Commands

Each line is one SSH command; the login name is quoted.

| Check | Command | Required |
|---|---|---|
| Your jobs (`bjobs`) | `bjobs -u alice -o "jobid jobindex job_name user queue stat pend_reason exec_host slots run_time proj_name gpu_num gpu_alloc" -json` | yes |
| Visible hosts (`bhosts`) | `bhosts -o "host_name status max njobs ngpus ngpus_alloc" -json` and `lshosts -gpu -w` | no |
| Limits | `bqueues -u alice -o "queue_name status max_runlimit" -json` and `blimits -a -w -u alice` | no |
| Failures (`bjobs -d`) | `date +%Y-%m-%dT%H:%M:%S; bjobs -d -u alice -o "<history fields> exit_reason gpu_num gpu_alloc" -json` | no |

If `bjobs` or `bhosts` rejects the field list, it is run once more without the GPU fields (and, for history, without `exit_reason`). If `blimits` rejects `-a` together with `-w`, it is run as `blimits -w -u alice`, which lists only limits that jobs currently use. "No unfinished job found", "No job found" and "No resource usage found" are empty results, not errors.

When an optional command fails, its data is left as it was and the source shows a warning (`nodes_unavailable`, `partitions_unavailable`, `qos_unavailable`, `history_unavailable`). When the job query fails, the whole collection fails and the previous data is kept.

## Jobs

| ComputeDeck | LSF |
|---|---|
| `id` | `<cluster id>:<jobid>`, or `<jobid>[<jobindex>]` for an array element |
| `state` | `STAT`: PEND, PSUSP, WAIT → `PENDING`; RUN → `RUNNING`; USUSP, SSUSP → `SUSPENDED`; PROV → `CONFIGURING`; UNKWN → `UNKNOWN`. DONE and EXIT are not listed. |
| `reason` | `Held` for jobs suspended while pending (`PSUSP`); other pending jobs carry `pend_reason` |
| `gpu_count` | `gpu_num`. A running or suspended job with `-` for both `gpu_num` and `gpu_alloc` counts as `0`; otherwise a missing count is unknown |
| `cpu_count` | `slots` |
| `node` | hosts of `exec_host` |
| `elapsed` | `run_time` (seconds, or hh:mm:ss when LSB_HMS is set) |
| `partition`, `qos` | `queue` (see [Limits](#limits)) |
| `account` | `proj_name` |
| `gpu_type` | not read |

## Hosts

| ComputeDeck | LSF |
|---|---|
| `gpu_count` | `ngpus`; when it is `-`, the number of GPUs `lshosts -gpu` lists for the host (none listed: `0`). Unknown if neither is available |
| `gpu_allocated` | `ngpus_alloc`; `0` when the host has no GPUs or no jobs (`njobs` is `0`) |
| `gpu_type` | `gpu_model` of `lshosts -gpu` |
| `cpu_count`, `cpu_allocated` | `max` (job slot limit) and `njobs` (tasks placed). LSF counts slots, which usually but not always equal cores |
| `partitions` | not read |

Hosts named `lost_and_found` are skipped. Statuses are mapped so that the web app treats them like the equivalent Slurm states:

| LSF | ComputeDeck |
|---|---|
| `ok` | `idle` with no jobs, otherwise `mixed` |
| `closed_Full`, `closed_Excl`, `closed_Cu_excl` | `allocated` |
| `closed_Adm`, `closed_Lock` | `drain` |
| `closed_LIM`, `unreach` | `not_responding` |
| `unavail` | `down` |
| `unlicensed` | `invalid` |
| others (`closed_Busy`, `closed_Wind`, ...) | unchanged, lower case |

## Limits

ComputeDeck keeps limits in the shape of Slurm QoS records and compares each limit with the jobs whose `qos` has the same name. The LSF driver names each limit after its queue and gives every job its queue as `qos`.

- `bqueues -u` lists the open queues that accept your jobs. `MAX_RUNLIMIT` becomes `MaxWallPJ` in minutes. LSF scales RUNLIMIT by the CPU factor of the execution host, so this is the limit on a reference host.
- `blimits` limits become `MaxTRESPU` (`gres/gpu=N`, from the `ngpus_physical` column, else `ngpus`) and `MaxJobsPU` (from `JOBS`) of a queue when the row is for your user name, names exactly one queue, and is not narrowed to hosts, projects or applications. The `LIMIT` part of `USED/LIMIT` is used; of two limits on one queue the lower wins.

## Failures

`bjobs -d` lists jobs that finished within `CLEAN_PERIOD` (lsb.params, one hour by default). Of these, jobs of the login user in state `EXIT` that finished within 24 hours of the cluster's clock are reported. LSF prints finish times without a year, so the year is taken from the cluster's `date`: the latest such date that is not in the future.

`exit_reason` with `TERM_RUNLIMIT` is shown as `TIMEOUT`, `TERM_MEMLIMIT` as `OUT_OF_MEMORY`, everything else as `FAILED`. Jobs killed by their owner or an administrator (`TERM_OWNER`, `TERM_ADMIN`, `TERM_FORCE_*`) are cancellations and are left out, as Slurm's `CANCELLED` jobs are. `end` is the cluster's local time, like Slurm's `End`.

## Warnings

| Code | Meaning |
|---|---|
| `nodes_unavailable` | `bhosts` failed or printed something unexpected |
| `partitions_unavailable` | `bqueues` failed or printed something unexpected |
| `qos_unavailable` | `blimits` failed or printed something unexpected |
| `history_unavailable` | `bjobs -d` failed or printed something unexpected |
| `gpu_count_unknown` | some jobs (`bjobs`) or hosts (`bhosts`) have GPU numbers the driver cannot read |

## Limitations

- The GPU fields of `bjobs -o` and `bhosts -o` are documented without the fix pack that introduced them, and without their value for jobs and hosts without GPUs. Pending jobs that show `-` for `gpu_num` have an unknown GPU request.
- Failure history reaches back only `CLEAN_PERIOD`, which defaults to one hour; `bhist` and `bacct` are not read.
- The format of `exit_reason` is not documented; a cancellation that does not mention `TERM_OWNER`, `TERM_ADMIN` or "killed by owner" is listed as a failure.
- `blimits` limits that span several queues or all queues, and limits on user groups, are not shown, because ComputeDeck compares a limit only with the jobs of one queue. Rows that cannot be aligned with their header (a value containing spaces) are skipped.
- `bhosts` and `lshosts -gpu` list the whole cluster; the job queries read only your jobs.

## Versions

Checked against documentation only, not against a running cluster:

- IBM Spectrum LSF 10.1.0 command reference: [bjobs -o](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bjobs.o.1.html), [bjobs -json](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bjobs.json.1.html), [bjobs -d](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bjobs.d.1.html), [bhosts](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bhosts.1.html), [lshosts](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/lshosts.1.html), [bqueues](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/bqueues.1.html), [blimits](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_command_ref/blimits.1.html).
- [LSF 10.1 Fix Pack 2 release notes](https://www.ibm.com/docs/en/SSWRJV_10.1.0/lsf_release_notes/lsf_relnotes_cmdout10.1.0.2.html) (`-json` for `bjobs`, `bhosts`, `bqueues`).
