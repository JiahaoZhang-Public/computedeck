# Reading the numbers

The service computes the headline figures once for the fleet, each cluster
or platform, and each source. Overview, Usage, cluster views and new history points
read those figures. `—` means unknown or no measurement; `≥ n` is a known subtotal,
with named missing evidence. Neither means zero.

- **Freshness** in the topbar uses the oldest enabled source’s last successful collection. If any enabled source has never succeeded, it says "Not collected yet". Disabled sources and manual SSH checks do not make the fleet age newer. "Collecting N" keeps that age visible, and Refresh can queue the other sources. Open the health pill on any page for source ages, next attempts, backoff and service faults. The age can look older than in earlier releases because it no longer follows the newest source.
- **GPUs in use** counts GPUs allocated to your running jobs and running cloud instances. For SSH GPU machines it counts GPUs with visible compute processes or an empty process list with memory use at least max(1024 MiB, 5% of total GPU memory). Unavailable process visibility (for example on AMD GPUs), or missing memory without visible processes, remains unknown. A monitored machine added by hand counts while its last SSH check, less than 20 minutes old, reached it; otherwise its use is unknown. Machines with monitoring off are excluded, with a note showing how many. Partial totals name each unmeasured machine or login and explain why, with a link. Checking a cloud instance over SSH never changes the GPUs its provider lists. When a source has not been collected recently, the number is a subtotal and is labeled as such.
- **Provider-reported running** instances (for example RunPod) count their listed GPUs as held, with the label "Running (reported by provider)". This is an allocation report, not a readiness check. `desired_running` remains unknown because it can mean provisioning. Stopped, terminated, deleted, desired-stopped and desired-terminated instances hold no GPUs. A missing GPU count or a stale source still makes the total partial. The same lifecycle table drives the headline, history and idle-instance suggestions.
- **SSH checks** of a cloud instance are kept across provider listings while its host, port and user stay the same, so a failed connection stays failed until it is checked again. A listing that reports the instance no longer holds GPUs clears the old check, even if it retains an endpoint. The check shows its own age next to the listing's; counting a provider's allocation never makes an old utilization reading fresh.
- **Usable capacity** includes only healthy nodes from enabled, current sources. Down, drained, reserved, UNKNOWN, FUTURE, ERROR and nonresponsive (`*`) nodes are unavailable. Slurm nodes must belong to a partition. Power-saving nodes with idle, free or empty base states, and PBS provisioning, sleep and wait-provisioning nodes, cannot contribute current usable or free GPUs. Nodes with assigned work remain usable and retain their allocations even with power flags. DYNAMIC_FUTURE is not the FUTURE state and does not exclude an idle node. Non-faulty resting Slurm power-saving nodes (with or without CLOUD) and PBS sleep/provisioning nodes are labelled **available on demand**, never free now. They remain healthy for cluster status and do not count as unhealthy nodes. Usable, unavailable and on-demand GPU counts are separate parts of the total inventory; GPUs on unknown-state nodes remain unknown. An outage reads "0 usable · N unavailable", alongside the total inventory. **Unallocated** GPUs are usable capacity minus the allocations on those usable nodes. QoS limits and your access still constrain where you can run.
- **QoS limits** are what the scheduler shows for your login. Limits alone do not prove access. The planner shows verified and unknown-access options together, with one access note per login. Only options without an association are collapsed. Limits of different QoS do not add up.
- **Where to run** estimates account for this login's eligible queued jobs in the same QoS. Held, dependency, begin-time and array-task-limit jobs are excluded. Eligible jobs are considered in listed order, subtracting each only if it fits the room left after previously counted jobs. A larger job is skipped because it cannot start first. If the remaining queued GPUs starting first would leave insufficient headroom for the request, the option reads "Likely to wait for your queue". This is an estimate, not FIFO or a promise of scheduling order. Unknown queued GPU counts that could consume remaining room, or a job list that is no longer current, prevent a "Likely" estimate. An unlimited room is unaffected by queued demand, even when its GPU count is unknown. Model-specific limits count the matching queued GPUs; generic limits count all models. "Room used by queue" shows the reduction in available headroom across these limits, rather than the total GPUs requested by all queued jobs. Kubernetes resource-quota usage already includes admitted pending pods, so those queues are not subtracted again. The best-estimate card is the first table row, and appears only for likely or possible options. Within a verdict, options sort by fitting on one node, room after the queue, free GPUs, then verified access.
  If an eligible pending job waits on a personal-limit reason even though its known GPU request fits the collected headroom, a "Likely" estimate becomes "Possible". The explanation names the job and scheduler code: the scheduler may count differently or enforce limits that were not collected. This does not assert that the new request will wait. Larger limit-held jobs do not trigger this cap; stale jobs, unknown relevant counts or models, and Kubernetes resource quotas do not supply contradiction evidence. If any finite per-model GPU cap exists, GPU-limit evidence must name exactly the requested model. Job-count and submit-count waits (`QOSMaxJobsPerUserLimit`, `QOSMaxSubmitJobPerUserLimit`, `AssocMaxJobsLimit`, `AssocMaxSubmitJobLimit`) still cap the estimate when QoS count limits are missing or unlimited. Association limits are separate from QoS limits and are not collected; a wait can also reflect an uncollected partition QoS limit. Any collected jobs or submit rule already at its limit prevents contradiction evidence. Zero-GPU GRES waits and CPU-limit waits are not used because their resource headroom is not evaluated. CPU-only running jobs consume no model-specific GPU headroom. The queue column uses short translated reason-class labels and keeps the raw code on hover; unrecognised reasons remain visible as reported.
  Sources with the same cluster and username share one option per QoS, preferring current QoS-limit data, then current job data, then the latest successful collection. Jobs attributed to either current twin are counted once, using their newest observation, even when the retained QoS source's job list is not current; an empty twin QoS list adds no extra row; different usernames remain separate options.

  若同一登录、同一 QoS 的可调度等待作业因个人配额受限，而已知 GPU 请求仍能放入采集到的余量，“很可能”会降为“可能”。说明列出作业和调度器原因码，提示调度器计数可能不同，也可能存在未采集到的限制，不保证新作业一定等待。超过余量的作业不触发此规则；过期作业、相关数量或型号未知的数据以及 Kubernetes 资源配额不作为矛盾证据。存在有限的型号 GPU 配额时，GPU 限制作业必须具有与请求一致的单一已知型号。作业数和提交数等待（`QOSMaxJobsPerUserLimit`、`QOSMaxSubmitJobPerUserLimit`、`AssocMaxJobsLimit`、`AssocMaxSubmitJobLimit`）在 QoS 计数上限缺失或无限制时仍会降低估计。关联限制独立于 QoS 限制且未被采集，等待也可能来自未采集的分区 QoS 限制。若已采集的任一作业数或提交数规则已达上限，则不提供矛盾证据。零 GPU 作业的 GRES 等待和 CPU 限制等待不触发矛盾提示，因为对应资源的余量未计算。纯 CPU 运行作业不占用特定型号 GPU 配额。排队列对已识别的原因显示简短分类标签，悬停可见原始代码；未识别的原因直接显示调度器原文。同一集群和用户名的重复连接按 QoS 合并，优先保留 QoS 配额数据当前有效的来源，其次比较作业数据是否当前有效，最后比较最近成功采集时间；两条连接的当前作业按最新观测去重，即使保留的 QoS 来源没有当前作业列表也会使用另一条连接的当前作业，空 QoS 列表的重复连接不再增加额外行，不同用户名保持独立。

