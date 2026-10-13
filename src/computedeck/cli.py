"""Command line: run the service, manage configuration, install a login service, connect."""

import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import paths, plugin_cli


def _with_data_dir(args: argparse.Namespace) -> None:
    if args.data_dir:
        # Absolute, because service files run from a different working directory.
        os.environ["COMPUTEDECK_DATA_DIR"] = str(Path(args.data_dir).expanduser().resolve())


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        port = 0
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError(f"{value} is not a port number (1-65535)")
    return port


def _open_page(
    port: int, token: str | None, *, next_path: str = "/", name: str, nonce: str | None = None
) -> bool:
    """Open the web app; a token travels only inside a private launcher file.

    With ``nonce``, only when the listener is the service process that has it.
    """
    from . import auth

    if token is None:
        if nonce is not None and not auth.matches(nonce, auth.service_nonce(port)):
            print(f"Another program answers on port {port}; not opening it.", file=sys.stderr)
            return False
        webbrowser.open(f"http://127.0.0.1:{port}{next_path}")
        return True
    try:
        session_token = auth.browser_session(port, token, nonce)
    except ValueError as error:
        print(error, file=sys.stderr)
        return False
    if session_token is None:
        webbrowser.open(f"http://127.0.0.1:{port}{next_path}")
        return True
    page = auth.launcher(paths.data_dir(), port, session_token, next_path=next_path, name=name)
    webbrowser.open(page.as_uri())
    # The browser reads the file right away; do not leave the token lying around.
    timer = threading.Timer(60, lambda: page.unlink(missing_ok=True))
    timer.daemon = True
    timer.start()
    return True


