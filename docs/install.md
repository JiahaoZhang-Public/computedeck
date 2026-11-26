# Install ComputeDeck

ComputeDeck is one Python package with the web app built in. It runs on your own
computer (or a server you choose) and listens on `http://127.0.0.1:8710`.

## Requirements

- macOS or Linux. Windows is not supported.
- Python 3.12 or 3.13. [uv](https://docs.astral.sh/uv/) can download one for you.
- The OpenSSH client (`ssh`), for clusters and SSH machines. Each SSH alias you add must
  log in without prompts (a key or an agent, and a known host key).
- Node.js 22.18+ or 24, only to build from source. A release needs no Node.js.

## Install a release

> These commands need a published release. If the Releases page lists none yet, use [Run
> from source](#run-from-source) or [build a wheel yourself](#build-a-wheel-yourself).
> ComputeDeck is not on PyPI, so `pip install computedeck` or `uv tool install computedeck`
> does not install it.

Each release on the [Releases page](https://github.com/JiahaoZhang-Public/computedeck/releases)
has a wheel, `computedeck-<version>-py3-none-any.whl`, with the web app already built, and
the matching sdist. Install the wheel as a tool, with uv or pipx, replacing `<version>`
(for example `1.0.0`) in both places:

```bash
uv tool install https://github.com/JiahaoZhang-Public/computedeck/releases/download/v<version>/computedeck-<version>-py3-none-any.whl
```

```bash
pipx install https://github.com/JiahaoZhang-Public/computedeck/releases/download/v<version>/computedeck-<version>-py3-none-any.whl
```

A downloaded file works the same way: `uv tool install ./computedeck-<version>-py3-none-any.whl`.
If the shell cannot find `computedeck` afterwards, run `uv tool update-shell` (or
`pipx ensurepath`) and open a new terminal.

Check what is installed, then start it:

```bash
computedeck --version
```

```bash
computedeck serve --open
```

### Upgrade

Install the newer wheel over the old one. Your data directory is kept.

```bash
uv tool install https://github.com/JiahaoZhang-Public/computedeck/releases/download/v<new version>/computedeck-<new version>-py3-none-any.whl
```

```bash
pipx install --force https://github.com/JiahaoZhang-Public/computedeck/releases/download/v<new version>/computedeck-<new version>-py3-none-any.whl
```

Make a backup first under **Settings → Backup**. A running service keeps the old version
until it restarts: stop `computedeck serve` and start it again, or, for a [login
service](#run-at-login), run `computedeck service install` again on macOS or
`systemctl --user restart computedeck.service` on Linux. Upgrade [collection
machines](deployment.md#add-a-collection-machine) too: they must run the same minor version.

### Uninstall

```bash
computedeck service uninstall   # only if you installed the login service
uv tool uninstall computedeck   # or: pipx uninstall computedeck
```

This leaves your data directory in place. Delete it to remove your history, settings and
access token as well.

## Run from source

This works today. It needs Node.js to build the web app.

```bash
git clone https://github.com/JiahaoZhang-Public/computedeck.git
cd computedeck
uv sync --frozen
npm --prefix web ci
npm --prefix web run build
uv run computedeck serve --open
```

Inside the checkout, put `uv run` before every `computedeck` command in these docs. To
update, run `git pull`, repeat the `uv sync`, `npm ci` and `npm run build` steps and restart
the service.

### Build a wheel yourself

From a checkout, `bash scripts/build.sh` builds the web app and writes a wheel and an sdist
to `dist/`. Install that wheel as a tool, exactly like a release:

```bash
bash scripts/build.sh
uv tool install dist/computedeck-*.whl
```

`bash scripts/smoke-wheel.sh dist/computedeck-*.whl` checks a built wheel the way a user
would use it: it installs it in a fresh virtual environment, starts the service and loads
the web app.

## Where your data lives

| System | Data directory |
|---|---|
| macOS | `~/Library/Application Support/ComputeDeck` |
| Linux | `~/.local/share/ComputeDeck` (or `$XDG_DATA_HOME/ComputeDeck`) |

Set `COMPUTEDECK_DATA_DIR` to use another directory. It holds the database
(`computedeck.sqlite`), logs, backups, the access token and installed plugins, and is
readable only by you. Sources hold credential references such as `env:RUNPOD_API_KEY`,
never the keys themselves. Uninstalling ComputeDeck does not delete this directory.

## Run at login

```bash
computedeck service install            # optional: --port 8710
computedeck service uninstall
```

On macOS this is a launchd agent that runs while you are logged in; on Linux a
`systemd --user` service (run `loginctl enable-linger $USER` once to keep it running after
you log out). The service uses the Python of the ComputeDeck that installed it, so after
switching from a source checkout to a release, run `computedeck service install` again
from the new installation. Credentials given as `env:` references must be in the
service's environment; see [configuration](configuration.md#credentials). [Running
ComputeDeck](deployment.md) covers servers, routes, the access token and backups.

## Next steps

- Turn on **Example data** to look around without connecting anything.
- Add a cluster, cloud account or SSH machine under **Sources → Add source**; see
  [configuration](configuration.md) and the [Slurm setup guide](drivers/slurm.md).
- A source this computer cannot reach directly can go through another machine: see
  [routes](deployment.md#2-routes-sources-through-another-machine).
- Already running ComputeDeck on a server? `computedeck import --from my-server` adopts its
  sources here; see [moving from a server to your
  laptop](deployment.md#moving-from-a-server-to-your-laptop).
- `computedeck doctor` checks the data directory, the service port, plugins and every
  source; the [diagnostics guide](doctor.md) explains the results.