- **Why this estimate** expands on every Where-to-run option, including options without access. Seven factors show free usable GPUs, the most measured free GPUs on one node versus the request, your GPU limit and use (plus binding or unchecked scheduler rules), your eligible queue, maximum run time, access verification and data age. Each factor names its source login, capability (nodes, limits, jobs or access) and observation age, with the absolute timestamp formatted in the viewer's locale and local time, visible on phones too. Node evidence follows the deduplicated node rows, even when another login collected them; job evidence follows the merged login snapshots. Missing timestamps stay unknown. Limits and access use the source's last successful collection time, the timestamp available in the current contract. Stale or unavailable capabilities are labelled and their retained values do not become current estimates.
  Factors state whether they support or lower the estimate, remain unknown, or leave the verdict unchanged. An exhausted GPU limit lowers the limit factor even when another rule is unknown; the queue lowers the estimate only when it takes the available room or contradicts the collected limits. Data age reflects source freshness, not capabilities the driver does not offer. Current degraded or unavailable cluster states are explained in the free-GPU factor and lower the estimate. Single-node fit only affects ranking. Maximum and requested run times use the same duration formatting as the table, rounding hours to one decimal place. A missing requested or maximum run time is explicitly unchecked and does not cap the verdict, preserving the existing calculation. The best-estimate card compares its first differing sorting factor with the next visible option: verdict, single-node fit, room after your queue, free GPUs, then verified access. Equal factors are described as a tie broken by display order; no advantage is invented. There is no comparison when only one visible option exists. These explanations add no collection calls or scheduling actions.

  **为什么这样估计**可在每个“在哪里运行”选项中展开，包括无权限选项。七项因素展示可用节点上的空闲 GPU、单节点已测得的最多空闲 GPU 与请求的比较、个人 GPU 上限和用量（以及生效或未能核对的调度规则）、个人可调度队列、最长运行时间、权限验证与数据时间。每项列出实际来源登录及观测时间，绝对时间使用查看者的语言格式和本地时区，手机上也直接显示。节点来源跟随去重后的节点记录，作业来源跟随合并后的登录快照；缺失的时间保持未知。上限和权限使用当前接口提供的最近成功采集时间。过期或缺少能力的数据会标明状态，保留的旧值不会变成当前估计。
  每条来源说明标明节点、上限、作业或访问权限，区分同一登录的不同观测时间。因素会说明支持、降低估计、未知或不改变判断。GPU 余量不足时，即使其他规则未知，上限因素仍会降低估计；只有队列占去可用余量或与已采集的限制矛盾时，队列因素才会降低估计。数据时间只反映来源是否当前有效，不把驱动未提供的能力当成数据过期。节点数据当前有效但集群降级或不可用时，空闲 GPU 因素会说明原因并降低估计。单节点容纳能力只影响排序。最长与请求运行时间使用和表格一致的时长格式，小时数四舍五入到一位小数；请求或最长运行时间未知时明确表示未核对，不会降低判断。最佳估计卡与下一个可见选项比较首个不同的排序因素：判断、单节点容纳能力、队列后余量、空闲 GPU、已验证权限。所有因素相同时明确表示并列，仅按显示顺序排列；只有一个可见选项时不作比较。这些说明不增加采集调用，也不执行调度操作。

- **Utilization** is a percentage, separate from allocation. GPU utilization is weighted by the number of GPUs observed, and the coverage figure reports how many GPUs contributed. CPU and memory utilization are simple means of available samples, not weighted by cores or RAM. Samples come from current running jobs and reachable SSH readings less than twelve minutes old; missing samples are left out, not treated as idle. Machines with monitoring off do not contribute. An instance reading covers the visible host, which can include more than the container. The twenty-minute rule for a hand-added machine's allocation does not extend the twelve-minute utilization window.
- **History** uses the same server allocation and utilization figures as Overview and Usage. Periods without data stay empty. Older points stay unchanged; excluding unmonitored machines can create a step at upgrade.
- **Jobs counts** include only current jobs from enabled logins. If an enabled login lacks a current list, the count is partial. Last-known jobs remain visible as stale rows but do not increase the current count. The navigation badge and unfiltered Jobs count use the same server selection.
- **Prices** are estimates from known hourly prices, not bills. Held instances show their hourly price; not-held instances do not. Unknown and transitional states retain the existing price display until fuller cost accounting is added; a price alone does not establish allocation. Currencies are never added together.

## Scope and freshness

Job allocation and queue figures cover the configured logins, not every cluster
user. Node capacity and node allocation cover the visible scheduler inventory
across all users. A load reading such as “12 / 32 usable GPUs allocated” therefore
has a different scope from your GPUs-in-use tile. Unrecognized node states make
usable capacity partial (`≥ n`); missing node data displays `—`.

A source is current when enabled, successfully collected, in a ready or collecting
state, without an error or stale flag, and with the capability needed by the figure.
Data becomes stale after the collection interval plus 10% and two minutes of grace.
The topbar age still uses the oldest success even when a source is failing. With no
enabled sources it reads “No sources connected”. Example mode uses the same
health severity rules for its fictional sources; the example banner identifies the mode.
An SSH check has its own timestamp and does not refresh the provider's listing.

