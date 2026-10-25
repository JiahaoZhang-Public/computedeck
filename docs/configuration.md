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

The browser starts with the device's language choice, otherwise the last server language
remembered for this origin, otherwise English. The remembered server language is only a
startup hint: `/settings` still supplies the current default and never creates a device
choice. A first visit to a Chinese-default server, a changed default, or unavailable
browser storage can therefore load both dictionaries. Later visits with a matching hint
load only that dictionary.

When you switch languages in Settings, the select shows the requested language and is
marked busy until loading finishes. The current page text stays visible until loading
succeeds; a failed switch restores the select, keeps the device preference unchanged,
and shows an error so you can select again to retry. A device selection takes precedence
over a late server-language response.

中文：浏览器优先使用设备上的语言选择，其次使用为当前来源记住的服务器语言，否则
使用英语。记住的服务器语言只是启动提示；`/settings` 仍提供当前默认值，且不会因此
保存设备选择。首次访问默认中文的服务器、默认语言发生变化或浏览器存储不可用时，
可能加载两份字典；之后若记住的语言与服务器一致，则只加载该语言字典。

在设置中切换语言时，下拉框立即显示所选语言并标记为忙碌，页面文字在加载成功前保持
不变。失败时下拉框恢复原值、设备偏好保持不变，并显示错误，可重新选择以重试。
设备上的选择优先于延迟返回的服务器默认语言。

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

One table per API account or machine. `driver` defaults to `"runpod"`; built in are also `vastai`, `lambda`, `aws-ec2`, `gpuhub` (beta) and `ssh` (one GPU machine collected over SSH).

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
| `hourly_cost`, `currency` | Whole-machine price per hour for cost estimates, not per GPU; `currency` is an ISO code such as `USD`. An omitted price stays unknown. |
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
- Planner: `#/plan?gpus=4&model=A100&hours=12`; `from=<job-id>` links a pending or failed job to alternatives. Recent-job presets fill resources, not run time.
- Cloud and machines: `#/cloud?use=low` for sustained low use, or `use=unknown` for insufficient readings.
- Cluster nodes: `#/resources?nodes=abnormal`.
- Usage & cost: `#/usage?range=24h`, `7d` or `30d`; old numeric history ranges
  (`24` → `24h`; `72`, `3d`, `168` → `7d`) map to offered chips. The range applies
  to observed history, not current figures.
- Tools: `#/toolbox?tab=market`; searches use `q` or `market-q`.

The route IDs and parameter values from 0.7 remain valid, including `state=pending`
and `tab=market`. `provider` remains a legacy alias for `group`; an explicit `group`
takes precedence. These additional route names resolve to the existing pages:

| Link | Canonical URL |
| --- | --- |
| `#/clusters` | `#/resources` |
| `#/nodes` | `#/resources?tab=nodes` |
| `#/marketplace` | `#/toolbox?tab=market` |
| `#/resources?nodes=abnormal&group=cluster-a` | `#/resources?nodes=abnormal&group=cluster-a&tab=nodes` |

Aliases replace the current history entry, so Back does not stop on a redirect.
Other filters, encoded IDs, and the connection/example-mode query before `#` are
preserved. Nodes and Marketplace aliases select `tab=nodes` and `tab=market` even
if the alias URL contains a different tab. A legacy `resources?nodes=…` link gains
`tab=nodes` only when it has no explicit tab. Its `nodes` filter and `group` still
apply to the existing Clusters view; the separate Nodes tab UI follows with the
Clusters page update.

Routing also preserves the new view keys `scope`, `reason`, `attention`, `node`,
`source`, `add`, `edit`, `repair`, `step`, `section`, `plugin`, `rule`, `rate` and
`tab`, including through filter changes and reloads. `edit=<source-id|instance-id>`
and `repair=<source-id>` share `step` with `add`; cloud and SSH machine forms use
`add` / `edit` on `#/cloud` and `#/sources`. The implemented panel and form addresses are listed under “Panels, forms and notifications”
below; page-specific keys such as `node`, `rule` and `rate` remain reserved.

