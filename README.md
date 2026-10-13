<p align="center"><img src="docs/assets/computedeck-mark.svg" width="88" alt=""></p>

# ComputeDeck

[中文说明](README.zh-CN.md)

ComputeDeck runs on your own computer and collects, read-only, what you have running on clusters, cloud GPUs and your own machines: your jobs and why they wait, the GPUs you hold, the capacity each cluster shows you, your limits, jobs that failed in the last day, and the hourly price of cloud instances.

It is meant for people who use one or more clusters with an ordinary account and no admin rights, and who rent GPUs on the side. It talks to clusters through the SSH configuration you already use, so jump hosts and keys keep working. Nothing is installed on the clusters.

Sources: **Slurm**, **Kubernetes**, **PBS** and **LSF** clusters; **RunPod**, **Vast.ai**, **Lambda** and **AWS EC2**; and any **GPU machine** you reach over SSH. Plugins can add more.

## What it shows

- **Jobs**: running and queued jobs of each login, with GPU counts, nodes and pending reasons. A job seen through two logins is counted once.
- **Clusters**: visible nodes, allocated and unallocated GPUs, and the QoS limits the scheduler reports for your login.
- **Failures**: jobs that ended as failed, timed out, out of memory, node failure or preempted in the last 24 hours (`sacct`).
- **Cloud instances and machines**: instances from cloud APIs, GPU machines collected over SSH (GPUs, the processes on them and their users, CPU and memory; NVIDIA through `nvidia-smi`, AMD through `rocm-smi`), and any machine you enter by hand.
- **Where to run**: say how many GPUs, which model and for how long; for every cluster login and QoS you see the free GPUs of that model, your remaining QoS limit, your queued jobs and the QoS time limit, ranked by how likely the job is to start. It is an estimate from the last collection, not a promise from the scheduler.
- **Sources**: one page to add, check and change sources. Each login shows which of `squeue`, `scontrol`, `assoc_mgr` and `sacct` its last collection could read, and can be collected on demand.
- **History**: GPUs in use and observed utilization over the last 24 hours, 3 days or 7 days.
- **Recent activity**: jobs that started, left the queue or failed, and sources that stopped or recovered.
- **Toolbox**: optional tools, off until you switch them on: **Notifications** (email or webhooks when jobs fail, start or end; an AI model can write the message) and **Team messages** (notes and small files for everyone using the same ComputeDeck). Plugins from marketplaces appear here too.

## What it does not do

- It does not submit, cancel or modify jobs, and does not start or stop instances. The core only reads; the tools that write (notifications, team messages) are off until you switch them on, and say what they do.
- It does not measure cluster-wide GPU utilization. Allocation (what the scheduler gave out) and utilization (how busy a GPU is) are shown separately.
- It never turns an unknown value into zero. If a source could not be collected, totals are marked incomplete.

## Requirements