Browser polling is separate from collection: hidden tabs pause requests, unchanged
dashboards reuse the previous response, and returning to a tab triggers one refresh.
After Refresh or adding a source, faster polling stops when the requested sources finish,
or after sixty seconds. Completed machine checks and manual additions reload once.
These actions do not turn retained observations into new measurements. Example timestamps
advance once per minute. Once an authenticated dashboard reports no sources, the health
panel’s “Add source” button opens the add-source dialog directly; it is hidden in example mode.

浏览器轮询与采集相互独立：隐藏标签页暂停请求，未变化的仪表盘复用先前响应，
返回标签页时刷新一次。刷新或添加数据源后，快速轮询在目标数据源采集结束时停止，
最长持续六十秒。机器检查完成或手动添加机器后只重新加载一次。
这些操作不会把保留的观测变成新测量。示例时间每分钟更新一次。
通过身份验证且仪表盘已加载并确认没有数据源时，健康面板的“添加来源”按钮直接打开添加对话框；示例模式下隐藏该按钮。

## Machine checks / 机器检查

Editing a hand-added machine or importing its configuration keeps its last SSH check
and measurements when the host, port, username, identity file and alias mode are unchanged.
Renaming it, changing its price or switching monitoring does not erase the check. Changing
its connection clears the check and readings until it is checked again. GPU inventory
fields supplied in the form or import still take effect.

“Recently reachable” uses the SSH check time (`last_probe_attempt`), never a provider's
listing time. A missing check time is unknown. SSH sources record this time when they
successfully check the machine during collection.

Machine checks have two concurrent slots separate from source collections. A timeout or
closed or reset SSH connection is retried once after two seconds. Authentication, host-key,
unreachable-network and refused-connection failures have specific guidance and are not
retried automatically. Remote command failures (SSH exit status other than 255) retain
their detail as a generic error, without connection guidance or retries. Unknown errors
remain generic. A first transient failure is not
saved as a failed check while its retry is pending.

编辑手动添加的机器或导入配置时，如果主机、端口、用户名、密钥文件和别名模式未改变，
会保留上次 SSH 检查和测量。重命名、修改价格或切换监控不会清除检查；连接设置改变后，
检查和测量会清空，直到再次检查。表单或导入中的 GPU 数量与型号仍会生效。

“最近可连接”使用 SSH 检查时间（`last_probe_attempt`），不使用云平台的列表更新时间。
缺少检查时间表示未知。SSH 数据源在采集时成功检查机器后也会记录该时间。

机器检查使用独立于数据源采集的两个并发名额。SSH 超时、连接关闭或重置后，等待两秒重试一次。
认证失败、主机密钥验证失败、网络不可达及连接被拒绝都有具体指引，不会自动重试。
未知错误保留通用说明。在重试期间，不会将第一次瞬时故障保存为检查失败。
远程命令失败（SSH 退出码不是 255）保留原始详情并使用通用错误说明，不提供连接指引或重试。

## Upgrading from 0.3

Older history points are not recalculated. New points count provider-reported
running instances, use measured allocation for hand-added machines and exclude
machines with monitoring off. These changes can produce a step at the upgrade;
they do not by themselves indicate a workload change. The age can also appear older
because it now follows the oldest enabled source instead of the newest one.

## Needs attention

The Overview tile, navigation badge and attention panel count the same server list of
unmuted items. The first collection failure appears as a warning; two consecutive
failures or stale data make it an error. Stale data becomes an error after three
collection intervals. Built-in drivers classify cluster availability using the
node-health rule over GPU-capable nodes (positive or unknown GPU counts), so healthy
CPU-only nodes cannot hide a GPU outage. One item per cluster uses the worst state
reported by its current logins. Source-failure and stale-data items replace retained
cluster faults and collection warnings. A capability warning counts only when the source
has delivered that capability before; permanent gaps stay on Sources. Other warnings are
all included. Unchecked connections and machines with monitoring off do not produce
attention items; failed SSH checks on monitored machines and provider instances do.
Disabled sources and plugins do not produce items. Disabling or re-enabling a source
clears its collection error and retry count while preserving retained observations and
capability history. It clears `last_success` so the next collection establishes a silent
event baseline. Retained inventories do not override the cluster state reported by the
latest collection.

Rows link to diagnosis (the last error and an explicit Test connection button), the
instance, service health, Toolbox or Notifications (channel delivery warnings). Their
times use existing observations: `since` is the last successful collection for a failing
or stale source: no good data has arrived since then. It is null for all other cases.
`observed_at` records the latest observation, shown as "Last seen": the collection that
observed a source condition, the latest failed attempt for a source that never
succeeded, an SSH check, or a background error report. Repeated observations do not
imply a new incident onset. Unreadable rows and plugin health errors have neither time.
Attention is derived on every dashboard read without an additional collection request.
Acknowledge keeps an item quiet until its cause or severity changes. Snooze keeps it
quiet for one hour or until the next midnight in the service host's timezone; a changed
cause or severity also ends a snooze early. Names, observation times and free-text error
output do not reopen items. A resolved item loses its saved acknowledgement after the
next collection, machine check, attention action, source or machine edit/removal, or
tool update. Unreadable acknowledgement rows are discarded during the same cleanup;
dashboard reads never delete saved state.

The tile, badge and panel count only unmuted items. Muted items remain in the collapsed
"Acknowledged (N)" group with Unmute and their snooze expiry, when applicable. This
state is saved on the service and shared by all viewers. The health pill still reports
source health. Background-task faults and unreadable rows cannot be muted. Example data
shows acknowledged and snoozed items, but its controls cannot change saved state.

确认会让待处理项保持静默，直到原因或严重程度发生变化。暂缓可持续一小时，或持续到服务主机
时区的次日零点；原因或严重程度变化也会提前结束暂缓。名称、观测时间和错误输出文本变化
不会重新提醒。问题解决后，下次采集、机器检查、待处理项操作、数据源或机器的编辑/删除，
或工具更新会清除其已保存的确认状态。无法读取的确认记录也会在清理时删除；读取概览不会删除保存的状态。