中文：0.7 的路由、参数及参数值保持有效（包括 `state=pending`、`tab=market`）。
`provider` 仍可代替 `group`，同时提供时以 `group` 为准。上表中的别名替换当前历史记录，
不会增加浏览器返回步骤；其他筛选、编码后的 ID 和 `#` 前的连接及示例模式参数均保留。
Nodes 和 Marketplace 别名分别固定选择 `tab=nodes`、`tab=market`；旧节点筛选链接仅在
未指定 `tab` 时补上 `tab=nodes`。节点和集群筛选继续作用于现有集群页，独立节点标签页
随集群页更新加入。上述新增参数会在筛选和刷新时保留；已实现的浮层地址见下文，
`node`、`rule`、`rate` 等页面参数仍为后续页面预留。`add`、`edit`、`repair` 共用 `step`，云和 SSH 机器表单在
`#/cloud`、`#/sources` 下使用相同的 `add` / `edit` 参数。

Opening a job, failed attempt or machine adds its ID to the current view URL. Browser Back
closes the detail while keeping the prior filters. Reloading a link restores the view, and
live details follow newly collected data. Arrays use `array=<cluster>:<array_id>`;
recorded jobs use `event=<id>` and keep the immutable facts saved with that event.
A link to an item no longer present, or to an expired event, says so.
The submit-copy format (flags or script headers) is a per-browser preference, not a
server setting or exported configuration. Copying does not submit anything.
These are links within your own dashboard; they do not grant access to its service.

中文：筛选、搜索、“去哪跑”输入和详情保存在地址栏中，刷新和浏览器返回会恢复对应状态。
链接不会包含凭据，也不会授予他人访问服务的权限。调度器未提供时区的作业时间会明确标注；
无法可靠计算的等待时长保持未知。动态页保存类型、时间范围及搜索条件，`job_filter` 用于
单个作业的历史；`array` 打开当前数组，`event` 打开事件记录时的作业快照，后者不随采集变化。
“在哪里运行”的 `from` 关联待运行或失败作业；预设不填入运行时间。云与机器的 `use=low` /
`unknown` 分别筛选持续低利用率与读数不足。提交参数的复制格式仅保存在当前浏览器，不随配置导出；复制不会提交任务。

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

## Low GPU use hints

Settings → Low GPU use controls two service-wide settings, shared by viewers:

| Setting | Default | Allowed values |
| --- | --- | --- |
| `low_use_threshold` | 10 (%) | Integer 1–50 |
| `low_use_window_minutes` | 60 (minutes) | Integer 30–360 |

`GET /api/settings` returns them; `PUT /api/settings` accepts either independently.
Configuration export includes these settings only when they differ from their defaults,
so default exports remain importable by 0.6. Import leaves omitted settings unchanged;
non-default values round-trip. For example, these top-level TOML settings select
strictly below 15% over at least 90 minutes:

```toml
low_use_threshold = 15
low_use_window_minutes = 90
```

