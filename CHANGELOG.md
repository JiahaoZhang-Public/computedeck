# Changelog

## 0.8.0 (2026-11-18)

- Run ComputeDeck on your own laptop even when some sources are only reachable from another machine. Add routes with **Add route** in the Routes panel of the Sources page (or as `[[node]]` in a configuration file) and set each source's **Route**; every other source still connects directly from this computer. The panel draws each route as a path, such as *This computer → Lab gateway → Cluster B*, with its kind and status, and a routed login names its route in the **Route** column.
- Add jump hosts (`mode = "jump"`): a source's SSH connections pass through that machine, as with `ssh -J`, with this computer's keys, SSH configuration and credentials. Nothing is installed there and collection runs here. The route carries collection, connection checks, SSH checks of machines and the job logs that notifications read, and replaces the target alias's own `ProxyJump` or `ProxyCommand`. The hop is as strict as any other connection: no prompts, verified host keys, no forwarding. Jump hosts carry clusters and SSH machines; a source that does not connect over SSH is refused, with a hint to use a collection machine.
- Keep collection machines (`mode = "collect"`) for sources that need another machine's keys, credentials, VPN or software. Existing collection machines and `[[node]]` entries without a `mode` keep working unchanged as collection machines. A route's kind cannot be changed while sources use it.
- Name the failing hop when a routed source fails. A connection check for a jump-routed source starts with **Reach {name} from this computer**; an unreachable jump host is reported as such with OpenSSH's own message, and failures beyond it keep their usual SSH message and name the jump host they went through. Successful collections make no extra connection.
- Suggest host aliases from your `~/.ssh/config` when you add a source or a route.
- Adopt an existing server's sources from your laptop with `computedeck import --from <ssh-alias> [--route collect|jump|direct] [--command <path>]`. It runs `computedeck export` there over SSH; by default the server becomes a collection machine for every source, `jump` routes SSH sources through it, and `direct` connects them all from the laptop. The server's settings, hand-added machines and own routes stay behind, and the command reminds you to stop the old service. Importing from a file is unchanged.
- Print the installed version with `computedeck --version`.
- Make main pages show what something is and its state, and leave the why to its details. A row is one line and a cell holds one value; nothing is cut off with an ellipsis. A queued or failed job shows a short reason such as **Resources** or **User limit**; the scheduler's wording, its code and the next step are in the job's details. Sources lists each login with its host, route, last success and state; what it can read, the error and the connection actions are in the source's details.
- Open a partial total such as **≥ 27** to see which sources were not counted. Partial totals still show `≥` and unknown is never shown as zero, without lines of caveats beside the number.
- Dismiss a Needs attention item with one click; it stays hidden until it changes, and **Dismissed** brings it back. Snoozing moves to the item's details. The indicator in the top bar shows how many items still need attention and returns to the collection age when none do; a service that cannot be reached still shows. Example data lets you try this without changing anything.
- Give every page the same shape: its title, tabs directly under it, one row with search and filters, then the list on the page with a detail pane beside it. Navigation, buttons and tabs are black on white (white on black in dark mode), and colour is kept for status and charts. Plugin colour names keep working.
- Where to run lists the options that can take the request and folds the rest under one line.
- Give the interface a calmer, more consistent look: new colour and type scales in light, dark and higher-contrast modes, checked against WCAG 2.2 AA; status shown by shape as well as colour; unknown values shown as a dash with their reason; consistent ages, durations, copy feedback and persistent group colours.
- Open details, forms and diagnoses in panels beside the list on wide screens and as sheets on phones. Escape and Back close them and return focus; menus, confirmations and notices work from the keyboard, and `j` / `k` step through rows.
- Redraw the Usage trend as stacked charts that can be pinned with a keyboard, mouse or touch, with gaps and partial coverage marked and a table of the same figures.
- Update live data without redrawing unchanged rows, keep focus while rows change, and announce job state changes to screen readers. Load pages and the selected language on first use, so the first download is smaller.
- Keep existing links working, including older page addresses and their filters. Plugin pages keep their styling and the WEB_API 1 components keep their behaviour; the outlines of compatibility status pills changed slightly.
- Build the wheel and sdist with the web app included, check that both install and serve the app in a clean environment, and attach them to a draft GitHub release for each version tag. Installing from the sdist needs no Node.js. PyPI publishing is prepared but not enabled.
- Rewrite the README around what ComputeDeck does and the three ways to run it, and add an install guide, a routes guide and a security policy.

## 0.7.0 (2026-10-24)

- Fix final-review issues: size copied Slurm flags within the proven partition; allow example-mode copying; wrap copy notes and show explanation factors across the row. Improve preset tap targets, accessible control names and Cloud sampling labels.
- Treat busy GPU utilization as evidence of use even when processes are invisible. Keep legacy plugin start-time text readable, treating ambiguous instance starts as unknown. Round partial spend down consistently and never guess a currency for low-use costs.
- Collapse consecutive unrecorded days in usage history, clarify shared-host scope, and keep unknown-currency sources out of currency-specific bars. Preserve timeout duration in notification attention through retries.

