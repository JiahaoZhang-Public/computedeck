# Reading the numbers

In 0.4.0, the service computes the headline figures once for the fleet, each cluster
or platform, and each source. Overview, Usage, cluster views and new history points
read those figures. `—` means unknown or no measurement; `≥ n` is a known subtotal,
with named missing evidence. Neither means zero.

- **Freshness** in the topbar uses the oldest enabled source’s last successful collection. If any enabled source has never succeeded, it says "Not collected yet". Disabled sources and manual SSH checks do not make the fleet age newer. "Collecting N" keeps that age visible, and Refresh can queue the other sources. Open the health pill on any page for source ages, next attempts, backoff and service faults. The age can look older than in earlier releases because it no longer follows the newest source.
- **GPUs in use** counts GPUs allocated to your running jobs and running cloud instances. For SSH GPU machines it counts GPUs with compute processes; unavailable process visibility (for example on AMD GPUs) remains unknown. A monitored machine added by hand counts while its last SSH check, less than 20 minutes old, reached it; otherwise its use is unknown. Machines with monitoring off are excluded, with a note showing how many. Partial totals name each unmeasured machine or login and explain why, with a link. Checking a cloud instance over SSH never changes the GPUs its provider lists. When a source has not been collected recently, the number is a subtotal and is labeled as such.
- **Provider-reported running** instances (for example RunPod) count their listed GPUs as held, with the label "Running (reported by provider)". This is an allocation report, not a readiness check. `desired_running` remains unknown because it can mean provisioning. Stopped, terminated, deleted, desired-stopped and desired-terminated instances hold no GPUs. A missing GPU count or a stale source still makes the total partial. The same lifecycle table drives the headline, history and idle-instance suggestions.
- **SSH checks** of a cloud instance are kept across provider listings while its host, port and user stay the same, so a failed connection stays failed until it is checked again. A listing that reports the instance no longer holds GPUs clears the old check, even if it retains an endpoint. The check shows its own age next to the listing's; counting a provider's allocation never makes an old utilization reading fresh.
- **Usable capacity** includes only healthy nodes from enabled, current sources. Down, drained, reserved, UNKNOWN and nonresponsive (`*`) nodes are unavailable; power-saving flags alone are normal. An outage reads "0 usable · N unavailable", alongside the total inventory. **Unallocated** GPUs are usable capacity minus the allocations on those usable nodes. QoS limits and your access still constrain where you can run.
- **QoS limits** are what the scheduler shows for your login. Limits alone do not prove access. The planner shows verified and unknown-access options together, with one access note per login. Only options without an association are collapsed. Limits of different QoS do not add up.
- **Where to run** estimates account for this login's eligible queued jobs in the same QoS. Held, dependency, begin-time and array-task-limit jobs are excluded. Eligible jobs are considered in listed order, subtracting each only if it fits the room left after previously counted jobs. A larger job is skipped because it cannot start first. If the remaining queued GPUs starting first would leave insufficient headroom for the request, the option reads "Likely to wait for your queue". This is an estimate, not FIFO or a promise of scheduling order. Unknown queued GPU counts that could consume remaining room, or a job list that is no longer current, prevent a "Likely" estimate. An unlimited room is unaffected by queued demand, even when its GPU count is unknown. Model-specific limits count the matching queued GPUs; generic limits count all models. "Room used by queue" shows the reduction in available headroom across these limits, rather than the total GPUs requested by all queued jobs. Kubernetes resource-quota usage already includes admitted pending pods, so those queues are not subtracted again. The best-estimate card is the first table row, and appears only for likely or possible options. Within a verdict, options sort by fitting on one node, room after the queue, free GPUs, then verified access.
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
dashboards reuse the previous response, and Refresh or a new SSH check gets a short
period of faster polling. These actions do not turn retained observations into new
measurements. Example timestamps advance once per minute.

## Upgrading from 0.3