Changes recompute hints from recorded readings. They do not enable any new collection
or SSH checks. At least three consecutive measurements must cover the chosen window, with no gap exceeding twice the
collection interval. A deliberately quiet inference server can be acknowledged or snoozed in Needs attention. Readings are retained for
seven days. See [sustained low GPU use](metrics.md#sustained-low-gpu-use) for coverage.

中文：“设置 → GPU 低利用率”提供服务端共享设置：利用率阈值 `low_use_threshold` 默认 10%，
范围为整数 1–50；窗口 `low_use_window_minutes` 默认 60 分钟，范围为整数 30–360。
配置导出仅包含非默认值，使默认配置仍可导入 0.6；导入时未指定的设置保持不变。
更改后按已有读数重新计算，不会开启新的采集或 SSH 检查。至少需要 3 次连续测量覆盖窗口，
相邻间隔不得超过采集周期的两倍。对于有意保持低负载的推理服务，可在“待处理”中确认或暂缓。
读数保留 7 天。

## Reproducible example data

Set `COMPUTEDECK_DEMO_NOW` to a timezone-qualified ISO datetime, such as
`2026-01-15T14:00:00Z`, to hold example data at a fixed UTC minute. It affects example
dashboards, history, events and collection nodes only; live data keeps its normal clock.
Omit it for the current minute. Invalid or timezone-less values are rejected.
See [Local UI checks](ui-testing.md) for the isolated service and screenshot workflow.

中文：将 `COMPUTEDECK_DEMO_NOW` 设为带时区的 ISO 时间（如 `2026-01-15T14:00:00Z`），
即可将示例数据固定在对应的 UTC 分钟，仅影响示例概览、历史、事件和采集节点，实时数据仍使用正常时钟。
未设置时使用当前分钟；无效或不带时区的值会被拒绝。隔离服务和截图流程见[本地 UI 检查](ui-testing.md)。

### Device appearance

Settings → Appearance offers Follow system (default), Light and Dark, plus Comfortable
(default) and Compact table density. These choices live only in this browser/device's
`localStorage` (`computedeck.theme`, `computedeck.density`), not in server configuration.
A small inline head script applies them before first paint, even while the application
bundle is loading; application initialization also reapplies them. Follow system leaves
`data-theme` absent on `<html>` and responds immediately to OS theme changes; an explicit choice sets
`data-theme="light|dark"`. Invalid saved values use the defaults. If storage is blocked,
changes still work for the current page, but cannot survive a reload.

Comfortable tables use 40 px rows (60 px for the shared two-line pattern) and 32 px controls;
Compact uses 32/48 px rows and 28 px table controls. These text-row sizes include the
hairline; longer content can grow. A plugin's `table.compact` also selects the denser rows
in Comfortable. Coarse pointers use 44/60 px text rows, overriding both density choices.
Forms and panels are unaffected.
Coarse-pointer controls are at least 44 px in either density. Appearance settings work in
example mode without writing example data to the server. High contrast, forced colours
and reduced motion follow the browser/OS preference. Older WebKit, including iOS 16,
uses the generated fallback palette with the same colours.

中文：设置 → 外观提供「跟随系统」（默认）、「浅色」、「深色」以及表格的「舒适」
（默认）和「紧凑」密度。选择仅保存到当前设备的浏览器 localStorage，不写入服务器。
内联 head 脚本在首次绘制前应用设置，无需等待应用脚本下载；应用初始化时再次应用。
跟随系统时根元素无 `data-theme`，系统主题变化会立即生效。
无效的存储值使用默认设置；存储受限时仍可临时切换，刷新后恢复默认。
舒适模式的单行/双行表格为 40/60 像素，控件为 32 像素；紧凑模式为 32/48 和
28 像素，行高包含分隔线，较长内容可自然增高。插件的 `table.compact` 在舒适模式下
也选择紧凑行高；粗指针覆盖两种密度，使用 44/60 像素文字行。仅影响表格，不影响
表单与面板，触屏控件至少 44 像素。示例模式也能切换，
不写入服务端示例数据。增强对比度、强制颜色和减少动态效果跟随系统，旧版 WebKit
（包括 iOS 16）使用生成的同色兼容样式。

### Display identity and clock

Identity colours belong to groups, not individual logins or status. The service persists
six slots in its existing configuration store and includes `identity_slots` in
`GET /api/dashboard`. All source-backed groups, including clouds, use their stable
`cluster_id`; manual machines use `platform:<platform name>` (trimmed, lowercase).
These are colour keys only: existing route and filter keys are unchanged. Two logins of
one group share a slot, even after the first login is renamed or removed. New groups take
a deterministic preferred slot
when free, otherwise the lowest free slot. After six groups, they share the least-used
slot. Removing a group releases its slot without recolouring surviving groups. Existing
sharing is retained when a larger fleet shrinks. Charts must distinguish shared slots
with a neutral/patterned series and direct labels.

Configuration export includes only explicit overrides in `[identity_slots]`; automatic
assignments stay local, so merging exports still fills free slots first. The table is
omitted when there are no overrides; only exports with explicit identity overrides
require 0.8 or later. Import can
override existing groups using integers 1–6, for example:

```toml
[identity_slots]
"cluster-a" = 2
"pods" = 5
```

Overrides are explicit colour choices and may deliberately share a slot. Unknown group
keys are ignored; import creates sources and machines before applying these choices.
Import merges overrides: omitting a key does not clear it. An override persists until
its group is removed; there is currently no reset to automatic assignment for an existing group.
Example mode has a separate deterministic map and never writes it to live configuration.

**Settings → Appearance → Clock** selects 24-hour (default) or 12-hour time, stored on
this device as `computedeck.clock`. The shared time display offers a keyboard/touch
accessible disclosure with the full local date, time, timezone and relative age.
Readings outside today's local date show a short date even when collapsed. Table times
add the full description to the row link without a separate button. Prose durations use
the same localized spelling in every browser (for example, `3 h 10 min`).
Display values distinguish exact counts, lower bounds (`≥`), labelled estimates (`≈`),
unknown values shown as a plain subtle dash with a reason, and explicitly dated last-known
readings. Stale exact values are displayed as unknown; a caller must explicitly supply a lower bound or a dated
last-known reading to retain a number. Copy controls copy text only and append
`# example data` on a new line in example mode.

中文：标识颜色按集群或平台分配，并由服务端保存。同一集群的多个登录共用颜色；
前六个组优先占用空闲色位，之后才共享使用最少的色位。删除组不会改变其他组的颜色；
超过六组后已有的共享关系在缩减组数时保留。`identity_slots` 随仪表盘返回，配置导入导出
使用同名表，色位为 1–6；导出仅包含显式覆盖，自动分配留在本地，合并导入时优先使用空闲色位。
没有覆盖时不导出该表；仅含显式标识颜色覆盖的导出配置需要 0.8 或更高版本。
所有由数据源组成的组（含云平台）均使用稳定的 `cluster_id`，首个登录改名或删除不改变颜色；
手动机器键是 `platform:<平台名称>`（去除首尾空格并转小写），现有网址与筛选键不变。
可手动覆盖已有组的颜色，也可显式共享色位；不存在的组键会被忽略。示例模式不写入真实配置。
导入会合并覆盖，省略某个键不会清除它。覆盖会一直保留到该组被删除；目前无法将已有组重置为自动分配。
设置 → 外观 → 时间格式可选 24 或 12 小时制，保存在本设备。新时间组件可通过键盘和触摸
展开本地完整时间、时区及相对时间。非本地当天的读数在收起时也显示日期；表格时间直接
加入行链接描述，不增加按钮焦点。所有浏览器使用相同的本地化时长格式。
数值组件区分准确值、下界、估计值、附原因的未知值和附时间的最后已知值；未知值的原因
显示在纯色浅色调长横线旁，过期准确值不会当作当前数字显示。复制按钮只复制文本，示例模式
会在新行附加 `# example data`。

### Panels, forms and notifications

Content panels push a history entry. Back or Escape closes the panel, and a cold
link closes to the same page with its filters preserved. At 1200 px and wider,
read-only details use a non-modal beside panel; below that they use a native modal
sheet. Focus moves to the heading and returns to the current subject’s row, falling back to the opening row or button if it is gone. The
beside panel's j/k keys follow the displayed rows of the same table, including its
filters, order and array grouping, scrolling the next row into view without adding Back stops; fields,
IME composition and modified keys are ignored. If filters change while a beside panel
is open, Escape or Close removes only the layer keys and keeps the current filters;
Back still returns to the preceding history entry.

The existing `job`, `failure`, `event`, `array` and `instance` links keep working.
These additional links now open layers (IDs below are fictional):

| Address | Layer |
| --- | --- |
| `#/sources?source=example-source` | Source diagnosis panel |
| `#/sources?add=source&step=1` | Existing source type chooser |
| `#/sources?add=ssh&step=2` | Existing SSH source form (`add` also accepts a driver ID) |
| `#/cloud?add=instance&step=1` | Manual machine form; also works on Sources |
| `#/sources?edit=example-source&step=2` | Source edit form |
| `#/sources?edit=example-source&step=3` | Saved-source check; a cold or restored link waits for **Run check** |
| `#/cloud?edit=example-machine&step=1` | Machine edit form |
| `#/sources?repair=example-source` | Source diagnosis and repair focus view |
| `#/cloud?section=ssh` | SSH configuration view |
| `#/toolbox?plugin=notify` | Installed tool panel |
| `#/toolbox?plugin=notify&edit=notify&step=1` | Tool settings focus view |
| `#/toolbox?tab=market&plugin=example-tool%40example` | Marketplace plugin panel |

Source steps are 1 (type), 2 (details) and 3 (the existing saved-source check).
Only a successful Save in the mounted form starts that check automatically. A cold,
reloaded or history-restored step-3 edit link waits for **Run check**, sends no check
request by itself, and does not claim settings were saved in this view.
A step-3 add link without a saved source explains that source settings are needed,
rather than starting a check. Tool settings close after a successful Save and remain
open with an error on failure. Switching Toolbox tabs clears the plugin and edit view.
Step changes replace the current entry; Back closes the form. Draft fields are
not stored in the URL. Focus views and removal confirmations never dismiss from
a backdrop click. Confirmations start on **Keep**; the other button names the
removal. The new source-connection wizard remains a later page item.

Health ages, menus and explanatory popovers are transient, with no URL; Escape
or an outside click dismisses them. A menu becomes a sheet on touch devices.
Notifications share one polite region, show at most three at once and move inside
an open modal without restarting their timers or losing pause state. Escape dismisses notifications first without moving focus. Undo
lasts ten seconds, pauses on hover or focus, and supports Command/Ctrl+Z outside
editable fields. Errors stay until dismissed and also appear as local action-error
rows; dismissing a toast does not remove its error row. These rows are not server
attention state and clear when switching example mode. Each row includes the error
shape, accessible Error prefix and time disclosure. Example-mode read-only notices
are temporary notifications and do not create error rows.

中文：内容面板打开时增加一条历史记录，返回或 Escape 关闭；直接打开链接时，关闭后
保留当前页面的筛选。宽度至少 1200 px 使用非模态旁侧面板，较窄时使用原生模态抽屉。
焦点先到标题，关闭后回到当前对象的行；该行已移除时才回到原触发行或按钮。旁侧面板中的 j/k 按相邻表格实际显示的顺序和筛选遍历对象（包括数组分组），将下一行滚动到可见范围，不增加返回步骤；
输入框、输入法组合输入和带修饰键的按键不触发切换。上表中的新地址现已生效；旧详情
地址仍兼容。来源步骤为 1（类型）、2（详情）、3（保存后的检查），步骤变更替换当前
历史项，草稿字段不写入 URL。仅当前表单保存成功后自动检查；直接打开、刷新或历史恢复的
第 3 步编辑链接等待点击“运行检查”，不自动发送检查请求，也不显示“设置已保存”。新连接向导仍留待后续页面更新。

编辑、修复及移除确认不会因点击遮罩而关闭；确认默认聚焦“保留”，另一按钮明确说明
移除对象。健康信息、菜单和说明浮层不占用 URL，触屏菜单使用抽屉。通知最多三条，
共用一个礼貌播报区域，打开模态框时移入其中，移动不重置计时或暂停状态。Escape 先清空通知且不移动焦点。
撤销保留十秒，悬停或聚焦时暂停；非输入区域支持 Command/Ctrl+Z。错误持续到手动关闭，
并另列为本地操作错误行；清除通知不删除错误行。这些行不写入服务端 attention 状态，
切换示例模式时清除。

中文：旁侧面板打开后修改筛选，Escape 或“关闭”只移除浮层参数并保留新筛选；浏览器返回
仍回到上一历史项。未保存数据源的第 3 步链接显示说明，不启动检查。工具设置保存成功后
关闭，失败时保留表单和错误；切换工具箱标签清除插件及编辑视图。本地错误行包含错误
形状、辅助技术可读的“错误”前缀和可展开的时间；示例模式的只读提示为临时通知，不加入错误行。

### Live updates

Dashboard, health, toolbox and collection-machine reads run every 10 seconds with a fine
pointer (including the native macOS app), and every 30 seconds with a coarse pointer.
Reads pause while the page is hidden
and refresh on return or focus. This reads the service's stored data;
it does not start a cluster or cloud collection. Refresh and source collection still use
the existing one-second follow-up for at most 60 seconds. Activity, Chat and Notify keep
their existing dedicated polling schedules.

Unchanged replies preserve the displayed rows and focus. Relative ages update once a
minute without rerendering the whole page. The shared polite notification region announces
health transitions, jobs joining/leaving the list or changing state, and changes in the
open attention count. It stays silent for the initial inventory, timestamps and unchanged
polls. A job leaving the list is not claimed to have finished successfully. Announcements
use the same region as toasts, including inside an open modal, and clear after 4.5 seconds.

仪表盘、健康、工具箱与采集机器的读取周期为精细指针 10 秒（含 macOS 原生应用）、粗略指针 30 秒。
页面隐藏时暂停，返回或获得焦点时刷新；只读取服务中已有数据，不会自动向集群或云端
发起采集。刷新和源采集仍保留最多 60 秒的每秒跟进。Activity、Chat 和 Notify 保持各自
现有的专用轮询周期。

未变响应保留列表行和焦点；相对时间每分钟只更新文字，不重绘整个页面。共享的礼貌播报
区域仅报告健康变化、作业加入或离开列表、作业状态变化及待处理提醒数量变化，首次载入、
时间戳和未变轮询均不播报。作业离开列表不代表成功结束。播报与通知共用一个区域，打开
模态视图时也随通知移入其中，4.5 秒后清除播报文字。

### History charts

Usage's observed trend uses separate utilisation and allocation plots with a shared
crosshair. Choose 24 h, 7 d or 30 d. Previous/Next name that span and sit beside Table
view inside the chart; Latest returns to the current window.
`#/usage?range=7d&end=<ISO time with timezone>` restores the chart window. Paging affects
only the trend; the existing usage totals and daily breakdown retain their relative range.

The shared minute clock checks for a new chart bucket while the current live window is
visible (5 minutes, 1 hour or 1 day). At that boundary, only the chart is requested,
without rollups or a second week request. A new history point still refreshes the usual
history and rollups. Example and historical windows stay fixed. Failed requests keep
the last data alongside their error reason and time.

Between collections, a bin holds the last observation while it is younger than twice
the fastest recorded interval at the bin's start (30 minutes for old records without
intervals). These bins say “Held from … · last sample” and have zero new samples.
Unknown readings remain unknown; overdue collection becomes a gap. Sample-count
shortfalls alone never mean partial coverage or a lower bound.

