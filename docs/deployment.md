# Running ComputeDeck

## On your own computer

```sh
uv run computedeck serve --open
```

The service collects only while it runs. Closing the browser does not stop it.

## As a login service

```sh
uv run computedeck service install [--port 8710]
uv run computedeck service uninstall
```

- **macOS** writes `~/Library/LaunchAgents/local.computedeck.service.plist`. The service runs while you are logged in, including with the screen locked.
- **Linux** writes `~/.config/systemd/user/computedeck.service`. To keep it running after you log out, run `loginctl enable-linger $USER` once.

The service runs with your user account, so it uses your `~/.ssh/config`, your SSH agent (if its socket is available to the service) and your keychain. Collection stops while the machine sleeps; a machine that should collect around the clock must not sleep automatically.

When asked to stop, the service waits at most 10 seconds for requests in flight (a browse of an unreachable machine, say), then cancels them and its background work. The service files give it 30 seconds (`ExitTimeOut` for launchd, `TimeoutStopSec` for systemd) before it is killed.

## On a server, viewed from a laptop

Install the service on the server as above, then on your laptop:

```sh
uv run computedeck connect my-server
```

This starts `ssh -N -L 127.0.0.1:8711:127.0.0.1:8710 my-server`, reads the server's access token with `ssh my-server computedeck token`, and opens the page: signed in with that token when the server asks for one, directly when it does not. Press Ctrl-C to disconnect; the server keeps collecting. Use `--remote-port` and `--local-port` if the ports differ. If `computedeck` is not on the server's `PATH` for non-interactive SSH, pass `--token-command "~/.local/bin/computedeck token"`, set `COMPUTEDECK_TOKEN`, or paste the token into the page. Avoid `--token <value>` on shared machines: other users can see command-line arguments.

In remote mode:

- SSH checks of instances run on the server, with the server's keys.
- **SSH configuration** produces a file for your laptop without the server's key paths.
- Backups are written on the server.

Set `server_name` in the configuration to control the name shown in the app.

## Collection machines

One ComputeDeck (the one you open) can collect some sources on other machines: a cluster
reachable only through one machine's VPN, a key that lives only there. Install ComputeDeck
on that machine (no service needed), make sure the machine you open reaches it with a
non-interactive `ssh <alias>`, then add it under **Sources → Collection machines** and pick
it as **Collected by** for those sources. **Check** runs `computedeck collect` there and
shows its version and drivers.

Each collection runs `<command> collect` over SSH, sends the source's connection settings
on standard input and reads one JSON result back. The machine uses its own drivers, SSH
configuration, credentials and network; results, history, events and notifications stay
on the machine you open. Keep both on the same minor version; a different one is reported
on the source.

In a configuration file:

```toml
[[node]]
name = "Lab gateway"
ssh_alias = "lab-gateway"
command = "~/.local/bin/computedeck"

[[cluster]]
label = "Cluster B"
username = "alice"
ssh_alias = "cluster-b"   # an alias on the lab gateway
node = "lab-gateway"
```

## Tools, plugins and policy

Tools that come with ComputeDeck (Notifications, Team messages) start switched
off; turn them on under **Toolbox**, which says what each will do. Plugins are
installed on the service machine with `computedeck plugin install` and loaded after a
restart; see [plugins.md](plugins.md). An administrator can put `policy.toml` in the data
directory to allow only certain marketplaces and to block plugins.

## Environment variables

| Variable | Default |
|---|---|
| `COMPUTEDECK_DATA_DIR` | platform user data directory |
| `COMPUTEDECK_PORT` | `8710` |
| `COMPUTEDECK_WEB_DIR` | the web app bundled with the package |
| `COMPUTEDECK_LOG_LEVEL` | `info` |
| `COMPUTEDECK_AUTH` | `off`; `token` makes every API request carry the access token (turn it on when other people have accounts on the machine that runs the service). Other values are refused, so a misspelling does not leave the service open |
| `COMPUTEDECK_BACKUPS` | `10`: backups kept in `<data dir>/backups` |

## Access token

Off by default. The service binds to `127.0.0.1`, which keeps other machines out, and accepts only the host names `127.0.0.1` and `localhost` and writes only from its own page (Origin and an `X-ComputeDeck` header), which keeps other websites out. That does not keep out other users of the same machine. On a machine shared with other people, set `COMPUTEDECK_AUTH=token`: every `/api` request then needs the token in `<data dir>/api-token` (mode 0600, created on first start). The token never appears in a URL or on a command line. `serve --open` and `connect` open a short-lived private page (mode 0600) in the data directory that posts a browser session token to `/api/session` (`serve --open` only once the listener has proved it is the process just started); the service checks it and answers with a page that stores it in `localStorage`, which belongs to that exact origin (host and port). Cookies are not used, because browsers send `127.0.0.1` cookies to every port, including servers run by other users. Before sending a stored session token, the page has the service prove it issued it (`/api/ping?session_challenge=`, an HMAC keyed by the session token); otherwise it forgets the token and asks you to sign in again. Opened any other way, the page asks for the token; `computedeck token` prints it. Scripts can send it in the `X-ComputeDeck-Token` header. Delete the file and restart the service to issue a new token. A file that holds no token (empty, blank, or anything but 16 to 512 letters, digits and `-._~+/=`) is replaced with a new token in the same way, and the replacement is logged.

## Backups and restore

**Settings → Backup** writes a consistent copy to `<data dir>/backups` and keeps the newest 10 (`COMPUTEDECK_BACKUPS`); older copies it wrote are removed. To restore, stop the service, copy a backup to a new data directory as `computedeck.sqlite`, and start the service with `COMPUTEDECK_DATA_DIR` pointing there. Backups contain no secrets; credential references must still resolve on the machine.

A database row that cannot be read (damaged, or written by a broken tool) is skipped rather than stopping the service: it is logged once, and `/api/health` counts such rows by table under `unreadable_rows`. A tool whose setup or startup fails is reported in the Toolbox; the rest of the service keeps running.

## Logs and startup permissions

The service writes application and uvicorn messages to `service.log` in its data directory.
Logs rotate at 5 MiB, keeping the active file and four backups (`service.log.1` through `.4`).
Existing oversized logs are retained when first rotated and expire as the backups turn over.
Log files are mode 600, including newly opened files after rotation. Startup restricts an
existing data directory to mode 700 and logs any permission correction.

New `computedeck service install` templates discard stdout and send only startup stderr to
`startup.log`; regular service logs go through the rotating handler. Reinstall the login
service to update an older template. On Linux the file is managed by systemd's `append:`
output mode; on macOS launchd uses `StandardErrorPath`.

Run [doctor](doctor.md) before changing a connection. Missing optional capabilities such as
accounting history do not count as failed sources; connection failures and stale data do.