概览卡片、导航徽标和面板只统计未静默的项目。静默项目保留在默认折叠的“已确认（N）”中，
可恢复提醒，并显示暂缓截止时间。状态保存在服务端，所有查看者共享。健康状态标记仍反映
数据源健康状况。后台任务故障和无法读取的数据行不能静默。示例数据包含已确认和暂缓项目，
但其中的控件不能修改保存的状态。

Follow-up: classify `gpu_count_unknown`, `partitions_unavailable` and
`instances_skipped` as driver capability checks or coverage-only conditions.
They currently count as partial data, including when the gap is permanent.

## Job times / 作业时间

Submitted and started times are shown when the scheduler reports them. Times with an
explicit offset are displayed in the viewer's timezone; times without an offset stay
labelled as scheduler time. A pending Slurm start estimate is not an actual start.
For pending jobs, waiting time runs from submission to the last observation, not the
current clock, so an old sample never implies that the job is still waiting. Missing or
unreliable times stay unknown. Historical job drawers hide unknown submitted, started
and waiting values rather than inventing them.

调度器报告提交或开始时间时，界面会显示这些时间。带时区偏移的时间转换为查看者所在时区；
没有偏移的时间保留“调度器时间”标注。Slurm 排队作业的预计开始时间不视为实际开始时间。
排队作业的等待时长从提交时间计算到最后一次观测，不延伸到当前时刻，因此旧数据不会暗示作业仍在等待。
缺失或不可靠的时间保持未知；历史作业详情隐藏未知的提交、开始及等待时间，不进行推测。

## Job lifecycle and Activity

Activity shows one reconciled ending per job attempt, with a scheduler outcome where
available. Jobs that start and end between collections can be found in terminal history.
A job leaving the queue is not assumed successful: sources without accounting say that
they do not report outcomes. With history, an unmatched departure waits for the next successful accounting
collection before being reported as unknown, bounded by 24 hours during an outage. A later accounting row does not announce it twice.

End times with offsets are displayed in the viewer's timezone; the hover text states
how many minutes later ComputeDeck observed the ending. Without a reliable end time,
the event is labelled as an observation. Activity sorts the fetched page by event time.
The Failed tab still reads the existing 24-hour failure list. Kubernetes container
failures remain in that list while a pod is running. When the pod disappears without a
terminal record, its last observed container failure supplies the ending, unless it
predates the job start. A reported terminal outcome takes precedence. Container failures
also retain their `job.failed` notifications while the pod is running or when it later
succeeds. Pre-upgrade Activity rows remain visible alongside new endings.

After an observation gap, completed, cancelled and unknown endings remain visible and
deliverable; Notify groups catch-up messages. Only the upgrade baseline stays silent.
When accounting cannot cover the full unobserved period, unknown outcomes explain that
lookback limit instead of implying the scheduler has not reported the job.

中文：动态为每次作业结束显示一条记录，优先使用调度器报告的结果与带时区的结束时间。
没有记账能力时会明确说明结果不可用；有历史能力时等待下一次成功的记账采集，记账中断期间最多等待 24 小时。悬停可查看观测延迟，
未知结束时间不会伪装成精确时间。失败标签页仍保留原有的 24 小时失败记录。
Kubernetes Pod 运行期间的容器失败保留在失败列表中；Pod 消失且没有终态记录时，使用此前观测到的容器失败作为结果，但不使用早于作业开始的失败。已有终态记录优先。
Pod 运行中或最终成功时，此前的容器失败仍产生 `job.failed` 通知；升级前的动态记录继续显示。
观测中断后的完成、取消和未知结果仍可见并发送通知，由任务提醒合并补收消息；仅升级基线保持静默。
记账窗口无法覆盖完整空档时，未知结果会说明历史查询范围的限制。

## Exploring activity / 浏览动态

Open **Activity** from the sidebar, or **All activity** on Overview or Jobs. Choose
Failed, Jobs, Sources, Gaps, My changes or Plugins; Plugins currently shows changes to
tool switches and settings. Scope by cluster/platform, search names and job IDs, and choose
24 hours, 7 days or 30 days. Filters are kept in the URL. A job's **All activity for this
job** link uses `job_filter` on the page (the existing `job` URL parameter still opens a
live-job drawer). Search ignores case for ASCII letters; other characters match exactly.

Rows are grouped by day, with absolute times on hover. Expand a row for recorded state,
exit code, nodes, elapsed time and translated errors. End times use your local timezone
when an offset is known; otherwise they are labelled as scheduler time. Open the live job
if still listed, otherwise its immutable event snapshot; connections and existing machines
have their own links. **Load older** pages back without splitting collection groups. New
arrivals appear behind an **N new** button until you choose to refresh. Loading, fetch
errors with Retry, an empty history and filters with no matches are shown separately;
errors retain the last successfully loaded rows. If there is no activity in the selected
24-hour or 7-day range, **Show 30 days** widens the range. **Clear filters** removes type,
search, job and scope filters and returns to the default 24 hours, wherever you click it.
Time ranges use the event's own time: a late-observed job ending outside the range will not
appear in that view or its **N new** button. Overview's teaser has no time-range filter.

Overview shows up to five recent changes, with failures and connection problems or
recoveries first. **Mark seen** marks the current activity as read; the teaser then shows
changes that arrive afterward, under **Since you last looked**. Before the first mark,
the heading is **Activity**. Opening Activity does not mark anything seen. Read state
stays in this browser and is not shared with other viewers. Without browser storage,
the teaser shows recent activity and hides the read controls. Example mode also shows
recent activity without reading or changing your read state. The Jobs Failed tab still
includes failures found during the first collection, which do not appear in Activity.

中文：从侧栏进入**动态**，或点击概览及作业页的**全部动态**。可按失败、作业、来源、观测空档、
我的更改、插件筛选；插件目前显示工具开关和设置的更改。支持集群或平台范围、名称及作业 ID 搜索，
以及 24 小时、7 天、30 天范围，筛选保存在 URL 中。作业动态链接使用 `job_filter`，
原有 `job` 参数仍用于打开实时作业抽屉。搜索忽略 ASCII 字母的大小写，其他字符按原样匹配。

