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
    requires=">=0.3,<0.4",  # ComputeDeck versions it supports
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
| `job.started` | a pending job is running | `job` |
| `job.ended` | a job left the queue | `job` (as last seen) |
| `job.failed` | a job ended with a failure in the last day | `job` with `exit_code`, `end` |
| `source.failed` | a source that worked could not be collected | `error` |
| `source.recovered` | a failing source was collected again | |

Every event has `id`, `type`, `at`, `source_id` and `data` with `source_name`,
`cluster_id`, `username` and `driver`. The first collection of a new source records what
already exists without delivering it.

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
- Put optional parts that failed in `Batch.warnings` as `{"code": ..., "detail": ...}`.
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
  overview: OverviewCard,             // optional: beside the overview chart
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
  Each dashboard node also gains `health: "usable" | "unavailable" | "unknown"`.
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

The optional health fields `background_errors` and `unreadable_rows` are now typed
for web plugins. Collector scheduling errors use `collector:schedule`; commit
errors use `collector:commit:<source_id>`. A clean scheduling pass or a successful
commit for that same source clears its error. Commit errors are also cleared when
the source is deleted or disabled. Unreadable rows are reported by table; consult
the service log for details.

## Dashboard attention

`GET /api/dashboard` adds an `attention` list, also present in example data. It is
computed on read, without stored inbox state or new events. Each item has `key`,
`kind`, `subject: {kind, id, name}`, `severity` (`error` or `warn`), a translatable
`message`, all relevant `details`, nullable `since`, `observed_at` and `next_attempt` times, and an
`action` (`diagnose`, `instance`, `health` or `toolbox`). All attention counts use
this list's length.

`since` is the last success for `source_failed` and `source_stale` (no good data
since that collection), otherwise null. `observed_at` is the latest observation,
not the incident onset: the latest attempt for collection failures, the last
success for stale data and source conditions, the SSH check time, or the recorded
loop error time. Both fields are null for unreadable rows and plugin health errors.
Capability regressions include the machine-readable `capability` and the driver's
check `command` in the message; the UI displays the command.

Kinds are `source_failed`, `source_stale`, `cluster_unavailable`,
`cluster_degraded`, `capability_regressed`, `partial_data`, `instance_ssh_failed`,
`service_loop_failed`, `unreadable_rows` and `plugin_error`. Plugin errors use the
existing health report's `error` key; plugins do not raise attention items.
Source rows gain `capabilities_seen`, the union of capabilities delivered by
successful collections. Older rows need no migration: their current capabilities
seed the union on the next successful collection. Connection changes through
source edits or configuration import clear both current and seen capabilities;
name, interval and enabled edits preserve them. Connection changes also clear
warnings and cluster state from the old connection.

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
      "requires": ">=0.3,<0.4",
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
