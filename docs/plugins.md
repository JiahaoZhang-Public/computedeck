# Plugins

ComputeDeck can be extended without changing it. A plugin is an ordinary Python package
that the service finds through entry points. It can add:

- **tools**: API routes, background work, settings and reactions to events, listed in the
  Toolbox where their owner switches them on or off;
- **drivers**: new kinds of data source (schedulers, clouds, machines);
- **notification channels** for the Notifications tool;
- **web pages**: a prebuilt bundle the web app loads at run time.

Plugins are shared through **marketplaces**: catalogs that list plugins with pinned
sources. Everything below that a plugin imports comes from `computedeck.sdk`, the stable
surface; other modules may change between releases.

A plugin runs inside the service with the permissions of the user who runs it. Install
only plugins you trust, and say plainly in your plugin what it does.

## Compatibility with 0.6.0

`PLUGIN_API = 1`, `WEB_API = 1`, `SCHEMA_VERSION = 2` and existing route IDs stay
unchanged. The additive `attention_state` table is created with `CREATE TABLE IF NOT
EXISTS`; a 0.5 build can still open the database. Existing API keys keep their meaning.
Event filters, grouping, change history and delivery status are opt-in; the default
`GET /api/events` response remains a plain list.

Plugins tested across 0.3–0.6 can declare `requires=">=0.3,<0.7"`; widen matching pip
dependencies and marketplace entries too. Features introduced in 0.4 require at least
0.4, and plugins relying on 0.6 fields should require `>=0.6,<0.7` or handle their absence
on older cores. A plugin's existing `<0.6` bound still excludes 0.6 even though its API
version is unchanged.