动态按日期分组，悬停可查看绝对时间。展开后显示已记录的状态、退出码、节点、运行时长及翻译后的错误。
已知时区的结束时间显示为本地时间，否则标注为调度器时间。
仍在列表中的作业打开实时详情，其余打开事件快照；存在的连接和机器也有详情链接。**加载更早的动态**
不会拆分采集合并组，新动态通过按钮提示，点击后才刷新列表。加载中、加载失败并重试、历史为空及筛选无匹配
分别显示，失败时保留上次成功加载的内容。所选的 24 小时或 7 天内没有动态时，点击**查看 30 天**可扩大范围。
两处**清除筛选**都会移除类型、搜索、作业和集群或平台筛选，并恢复默认的 24 小时。
时间范围按事件自身的时间筛选：延迟观测到的作业结束若不在范围内，不会出现在该视图或新动态按钮中。
概览摘要不按时间范围筛选。

概览最多显示五条最近动态，优先显示失败及连接故障和恢复。**标为已读**将当前动态标记为已读，
此后摘要显示新到达的动态，并使用“自上次查看以来”标题；首次标记前标题为“动态”。
打开动态页不会自动标记。已读状态仅保留在当前浏览器，不与其他查看者共享。
浏览器存储不可用时，摘要显示最近动态并隐藏已读控件。示例模式同样显示最近动态，不读取或更改你的已读状态。
作业页的失败标签仍包括首次采集发现的失败，这些记录不会出现在动态中。

## Observation gaps / 观测空档

Activity shows grey rows with absolute times when job sources go unobserved long enough
to risk missing history. The row gives the full interval between observations. When a
known history window does not cover it, a second sentence says which earlier failures
could not be checked. Unknown windows and unavailable history never imply complete
coverage. Slurm and PBS check 24 hours; LSF is limited by its readable `CLEAN_PERIOD`
(at most 24 hours); Kubernetes cannot recover deleted pods. Collection lookbacks and
the Failed tab are unchanged. Normal daily scheduling does not produce a gap each day.
With a known history window, a gap must exceed the largest of the window minus one
hour, one collection interval plus 15 minutes, and one hour. For example, a daily
source produces a row after 24 hours 15 minutes; a one-hour window with a 10-minute
interval produces one after an hour. Unknown or unavailable history instead requires
a gap longer than both one hour and two collection intervals.

A separate row says that ComputeDeck was not running or the computer was asleep when
more than five minutes pass between service heartbeats. Source gaps covered by that
service gap are suppressed unless a known history window leaves part of the unobserved
period unchecked. In that case the source warning remains alongside the service gap.
An unknown history window adds no coverage boundary, so the covering service gap is shown
alone. These are Activity records, never Notify alerts; plugins must explicitly subscribe to `source.gap` or `service.gap`. Cloud and SSH-host sources
do not produce source gap events.

中文：作业来源长时间未被观测时，动态显示灰色空档记录，并以绝对时间标明两次观测之间的完整区间。
如果已知的历史窗口无法覆盖该区间，会补充说明哪个时间之前的失败记录无法检查。
历史窗口未知或本次历史采集失败时，不会暗示记录完整。Slurm 和 PBS 检查最近 24 小时；
LSF 受可读取的 `CLEAN_PERIOD` 限制，最多 24 小时；Kubernetes 无法恢复已删除的 Pod。
采集回溯范围与失败标签页保持不变，正常的每日采集不会每天生成空档记录。
历史窗口已知时，空档必须超过以下三者中的最大值：历史窗口减一小时、一个采集间隔加 15 分钟、一小时。
例如，每日采集的来源超过 24 小时 15 分钟后才显示空档；历史窗口为一小时且每 10 分钟采集时，超过一小时后显示。
历史窗口未知或历史不可用时，空档必须同时超过一小时和两个采集间隔才会显示。
服务心跳间隔超过五分钟时，会单独说明 ComputeDeck 未运行或电脑处于睡眠状态，
被服务空档覆盖的来源空档通常不再单独显示；如果已知记账窗口无法覆盖完整的未观测区间，
仍保留来源空档以说明无法检查的历史。窗口未知时没有额外的覆盖边界信息，仅显示覆盖该区间的服务空档。
这些记录只出现在动态中，不触发 Notify 通知；
插件需明确订阅 `source.gap` 或 `service.gap`。云来源和 SSH 主机不生成来源空档事件。

## Understanding a failure

Failure rows open the job drawer. The Result column shows how long the attempt ran;
Ended is relative, with the absolute time on hover, only when its timezone is known.
Old records without an offset keep their labelled scheduler time. The drawer distinguishes
"What happened" (a scheduler-reported cause and its verbatim reason) from "Likely" hints.
Signal 9 supports the SIGKILL hint; status 127 supports command not found. Each hint shows
its evidence; hints are suppressed when a scheduler reason is present. Statuses 1–125
remain factual program exits even with a reason, PBS negative codes are scheduler codes,
and other raw codes remain unexplained. Exit 137 alone is never treated as proof of OOM.

The drawer shows ran-for versus time limit and the log path when supplied; missing values
are not inferred. Slurm reads the accounting time limit, PBS reads requested walltime
and the output path (including any host prefix), and Kubernetes reads the pod deadline.
LSF limits and log paths remain unavailable; Slurm does not query version-sensitive
stdout/stderr fields. Failure cards retain a "Next step" below the explanation.
A copy-only inspection command (`sacct`, `qstat -fx`, `bhist -l`, or `kubectl describe pod`)
helps inspect those details on the matching cluster or Kubernetes context. ComputeDeck
never runs it. Unknown outcomes on clusters without history do not offer an inspection
command. History freshness is labelled "Failure history updated".

Job rows in Activity, including expanded group children, open an event snapshot addressed
by `?event=<id>`. Links remain usable after the attempt leaves the 24-hour failure list,
within event retention. Event snapshots hide utilization meters. Legacy `job.ended` records
and unknown `job.finished` outcomes say "Last seen …; ended between collections", using
the job snapshot's observation time separately from "Event observed". The latter uses
the event's `data.observed_at`, or its `at` collection time for legacy records. Unknown outcomes
also keep their reason for being unknown. Missing or expired events show an unavailable drawer.

