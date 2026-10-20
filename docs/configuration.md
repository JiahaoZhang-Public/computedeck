# Configuration file

Everything you set in the app can also be written as TOML and imported:

```sh
computedeck import config.toml     # create or update; nothing is deleted
computedeck export > config.toml   # current sources, instances and settings
```

Import keeps the collected data and state of sources that already exist. Run it while the service is stopped, or refresh in the app afterwards. A complete example is in [examples/config.toml](../examples/config.toml).

## Terms / 术语

The interface uses the [English glossary](../README.md#terms-in-the-interface) and
[中文术语表](../README.zh-CN.md#界面术语). Configuration keys keep their existing names:

| UI term / 界面术语 | Configuration meaning / 配置含义 |
|---|---|
| Source / 来源 | One login (`[[cluster.identity]]` or `[[cluster]]` with inline `username` / `ssh_alias`), or one `[[cloud]]` API account or SSH host / 一个登录身份（`[[cluster.identity]]` 或直接填写 `username` / `ssh_alias` 的 `[[cluster]]`），或一个 `[[cloud]]` 云 API 账号或 SSH 主机。 |
| Cluster or platform / 集群或平台 | A resource group: a `[[cluster]]` or a cloud platform name / 资源分组，由 `[[cluster]]` 或云平台名称表示。 |
| Instance / machine / 实例 / 机器 | A collected machine or hand-added `[[instance]]` / 采集到的机器或手动添加的机器。 |
| Collection machine / 采集机器 | `[[node]]`, selected by a source's `node` field / 通过来源的 `node` 字段选择的采集电脑。 |
| Node / 节点 | A scheduler's compute node, not `[[node]]` / 调度器的计算节点，不是配置中的采集机器。 |
| Needs attention / 待处理 | Derived faults and warnings, not a configuration table / 根据当前状态生成的故障和警告列表，不是配置表。 |

## Top level

| Key | Meaning |
|---|---|
| `language` | Default UI language of this server: `"en"` (default) or `"zh-CN"`. Viewers can still choose their own in Settings. |
| `server_name` | Name shown in remote mode. Defaults to the host name. |

## `[[cluster]]`

One table per cluster. `driver` defaults to `"slurm"`.

| Key | Meaning |
|---|---|
| `id` | Stable identifier used in job ids (`<id>:<JobID>`). Defaults to a slug of `label`. |
| `label` | Display name. |
| `driver` | Collection method. Built in: `slurm`, `kubernetes`, `pbs`, `lsf`. |

Each `[[cluster.identity]]` is one login:

| Key | Meaning |
|---|---|
| `username` | Login name on the cluster. Only this user's jobs are collected. |
| `ssh_alias` | A `Host` from `~/.ssh/config` on the machine that collects. ProxyJump, ProxyCommand and keys come from there. |
| `options` | Driver-specific settings as an inline table, e.g. `options = { context = "lab" }` for Kubernetes. See [drivers](drivers/). |
| `node` | The `id` of a `[[node]]` that collects this source. Empty (default) means the machine running the service. |
| `enabled` | `false` keeps the identity without collecting it. Default `true`. |
| `interval_minutes` | 5–1440. Default 10. |

A cluster without identity tables can put `username` and `ssh_alias` directly in the `[[cluster]]` table.

## `[[cloud]]`

One table per API account or machine. `driver` defaults to `"runpod"`; built in are also `vastai`, `lambda`, `aws-ec2` and `ssh` (one GPU machine collected over SSH).

| Key | Meaning |
|---|---|
| `id`, `label`, `driver` | As for clusters. |
| `credential` | Where the API key is read: `env:NAME`, `keychain:service/account` or `file:path`. |
| `ssh_alias` | For `ssh`: the alias that reaches the machine. |
| `options`, `node`, `enabled`, `interval_minutes` | As for clusters. `aws-ec2` needs `options = { region = "us-east-1" }`. |

## `[[node]]`

A collection machine: another computer that collects the sources naming it, over SSH, with
its own SSH configuration, credentials and network. It needs ComputeDeck installed; no
service has to run there.

| Key | Meaning |
|---|---|
| `id` | Identifier used by `node` in sources: lowercase letters, digits and dashes, up to 40. Defaults to a slug of `name`. |
| `name` | Display name. |
| `ssh_alias` | The alias, on the machine running the service, that reaches it. |
| `command` | How to run ComputeDeck there: a path and plain arguments, not empty. Default `computedeck`; SSH commands do not load your login `PATH`, so a full path such as `~/.local/bin/computedeck` is often needed. |

## `[[instance]]`

A machine you reach over SSH and add by hand.

| Key | Meaning |
|---|---|
| `platform` | Free text, used to group instances (e.g. `"Lab workstation"`). |
| `id` | Your identifier for the machine; part of the generated alias `cd-<platform>-<id>`. |
| `name` | Display name. |
| `host`, `port`, `username`, `identity_file` | SSH endpoint. `identity_file` must be absolute or start with `~/`. |
| `existing_alias` | `true` when `host` is an alias already in your SSH configuration; no Host block is generated. |
| `gpu_count`, `gpu_type` | Shown until a hardware snapshot reports the real values. |
| `hourly_cost`, `currency` | For cost estimates; `currency` is an ISO code such as `USD`. |
| `monitoring` | Read GPUs, their processes, CPU and memory over SSH every 10 minutes. The machine counts in GPUs in use while its last check is under 20 minutes old. |

## Credentials

Sources hold references, never secrets:

- `env:RUNPOD_API_KEY` — an environment variable of the service process. When the service runs as a login service, put the variable in its environment (launchd plist or systemd unit).
- `keychain:computedeck/runpod` — the system keychain through the `keyring` package (macOS Keychain, or Secret Service on Linux desktops). Store it with `keyring set computedeck runpod`.
- `file:~/.config/computedeck/runpod` — a file that only its owner can read (`chmod 600`); refused otherwise. Useful on servers and collection machines without a keychain.

A source collected on a collection machine resolves its reference there.

Plugins can add further schemes.


## Links and view state

The URL preserves view choices without storing credentials:

- Jobs: `#/jobs?state=pending&q=train`; add `group=<cluster-id>` to filter a cluster.
- Planner: `#/plan?gpus=4&model=A100&hours=12`.
- Cluster nodes: `#/resources?nodes=abnormal`; history uses `range=24`, `72` or `168`.
- Tools: `#/toolbox?tab=market`; searches use `q` or `market-q`.

Opening a job, failed attempt or machine adds its ID to the current view URL. Browser Back
closes the detail while keeping the prior filters. Reloading a link restores the view, and
open details follow newly collected data. A link to an item no longer present says so.
These are links within your own dashboard; they do not grant access to its service.

中文：筛选、搜索、“去哪跑”输入和详情保存在地址栏中，刷新和浏览器返回会恢复对应状态。
链接不会包含凭据，也不会授予他人访问服务的权限。调度器未提供时区的作业时间会明确标注；
无法可靠计算的等待时长保持未知。