Metric lines are ink. Identity colours apply only to group series; a shared slot gets
a neutral square marker and its own label. Hatching is reserved for merged missing-data
bands. Only allocation lower bounds use a dashed line and “≥”; other partial coverage
is stated in the readout/table. The 7 d/30 d band shows min/max, not a forecast.
Plots measure their width so hatch angles and marker shapes survive phone resizing,
and each has a labelled y-axis. The current bucket says “So far”.

Click or tap a reading to pin it, and click it again or press Escape to release it.
Unpinned Escape remains available to a containing layer. The readout stays above the
plots and can be copied. Times are compact and local, with dates when needed; the
readout's start time and last-sample time disclose the full date, time and zone.
The Activity link opens the exact interval (`from` inclusive, `to` exclusive).
Activity's range chips replace it with the usual relative range. Charts allow vertical
page scrolling; there is no brush, pinch, pan or scrub.

Tab focuses the plot stack once. Left/Right move one bucket (Shift moves ten),
Page Up/Down move an hour in the 24 h range or a day in longer ranges, Home/End reach
the first/last bucket, and Up/Down choose a series. Enter pins; 1/2/3 select the range
while the plot has focus. Table view shows the same values, held readings, coverage,
bounds and reasons in pages of 24 buckets. Missing historical coverage remains unknown.