中文：失败记录可打开作业详情；结果列显示运行时长。只有已知时区的结束时间才显示相对时间，
悬停显示绝对时间；旧记录仍标注为调度器时间。“发生了什么”区分调度器报告的原因、原始原因文本
和附有依据的“可能原因”。只有信号 9 才提示 SIGKILL，状态 127 提示找不到命令；已有调度器原因时不显示推测。
1–125 是程序退出状态，即使有原因文本也保留该事实；PBS 负值属于调度器代码，其余退出码不作解释。仅凭 137 不推断内存不足。
已提供时才显示运行时长与时间限制、日志路径：Slurm 读取记账时间限制，PBS 读取申请的运行时限
及输出路径（保留主机前缀），Kubernetes 读取 Pod 截止时长。LSF 暂不读取限制与日志路径；
Slurm 不查询依赖版本的标准输出或错误路径字段。失败解释下方保留“下一步”建议。
检查命令只复制、不执行，请在对应集群或 Kubernetes 上下文中运行。没有历史能力的集群，其未知结果不提供检查命令。历史新鲜度标为“失败历史更新于”。
动态中的作业记录（含展开的分组子项）通过 `?event=<id>` 打开事件快照，在事件保留期内不受
24 小时失败列表限制。快照不显示利用率仪表；旧的结束事件和未知结果均标注作业快照的最后观测时间与
“在两次采集之间结束”，与“事件观测时间”分开显示。后者使用事件的 `data.observed_at`，旧记录则使用 `at` 采集时间。
未知结果还保留其原因。已过期或不存在的事件显示不可用提示。

## Job arrays

Jobs and Overview group two or more listed elements with the same cluster and array id
into one row. Filtering by tab, cluster or search happens first, so a summary includes only
the matching elements; a single matching element remains an ordinary job row. Searching
matches the array id as well as element ids. Overview takes its first eight rows after grouping.
Tiles, navigation badges, tabs and panel counts still count elements using the server summary.

The array row shows nonzero running (including configuring and completing), pending and other
counts, queue or QoS and partition (`mixed` when they differ), and the most common reported pending
reason plus the number of other reported reasons. Missing reasons are not counted. GPUs held sum
only elements holding an allocation: a missing GPU count makes the result `≥ N`, or `—` if no
positive subtotal is known. Pending requests are not
held GPUs. Any stale element marks the array as last-known, and the row shows its oldest
observation time. CPU and elapsed totals are not inferred; inspect the individual elements.

Click or press Enter on an array row to open its `?array=<cluster>:<array_id>` drawer.
It lists all currently listed members of that array, independently of the page filters,
including retained last-known jobs. Shared cluster, user, queue or QoS and partition facts
appear once above a compact element table (`mixed` for differing values, `—` for unknowns).
The drawer uses the scheduler's terms: Partition and QoS for Slurm, or a single Queue for PBS and LSF.
Each row shows the element index and full job id, state, allocated or requested GPUs,
node or pending reason, run or wait time, and a stale tag when needed.
The first 50 are shown, with **Show next 50** and
**Show all** controls. Opening an element uses its existing job drawer; Back returns to the
array. The drawer follows membership on each poll, and explains when the array is no longer
listed. It does not run scheduler commands. The Failed table lists array elements individually.

作业页和总览把同一集群、同一数组中至少两个已列出的元素合并为一行。先按标签、集群和
搜索条件筛选，再分组，因此摘要只包含匹配的元素；仅匹配一个元素时仍显示普通作业行。
搜索同时匹配数组 ID 和元素 ID。总览在分组后取前八行。卡片、导航徽标、标签和面板的
计数仍按元素计算，使用服务端汇总。

数组摘要显示数量非零的运行中（含配置和收尾）、等待中及其他状态、队列或 QoS、分区
（不同则显示“混合”），以及最常见的已报告等待原因和其他已报告原因的种类数，不计入缺失原因。
GPU 占用仅汇总已占用资源的元素；部分数量未知时显示 `≥ N`，没有已知的正数小计时显示 `—`，不会把等待请求当成
占用。任一元素过期时整组标记为上次已知状态，观测时间取最早值。CPU 和运行时长不推算总数，
可查看单个元素。

点击数组行或按 Enter 可打开独立的 `?array=<cluster>:<array_id>` 抽屉。抽屉不受页面筛选
条件限制，列出当前已列出的全部成员（含保留的上次观测作业）。集群、用户、队列或 QoS 和分区
只在紧凑元素表上方显示一次，值不同时显示“混合”，未知时显示 `—`。抽屉使用调度器自身的术语：
Slurm 显示“分区”和“QoS”，PBS 和 LSF 仅显示一个“队列”。每行显示元素索引及完整作业 ID、
状态、占用或请求的 GPU、节点或等待原因、运行或等待时长，以及必要的过期标记。
先显示 50 个，可“再显示 50 个”
或“显示全部”。打开元素进入原有作业抽屉，返回可回到数组。每次轮询更新成员，数组不再列出时
明确提示；不执行调度器命令。失败表目前逐个列出数组元素。

## Activity collection groups / 动态采集合并

Activity collapses three or more events of the same type and source collected together.
Expand a row to see up to 50 events, prioritizing failures, then unknown outcomes,
then other events (newest ID first within each class), followed by “and N more”
for larger groups. Totals, names, outcome counts, failure indicators and time ranges
cover the entire group, with failures first and a red dot if any child failed. Known job times
always take precedence: children retain their own end/start times, and a group whose
children all have known times shows their first-to-last range. Only children without a
known time use the previous-success-to-observation window after a gap; a group containing
such children also shows that window. Equal range endpoints display a single time.
Unknown times keep their observation-time labels, including on group rows when any
child lacks its own time, even without a collection gap. Grouping does not change job
or failure totals.

动态将同一来源、同一类型、同一轮采集中的三个及以上事件合为一行，展开后可查看最多
50 个事件及结果，依次优先显示失败、未知和其他结果，同类按事件 ID 从新到旧排列，更多事件显示为“另有 N 个事件”。合并行的总数、名称、结果数量
（失败优先）、失败标记及时间范围仍涵盖全部事件，含失败事件时显示红点。
已知作业时间优先：子事件显示自身结束或开始时间；全部子事件时间已知时，合并行显示
最早至最晚时间。只有时间未知的补收事件及包含这些事件的合并行，才显示上次成功采集
至本次观测的区间；区间起止相同时只显示一个时间。未知时间保留观测时间标注；
只要任一子事件自身时间未知，合并行也显示该标注，即使没有采集中断。
合并展示不改变作业数或失败总数。