def _wait_for_port(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def serve(args: argparse.Namespace) -> int:
    _with_data_dir(args)
    from . import auth
    from .app import serve as run

    port = args.port or paths.port()
    ready: Callable[[str], None] | None = None
    if args.open:
        token = auth.ensure_token(paths.data_dir()) if auth.enabled() else None

        def open_page(nonce: str) -> None:
            # Only this process: never whatever else may answer on the port.
            _open_page(port, token, name="open.html", nonce=nonce)

        ready = open_page
    if not run(port=port, ready=ready):
        print(
            f"ComputeDeck did not start on 127.0.0.1:{port} (see above); nothing was opened.",
            file=sys.stderr,
        )
        return 1
    return 0


def doctor(args: argparse.Namespace) -> int:
    from .doctor import run

    return run(paths.data_dir(), args.port or paths.port(), args.source, args.json, args.language)


def import_config(args: argparse.Namespace) -> int:
    _with_data_dir(args)
    from .config import ConfigError, apply
    from .plugins import Runtime, discover, load
    from .store import Store

    store = Store(paths.data_dir() / "computedeck.sqlite")
    runtime = Runtime(paths.data_dir())
    runtime.store = store
    # Plugins that are on may register credential schemes that the file refers to.
    load(discover(paths.data_dir()), runtime)
    try:
        counts = apply(store, Path(args.file).read_text(encoding="utf-8"))
    except (ConfigError, OSError, UnicodeError) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1
    finally:
        store.db.close()
    print(f"Imported {counts['sources']} sources and {counts['instances']} instances.")
    return 0


def export_config(args: argparse.Namespace) -> int:
    _with_data_dir(args)
    from .config import export
    from .store import Store

    store = Store(paths.data_dir() / "computedeck.sqlite")
    try:
        sys.stdout.write(export(store))
    finally:
        store.db.close()
    return 0


def service(args: argparse.Namespace) -> int:
    _with_data_dir(args)
    from . import service as login_service

    try:
        if args.action == "install":
            print(login_service.install(args.port or paths.port(), paths.data_dir()))
        else:
            print(login_service.uninstall())
    except login_service.ServiceError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


def token(args: argparse.Namespace) -> int:
    """Print the API token of this data directory, for the page's token form or scripts."""
    _with_data_dir(args)
    from . import auth

    print(auth.ensure_token(paths.data_dir()))
    if not auth.enabled():
        print("The service does not ask for it unless COMPUTEDECK_AUTH=token.", file=sys.stderr)
    return 0


def _remote_token(host: str, command: str) -> str | None:
    """Ask the server for its token over SSH; None if that is not possible."""
    try:
        result = subprocess.run(
            ["ssh", "-T", "-o", "BatchMode=yes", "--", host, command],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and value and value.isprintable() else None


def connect(args: argparse.Namespace) -> int:
    """Forward a remote ComputeDeck service to this computer over SSH and open it."""
    if not shutil.which("ssh"):
        print("OpenSSH client (ssh) is required.", file=sys.stderr)
        return 1
    if _wait_for_port(args.local_port, 0.1):
        print(f"Local port {args.local_port} is already in use.", file=sys.stderr)
        return 1
    forward = f"127.0.0.1:{args.local_port}:127.0.0.1:{args.remote_port}"
    tunnel = subprocess.Popen(
        ["ssh", "-N", "-T", "-o", "ExitOnForwardFailure=yes", "-L", forward, "--", args.host]
    )
    try:
        if not _wait_for_port(args.local_port, 20) or tunnel.poll() is not None:
            print("The SSH tunnel did not start.", file=sys.stderr)
            return 1
        secret = (
            args.token
            or os.environ.get("COMPUTEDECK_TOKEN")
            or _remote_token(args.host, args.token_command)
        )
        if tunnel.poll() is not None:
            print("The SSH tunnel stopped while reading its token.", file=sys.stderr)
            return 1
        url = f"http://127.0.0.1:{args.local_port}/?remote=1"
        if secret:
            print(f"Connected to {args.host}. Open {url}  (Ctrl-C to disconnect)")
        else:
            print(
                f"Connected to {args.host}, but its access token could not be read with "
                f"`{args.token_command}`. Run `computedeck token` on the server and paste it "
                f"into the page. Open {url}  (Ctrl-C to disconnect)"
            )
        if not args.no_browser:
            if not _open_page(
                args.local_port,
                secret,
                next_path="/?remote=1",
                name=f"connect-{args.local_port}.html",
            ):
                return 1
        return tunnel.wait()
    except KeyboardInterrupt:
        return 0
    finally:
        if tunnel.poll() is None:
            tunnel.terminate()
            tunnel.wait(timeout=5)


def collect(args: argparse.Namespace) -> int:
    """Answer one request from a hub on standard input; used over SSH, not by people."""
    from . import nodes
    from .plugins import Runtime, discover, load
    from .store import Store

    _with_data_dir(args)
    try:
        runtime = Runtime(paths.data_dir())
        database = paths.data_dir() / "computedeck.sqlite"
        if database.is_file():
            # Tools switched off in this machine's own Toolbox stay off here too.
            runtime.store = Store(database)
        # Plugins may add credential schemes (e.g. shell:) that sources on this node use.
        load(discover(paths.data_dir()), runtime)
    except Exception as error:
        print(f"Plugins not loaded: {error}", file=sys.stderr)
    try:
        request = sys.stdin.read()
    except UnicodeDecodeError:
        request = ""  # answered as a request that was not understood
    print(json.dumps(nodes.answer(request)))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="computedeck", description=__doc__)
    root.add_argument("--data-dir", help="data directory (default: platform user data dir)")
    commands = root.add_subparsers(dest="command")

    run = commands.add_parser("serve", help="run the service on 127.0.0.1 (default command)")
    run.add_argument("--port", type=_port, help=f"port (default {paths.DEFAULT_PORT})")
    run.add_argument("--open", action="store_true", help="open the web app in a browser")
    run.set_defaults(handler=serve)

    load = commands.add_parser("import", help="create or update sources from a TOML file")
    load.add_argument("file")
    load.set_defaults(handler=import_config)

    dump = commands.add_parser("export", help="print sources and settings as TOML")
    dump.set_defaults(handler=export_config)

    diagnose = commands.add_parser(
        "doctor", help="check connections, permissions and plugin compatibility"
    )
    diagnose.add_argument("--source", help="check one configured source id")
    diagnose.add_argument("--port", type=_port)
    diagnose.add_argument("--json", action="store_true")
    diagnose.add_argument("--language", choices=["en", "zh-CN"], default="en")
    diagnose.set_defaults(handler=doctor)

    login = commands.add_parser("service", help="run at login (launchd or systemd --user)")
    login.add_argument("action", choices=["install", "uninstall"])
    login.add_argument("--port", type=_port)
    login.set_defaults(handler=service)

    remote = commands.add_parser("connect", help="open a remote service through an SSH tunnel")
    remote.add_argument("host", help="SSH host or alias of the server")
    remote.add_argument("--remote-port", type=_port, default=paths.DEFAULT_PORT)
    remote.add_argument("--local-port", type=_port, default=paths.DEFAULT_PORT + 1)
    remote.add_argument("--no-browser", action="store_true")
    remote.add_argument(
        "--token",
        help="the server's API token (default: $COMPUTEDECK_TOKEN, else read over SSH); "
        "other local users can see command-line arguments, so prefer the default",
    )
    remote.add_argument(
        "--token-command",
        default="computedeck token",
        help="command run on the server to print its token (default: %(default)s)",
    )
    remote.set_defaults(handler=connect)

    secret = commands.add_parser("token", help="print the API token of this data directory")
    secret.set_defaults(handler=token)

    node = commands.add_parser(
        "collect", help="answer a collection request from a hub on stdin (used over SSH)"
    )
    node.set_defaults(handler=collect)

    def plugin_handler(handler: Any) -> Any:
        guarded = plugin_cli.guarded(handler)

        def call(args: argparse.Namespace) -> int:
            _with_data_dir(args)
            return int(guarded(args))

        return call

    plugin_cli.add_parser(commands, plugin_handler)
    return root


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = parser().parse_args(argv)
    if args.command is None:
        args = parser().parse_args([*argv, "serve"])
    from . import auth

    try:
        auth.enabled()
    except ValueError as error:
        print(f"computedeck: {error}", file=sys.stderr)
        return 2
    if args.command != "plugin":
        # Files and folders the service and these commands create are the user's alone.
        # Not for `plugin`: its installer writes into the Python environment.
        os.umask(0o077)
    from .store import DatabaseVersionError

    _with_data_dir(args)
    if paths.data_dir().exists() and not paths.data_dir().is_dir():
        print(f"computedeck: the data directory {paths.data_dir()} is a file", file=sys.stderr)
        return 1
    try:
        return int(args.handler(args))
    except (OSError, sqlite3.Error, DatabaseVersionError) as error:
        # A file or database that cannot be used: say which, without a traceback.
        print(f"computedeck: {error}", file=sys.stderr)
        return 1