- Count only scheduler nodes that can take work now as usable or free. Show resting power-saving and PBS provisioning nodes as “Available on demand”, separately from unavailable capacity. Keep active allocations visible, and explain Slurm nodes without a partition.
- Make Where to run more cautious when your scheduler reports personal limits despite apparent room. Merge duplicate logins for the same account, retain separate users, and keep CPU-only jobs from consuming model-specific GPU headroom.
- Expand “Why this estimate” on every resource option to see seven factors, their effects, source logins and data ages. Explain the first ranking difference from the next option, or say when options tie; unknown evidence stays unknown.
- Show per-GPU availability, memory, utilization and owners on SSH machines, with no PIDs in the interface. Offer current free GPUs in a separate Machines panel with copy-only NVIDIA setup. GPUs with significant memory use now count as in use even with an empty process list; unreadable evidence stays unknown, never free.
- Reuse recent jobs as resource presets, find alternatives from pending or failed jobs, and copy Slurm submit flags or script headers. Use the selected QoS, current node model spelling and your own job evidence for partition and account flags; explain unconfirmed flags separately. Copying never submits a job.
- Show running-since and cost-so-far estimates, distinguishing provider start times from ComputeDeck observation windows. Freeze stale estimates at the last successful collection. Keep currencies separate, name missing prices and show incomplete hourly totals as “≥”. GPUhub prices remain unknown for multi-GPU containers or unknown GPU counts because the price unit is ambiguous.
- Make Usage & cost the home of trends, current GPU use and hourly spend by group. Add daily GPU-hours and spend, today and seven-day estimates, and 24-hour / seven-day / 30-day ranges. Mark partial-day spans, missing observations and unknown measurements; pre-upgrade history stays “Not recorded”. Costs are estimates, not bills.
- Detect sustained low GPU use from at least three measured readings over a configurable window, checking per-GPU maxima where available and gaps between readings. Show acknowledgeable hints, Cloud filters and provider console links; include covered-duration cost only when priced. No instances are stopped and no automatic provider SSH checks are added.
- Explain Slurm Priority and Resources waits with per-partition queue estimates and account fair-share when available. Hidden or unreadable queues stay unknown; only counts are retained, never other users' job ids.
- Show typical waits from your own Slurm or PBS accounting jobs over the last 30 days, grouped by login, queue/QoS, partition and GPU count. Show a 25th–75th percentile range only with at least eight matching samples, labelled “not a prediction”. Explain missing GPU counts, insufficient history and unsupported or unavailable accounting. History builds from normal collections without a backfill or ranking changes.
- Recognize SSH machines that are also scheduler nodes using a unique session IP match corroborated by the probed hostname. Label the shared host and count its GPUs with the cluster in summaries and new history; keep hardware checks and separate prices. Missing or ambiguous identity stays unmatched, with no extra connections or DNS lookups.
- Keep plugin API, web API, database schema versions and route IDs unchanged. Add optional measurement, cost, queue, wait-history and host-identity fields, opt-in usage rollups, and low-use settings. Existing event subscriptions are unchanged.

## 0.6.0 (2026-10-22)

- Collapse QoS lists by default and show their entry counts. Keep cluster account columns readable when expanded, with queue labels wrapping within their column and cards on narrow screens.
- Browse a searchable Activity page with failed, job, source, gap, your-change and plugin filters, cluster or platform scope, and 24-hour, 7-day or 30-day history. Load older rows, expand recorded facts and open job snapshots; new arrivals wait behind a button instead of moving the list.
- See recent activity on Overview and mark it seen in this browser. This summary replaces the "Failed in the last 24 hours" table; failed attempts remain under Jobs › Failed. Failures and connection problems come first; read state stays separate for each viewer.
- Report one ending per job attempt, using the scheduler's outcome and end time when available. Include short jobs found only in accounting, label unknown outcomes and observation times, and recover failures after accounting outages without duplicate notifications. The first collection after upgrading establishes a silent baseline.
- Group Slurm, PBS and LSF job arrays into one row with state counts and GPU totals. Open an array to inspect its elements; job totals still count individual elements.
- Combine matching array and catch-up notifications into one digest per rule and event type, while unrelated failures keep their own messages. Filter notifications by job outcome, preserve existing rules, show grouped or suppressed deliveries and avoid resending them after a restart.
- Explain job failures with scheduler-reported causes, clearly labelled likely causes and their evidence. Show run time against the limit and log paths when known, and offer inspection commands to copy without running them.
- Show gaps in source observations and periods when ComputeDeck was stopped or the computer was asleep. Record source, machine, tool and import changes in Activity using changed field names, never setting values.
- Acknowledge Needs attention items until they change, or snooze them for an hour or until the service host's next midnight. Muted items remain available to unmute; changed causes and severity reopen them, and service health stays visible.
- Show recorded notification delivery outcomes beside Activity rows and warn about failing channels in Needs attention. Refresh the Notifications log automatically while its page is visible.
- Preserve hand-added machines' SSH checks across edits and imports when the connection is unchanged. Give specific connection-failure guidance, retry transient timeouts and closed connections once, and keep machine checks separate from collection concurrency.
- Avoid duplicate refreshes when returning to the app and stop fast polling when the requested collections finish. Offer Add source in the health panel once an authenticated, loaded dashboard confirms there are no sources.
- Preserve pre-upgrade Activity history and catch-up endings, recover short failures reported late, and retain Kubernetes container-failure notifications. Keep `sdk.EVENT_TYPES` at its 0.5 set and interpret old Notify rules without rewriting them. Mixed digests and expanded Activity groups prioritize failures; long outages explain unchecked accounting history.
- Make observation times visible on touch screens, announce attention actions and retain keyboard focus, improve phone controls and numeric table layout, and keep example array failures consistent across views.
- Keep plugin API, web API and database schema versions unchanged. New event types require explicit subscriptions; existing plugin handlers keep receiving legacy job endings. Event filters, grouped reads, change history and notification delivery status are opt-in API additions.