## Your changes / 你的更改

Recent activity includes successful changes you make in ComputeDeck: adding, editing,
pausing, resuming or removing sources; adding, editing or removing collection machines
and hand-added machines; switching tools on/off or saving their settings; and importing
configuration. These are grey rows, separate from job outcomes and collection gaps. A
source change scrolls its Sources group into view while that source still exists, keeping
all groups visible; removed sources have no link. The recorded name is the name at the
time of the action. Installed tools use their current localized name; removed tools keep
the recorded name. Saving unchanged source, machine or tool settings produces no row.

Records contain changed field names, never their values; tool settings omit even the
field names. Edited rows show raw changed field names, never values; pause/resume rows
show any other changed fields except `enabled`, while added, removed, tool and import
rows show no field list. Imports produce one summary with counts. Pausing and immediately resuming
keeps both records. These records are kept for 30 days and never trigger notifications or
plugin handlers. Language and server-name preferences do not produce records. Activity
requests `include=changes`; API event lists omit them unless requested explicitly.

最近动态会显示你在 ComputeDeck 中成功保存的更改：添加、编辑、暂停、恢复或移除数据源；
添加、编辑或移除采集机器和手动添加的机器；开启、关闭工具或保存工具设置；以及导入配置。
这些灰色记录与作业结果、采集空白分开显示。数据源仍存在时，更改记录会滚动到对应的数据源分组，同时保留其他分组；
已移除的数据源不再显示链接。名称保留为操作发生时的名称。
已安装的工具使用当前语言的名称；已卸载的工具保留记录时的名称。保存未更改的数据源、机器或工具设置不会产生记录。

记录只包含更改的字段名，不包含字段值；工具设置连字段名也不记录。
编辑记录显示更改的原始字段名，不显示字段值；暂停或恢复记录只显示 `enabled` 之外的更改字段，
添加、移除、工具和导入记录不显示字段列表。每次导入只生成一条带数量的摘要。
暂停后立即恢复会保留两条记录。这些记录保留 30 天，不会触发通知或插件处理程序。
语言和服务器名称偏好设置不产生记录。动态面板会请求 `include=changes`；API 默认不返回这些记录。

## Notification delivery / 通知发送状态

Notifications refreshes its recent-message log about every 30 seconds while the page is
visible and the tool is on. A configured channel whose latest recorded attempt in the
last 24 hours failed appears as a Notifications warning in Needs attention, with its
channel label and last error code. Pending retries count too. Opening the warning goes
to Notifications. A later successful attempt or test clears the warning; switching the
tool off hides it. The time shown is the last failed attempt, not when the problem began.

Activity shows recorded notification outcomes beside the event: Sent, Failed, Suppressed,
Grouped or Dropped. Grouped means included in a digest, not delivery success; mixed
outcomes can mean different rules or channels. Channel delivery results are shown on
the digest leader and aggregate row; siblings show Grouped rather than implying each
had a separate message. Suppressed siblings retain the rate-limit status. Outcomes use the retained 500-row log,
so a missing label means unknown. Activity reads these outcomes when it loads the rows;
Notifications has the automatically refreshed delivery log. Example mode shows fictional
outcomes and a failing Team alerts channel, without reading live deliveries.

中文：任务提醒页面在可见且工具开启时，约每 30 秒刷新近期消息。已配置渠道在最近 24 小时内的
最后一次发送尝试失败时，待处理列表显示带有“任务提醒”标签的警告，列出渠道名称和最后的错误代码，
等待重试的失败也包括在内。点击警告进入任务提醒页面；之后发送或测试成功会清除警告，关闭工具会隐藏它。
显示的时间是最后一次失败尝试的时间，不代表问题开始时间。

动态在事件旁显示已记录的通知状态：已发送、失败、已抑制、已合并或已丢弃。已合并表示包含在摘要中，
不代表发送成功；多个结果可能来自不同规则或渠道。摘要首条事件和汇总行显示消息发送结果，
其余事件仅显示“已合并”，避免误以为每个事件都单独发送了消息；限流事件仍显示“已抑制”。状态来自保留的最近 500 条日志，未显示状态表示未知。
动态加载记录时读取这些状态；任务提醒页面的发送日志会自动刷新。示例模式使用虚构状态和发送失败的
Team alerts 渠道，不读取真实发送记录。

### Per-GPU SSH availability / SSH 单卡可用状态

Machine drawers show Free, Busy, Busy (processes not visible), or Unknown for each GPU,
with memory, utilization, and up to two owners with process counts and memory. Unknown
memory is shown as `—`, just like unknown utilization. Owners sort by memory (unknown last),
then process count. Owner totals cover only the shown processes when the 16-process
cap is reached; PIDs are not displayed. The section uses its own `gpus_observed_at`,
which probes never refresh. Older samples without a timestamp say “Sample time unknown”.

Where to run has a separate Machines panel for running SSH-source instances with GPU samples
no older than twice the collection interval. Missing instances are excluded. Only `in_use: false`
counts as free. Unknown states or models keep free counts as lower bounds, with the missing count stated. Rows sort by
known free GPUs and are muted when fewer than requested are known free. Model filtering
includes machine models; machines with no matching GPU are hidden with a count note, while
unknown models remain visible. Copy-only SSH and NVIDIA CUDA settings select known-free indexes
in ascending index order, up to the requested count; fewer free GPUs means fewer selected,
with both counts stated on the copy button.
A separate count note identifies machines hidden because their GPU sample is missing or too old.
The copied setup is one command: `ssh -t 'lab-server' 'export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=2; exec "${SHELL:-sh}" -l'`.
Pasting it opens an SSH shell with the selected GPU settings; run your command in that shell.
Copying runs nothing and reserves no GPU. SSH hosts
do not appear in the paid-cloud idle list. Hand-added machines do not yet retain per-GPU data.

机器抽屉逐卡显示空闲、使用中、使用中但进程不可见或未知，以及显存、利用率和最多两位
用户的进程数与显存。未知显存与未知利用率统一显示为 `—`。用户按显存用量（未知排最后）、
进程数降序排列。可见进程或空进程列表下达到 max(1024 MiB, 总显存的 5%) 的用量
表示使用中；只有空进程列表且已知显存低于阈值才是空闲。进程不可读，或没有可见进程且
显存未知时，状态保持未知。任一卡未知都会使机器的总使用量未知。每卡最多保留 16 个进程，
超出时说明用户合计仅覆盖已显示的进程；不显示 PID。单卡列表使用独立采样时间，探测不会刷新它。
旧采样缺少时间戳时显示“采样时间未知”。

