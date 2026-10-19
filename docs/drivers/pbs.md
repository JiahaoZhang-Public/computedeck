# PBS driver (`pbs`, beta)

Reads your jobs, the visible nodes, queue limits and recent failures from an OpenPBS or PBS Professional cluster over SSH. Every command is a read-only query; nothing is submitted, changed or deleted.

The driver is marked beta: it was written against the OpenPBS source and has not yet been run against a live PBS server (see [Versions](#versions)).

## Requirements

- An SSH host alias and a login name, exactly as for the Slurm driver: a `Host` in `~/.ssh/config` on the machine running ComputeDeck, with the host key already accepted. Connections are non-interactive.
- On the cluster: `qselect`, `qstat` and `pbsnodes` from a release that supports `-F json` for both `qstat -f` and `pbsnodes`.
- A POSIX `sh`. The login shell can be anything that understands single quotes (sh, bash, zsh, csh, tcsh).
- For failure history: job history enabled on the server (`job_history_enable = True`) and GNU `date` (for `date -d`).
- For GPU numbers: a host-level consumable resource named `ngpus`, the name PBS uses for GPU scheduling (`pbsnodes -S` reports it under that name). Sites that count GPUs under another name get unknown GPU numbers.

## Configuration

```toml
[[cluster]]
id = "cluster-c"
label = "Cluster C"
driver = "pbs"

  [[cluster.identity]]
  username = "alice"
  ssh_alias = "cluster-c"
```

## Commands

Each line is one SSH command. The login name is passed as the argument `$1` of a fixed script and is never inserted into the script text.

| Check | Command | Required |
|---|---|---|
| Your jobs (`qstat`) | `sh -c 'set -f; ids=$(qselect -u "$1") ...; qstat -f -F json -t $ids' sh alice` | yes |
| Visible nodes (`pbsnodes`) | `pbsnodes -a -F json` | no |
| Queue limits (`qstat -Q`) | `qstat -Q -f -F json` | no |
| Failures (`qstat -x`) | `sh -c 'date ...; qstat -B -f -F json; qselect -H -u "$1" -tm.gt.<24 h ago>; qstat -x -f -F json $ids' sh alice` | no |

`qstat` refuses `-u` together with `-F json`, so `qselect -u` selects your unfinished jobs on the server and `qstat` reads them; `-t` lists array subjobs one by one. If a job ends between the two commands, the read is retried once.

When an optional command fails, its data is left as it was and the source shows a warning (`nodes_unavailable`, `qos_unavailable`, `history_unavailable`). When the job query fails, the whole collection fails and the previous data is kept.

## Jobs

| ComputeDeck | PBS |
|---|---|
| `id` | `<cluster id>:<job id without the server suffix>`, e.g. `cluster-c:1234[5]` |
| `state` | `job_state`: Q, H, W, T → `PENDING`; R → `RUNNING`; E → `COMPLETING`; S, U → `SUSPENDED` |
| `reason` | `Held` for held (`H`) jobs and `BeginTime` for waiting (`W`, begin time) jobs, regardless of any comment; other pending jobs carry `comment` without the `Not Running:` prefix |
| `gpu_count` | `Resource_List.ngpus`; otherwise the sum of `ngpus` over `exec_vnode` (running) or `select` chunks; `0` when the request names no GPU resource; unknown when it names another GPU-like resource |
| `gpu_type` | `gpu_model`, `gpu_type` or `accelerator_model` in the request, if the site defines one |
| `cpu_count` | `Resource_List.ncpus` |
| `node` | hosts of `exec_host` |
| `elapsed` | `resources_used.walltime` |
| `partition`, `qos` | `queue` (see [Queue limits](#queue-limits)) |
| `account` | `Account_Name` |

Array parents (`1234[]`) are skipped because their subjobs are listed.

## Nodes

One entry per vnode from `pbsnodes -a`.

| ComputeDeck | PBS |
|---|---|
| `gpu_count` | `resources_available.ngpus`; `0` when the vnode reports resources but none is GPU-like |
| `gpu_allocated` | `resources_assigned.ngpus`. `pbsnodes -F json` leaves zero values out of `resources_assigned`, so a missing value counts as `0` |
| `gpu_type` | `resources_available.gpu_model` (or `gpu_type`, `accelerator_model`) |
| `cpu_count`, `cpu_allocated` | `resources_available.ncpus`, `resources_assigned.ncpus` |
| `partitions` | the vnode's `queue` attribute, if set |

States are mapped so that the web app treats them like the equivalent Slurm states:

| PBS | ComputeDeck |
|---|---|
| `free` | `idle`, or `mixed` when anything is assigned |
| `job-busy`, `job-exclusive` | `allocated` |
| `resv-exclusive` | `reserved` |
| `offline` | `drain` |
| `down`, `unresolvable` | `down` |
| `state-unknown`, `stale` | `unknown` |
| others | unchanged, lower case; combined states are joined with `+` (`down+drain`) |

## Queue limits

PBS has no QoS. ComputeDeck keeps limits in the shape of Slurm QoS records and compares each limit with the jobs whose `qos` has the same name, so the PBS driver names each limit after its queue and gives every job its queue as `qos`.

Enabled and started execution queues are read. Routing queues are skipped.

| ComputeDeck key | PBS queue attribute |
|---|---|
| `MaxTRESPU` (`gres/gpu=N`) | `max_run_res.ngpus` entry `[u:<you>=N]`, else `[u:PBS_GENERIC=N]`, else `max_user_res.ngpus` |
| `GrpTRES` (`gres/gpu=N`) | `max_run_res.ngpus` entry `[o:PBS_ALL=N]` |
| `MaxJobsPU` | `max_run` user entry, else `max_user_run` |
| `MaxSubmitJobsPU` | `max_queued` user entry |
| `MaxTRESPJ` (`gres/gpu=N`) | `resources_max.ngpus` |
| `MaxWallPJ` (minutes) | `resources_max.walltime` |

## Failures

Finished jobs (`F`, or `X` for subjobs) of the login user with a non-zero `Exit_status` whose `obittime` lies within 24 hours of the server's clock. `qselect -H` narrows the read to jobs modified in that window.

`Exit_status` -29 (walltime exceeded) is shown as `TIMEOUT`, -27 and -26 (memory exceeded) as `OUT_OF_MEMORY`, everything else as `FAILED` with the status as `exit_code`. `end` is the server's local time, like Slurm's `End`.

If job history is not enabled, `qselect -H` selects nothing without an error; the driver checks `job_history_enable` first and reports `history_unavailable` instead of "no failures".

## Warnings

| Code | Meaning |
|---|---|
| `nodes_unavailable` | `pbsnodes` failed or printed something unexpected |
| `qos_unavailable` | `qstat -Q` failed or printed something unexpected |
| `history_unavailable` | the history query failed, or job history is disabled |
| `gpu_count_unknown` | some jobs (`qstat`) or nodes (`pbsnodes`) use a GPU resource other than `ngpus` |

## Limitations

- GPUs are counted only through `ngpus`. Other GPU resources (`gpus`, `naccelerators` with a non-zero value, a model without a count) make the count unknown rather than zero.
- Queue ACLs are not evaluated, so a queue may be listed that you cannot submit to. Server-wide limits and group (`g:`) or project (`p:`) limits are not read.
- A job array that failed appears once, as its parent, with the parent's exit status.
- A running job deleted with `qdel` ends with a signal status (for example 271) and cannot be told apart from other signal kills, so it is listed as a failure.
- `pbsnodes -a` and `qstat -Q` list the whole cluster; the job query reads only your jobs.
- If a value is printed with an invalid backslash escape (such as `\,` in `Variable_List`), the driver repairs the escape before giving up on the output, so one unusual value cannot hide every job. This is a precaution, not a fix for a known release.

## Versions

Checked against documentation and source only, not against a running server:

- OpenPBS source on GitHub, master branch, October 2026: [`qstat.c`](https://github.com/openpbs/openpbs/blob/master/src/cmds/qstat.c) (`-F json` layout, the `-u`/`-F` conflict, time formatting), [`qselect.c`](https://github.com/openpbs/openpbs/blob/master/src/cmds/qselect.c) (`-H`, `-t`), [`pbsnodes.c`](https://github.com/openpbs/openpbs/blob/master/src/cmds/pbsnodes.c) and [`pbs_cjson.c`](https://github.com/openpbs/openpbs/blob/master/src/lib/Libjson/cJSON/pbs_cjson.c) (node JSON, omitted zero values), [`job.h`](https://github.com/openpbs/openpbs/blob/master/src/include/job.h) (states and exit statuses), [`req_select.c`](https://github.com/openpbs/openpbs/blob/master/src/server/req_select.c) (owner selection, history).
- PBS Professional shares these commands; releases without `-F json` are not supported.