New event types reach only handlers that name them. A handler that does not subscribe
to `job.finished` continues to receive one legacy `job.failed` or `job.ended` per ending;
wildcard handlers and subscriptions using `sdk.EVENT_TYPES` retain the five 0.5 types.
`EVENT_TYPES` stays frozen at that set; subscribe to `"job.finished"` by name to opt in.
Gap events also require named subscriptions.
`change.*` events are never delivered to plugins. See [Events](#events) for the full
contract and [Notification delivery status](#notification-delivery-status) for the
optional delivery fields.

Notify interprets stored 0.5 rules at read time without rewriting them, so a downgrade
keeps those rules usable until the user edits them in 0.6. Kubernetes container failures
still produce legacy `job.failed` events while a pod is running or when it later succeeds;
these describe a failed container run, separately from the pod's terminal outcome.
If a departure reuses the same failure already reported while the job was present,
`job.finished` carries `data.failure_announced: true`. Its failure outcome remains
visible in Activity, but API-1 handlers receive `job.ended` for this departure and
Notify rules with outcome filters do not match the failure again. Rules matching all
outcomes can still receive the departure. A different failure end time is a new failure.
Mapped Slurm, PBS and LSF legacy events keep scheduler-local naive `data.job.end`, while
`data.ended_at` retains the offset. The job payload for a known ending is the accounting
record, rather than the last queue sample; absent utilization fields remain unknown.

## Quick start

While packages are unreleased, follow the [local plugin development guide](https://github.com/JiahaoZhang-Public/computedeck-plugins/blob/main/CONTRIBUTING.md#create-a-plugin)
to use an adjacent core checkout. After release, the scaffold can resolve its core dependency from PyPI:

```bash
computedeck plugin new lab-alerts --web     # add --driver for a data source
cd computedeck-lab-alerts
uv sync && uv run pytest
npm --prefix web install && npm --prefix web run build   # only with --web
uv run computedeck plugin validate .
```

Try it against your own ComputeDeck by installing it into the same environment
(`uv pip install -e .`), restarting the service and switching it on in the Toolbox.

## The plugin object

```python
from computedeck.sdk import Plugin, PluginContext, SettingField

plugin = Plugin(
    id="lab-alerts",  # lowercase, digits and dashes; also the route prefix
    setup=setup,  # called once at startup, see below
    name={"en": "Lab alerts", "zh-CN": "实验室提醒"},
    description={"en": "One line on what it does."},
    permissions=({"en": "posts failed jobs to the lab chat"},),
    settings=(SettingField(key="room", label={"en": "Chat room"}, required=True),),
    default_enabled=False,  # start off until the owner turns it on
    requires=">=0.3,<0.7",  # ComputeDeck versions it supports
    api=1,  # the plugin API it was written for
    page="lab-alerts",  # the page its web bundle adds, if any
    web=Path(__file__).parent / "web",  # the built web bundle, if any
    author="Example Lab",
    homepage="https://example.com/lab-alerts",
)
```

Register it in `pyproject.toml`:

```toml
[project.entry-points."computedeck.plugins"]
lab-alerts = "computedeck_lab_alerts:plugin"
```

`name`, `description` and `permissions` are shown in the Toolbox before anyone switches the
plugin on, in English and, when given, Chinese. Write permissions as what the plugin will
do ("reads job logs over SSH", "posts to the webhook you set"); they inform people, they
are not enforced.

A plugin that needs a newer plugin API or another ComputeDeck version is listed in the
Toolbox with the reason and not set up. The service's `policy.toml` can block plugins.

The entry-point name must equal `Plugin.id`. Before importing code, policy checks the
entry-point name, the distribution package name and, for a plugin installed from a
marketplace, its catalog name and marketplace. Importing one entry point runs its
package's code, so blocking any plugin or driver of a package blocks all of them (the
tools shipped with ComputeDeck are blocked one by one). A different runtime `Plugin.id`
can only be checked after import; installed plugins run trusted Python code, without a
sandbox.

## setup(ctx)

`setup` runs at service start even while the plugin is off, so it should only register
what follows. Nothing it registers runs or resolves until the plugin is switched on.

| | |
|---|---|
| `ctx.router` | A FastAPI router served at `/api/plugins/<id>/…`. Requests need the access token like every API call, and the routes answer 404 while the plugin is off. |
| `ctx.settings()` | The declared settings with saved values. Kinds: `text`, `textarea`, `number`, `boolean`, `select`, `credential` (a reference such as `env:NAME`, never a secret). |
| `ctx.validate_settings(fn)` | Check settings beyond their kinds; raise `ValueError("message_code")`. |
| `ctx.on_event(handler, types)` | Receive events while on (see below). |
| `ctx.background(loop)` | A coroutine run while the plugin is on; restarted after a crash, stopped when switched off. |
| `ctx.on_startup(fn)`, `ctx.on_shutdown(fn)` | Prepare and release resources, e.g. tables in `ctx.store.db`. Startup runs once, when the plugin is first on (at service start or when switched on); shutdown runs at service stop if startup ran. |
| `ctx.health` | A function returning a small dict, shown in the Toolbox and `/api/health` while the plugin is on. Also called synchronously on every `/api/dashboard` request, so it must be cheap. Exceptions and non-dict results are reported as plugin health errors. |
| `ctx.credential_scheme(name, resolver)` | Add a credential reference scheme, e.g. `vault:path`. While the plugin is off, its references fail with a message saying so. |
| `ctx.runtime.cluster_lock(id)`, `ctx.runtime.semaphore` | Share the collector's connection budget when you reach clusters. |
| `ctx.data_dir` | Private files in `plugins/<id>/` below the service data directory (mode 700). |
| `ctx.get_state(key, default)`, `ctx.set_state(key, value)` | Persistent JSON values scoped to this plugin. |
| `ctx.database()` | A context manager for a standard SQLite transaction in this plugin's database. |
| `ctx.sources()`, `ctx.source(id)` | Read configured sources without importing core internals. |

### Events

Events are recorded between collections, stored, and delivered in order to each plugin
that is on, from where it left off; a short restart loses nothing. Switching a plugin on
starts it with events from then on, and so does starting the service with a plugin its
previous run did not load (newly installed, reinstalled, or no longer blocked): it never
receives the backlog of an earlier installation.

| Type | When | `data` |
|---|---|---|
| `job.started` | a job is first seen running or changes to running | `job`, `started_at`, `observed_at`, optional `since` |
| `job.finished` | one reconciled ending, including jobs seen only in history | `job`, `outcome`, `state`, `exit_code`, `submitted_at`, `started_at`, `ended_at`, `observed_at`, `outcome_reason`, optional `since` |
| `job.ended` | legacy delivery of a non-failure ending | `job` (as last seen for unknown departures) |
| `job.failed` | legacy delivery of a failure ending | `job` with `exit_code`, `end` |
| `source.failed` | a source that worked could not be collected | `error` |
| `source.recovered` | a failing source was collected again | |
| `source.gap` | a job source was not observed long enough to risk missing history | `unobserved_from`, `unobserved_to`, `failures_checked_from` (or null) |
| `service.gap` | more than five minutes between service heartbeats | `from`, `to` |

Every event has `id`, `type`, `at`, `source_id` and `data`. Collection source events include
`source_name`, `cluster_id`, `username` and `driver` in `data`; `service.gap` has no
source context and its `source_id` is null. The first collection of a new source records what
already exists without delivering it. The first successful collection after upgrading to
reconciled endings also records terminal history silently.

User actions use `events.CHANGE_TYPES`, separate from `TYPES` and `sdk.EVENT_TYPES`:
`change.source` (added, edited, enabled, disabled, removed), `change.node` and
`change.instance` (added, edited, removed), `change.tool` (on, off, settings), and
`change.import` (imported). They are never delivered to any plugin, even one subscribing
by name, and are not Notify rule types. `Store.recent_events()` excludes them by default.
`GET /api/events` returns them only with `include=changes`, including grouped and ID
lookups; filtering happens before `limit`. Changes remain individual rows under `group=1`.

Each source, collection-machine, hand-added-machine or Toolbox save/removal that changes data
records one event after saving. `data` contains `subject_id`, the subject's display `name`,
`action`, and `fields`: top-level field names only, never old/new values, credentials,
connection details or nested option keys. Adds list only explicitly supplied, non-null fields;
removals have an empty field list. Edits list only fields whose values changed;
saving unchanged data records nothing. A source enable/disable takes precedence
over edited when one save changes both. Tool settings always have an empty field list and
are recorded only when the saved settings differ; when a save also switches the tool on/off,
that switch is the action. Stored tool names use the plugin's English display name, falling
back to its ID; Activity uses the current localized name while the tool is installed.
Other changes have `source_id` null;
`change.source` retains its source ID after removal. These rows do not carry the collection
source context described above.

Removal events are recorded immediately after deleting the saved record, before updating
the SSH include file, so a file-write failure does not hide a completed deletion.

`config.apply` (also used by CLI import) records one `change.import` after a successful
import, with `data.counts = {sources, nodes, instances}` instead of individual records.
Language and server-name preferences are not logged. Rejected writes create no change row.
There is no merge window: a quick pause/resume keeps both actions. These events use the
existing 30-day retention and do not add a table or change an API version.

`job.finished` is stored once. Its `outcome` is `completed`, `cancelled`, `failed`, `timeout`,
`out_of_memory`, `node_fail`, `boot_fail`, `deadline`, `preempted`, or `unknown`. A departed
job waits until the next successful accounting collection when history has been available.
During an accounting outage it stays pending for up to 24 hours; a successful history
collection that still omits it, or expiry of that window, resolves it as unknown.
Sources that have never reported history resolve departures immediately as unknown. `outcome_reason` distinguishes `outcomes_unavailable`
(this connection cannot read accounting) from `outcome_not_reported` (history had not
reported this job by the observation) and `outside_lookback` (accounting could not cover
the full unobserved period). Late accounting does not deliver a second ending for an unknown one.

`at` uses the offset-bearing job end time (start time for `job.started`) when known;
otherwise it is the observation time. `data.observed_at` always records collection time.
Unknown job times are null. After a gap longer than two collection intervals plus 240 seconds
(allowing for a failed attempt and recovery, each bounded by the 120-second collection timeout),
all endings remain visible and eligible for delivery, including departures resolved in a
later collection. Notify groups catch-up messages. Job events found after that gap carry `data.since`, the
previous successful collection time; the collection window is `since` to `observed_at`,
not a claim that every job ended or started at recovery. Unknown departures preserve `data.job` as last seen;
`data.outcome` is `unknown`, and top-level `data.state` and `data.exit_code` are null.

**Named-type delivery:** new event types reach only handlers that explicitly name them
in `ctx.on_event(handler, types=[...])`. API-1 wildcard handlers retain the original set
of five types above. For a handler that does not name `job.finished`, failure outcomes
map to one `job.failed`, and all other outcomes to one `job.ended`. A handler that names
`job.finished` receives that event once, even if it also names the legacy types. Stored
legacy rows remain readable and deliverable; cursors still use event IDs. `PLUGIN_API`
and `WEB_API` remain 1.

The new types `job.finished`, `service.gap` and `source.gap` are outside `sdk.EVENT_TYPES`.
Subscribe to new types by name. Wildcard handlers do not receive gap events, and
Notify refuses `service.gap` and `source.gap` as rule types. Gap events use the
observation time at the end of the gap for `at`.
`source.gap` describes the full span between successful observations, not job end times.
`failures_checked_from` uses the current successful history query's lookback. It is
null when the window is unknown or history could not be collected. A known window
does not guarantee that the scheduler retained every record.

For a known window, the gap threshold is
`max(window - 1 hour, interval + 15 minutes, 1 hour)`, allowing fixed scheduling
slack even for daily collections. Without history or with an unknown window, it is
`max(2 * interval, 1 hour)`. Only job sources produce source gaps.
The service records its heartbeat at most once a minute and reports a gap after more
than five minutes, on startup, a later scheduling tick, or before recording a successful
collection. Source gaps are suppressed when the most recent service gap starts no later
than one collection interval after the last successful observation, allowing another
75 seconds for heartbeat/tick granularity and 120 seconds for a collection in flight,
and the time from service resume to successful
collection is no longer than the source-gap threshold. This includes failed attempts
and retries shortly after waking up. When the accounting window is known, it must also
cover the whole unobserved period; otherwise the source gap remains visible to explain
unchecked history. When the window is unknown or history is unavailable, a covering
service gap suppresses the redundant source gap.
First collections have no source gap; repeated observations use the same deduplication
key. Lookbacks and the Failed tab's 24-hour meaning are unchanged.

`GET /api/events?id=<positive integer>` returns a list containing that exact visible
stored event, or an empty list when missing, expired or silent. With `demo=true` it
reads only example events. The optional id takes precedence over grouping and leaves
the default list response unchanged. The web uses it to restore `?event=<id>` job drawers.

Drivers may supply `Batch.finished` as terminal history, separate from `Batch.failures`
(the retained 24-hour failure list). Finished rows undergo the same row validation but
are not copied into snapshots. `lifecycle_ended` records add an optional normalized
`ended_at` to compare end instants across raw formats without changing event keys; old
records fall back to an offset-bearing `end`. Reconciliation retains only pending departures and recent
ending IDs/times in snapshot lists.

### Collection digests

Individual events remain stored and delivered to third-party handlers unchanged. Notify
combines matching array events of the same type and source in one collection into a
message per rule. Ordinary non-array jobs keep their own messages, including a failure
alongside a large array burst. Non-array catch-up events with `data.since` are combined
separately. Rules filter every child before grouping; silent events are excluded.
Collection identity uses `data.observed_at`, falling back to `at` for legacy rows, never
the job's end time.

The lowest-ID failure outcome leads when present; otherwise the lowest event ID leads.
The leader's template and optional log are used. A translated tail lists failure groups
and their IDs before other outcomes, and names the other jobs, grouped by array, name and outcome, with at most ten groups and
ten additional job IDs; omitted events are counted. Opt-in AI composition receives the
total count, this summary, and template facts for at most twenty siblings, rather than
full sibling records. Full siblings are used only in memory during composition. The
queued message and JSON webhook `event` contain only the leader event; the message body
carries the digest summary. Stored events are unchanged.

Notify records one `grouped` row per digest and rule, with `digest` and `event` (the
leader ID), `events` (the sibling IDs), and `count` (the total number of events including the leader).
This row is reserved with the queued message in one transaction. Channel `sent`/`failed`
records retain the total count including the leader. A suppressed digest gets one
`suppressed` row with the total count, leader ID and sibling IDs. These compact records
preserve the earlier delivery history; replay resolves each sibling to its recorded
leader. A digest spends one rate-limit slot. The last allowed message includes a limit
notice, without exceeding the cap. A zero limit sends no message or notice. Retries use
the existing delivery queue.

`GET /api/events` still returns the plain event list by default. Opt-in `group=1`
collapses three or more non-silent events sharing source, type and observation time.
Each group is an event-shaped row with an additional `group` object: `count`, `ids`,
`first_at`, `last_at`, `names` (up to ten `{name, count}` entries), `outcomes` (outcome
to count for `job.finished`, empty for other types), and `events` containing at most
50 children, with failure outcomes first, then unknown outcomes, then other endings,
newest ID first within each class. `count`, `ids`, names and outcome counts cover the
whole group. `observed_time` is true when any child lacks its own start/end time;
`since` is the collection-gap start for such children, or null. These fields cover
omitted children too, so the time label and failure indicator remain accurate.
The group row's `at` is `last_at`, so Activity sorts it by its latest child time.
`limit` counts display rows. The Activity panel expands groups in place and shows
“and N more” when children are omitted. No event types, database columns or contract
versions were added.

### Activity filters

`GET /api/events` accepts optional `before_id` and `after_id` (exclusive ID cursors),
repeatable `type`, `source_id`, `cluster_id`, `job` (the full stored job ID),
`range=24h|7d|30d`, ISO `since`, and `q` (up to 64 characters). Types must be one of
`TYPES`, `GAP_TYPES` or `CHANGE_TYPES`. Change rows still require `include=changes`,
even with a type filter. All reads exclude silent rows. `limit` remains 1–200 and the
response remains a plain list. The exact `id` lookup takes precedence over filters.

`category=failed|jobs|sources|gaps|changes|plugins` supplies the page's type filters.
Failed includes `job.failed`, `source.failed` and the failure outcomes of `job.finished`.
Sources includes collection failures and recoveries; gaps has its own category.
Plugins currently selects `change.tool` (tool switches and settings), and also requires
`include=changes`; it does not introduce plugin-emitted event types.

Search matches literal substrings in recorded cluster IDs, job IDs and names, source names
and changed-object names. `%` and `_` are literal characters. Cluster/platform scope also
resolves change rows through currently configured sources and manual machines; a deleted
object without recorded scope cannot be matched that way. `since` compares instants,
assuming UTC for an offset-free timestamp; when supplied with `range`, the later cutoff wins.

Filters run before grouping. With `group=1`, the display row ID is the newest matching
child ID. Cursor bounds apply to that display ID, and the whole matching collection is
returned (with the existing 50-child detail cap). Use the last returned display ID as
`before_id` and the first as `after_id`. One- and two-event collections remain individual
rows, so paging through interleaved collections loses no rows. A collection extended since
the previous read can reappear with a newer display ID; clients should refresh it rather
than append a second copy. Stored events and plugin/Notify reads are unchanged.

Known limit: grouped reads scan the event history, so large histories can slow Activity
polls.

## Drivers

A driver turns one configured source into one `Batch`. Built-in drivers are in
`src/computedeck/drivers/` and are good examples: `slurm` and `pbs` (SSH), `kubernetes`
(kubectl), `runpod` and `lambda` (HTTP APIs), `aws-ec2` (a CLI), `ssh` (one machine).

```python
from typing import Any, ClassVar, Literal

from computedeck.sdk import (
    Batch,
    DriverCheck,
    DriverInfo,
    SourceError,
    ssh_alias_field,
    username_field,
)


class TorqueDriver:
    name: ClassVar[str] = "torque"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "Torque cluster"},
        description={"en": "Your jobs, read through SSH."},
        details={"en": "Read-only queries through an SSH host alias on {where}."},
        fields=[username_field(), ssh_alias_field()],
        checks=[DriverCheck(capability="jobs", command="qstat", label={"en": "Your jobs"})],
        beta=True,
    )

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("ssh_alias") or not source.get("username"):
            raise SourceError("cluster_connection_required")

    async def collect(self, source: dict[str, Any]) -> Batch:
        jobs = ...  # read-only queries
        return Batch(jobs=jobs, capabilities=["jobs"])
```

```toml
[project.entry-points."computedeck.drivers"]
torque = "computedeck_torque:TorqueDriver"
```

`info` builds the add-source form: `username`, `ssh_alias` and `credential` are common
fields; any other field key is stored in `source["options"]` (read it with
`computedeck.sdk.options(source)`). `checks` become the first-collection checklist and
the capability tags on the Sources page.

Rules that keep the numbers honest:

- `None` means not collected: `Batch(jobs=None)` is "not collected", `Batch(jobs=[])` is
  "no jobs". Never report an unknown value as zero.
- Raise `SourceError(code, detail)` on failure; the previous results are kept.
- Ids are `<cluster_id>:<id>`, so two logins on one cluster count a job once.
- Fields shown as text (`name`, `user`, `qos`, `node`, `elapsed`, ...) are strings or
  `None`; numbers are stored as text, and a list or object rejects the whole batch.
- Jobs may add `submitted_at` and `started_at` as text or `None`. Offset-bearing
  timestamps identify an instant; scheduler timestamps without an offset remain text
  and must not be interpreted in the viewer's timezone. Missing fields on older rows
  mean unknown. A pending Slurm `StartTime` is an estimate, not an actual start, and is
  not stored as `started_at`.
- Accounting rows may add `exit_status` and `exit_signal` (nonnegative integers or
  `None`). Keep `exit_code` raw: missing normalized fields do not enable exit-code
  heuristics. Slurm splits `status:signal`; PBS values above 256 supply a signal,
  negatives have no program status; LSF supplies a status; Kubernetes supplies the
  container exit status and its explicit signal when present. `reason` retains the
  scheduler reason, including LSF `EXIT_REASON`.
- `ended_at` is the optional offset-bearing end time; legacy `end` retains its meaning
  and event-key format. Optional text fields `time_limit` (duration as reported) and
  `log_path` display only when supplied. Slurm supplies `Timelimit` (unlimited and
  unspecified values are null), PBS supplies `Resource_List.walltime` and `Output_Path`
  unchanged, and Kubernetes formats `spec.activeDeadlineSeconds` as an elapsed duration.
  LSF does not request additional fields for limits or log paths.
- Jobs and accounting rows may add `array_id` and `array_index` (text or `None`).
  Missing fields mean no known array membership; the web app never guesses from a job id.
  `array_id` is scheduler-local and grouped together with `cluster_id`; `array_index` is
  the element index as text. Slurm uses `1234` / `7` for `1234_7`, PBS `1234[]` / `7`
  for `1234[7].server`, and LSF `1234` / `7` for `1234[7]`. Unrecognised forms,
  including Slurm heterogeneous jobs and ranges, remain ungrouped. Kubernetes does
  not set these fields. Existing snapshots and third-party drivers need no change.
- Put optional parts that failed in `Batch.warnings` as `{"code": ..., "detail": ...}`.
- `Batch.history_window_seconds` is an optional nonnegative integer, defaulting to
  `None` (unknown). The collector stores it on the source beside `capabilities`, not
  in the snapshot. Slurm and PBS use 86400; LSF uses the lesser of 86400 and the
  readable `CLEAN_PERIOD` from `bparams -l`, otherwise unknown. Kubernetes leaves it
  unknown because deleted pods are no longer visible. The `history` capability must
  also be present in the current batch before this window describes checked failures.
- Only read. Quote or strictly validate everything placed in a command, and never pass a
  provider's error body on: it may echo secrets.

### A new cloud provider

Cloud GPU providers share most of their work, so a provider is a small subclass of
`CloudDriver`: say where the API is and how the key is sent, then turn the provider's
rows into `CloudInstance`. The base resolves the key reference, maps HTTP failures to
messages without the provider's reply, validates SSH endpoints, tries fallback hosts,
builds the add-source form and records the instances.

```python
from computedeck.sdk import CloudDriver, CloudInstance, parse_ssh_command


class ExampleCloud(CloudDriver):
    name = "example-cloud"
    label = {"en": "Example Cloud", "zh-CN": "示例云"}
    base_url = "https://api.example-cloud.com"
    key_env = "EXAMPLE_CLOUD_API_KEY"  # the form suggests env:EXAMPLE_CLOUD_API_KEY
    auth_scheme = "Bearer"  # "" sends the key alone

    async def instances(self, api, source):
        rows = await api.get("/v1/instances")
        return [
            CloudInstance(
                id=row["id"],
                name=row["name"],
                state="running" if row["status"] == "active" else "unknown",
                gpu_count=row.get("gpus"),
                gpu_type=row.get("gpu_model"),
                hourly_cost=row.get("price_per_hour"),
            )
            for row in rows
        ]
```

Override `account(api, source)` to return `Account(balance=...)` when the provider has a
balance call; it is shown next to the source. `drivers/runpod.py` and `drivers/gpuhub.py`
are complete examples.

Drivers emitting `reported_running` or other SDK values introduced in 0.4 must declare
`requires=">=0.4,<0.7"`, or use `desired_running` on 0.3.

`CloudInstance.state` also accepts `reported_running`: the provider's normal running
report without an observation of readiness, as with RunPod REST. It can still be starting
its image; it is not proof that SSH or the workload is ready. `desired_running` retains
its meaning for transitional or intended running states (for example EC2 pending).

The allocation lifecycle is defined in `drivers/cloud.py` by `INSTANCE_LIFECYCLE` and
`instance_lifecycle(state)`, mirrored in the web app with a parity test:

| Allocation lifecycle | Instance states |
| --- | --- |
| `held` | `running`, `reported_running` |
| `not_held` | `stopped`, `terminated`, `deleted`, `desired_stopped`, `desired_terminated` |
| `unknown` | Everything else, including `desired_running`, `unknown`, `missing` and absent states |

Held instances count their listed `gpu_count`; a missing count or stale source remains
unknown. SSH checks do not replace a provider's allocation with a process count. Existing
stored states are unchanged until the next collection. `PLUGIN_API` and `WEB_API` remain 1.

## Notification channels

The Notifications tool sends to email and webhooks. A plugin can add a channel kind:

```python
from computedeck.sdk import ChannelKind, Message, SettingField, register_channel


async def send(
    config: dict, message: Message
) -> None: ...  # raise SourceError("send_failed") on failure


def setup(ctx):
    register_channel(
        ChannelKind(
            kind="lab-pager",
            label={"en": "Lab pager"},
            fields=(SettingField(key="number", label={"en": "Pager number"}, required=True),),
            send=send,
        )
    )
```

Each delivery, one rule's message to one channel, is stored before it is sent and is sent
on its own: a slow or failing channel holds up no other channel, rule or event. One call
to `send` gets 30 seconds in all, from connecting to the end of the answer; after that it
is cancelled and counts as a failure. Do not retry or wait inside `send`. A failure is
tried again after 20 and then 90 seconds, also after a restart, except a `SourceError`
with the code `credential_unavailable`, `webhook_url_invalid` or `channel_kind_unknown`,
or any other exception, which fail at once. Blocking work belongs in a thread that
cancellation can stop, or the thread keeps running after the attempt is given up.

## Web pages

A plugin package can ship a prebuilt bundle: a folder with `index.js` (and optionally
`index.css`), named by `Plugin.web`. While one of the package's plugins is on, the web app
loads it from `/plugin-web/<package>/`. The bundle is a classic script that uses the page's
React through `window.ComputeDeck` and registers itself:

```jsx
const { components, register } = window.ComputeDeck;

register({
  id: 'lab-alerts',
  requires: 'lab-alerts',            // hidden while this server plugin is off
  pages: [{ id: 'lab-alerts', label: { en: 'Lab alerts' }, icon: Icon, render: (props) => <Page {...props} /> }],
  overview: OverviewCard,             // optional: beside the 24-hour chart at the bottom of the Overview
  settings: SettingsPanel,            // optional: on the Settings page
  banner: Banner,                     // optional: above every page
});
```

`window.ComputeDeck` offers `React`, `jsxRuntime`, `components` (`Panel`, `Empty`, `Status`,
`Switch`, `Chips`, `Stat`, `Meter`, `BrandMark`), `request(path, body?, method?)` for the
API, `format.relativeTime` and `format.dateTime`, `routeHash`, `locale()` and
`localized(text)`. Page components receive `{ request, demo, remote, locale, page, health,
navigate }`. `computedeck plugin new --web` sets up the build: Vite in library mode, IIFE
output, with `react` and `react/jsx-runtime` mapped to `ComputeDeck.React` and
`ComputeDeck.jsxRuntime`. Build the bundle before building the wheel, and include the
folder with `artifacts` (hatch) or package data.

While example data is on, the host's `request` rejects every non-GET request before
fetching, except the access-token check (`POST /session`). This includes requests
from Notify, Chat and plugins. File uploads use the same guard. Reads still return
each tool's own settings and data; the banner says so. Plugins must use the supplied
`request` for API calls. This browser safeguard does not sandbox plugin code or
pause the service's background collectors. Example resource IDs use the `example:`
namespace; example data is never stored.

`request(path, body?, method?)` defaults to GET without a body and POST with one.
An explicit method is honored even without a body, normalized to uppercase, and
every non-GET request includes `X-ComputeDeck: 1`. Turning example mode on adds
`?demo=true` to the URL; turning it off removes that parameter. Either change closes
open dialogs and drawers.

## Instance observations

Dashboard instance rows can carry `last_probe_attempt`, independently of the provider
listing's `observed_at`. The last `ssh_status`, `ssh_error` and check time survive a
listing with the same host, port and user, until the provider reports the instance
released. Provider allocation fields are not overwritten by an SSH check.

Hand-added rows carry `gpu_allocated` (GPUs with visible compute processes or significant
GPU memory use, or null when processes are unreadable or memory is missing without visible
processes) and `probe_warnings`, such as `{"code": "gpu_processes_unavailable", "detail": "rocm-smi"}`.
Their dashboard `state` is `running` while a successful check is less than twenty
minutes old, otherwise `unknown`. Use `summary` for totals: typed-in GPU inventory
is not evidence of use, and hand-added machines with monitoring off are excluded.

## Dashboard summaries

`GET /api/dashboard` (including example data) adds `summary`. Existing dashboard
keys and `WEB_API = 1` remain unchanged. The summary contains fleet figures and the
same figures under `groups[cluster_id]` (or `platform:<lowercase platform>` for
hand-added machines) and `sources[source_id]`:

- `allocated`, `requested`, `running`, `pending` are complete totals or `null`.
  `known_allocated`, `known_requested`, `known_running`, `known_pending` are their
  observed subtotals. A null total must never be displayed as zero.
- `unmeasured` and `queued_unmeasured` name missing allocation and queue evidence as
  `{subject: {kind: "source" | "instance", id, name}, reason: {code}}`. Reason codes
  have English and Chinese translations. `unmonitored` counts excluded hand-added
  machines with monitoring off.
- `utilization` is GPU-weighted, with `covered` measured GPUs. `cpu_utilization` and
  `memory_utilization` are means of available samples. Provider allocation and SSH
  sample freshness are independent.
- `nodes` gives `capacity`, `usable`, `known_usable`, `unavailable` GPU counts,
  allocation and unallocated GPUs **on usable nodes**, node counts, and the oldest
  observation. `usable` is null when node health is partly unknown; `known_usable`
  preserves the subtotal on known usable nodes, displayed as a lower bound.
  `observed_at` is the oldest contributing observation.
  Only enabled, current inventories contribute.
  Each dashboard node has `health: "usable" | "unavailable" | "on_demand" | "unknown"`.
  `on_demand` is an additive state for non-faulty resting Slurm power-saving nodes (with or
  without CLOUD) and PBS provisioning/sleep/wait-provisioning nodes. `nodes.on_demand`
  counts their GPUs (null when their count is unknown), separately from `usable`
  and `unavailable`; they contribute no `unallocated` GPUs. These three capacity
  categories, plus GPUs on unknown-state nodes, partition the total inventory.
  On-demand nodes count as healthy for cluster status and never as `abnormal` nodes.
  Slurm nodes with empty or missing `partitions` are unavailable; other drivers do
  not require a Slurm partition. Faults, including FUTURE/ERROR, always take
  precedence over power-saving flags. FUTURE/ERROR match whole state tokens;
  DYNAMIC_FUTURE alone is not a fault. Nodes with assigned work keep `health: "usable"`
  and their allocation even with power flags. Dashboard nodes also carry the additive
  `health_reason: "no_partition" | null`, explaining missing Slurm membership without
  requiring consumers to infer the scheduler rule.
  The server supplies this shared classification; web consumers should use `health`
  rather than interpreting the raw scheduler state.
- `jobs` supplies `known`, `total` and `missing_source_ids` at every scope. Only the
  fleet-level `summary.jobs` includes `current_ids`, `listed_ids`, `running_ids` and
  `pending_ids`; these lists are not repeated under groups or sources. The running
  and pending IDs select the corresponding tabs from listed jobs using the server's
  state rules. Listed and tab IDs include retained stale jobs; counts exclude those rows.

`unknown_allocation_sources` retains the history coverage count: provider instances
share their login's missing count; unmeasured hand-added machines count individually.
The summary does not add cost accounting or failure-history coverage.

## Dashboard freshness

`GET /api/dashboard` also adds `as_of`, `behind` and `collecting`:

- `as_of` is the oldest enabled source's `last_success`, or null if any enabled
  source has never succeeded (also null when none are enabled). Disabled sources
  and manual probes do not contribute. `updated_at` keeps its previous meaning.
- `behind` lists enabled source IDs without current successful collection, using
  the same freshness rule as the summary, without requiring a specific capability.
- `collecting` lists pending source IDs, sorted. `refreshing` remains unchanged.
  Refresh may still enqueue sources that are not already pending.

Source rows also expose `next_due_at` and `failures` for retry scheduling. A pending
source may still be queued; only `status: "syncing"` means collection has started.

The optional health fields `background_errors` and `unreadable_rows` are now typed
for web plugins. Collector scheduling errors use `collector:schedule`; commit
errors use `collector:commit:<source_id>`. A clean scheduling pass or a successful
commit for that same source clears its error. Commit errors are also cleared when
the source is deleted or disabled. Unreadable rows are reported by table; consult
the service log for details.

## Connection-check progress

`POST /api/sources/{source_id}/check` keeps its existing JSON list response by default.
With `Accept: application/x-ndjson`, it streams newline-delimited objects containing
`rows`, a list of the accumulated checks identified by `id`; the final object also has
`done: true`. Each check reports a `state` of `checking`, `ok`, `failed` or `missing`
(for an unavailable optional capability).
Use these updates to replace prior rows with the same ID. Closing the request cancels
the check. It uses the existing authentication and write checks and does not establish
a successful collection or replace the source snapshot.

## Dashboard attention

`GET /api/dashboard` adds an `attention` list, also present in example data. It is
computed on read, with acknowledgement state stored separately and no new events. Each
item has `key`, `kind`, `subject: {kind, id, name}`, `severity` (`error` or `warn`), a
translatable `message`, all relevant `details`, nullable `since`, `observed_at` and
`next_attempt` times, and an `action` (`diagnose`, `instance`, `health`, `toolbox` or
`notify`). Each item also has a `fingerprint` and a boolean `mutable` (false for
service-loop faults and unreadable rows), plus nullable `muted`: `{state: "acknowledged"
| "snoozed", at, until}`. `at` is the action time; `until` is the snooze expiry or null.
All items remain in the list. The additive `attention_count` is the number with `muted
== null`, used by the tile, badge and panel.

`PUT /api/attention/{key}` accepts `{action: "acknowledge" | "snooze" | "clear", until?:
"1h" | "tomorrow", fingerprint?: string | null}` under the usual origin and
`X-ComputeDeck` checks. Snooze requires `until`; tomorrow means the next midnight in the
service host's timezone. Unknown or resolved keys return 404 (`attention_not_found`);
`service_loop_failed` and `unreadable_rows` return 422 (`attention_not_mutable`) for every
action. Example mode refuses writes in the web request layer; example keys are absent from
the live list and return 404.

For acknowledge and snooze, a supplied fingerprint must match the current item or the
request returns 409 (`attention_changed`) without saving acknowledgement state. Omitting
it preserves the behaviour of acknowledging the current item; clear ignores it. The web
sends the displayed fingerprint and reloads the dashboard after every attention action,
including failures, while showing any error.

The fingerprint covers kind, severity, message parameters except the name, and structured
detail codes/statuses. Free-text errors and observation times are excluded. A different
fingerprint or expired snooze reopens the item on read, changing the dashboard content
token. Resolved or changed state is cleared after collection commits, machine checks,
attention actions, source or machine edits/removals, and tool updates. Unreadable rows
in the disposable acknowledgement table are deleted during this cleanup. Cleanup failures
are logged without changing a completed collection or machine check's outcome.
GET never writes acknowledgement state. The additive
`attention_state` table uses `CREATE TABLE IF NOT EXISTS`, with no schema-version bump.
Acknowledgement is shared by viewers and does not change source health or event delivery.

`since` is the last success for `source_failed` and `source_stale` (no good data
since that collection), otherwise null. `observed_at` is the latest observation,
not the incident onset: the latest attempt for collection failures, the last
success for stale data and source conditions, the SSH check time, or the recorded
loop error time. Both fields are null for unreadable rows and plugin health errors.
Capability regressions include the machine-readable `capability` and the driver's
check `command` in the message; the UI displays the command.

Kinds are `source_failed`, `source_stale`, `cluster_unavailable`,
`cluster_degraded`, `capability_regressed`, `partial_data`, `instance_ssh_failed`,
`service_loop_failed`, `unreadable_rows`, `plugin_error` and `notification_failed`. Plugin
errors use the existing health report's `error` key; Notify channel failures use its
`delivery_failures` key, described below. There is no general plugin-raised attention API.
A first collection failure produces a warning item; repeated failures or stale
data escalate it to an error.
Source rows gain `capabilities_seen`, the union of capabilities delivered by
successful collections. Older rows need no migration: their current capabilities
seed the union on the next successful collection. Connection changes through
source edits or configuration import clear both current and seen capabilities;
name, interval and enabled edits preserve them. Connection changes also clear
warnings and cluster state from the old connection. `Batch.cluster_state` is honored
as reported by the driver; retained node inventories do not override it. Built-in
drivers classify availability over GPU-capable nodes (unknown or positive GPU counts).
Enabled toggles clear the collection error and retry count, resetting status to
`ready` or `unconfigured`, clearing last success to establish a silent event baseline
on the next collection. Current and seen capabilities are preserved.

## Notification delivery status

Notify health adds `delivery_failures`, a list of `{channel, channel_name, error_code,
at}` for configured channels whose latest recorded attempt in the last 24 hours failed.
It reads the retained 500 delivery-log rows and pending retries. Retry records now keep
`last_attempt_at` and a code-only `last_error` in the existing queue JSON, so a restart
keeps their warning. Older pending records without these fields remain unknown until
another attempt. A later successful attempt (including Send test), removal of the channel,
or expiry of the 24-hour window clears the warning. Switching Notify off hides it.
No channel configuration, recipient address or error detail is copied into this list.

The dashboard lifts these failures as `notification_failed` warning items, labelled as
Notifications and linking to its page (`action: "notify"`). Their keys are
`notification_failed:notify:<channel>`. `observed_at` is the latest failed attempt;
`since` stays null because the start of the failure is unknown. The displayed error code
participates in acknowledgement matching; channel renames and timestamps do not.
This is specific to Notify, not a new plugin attention API.

`GET /api/events?delivery=true` adds a `delivery` list of distinct recorded outcomes:
`sent`, `failed`, `suppressed`, `grouped` and `dropped`. Default event reads are unchanged.
The lookup uses existing log `event` IDs and digest sibling `events` IDs; it does not
rewrite events or deliver new event types. Per rule/channel the newest outcome wins;
different channels and rules may produce different outcomes for the same event.
Grouped rows summarize all their IDs, including children omitted from the display cap,
and displayed children carry their own outcomes. `grouped` means included in a digest,
not successfully delivered. Channel outcomes (`sent`, `failed`, `dropped`) attach to
the leader; siblings carry `grouped`, or `suppressed` for a rate-limited message.
The aggregate row still shows all recorded outcomes across its members.

Only retained, linked log records contribute. An absent/empty list means no retained
outcome is known, not that nothing was sent. Test messages and records without an event
ID do not attach to Activity. Example mode uses fictional outcomes only. No subjects,
message bodies, channel settings or error details are added to the event response.
No table, schema version or plugin API version changes are needed.

## Marketplaces

A marketplace is a `computedeck-marketplace.json` file at the root of a git repository, at
an https address, or in a folder. The format follows Claude Code's `marketplace.json`:

```json
{
  "name": "example-lab",
  "owner": { "name": "Example Lab" },
  "plugins": [
    {
      "name": "lab-alerts",
      "display_name": { "en": "Lab alerts", "zh-CN": "实验室提醒" },
      "description": { "en": "Posts failed jobs to the lab chat." },
      "version": "1.0.0",
      "source": { "type": "pypi", "package": "computedeck-lab-alerts", "version": "1.0.0",
                  "sha256": ["<sha256 of the wheel>"] },
      "permissions": [{ "en": "posts failed jobs to the lab chat" }],
      "requires": ">=0.3,<0.7",
      "license": "MIT",
      "homepage": "https://example.com/lab-alerts"
    }
  ],
  "renames": {}
}
```

Sources must be pinned: `pypi` (package and exact version, sha256 recommended), `wheel`
(https URL and sha256), `git` (URL and a 40-character commit `sha`, optional
`subdirectory`; built from source) or `path` (inside the marketplace folder; for private
and local catalogs).

```bash
computedeck plugin marketplace add example-lab/computedeck-plugins   # or a URL or folder
computedeck plugin search alerts
computedeck plugin info lab-alerts
computedeck plugin install lab-alerts@example-lab
computedeck plugin list
computedeck plugin uninstall lab-alerts
```

Installing shows where the plugin comes from, how it will be installed and what it says it
will do, and asks before going on. It installs into the environment ComputeDeck runs in
(with uv when available, otherwise pip), takes wheels only from PyPI, and checks hashes.
It never installs or uninstalls ComputeDeck, a package it depends on, or a package that
was installed some other way. Restart ComputeDeck afterwards. The web app's Toolbox lists marketplaces and their plugins
but does not install anything: anyone who can open the page could otherwise run code on
the machine.

Each added catalog is checked again when it is read. One that an earlier version of
ComputeDeck accepted but this one does not is marked as unreadable, with the reason, in
`plugin marketplace list`, `plugin search` and the web app; the other marketplaces work as
usual. `computedeck plugin marketplace update NAME` reads it again.

The tier shown next to a plugin comes from where its catalog was added, never from the
catalog itself: **internal** (named in `policy.toml`), **community** (any other
marketplace), **local** (a folder) and **official** (the ComputeDeck project's catalog).

### policy.toml

An owner or administrator can put `policy.toml` in the data directory:

```toml
allowed_marketplaces = ["https://github.com/example-lab/*"]   # only these may be added
blocked_marketplaces = []
internal_marketplaces = ["https://github.com/example-lab/*"]  # shown as Internal
blocked_plugins = ["unwanted-tool", "risky@*", "*@untrusted"] # names, name@market or packages
allow_local = true                                            # folder marketplaces and sources
```

Names compare as Python packages do (`Evil.Pkg`, `evil_pkg` and `evil-pkg` are the same).
Blocked plugins are not loaded. A policy file that cannot be read blocks every plugin
not shipped with ComputeDeck.

## Before you publish

- `computedeck plugin validate .` passes, with names, permissions and `requires` set.
- Secrets are credential references; nothing secret is logged, stored or returned.
- Collected data uses `None` for unknown, and failures raise `SourceError`.
- The web bundle is built into the wheel and uses the page's React.
- The marketplace entry pins the source and lists the same permissions.

## Persistent plugin data and SSH

Import `Plugin`, `PluginContext`, `now`, `ssh_command`, and `SSHBusyError` from
`computedeck.sdk`. `now()` returns an aware UTC ISO timestamp. `ssh_command` executes
a strict, non-interactive SSH command; wrap it in `asyncio.timeout` to set your timeout.
Use `wait=False` to raise `SSHBusyError` when another operation is using that destination.
The separate `parse_ssh_command` parses a provider's connection string without executing it.

```python
ctx.set_state("last_refresh", {"at": now()})
previous = ctx.get_state("last_refresh", {})
with ctx.database() as db:
    db.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)")
    db.execute("INSERT INTO notes(body) VALUES (?)", ("Example note",))
```

Each plugin owns its directory and SQLite database, created with modes 700 and 600.
The database context commits on success, rolls back on exceptions, and closes the connection.
Keep transactions short and do not hold one across an `await`. `plugin_state` is reserved
for the key/value helpers; use your own names for other tables. Use `ctx.sources()` to
read source settings, rather than importing `computedeck.store`. Installed plugins are
trusted Python code: this storage separation is not an operating-system sandbox.

Core database backups do not include the separate plugin directories. Include each plugin's
files and SQLite database in your own backups while its database connections are closed.

## Machine check results

Manual instance edits and config imports retain check results and measurements for an
unchanged connection (host, port, username, identity file and alias mode). Changed
connections start unverified. Provider listing carryover keeps its existing semantics.
The SSH source driver also sets `last_probe_attempt` on a successful collection; clients
use it, rather than `observed_at`, to decide whether an SSH check is recent.

Machine check failures return HTTP 502 and store a structured `ssh_error`. Known causes
use `ssh_authentication`, `ssh_host_key`, `ssh_network`, `ssh_refused`, `ssh_timeout` or
`ssh_closed` (including connection resets); unclassified SSH failures use `ssh_failed`.
The optional `detail` remains the remote diagnostic. Checks use two slots independent of
source collection and retry only `ssh_timeout` and `ssh_closed` once after two seconds.
Only the final result is saved.
No API or database version changes are required.

## Dashboard polling

Every full `GET /api/dashboard` response includes `token`, a short SHA-256 of the serialized
response before the token is added. Send it back as `?since=<token>` (alongside
`demo=true` for example data). When the content matches, the service returns HTTP
200 with `{"unchanged": true, "token": "..."}`; otherwise it returns the complete
dashboard and its new token. Callers without `since` always receive the complete
response, including `history`. Responses still use `Cache-Control: no-store`;
there are no ETags or 304 responses. The token covers time-derived freshness,
summaries, attention, the sliding history window and pending collections, so it
can change without a database write. Live and example data have separate tokens;
example timestamps advance once per minute.

Keep health reports cheap and avoid changing error text on every call (for example,
by embedding the current time). Plugin health errors feed attention and therefore
the dashboard token; a changing error prevents unchanged responses.

The web pauses polling while hidden and reloads on visibility or focus. Requests
made through its request function while the page is hidden wait until it is
visible again; this includes plugin requests and writes. Visible requests do
not wait for visibility. Hidden GETs to the same path share one request on return,
with a separate response body for each caller; writes remain separate.

Visible dashboard polls run every ten seconds, or every second for up to sixty
seconds after Refresh or starting collection for an added source. Fast polling stops
when the targeted sources leave `collecting`; unrelated collections do not prolong a
source-specific follow-up. Probe and manual-add responses complete before one reload.
The paired visibility and focus events on return trigger only one refresh. Health, toolbox and
collection-machine status keep their ten-second cadence; `/api/health` checks
only the managed SSH include prefix, without building a dashboard. Activity
polls every fifteen seconds and when the dashboard token changes. Relative ages
continue to advance even when the dashboard is unchanged.

SSH-source instances may include optional `gpus_observed_at` and `gpus` rows with
`index`, `name`, `utilization`, `memory_used_mb`, `memory_total_mb`, `processes`,
`in_use: true | false | null`, and `processes_omitted`. Process rows retain their existing
`pid`, `user`, and `memory_mb` fields, with at most 16 rows per GPU. Missing fields in
older snapshots mean unknown. See [the SSH driver](drivers/ssh.md#per-gpu-availability)
for the memory-floor rule and timestamp semantics. No API or schema version changes.