“在哪里运行”的机器面板仅采用运行中 SSH 来源实例最近两个采集周期内的有效单卡采样，
不再报告的实例不参与比较。未知卡不计为空闲，空闲数标为下界并说明未知数量。按已知空闲卡数排序，不足请求数量时淡化显示。
型号筛选包含机器型号；没有匹配 GPU 的机器隐藏并汇总数量，型号未知的机器仍然显示。
SSH 和 NVIDIA CUDA 设置仅供复制，按编号升序选取已知空闲卡，
最多选取请求数量；不足时选取所有已知空闲卡，并在复制按钮上说明选取数量和请求数量。
GPU 采样缺失或过旧而隐藏的机器会单独汇总数量。
复制内容是一条 SSH 命令，会在远端设置 `CUDA_DEVICE_ORDER=PCI_BUS_ID` 和 `CUDA_VISIBLE_DEVICES`，
然后打开 shell；粘贴后在该 shell 中运行你的命令。
复制操作不会执行命令或预留 GPU。SSH 主机不再出现在付费云实例的低利用率列表中；手动添加机器尚不保留单卡数据。

The partial-total reason `summary_gpu_processes_unavailable` means GPU use could not be
read on every GPU, whether because processes were unreadable or memory was missing without
visible processes. The reason code is unchanged; it does not imply the process query failed.

部分总量的原因码 `summary_gpu_processes_unavailable` 表示部分 GPU 的使用情况无法读取：
可能是进程不可读，也可能是没有可见进程且显存缺失。原因码保持不变，并不表示进程查询一定失败。

### Copying requests and reusing job shapes

Where to run offers **Copy submit flags** on Slurm options estimated likely, possible,
behind your queue or busy, unless a per-job rule decides the verdict. It copies only;
the toast confirms that nothing was submitted. Example mode disables this copy action.
The format switch chooses flags alone (no command or comments) or `#SBATCH` header lines
and remembers the choice in this browser when storage is available.

QoS always comes from the selected option when its name can be used safely in a flag.
Model spelling comes from current scheduler node records for this cluster, regardless of
node health: a case-insensitive match must yield exactly one safe spelling. Account and
partition still require an unambiguous value from your own current jobs or recent
failures in that QoS. Current jobs from any twin login with the same cluster and
username can provide evidence. A partition also needs a currently observed usable
matching node. Missing or unsafe flags are combined into one visible note. Model
omissions, multi-node layout and zero-time notes stay separate; neither copied format
contains these notes. A model containing spaces, or without one unambiguous current
spelling, is omitted with a note to add the model before submitting. Generic GPU counts
and entered run time come from the request. Positive hours round to the nearest minute
(at least one minute); zero is omitted because Slurm would interpret it as unlimited.
Node count is added only when every matching usable node has the same known GPU capacity
and the request exceeds that capacity and is an exact multiple of it; the GPU flag then
uses the per-node count. Otherwise a known need for multiple nodes is explained without
inventing a layout. Review these partial flags before using them. PBS, LSF and
Kubernetes do not offer submission copying.

Up to four preset chips reuse distinct positive GPU-count/model shapes from your current
jobs and recent failures. Labels and deduplication use the count and model actually
filled; unlisted or multiple models become a model-less request. They clear the optional
run time and perform no action on a source. Pending and failed job drawers link to the
same form with `#/plan?from=<job id>` plus the GPU count and, if listed, a single model.
From-only links resolve the job while it is available; explicit form parameters win and
survive the job leaving the list. Unknown or zero job GPU counts require you to enter
the intended request. The banner names the source job and its own GPU count, or just its
name when that count is unknown or zero. Its waiting login/QoS is marked, including a
merged twin login. Neither queue counts nor ranking are adjusted. Clearing the job
context keeps the form values.

中文：“在哪里运行”在 Slurm 的较可能启动、可能、较可能等待你的排队作业及空闲不足选项上提供“复制提交参数”，
由每作业规则决定的选项除外。操作只复制，提示明确说明未提交任何作业；示例模式禁用此复制按钮。
可选择不含命令或注释的单行参数，或 `#SBATCH` 脚本头部，格式偏好在浏览器允许时保存。
QoS 始终来自所选选项，只要名称可安全用于参数。型号写法来自该集群当前的调度器节点记录，
不受节点健康状态影响：忽略大小写匹配后必须只有一种可安全用于参数的写法。账户和分区仍需
同一集群、用户名和 QoS 的当前作业或近期失败记录提供唯一值；任一相同账户的重复连接都可
提供当前作业证据。分区还必须出现在当前观测的、符合型号且可用的节点上。
未知或不安全的参数合并为一行提示，型号、多节点布局和零运行时间的提示保持独立；两种复制
格式均不包含提示文字。包含空格或无法确认唯一当前写法的型号会省略，提示提交前补充。
GPU 数和运行时间来自表单；正数小时四舍五入到分钟（至少一分钟），零因在 Slurm
表示不限时而省略。仅在所有匹配可用节点的 GPU 容量一致且已知、请求超过单节点容量并可整除时
添加节点数，同时把 GPU 参数改为每节点数量；其他已知多节点需求只提示，不推测布局。
使用前请检查这些可能不完整的参数。PBS、LSF 和 Kubernetes 不提供提交参数复制。

最多四个预设按钮复用当前作业和近期失败记录的资源需求，按实际填入的 GPU 数量和型号生成
标签并去重；未列出的型号或多型号请求按不指定型号处理。预设会清空可选运行时间，
不操作任何来源。等待和失败作业详情可通过 `#/plan?from=<作业 ID>` 及资源参数进入表单；
型号只有在列表中存在且为单一型号时才填入。仅含 from 的链接在作业仍存在时解析，显式资源参数
优先，并在作业离开列表后保留。GPU 数未知或为零时提示填写需求。横幅显示作业自身的 GPU 数，未知或为零时仅显示名称。
页面标明关联作业及其等待的登录/QoS，合并的重复登录也可识别；队列数量和排序均不改变。清除作业关联保留资源输入。