## 0.5.1 (2026-10-20)

- Recognize both `gres:gpu` and `gres/gpu` in Slurm job requests, including typed GPUs and per-node counts when GPU accounting is unavailable. Missing resource information remains unknown.

## 0.5.0 (2026-10-20)

- Show connection-check progress as each step runs, with specific guidance for authentication, host identity, network and port failures. Closing the check cancels its request. Existing JSON diagnostics remain available.
- Keep connection and credential-reference edits open until a fresh collection result arrives; saving settings and resolving a credential are not treated as proof of successful collection.
- Explain common Slurm wait reasons and terminal job failures while retaining the original scheduler reason. Show submitted and started times where available; unknown scheduler timezones stay explicit, and pending start estimates are not shown as actual starts.
- Show observed waiting time without extending stale samples to the present. Normal queued and starting states use an informational tone.
- Turn resource, job, failure, source and usage tables into labeled cards when space is limited, keeping status, prices and connection details visible.
- Preserve group/search/state filters, chart ranges, tool tabs and planner inputs in the URL. Job, failed-attempt and machine details support direct links, browser navigation and live updates; missing items are explained.
- Keep plugin API, web API and database versions unchanged. Existing rows without the new job times continue to display unknown values.

## 0.4.0 (unreleased)

- Use the same GPU, job and utilization figures across Overview, Usage, cluster views and history. Partial totals name the machines or logins that could not be measured; machines with monitoring off are excluded.
- Count running instances reported by a cloud provider as GPUs in use, including RunPod pods. SSH checks measure utilization without changing the provider's allocation.
- Keep an instance's last SSH check across provider updates until its connection changes or the instance is released. Hand-added machines count measured GPUs with compute processes while their checks are current; failed, old or unavailable readings stay unknown.
- Show usable GPU capacity separately from unavailable GPUs. A cluster with every node down reads “0 usable”; unknown node states preserve a lower bound instead of appearing free.
- Show collection age and service health on every page. Age follows the oldest enabled source, so it may look older after upgrading. Open the health panel for failures, retries and collection progress; Refresh remains available during background collection.
- Use one Needs attention list and count for collection failures, stale data, cluster faults, lost capabilities, failed SSH checks and service or plugin errors. Missing capabilities that have never worked and unchecked connections no longer count as faults. Source items open connection diagnosis. A first collection failure appears as a warning.
- Clarify the interface with “Clusters & clouds” and “Cloud and machines”, a bilingual glossary and job-detail labels appropriate to Slurm, PBS, LSF or Kubernetes.
- Make example data read-only across tools and plugin requests, while still allowing sign-in. Keep example mode in the URL and show a neutral banner on every page. Examples now include failed and stale logins, a rate-limited cloud account, a timed-out job and an all-down cluster.
- Pause browser requests while the tab is hidden, send a small response when the dashboard is unchanged and follow Refresh, SSH checks and newly added resources more quickly. Service health checks do less work; example timestamps advance once per minute.
- Account for your eligible queued GPU demand in Where to run, with a “Likely to wait for your queue” estimate when it uses the available room. Held, dependency, delayed-start and array-throttled jobs are excluded; unknown counts stay unknown. Kubernetes quota usage is not counted twice.
- Show options with unchecked access in the main planning table, with one note per login. Within each verdict, rank by whether the request fits one node, room after your queue, free GPUs and verified access. Show the first row as the best estimate only when it is likely or possible.
- Put Needs attention, current jobs and recent failures before Clusters & clouds and the history chart on Overview. Plugin overview cards appear beside the chart at the bottom.
- Preserve existing history points. The corrected allocation and monitoring rules can cause a step in the chart after upgrading. Repointing a source clears its old capability history; switching it off or on preserves that history and clears collection errors and retry counts.

## 0.3.0 (unreleased)

- Verify Slurm QoS association access and separate unknown or unassociated planner choices.
- Distinguish optional capabilities from source failures; surface unavailable and degraded clusters.
- Count an SSH GPU as in use when it has compute processes; preserve unknown process visibility.
- Rotate service logs and restrict data-directory and log permissions at startup.
- Provide isolated plugin files, JSON state, SQLite transactions and strict SSH execution in the SDK.
- Add shared CLI and web connection diagnostics with repair guidance and credential redaction.
- Recognize the official plugin marketplace and show its copyable add command.