- Python 3.12 and [uv](https://docs.astral.sh/uv/)
- Node.js 22 (only to build the web app from source)
- macOS or Linux, with the OpenSSH client
- For clusters: an SSH host alias that logs in **without prompts** (key or agent, host key already accepted). ComputeDeck uses `BatchMode=yes` and `StrictHostKeyChecking=yes`.

## Run from source

ComputeDeck is not published on PyPI yet.

```sh
git clone <this repository> computedeck
cd computedeck
uv sync
npm --prefix web ci
npm --prefix web run build
uv run computedeck serve --open
```

The service listens on `http://127.0.0.1:8710` only. `--open` opens the page; there is nothing to sign in to unless you turn on the access token (see [Data and security](#data-and-security)). Turn on **Example data** at the bottom left to look around without connecting anything.

## Connect your resources

Use **Add source** on the first page or under **Sources**, or write a configuration file and import it (see [docs/configuration.md](docs/configuration.md)).

**Slurm cluster.** Enter a cluster name, your login username and an SSH host alias. ComputeDeck runs these commands, all read-only:

| Command | Used for |
|---|---|
| `squeue --user=<you>` | your running and queued jobs |
| `scontrol -d show nodes -o` | visible nodes and their GPU allocation |
| `scontrol show partition -o` | QoS names allowed by partitions |
| `scontrol show assoc_mgr flags=qos` | QoS limits |
| `sacct --user=<you> --state=FAILED,…` | failures in the last 24 hours |

Only `squeue` is required. If a cluster does not allow the others, the source is marked as partial and the rest still works. After adding a source, the app runs a first collection and shows which of these worked. Add a second login on the same cluster by entering the same cluster name.

**Other clusters.** Kubernetes (kubectl with your kubeconfig, locally or over SSH; the namespace is the login), PBS and LSF (over SSH like Slurm). See [docs/drivers](docs/drivers/). PBS, LSF, Kubernetes and Vast.ai are marked beta: they follow the documented formats but have not been run against every version.

**Cloud GPUs.** RunPod, Vast.ai and Lambda through their APIs; AWS EC2 through the AWS CLI with its own configuration. Enter a reference to an API key, not the key itself: `env:RUNPOD_API_KEY` reads an environment variable of the service, `keychain:computedeck/runpod` reads the system keychain (service `computedeck`, account `runpod`), and `file:~/.config/computedeck/runpod` reads a file only you can read.

**A GPU machine.** Add it as a source with the SSH alias that reaches it; it is collected on schedule. Collection needs `python3` there and installs nothing.

**Any other machine.** Add it under **Cloud instances → Add instance** with its host, port and user, or with an SSH alias you already have. ComputeDeck writes stable aliases to its own `computedeck.conf`; you can add one `Include` line to `~/.ssh/config` from the app, after a preview.

Sources are collected every 10 minutes by default (5 to 1440 minutes per source).

## Run it on a server

To keep collecting while your laptop sleeps, run ComputeDeck on a machine that stays on and open it through SSH:

```sh
# on the server
uv run computedeck service install      # launchd on macOS, systemd --user on Linux

# on your laptop
uv run computedeck connect my-server     # SSH tunnel to the server, then opens the browser
```

The HTTP API is never exposed beyond `127.0.0.1`. See [docs/deployment.md](docs/deployment.md).

## Several machines

When a cluster can be reached only from another machine (its VPN, its key), add that machine under **Sources → Collection machines** with its SSH alias, and choose it as **Collected by** for the source. ComputeDeck then runs `computedeck collect` on that machine over SSH: the machine needs ComputeDeck installed but no running service, port or token, and uses its own SSH configuration, credentials and network. Results, history and alerts stay on the machine you open.

## Tools and plugins

Plugins are Python packages listed in marketplaces, catalogs kept in a git repository, at an https address or in a folder. Installing is done on the service machine:

```sh
computedeck plugin marketplace add example-lab/computedeck-plugins
computedeck plugin search alerts
computedeck plugin install lab-alerts@example-lab     # then restart, and switch it on in the Toolbox
```

The Toolbox shows each plugin's source and tier, version and what it says it will do. A `policy.toml` in the data directory can limit marketplaces and block plugins. To write a plugin, start with `computedeck plugin new my-tool --web` and read [docs/plugins.md](docs/plugins.md).

## Language

The interface is in English by default. Switch to Chinese under **Settings → Language**; the choice is saved in the browser. A server can set its default with `language = "zh-CN"` in the configuration file.

## Data and security

- Data lives in `~/Library/Application Support/ComputeDeck` (macOS) or `~/.local/share/ComputeDeck` (Linux); set `COMPUTEDECK_DATA_DIR` to change it. Everything ComputeDeck writes there is readable only by you (folders 0700, files 0600).
- API keys, passwords and private keys are never written to the database, backups or logs. Sources store only references such as `env:NAME`.
- ComputeDeck is meant for your own machine. The service listens on `127.0.0.1` only, accepts only the host names `127.0.0.1` and `localhost` (so a web page cannot reach it by DNS rebinding), and browsers do not let other websites read its answers. That does not keep out other user accounts on the same machine: if other people have accounts on the machine that runs the service (a shared server), set `COMPUTEDECK_AUTH=token`. Every API request then needs the access token in the data directory (`api-token`, readable only by you); `serve --open` and `connect` sign you in after checking that the listener is your service, and `computedeck token` prints it for signing in by hand. [docs/deployment.md](docs/deployment.md#access-token) describes how the token reaches the page.
- Write requests must also come from the ComputeDeck page itself (origin and header checks), so other websites cannot change your configuration.
- Backups are consistent SQLite copies made from **Settings → Backup**; the newest 10 are kept (`COMPUTEDECK_BACKUPS` changes how many).

## What the numbers mean

- **GPUs in use** counts GPUs allocated to your running jobs and running cloud instances. When a source has not been collected recently, the number is a subtotal and is labeled as such.
- **Unallocated** GPUs on a cluster are node capacity minus allocation. Maintenance, reservations or QoS limits can still prevent you from using them.
- **QoS limits** are what the scheduler shows for your login. They are not proof that you may use that QoS, and limits of different QoS do not add up.
- **Utilization** of cloud instances is an instant reading of the whole host. Inside a container it can reflect the host machine.
- **History** comes from successful collections only; periods without data stay empty.
- **Prices** are estimates from known hourly prices, not bills. Currencies are never added together.

## Development

```sh
bash scripts/check.sh    # ruff, mypy, pytest, eslint, prettier, tsc, vitest, vite build
bash scripts/build.sh    # wheel and sdist with the web app bundled
```

Layout: `src/computedeck` is the service (FastAPI, SQLite), `web` is the React app, `tests` are the Python tests. Adding a scheduler or cloud provider, or extra pages, is described in [docs/plugins.md](docs/plugins.md).

## License

Not chosen yet; it will be added before the first release.

### Diagnose a source

Run `computedeck doctor` for connection, command, permission and plugin checks, or use
**Test connection** on the Sources page. Both show the same repair guidance. Use
`computedeck doctor --source <source-id> --language zh-CN` for a Chinese report.
See [diagnostics](docs/doctor.md), [Slurm permissions](docs/drivers/slurm.md), and
[logging](docs/deployment.md#logs-and-startup-permissions).
