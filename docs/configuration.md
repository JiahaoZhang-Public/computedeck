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

An edit or import keeps the last SSH check and measurements when `host`, `port`,
`username`, `identity_file` and `existing_alias` are unchanged. Renaming a machine,
changing its price or switching monitoring preserves the check's original age; changing
its connection clears the check until it is run again.

中文：编辑或导入时，如果主机、端口、用户名、密钥文件和 `existing_alias` 均未改变，
会保留上次 SSH 检查结果和测量数据。重命名、修改价格或切换监控不会重置检查时间；
连接改变后会清除检查，需要重新检查。

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
- Activity: `#/activity?type=failed&range=7d&q=train`; `group` scopes a cluster or platform,
  and `job_filter` selects one job's history.
- Planner: `#/plan?gpus=4&model=A100&hours=12`.
- Cluster nodes: `#/resources?nodes=abnormal`.
- Usage & cost: `#/usage?range=24h`, `7d` or `30d`; old numeric history ranges
  (`24` → `24h`; `72`, `3d`, `168` → `7d`) map to offered chips. The range applies
  to observed history, not current figures.
- Tools: `#/toolbox?tab=market`; searches use `q` or `market-q`.

Opening a job, failed attempt or machine adds its ID to the current view URL. Browser Back
closes the detail while keeping the prior filters. Reloading a link restores the view, and
live details follow newly collected data. Arrays use `array=<cluster>:<array_id>`;
recorded jobs use `event=<id>` and keep the immutable facts saved with that event.
A link to an item no longer present, or to an expired event, says so.
These are links within your own dashboard; they do not grant access to its service.

中文：筛选、搜索、“去哪跑”输入和详情保存在地址栏中，刷新和浏览器返回会恢复对应状态。
链接不会包含凭据，也不会授予他人访问服务的权限。调度器未提供时区的作业时间会明确标注；
无法可靠计算的等待时长保持未知。动态页保存类型、时间范围及搜索条件，`job_filter` 用于
单个作业的历史；`array` 打开当前数组，`event` 打开事件记录时的作业快照，后者不随采集变化。

## Notify job outcomes

Notify rules can select **Job finished** and any combination of outcomes. No selected
outcomes means all outcomes; this filter applies only to job endings. The default new
rule selects failure outcomes. Templates support `{outcome}` in English and Chinese.

Existing saved `job.failed` rules migrate to `job.finished` with the failure outcomes;
`job.ended` rules, including rules containing both old types, migrate to all outcomes.
Channels, custom templates and other filters are preserved. Pending legacy events and
queued deliveries continue to work after upgrading. New-source and first-upgrade
terminal history is silent; after a gap, non-failure catch-up endings are also silent.

中文：通知规则可选择“作业结束”及具体结果，未选择结果表示全部结果。原失败规则迁移为
失败结果筛选，原离开队列规则迁移为全部结果；渠道、自定义模板和其他筛选条件保持不变。
`{outcome}` 会按界面语言显示结果。首次采集及升级后的首次历史记录不会发送通知。

## Notify digests

Matching array elements in one collection share one notification per rule and event
type. An unrelated failure keeps its own message. Catch-up events after a collection gap
are also grouped; their messages show the collection window. The leader keeps your
template, and only its log is read if requested. A translated summary names the
remaining jobs. The collection window, summary and limit notice appear before the log
section. The delivery log uses one **Grouped · N events** row for the siblings,
retaining their IDs. Channel results show the total count including the leader. A
suppressed digest likewise uses one row, so a large array does not crowd out earlier
deliveries. Grouping spends one hourly slot. The last allowed message says the limit was
reached; subsequent events remain in Activity and are logged as suppressed. A limit of
zero sends nothing.

中文：同一轮采集中的数组元素按规则和事件类型合并通知，无关作业的失败单独发送。
采集中断后的补收事件也会合并，并注明采集时间区间。首个事件使用已有模板；启用日志时
只读取该事件的日志。采集时间区间、其他作业摘要及额度提醒均显示在日志段落之前。
每组合并事件只占一条“已合并 · N 个事件”记录，并保留各事件 ID；渠道结果显示含首个
事件在内的总数。被抑制的合并消息也只占一条
记录，大数组不会挤走此前的投递记录。
每条合并消息只占一个每小时额度；最后一条允许发送的消息提醒已达上限，后续事件保留在
动态中并记为已抑制。上限为零时不发送任何消息。

## Notification delivery and attention

The Notifications page refreshes its delivery log while visible and enabled. Activity
shows recorded delivery outcomes, and a channel's recent failed attempt appears in Needs
attention. Acknowledge or snooze quiets that attention item; it does not disable its rule,
stop retries or mute the service health indicator. A later success clears the channel
warning. Missing delivery records mean unknown, not successful delivery.

Acknowledgements and snoozes are saved on the service and shared by viewers. “Until
tomorrow” expires at the next midnight in the service host's timezone. Overview's **Mark
seen** is separate: it stays in this browser and does not acknowledge faults or affect
notification delivery. See [Needs attention](metrics.md#needs-attention).

中文：任务提醒开启且页面可见时会自动刷新发送日志。动态显示已记录的发送结果，近期发送失败的
渠道会出现在待处理列表。确认或暂缓只让该待处理项静默，不会停用规则、停止重试或隐藏服务健康状态。
之后发送成功会清除渠道警告；缺少发送记录表示未知，不表示成功。

确认和暂缓保存在服务端，所有查看者共享。“直到明天”在服务主机时区的次日零点到期。
总览的“标为已读”独立保存在当前浏览器，不会确认故障或影响通知发送。