Older history points are not recalculated. New points count provider-reported
running instances, use measured allocation for hand-added machines and exclude
machines with monitoring off. These changes can produce a step at the upgrade;
they do not by themselves indicate a workload change. The age can also appear older
because it now follows the oldest enabled source instead of the newest one.

## Needs attention

The Overview tile, navigation badge and attention panel count the same server
list. The first collection failure appears as a warning; two consecutive failures
or stale data make it an error. Stale data becomes an error after three collection
intervals. Built-in drivers classify cluster availability using the node-health
rule over GPU-capable nodes (positive or unknown GPU counts), so healthy CPU-only
nodes cannot hide a GPU outage. One item per cluster uses the worst state reported
by its current logins. Source-failure and stale-data items replace retained cluster
faults and collection warnings.
A capability warning counts only when the source has
delivered that capability before; permanent gaps stay on Sources. Other warnings
are all included. Unchecked connections and machines with monitoring off do not
produce attention items; failed SSH checks on monitored machines and provider
instances do. Disabled sources and plugins do not produce items.
Disabling or re-enabling a source clears its collection error and retry count while
preserving retained observations and capability history. It clears `last_success`
so the next collection establishes a silent event baseline. Retained inventories
do not override the cluster state reported by the latest collection.

Rows link to diagnosis (the last error and an explicit Test connection button),
the instance, service health or Toolbox. Their times use existing observations:
`since` is the last successful collection for a failing or stale source: no good
data has arrived since then. It is null for all other cases. `observed_at` records
the latest observation, shown as "Last seen": the collection that observed a
source condition, the latest failed attempt for a source that never succeeded,
an SSH check, or a background error report. Repeated observations do not imply a
new incident onset. Unreadable rows and plugin health errors have neither time.
Attention is derived on every dashboard read; there is no acknowledge, snooze or
additional collection request.

Follow-up: classify `gpu_count_unknown`, `partitions_unavailable` and
`instances_skipped` as driver capability checks or coverage-only conditions.
They currently count as partial data, including when the gap is permanent.

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
predates the job start. A reported terminal outcome takes precedence.

中文：动态为每次作业结束显示一条记录，优先使用调度器报告的结果与带时区的结束时间。
没有记账能力时会明确说明结果不可用；有历史能力时等待下一次成功的记账采集，记账中断期间最多等待 24 小时。悬停可查看观测延迟，
未知结束时间不会伪装成精确时间。失败标签页仍保留原有的 24 小时失败记录。
Kubernetes Pod 运行期间的容器失败保留在失败列表中；Pod 消失且没有终态记录时，使用此前观测到的容器失败作为结果，但不使用早于作业开始的失败。已有终态记录优先。

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
listed. It does not run scheduler commands. Failure-history rows remain individual jobs.

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
明确提示；不执行调度器命令。失败历史仍逐作业显示。


## Activity collection groups / 动态采集合并

Activity collapses three or more events of the same type and source collected together.
Expand a row to see every job and outcome. The group shows names and outcome counts with
failures first, a red dot if any child failed, and the event time range. Known job times
always take precedence: children retain their own end/start times, and a group whose
children all have known times shows their first-to-last range. Only children without a
known time use the previous-success-to-observation window after a gap; a group containing
such children also shows that window. Equal range endpoints display a single time.
Unknown times keep their observation-time labels, including on group rows when any
child lacks its own time, even without a collection gap. Grouping does not change job or failure totals.

动态将同一来源、同一类型、同一轮采集中的三个及以上事件合为一行，展开后可查看各作业
及结果。合并行显示名称、各结果的数量（失败优先）及时间范围，含失败事件时显示红点。
已知作业时间优先：子事件显示自身结束或开始时间；全部子事件时间已知时，合并行显示
最早至最晚时间。只有时间未知的补收事件及包含这些事件的合并行，才显示上次成功采集
至本次观测的区间；区间起止相同时只显示一个时间。未知时间保留观测时间标注；
只要任一子事件自身时间未知，合并行也显示该标注，即使没有采集中断。
合并展示不改变作业数或失败总数。