### 历史图表

使用情况页面的利用率和分配量分图展示，共享读数。选择 24 小时、7 天或 30 天，
带具体时长的前后翻页按钮与表格视图同处图内工具行，“最新”返回当前窗口。
`end` 参数恢复图表窗口；翻页仅影响趋势，已有总计和每日明细保留所选相对范围。

当前实时图表可见时，共享分钟时钟检查是否跨入新区间（5 分钟、1 小时或 1 天）。
跨界后仅请求图表，不请求汇总或额外的周数据。出现新历史点时仍按原流程刷新历史和
汇总。示例及历史窗口固定。请求失败保留上次数据，同时显示原因和失败时间。

两次采集之间，区间起点距最近观测未满记录中最快采集周期的两倍时，沿用最近读数；
无周期的旧记录使用 30 分钟。沿用区间标注“沿用……的读数 · 最近样本”，新样本数为零。
未知读数保持未知，采集超时后显示间隙。样本数低于预期本身不表示覆盖不完整或下界。

指标线使用墨色；身份色仅用于组序列，共享色槽的后续序列使用中性色、方形标记及直接
标签。斜线仅表示合并的缺失区间；虚线和“≥”仅表示分配量下界，其余覆盖不完整在
读数和表格中说明。7 天/30 天色带表示最小–最大值，不作预测。图表测量实际宽度，
手机上斜线角度和标记形状保持一致，每幅图均有纵轴数字。当前区间标注“截至目前”。

点击或轻触固定读数，再次点击或 Escape 取消；未固定时 Escape 继续传递给外层。
读数在图上方，可复制。时间使用紧凑的本地格式，需要时显示日期；起始时间和最近采集
时间可展开完整时间及其时区。动态链接使用 `from`（含）至 `to`（不含）的精确时段，
动态范围按钮清除该时段。图上允许纵向滚动，不提供框选、缩放、平移或滑动取值。

图表仅有一个 Tab 焦点：左右移动一个区间，Shift 移动十个；Page Up/Down 移动一小时
或一天；Home/End 到首尾；上下切换序列；Enter 固定；1/2/3 切换范围。表格每页展示
24 个相同区间及其沿用读数、下界、覆盖数和缺失原因。旧记录缺失的覆盖数保持未知。
