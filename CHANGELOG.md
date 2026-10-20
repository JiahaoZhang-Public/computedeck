# Changelog

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
