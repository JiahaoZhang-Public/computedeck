# Changelog

## 0.7.0 (unreleased)

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

## 0.6.0 (unreleased)

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
