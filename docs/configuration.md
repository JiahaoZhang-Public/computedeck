# Configuration file

Everything you set in the app can also be written as TOML and imported:

```sh
computedeck import config.toml     # create or update; nothing is deleted
computedeck export > config.toml   # current sources, instances and settings
```

Import keeps the collected data and state of sources that already exist. Run it while the service is stopped, or refresh in the app afterwards. A complete example is in [examples/config.toml](../examples/config.toml).

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
| `monitoring` | Read GPU, CPU and memory over SSH every 10 minutes. |

## Credentials

Sources hold references, never secrets:

- `env:RUNPOD_API_KEY` — an environment variable of the service process. When the service runs as a login service, put the variable in its environment (launchd plist or systemd unit).
- `keychain:computedeck/runpod` — the system keychain through the `keyring` package (macOS Keychain, or Secret Service on Linux desktops). Store it with `keyring set computedeck runpod`.
- `file:~/.config/computedeck/runpod` — a file that only its owner can read (`chmod 600`); refused otherwise. Useful on servers and collection machines without a keychain.

A source collected on a collection machine resolves its reference there.

Plugins can add further schemes.
