# SSH machine driver (`ssh`)

Collects one GPU workstation or server on schedule, through a Host alias that already exists in your SSH configuration. One source is one machine. The machine appears on the instances page like a cloud instance.

The driver class is `computedeck.drivers.ssh_host.SSHHostDriver` (driver name `ssh`, kind `cloud`).

## Requirements

On the computer that runs ComputeDeck:

- A Host entry in `~/.ssh/config`, for example `gpu-box`. User, port, keys and any `ProxyJump` come from that entry; ComputeDeck does not generate a Host block for it.
- Non-interactive access. Connections use `BatchMode=yes` and `StrictHostKeyChecking=yes`, so log in once with a normal `ssh gpu-box` to accept the host key, and use a key or agent rather than a password.

On the machine:

- `python3` (3.5 or later) and a POSIX login shell (sh, bash, zsh).
- `nvidia-smi` for NVIDIA GPUs, or `rocm-smi` for AMD GPUs. Without either, the machine is still listed with CPU and memory use, and its GPUs are unknown.
- `ps`, to name the owner of each GPU process (NVIDIA only).

Nothing is installed, and nothing is written on the machine.

## What is read

Each collection opens one SSH session and runs a short Python script with `python3 -I -c`. The script prints one JSON object; all parsing happens in ComputeDeck.

| Data | Source |
| --- | --- |
| CPU utilization | `/proc/stat`, two samples 0.3 s apart |
| Memory utilization | `/proc/meminfo` (`MemTotal`, `MemAvailable`) |
| Login user | the user the SSH session runs as |
| Per-GPU index, name, utilization, memory used and total (MiB) | `nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits` |
| GPU processes: pid and GPU memory (MiB) | `nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits` |
| Owner of each GPU process | `ps -o pid=,user= -p <pids>` (only digit-only pids from the previous command) |
| AMD GPUs: name and utilization | `rocm-smi --showproductname --showuse --json` |
| AMD GPUs: VRAM used and total | `rocm-smi --showmeminfo vram --json` |

Each command has its own short timeout, and the whole collection is limited to 25 seconds.

The result is one instance with id `<cluster_id>:<alias>`, state `running` (the machine answered), SSH status `reachable`, the mean GPU utilization over GPUs that reported one, and a `gpus` list:

```json
{
  "index": 0,
  "name": "NVIDIA A100 80GB",
  "utilization": 80,
  "memory_used_mb": 40000,
  "memory_total_mb": 81920,
  "processes": [{ "pid": 4242, "user": "alice", "memory_mb": 39000 }],
  "in_use": true,
  "processes_omitted": 0
}
```

`null` always means "not read", never zero. `processes: []` means no compute processes were visible; `processes: null` means they could not be read.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `ssh_alias` | yes | A Host in `~/.ssh/config` on the computer that runs ComputeDeck, e.g. `gpu-box`. |

The driver has no options.

## Capabilities and notices

- `instances`: the machine answered and its snapshot was read.
- `gpu_processes`: GPU processes were read (NVIDIA only).

Notices added to the source:

- `gpu_processes_unavailable`: GPU processes could not be read: the query failed, its output was unexpected, or the GPUs are AMD.
- `gpus_unavailable`: neither `nvidia-smi` nor `rocm-smi` produced a GPU list. CPU and memory are still reported.

Errors (the previous snapshot is kept):

- `ssh_alias_required`, `invalid_ssh_alias`, `invalid_endpoint`: the alias is missing or not a plain Host name.
- `ssh_failed`, `ssh_timeout`: the machine could not be reached, or `python3` is missing (the remote error is shown).
- `unexpected_output`: the script, `nvidia-smi` or `rocm-smi` printed something that could not be parsed.

## Limitations

- Utilization is what the login can see on the host. Inside a container, `nvidia-smi` may show GPUs and processes of the whole host, or none.
- The process owner is unknown (`null`) when `ps` cannot see the process: it has exited, runs in another PID namespace, or `/proc` is mounted with `hidepid`.
- AMD GPUs have no per-process data, and VRAM is unknown when `rocm-smi --showmeminfo` is unavailable.
- With MIG enabled, process rows may not match a listed GPU; processes are then reported as unavailable.
- The cost of the machine is not known, so the hourly price is empty.
- Changing the alias changes the instance id; the row under the old alias stays as `missing`.
- **Check connection** on the instance page refreshes the summary numbers, not the per-GPU rows; those update on the next scheduled collection.

## Per-GPU availability

`in_use` is true when compute processes are visible, or when an empty process list has
memory use at least `max(1024 MiB, 5% of total memory)`. It is false only with an empty
process list and known used and total memory below that floor. An unreadable process list,
or missing memory without visible processes, leaves it null. Utilization alone does not
establish availability. `gpu_allocated` counts true rows only when every row is known;
otherwise it is null. Hand-added probes share this rule for their aggregate count.

Each process list keeps at most 16 entries; `processes_omitted` counts those left out.
The drawer shows at most two owners with process counts and memory, sorted by memory
(unknown last), then process count, plus the number of other displayed owners.
Truncated lists explicitly label owner totals as partial. PIDs are retained in the
existing API field but never shown in the drawer.

`gpus_observed_at` is the timezone-aware collection time of the GPU list. An on-demand
hardware probe updates aggregate readings but never this timestamp or the per-GPU
rows. Where to run uses running instances from current SSH sources and GPU lists no
older than two source collection intervals. Missing instances are excluded,
including old rows after an alias change.
It shows free GPUs separately from cluster estimates, unknown rows as a lower bound,
and copy-only SSH/CUDA setup for NVIDIA GPUs. The snippet selects known-free indexes in
ascending index order, up to the requested count (or all available indexes if fewer are free).
The copy button states the selected and requested counts when fewer GPUs are free. Machines
with no matching GPU are hidden with a count note; unknown models remain visible.
Machines excluded for missing or old GPU samples have a separate count note.
The copied setup is one command, for example:

```sh
ssh -t 'lab-server' 'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=2; exec "${SHELL:-sh}" -l'
```

Pasting it opens an SSH shell with the selected GPU settings; run your command in that shell.
Copying runs nothing and reserves no GPU. Hand-added machines
remain outside this panel because their probes do not retain per-GPU lists.
