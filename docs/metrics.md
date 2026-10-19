# Reading the numbers

- **Freshness** in the topbar uses the oldest enabled source’s last successful collection. If any enabled source has never succeeded, it says "Not collected yet". Disabled sources and manual SSH checks do not make the fleet age newer. "Collecting N" keeps that age visible, and Refresh can queue the other sources. Open the health pill on any page for source ages, next attempts, backoff and service faults. The age can look older than in earlier releases because it no longer follows the newest source.
- **GPUs in use** counts GPUs allocated to your running jobs and running cloud instances. For SSH GPU machines it counts GPUs with compute processes; unavailable process visibility (for example on AMD GPUs) remains unknown. A monitored machine added by hand counts while its last SSH check, less than 20 minutes old, reached it; otherwise its use is unknown. Machines with monitoring off are excluded, with a note showing how many. Partial totals name each unmeasured machine or login and explain why, with a link. Checking a cloud instance over SSH never changes the GPUs its provider lists. When a source has not been collected recently, the number is a subtotal and is labeled as such.
- **Provider-reported running** instances (for example RunPod) count their listed GPUs as held, with the label "Running (reported by provider)". This is an allocation report, not a readiness check. `desired_running` remains unknown because it can mean provisioning. Stopped, terminated, deleted, desired-stopped and desired-terminated instances hold no GPUs. A missing GPU count or a stale source still makes the total partial. The same lifecycle table drives the headline, history and idle-instance suggestions.
- **SSH checks** of a cloud instance are kept across provider listings while its host, port and user stay the same, so a failed connection stays failed until it is checked again. A listing that reports the instance no longer holds GPUs clears the old check, even if it retains an endpoint. The check shows its own age next to the listing's; counting a provider's allocation never makes an old utilization reading fresh.
- **Usable capacity** includes only healthy nodes from enabled, current sources. Down, drained, reserved, UNKNOWN and nonresponsive (`*`) nodes are unavailable; power-saving flags alone are normal. An outage reads "0 usable · N unavailable", alongside the total inventory. **Unallocated** GPUs are usable capacity minus the allocations on those usable nodes. QoS limits and your access still constrain where you can run.
- **QoS limits** are what the scheduler shows for your login. Limits alone do not prove access. The planner shows currently verified association grants by default and separates unverified or unassociated choices. Limits of different QoS do not add up.
- **Utilization** of cloud instances is an instant reading of the whole host. Inside a container it can reflect the host machine.
- **History** uses the same server allocation and utilization figures as Overview and Usage. Periods without data stay empty. Older points stay unchanged; excluding unmonitored machines can create a step at upgrade.
- **Jobs counts** include only current jobs from enabled logins. If an enabled login lacks a current list, the count is partial. Last-known jobs remain visible as stale rows but do not increase the current count. The navigation badge and unfiltered Jobs count use the same server selection.
- **Prices** are estimates from known hourly prices, not bills. Held instances show their hourly price; not-held instances do not. Unknown and transitional states retain the existing price display until fuller cost accounting is added; a price alone does not establish allocation. Currencies are never added together.

## Needs attention

The Overview tile, navigation badge and attention panel count the same server
list. A collection failure appears after two consecutive failures, or immediately
if its data is stale. Stale data becomes an error after three collection intervals.
Cluster availability uses the existing node-health rule and current node data,
with one item per cluster. A capability warning counts only when the source has
delivered that capability before; permanent gaps stay on Sources. Other warnings
are all included. Unchecked connections and machines with monitoring off do not
produce attention items; failed SSH checks on monitored machines and provider
instances do. Disabled sources and plugins do not produce items.

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
