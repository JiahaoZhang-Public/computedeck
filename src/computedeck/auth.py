"""Access token for the API.

Binding to 127.0.0.1 keeps other machines out, and the Origin, header and Host checks keep
other websites out, but not other users of the same machine. With COMPUTEDECK_AUTH=token
every /api request therefore proves knowledge of a token that only the owner of the data
directory can read. It is off by default: ComputeDeck is meant for one person's machine.

The token never appears in a URL, on a command line or in a cookie (cookies for 127.0.0.1
are sent to every port, including another user's server). A private launcher page POSTs it
to the service. The browser stores only a session token that expires when the service
restarts, never the persistent API token. API requests send credentials in the
X-ComputeDeck-Token header.
"""

import hmac
import html
import http.client
import json
import logging
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Any

HEADER = "x-computedeck-token"
FILE_NAME = "api-token"
SESSION_PATH = "/api/session"
STORAGE_KEY = "computedeck.session"
# What a token file must hold; generated tokens are 43 URL-safe characters.
TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{16,512}")
logger = logging.getLogger("computedeck")


def enabled() -> bool:
    """Whether the API asks for the token. Off unless COMPUTEDECK_AUTH is "token" (or "on"):
    turn it on when other people have accounts on the machine that runs the service.

    Any other value is refused rather than read as off: a misspelt "token" must not leave
    the service open."""
    value = os.environ.get("COMPUTEDECK_AUTH", "off").strip().lower()
    if value not in {"", "off", "token", "on"}:
        raise ValueError(f"COMPUTEDECK_AUTH must be off or token, not {value[:20]!r}")
    return value in {"token", "on"}


def existing_token(data_dir: Path) -> str | None:
    """The token in the data directory, if there is a usable one; nothing is created."""
    try:
        token = (data_dir / FILE_NAME).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return token if TOKEN.fullmatch(token) else None


def ensure_token(data_dir: Path) -> str:
    """Read the token, creating it (mode 0600) on first use.

    A file that holds no token (empty, blank or garbage) would lock every client out
    without a word, so it is replaced like a missing one.
    """
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = data_dir / FILE_NAME
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.stat().st_mode & 0o077:
            path.chmod(0o600)
        try:
            token = path.read_text(encoding="utf-8").strip()
        except UnicodeDecodeError:
            token = ""
        if TOKEN.fullmatch(token):
            return token
        logger.warning("%s holds no usable access token; writing a new one", path)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{FILE_NAME}.", dir=data_dir)
        token = _write_token(descriptor)
        os.replace(temporary, path)
        return token
    return _write_token(descriptor)


def _write_token(descriptor: int) -> str:
    token = secrets.token_urlsafe(32)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
    return token


def matches(expected: str, supplied: str | None) -> bool:
    # surrogatepass: a lone surrogate in a pasted token is a wrong token, not a failure.
    return bool(supplied) and hmac.compare_digest(
        expected.encode(), str(supplied).encode("utf-8", "surrogatepass")
    )


def session_proof(token: str, challenge: str) -> str:
    return hmac.digest(token.encode(), f"computedeck-session:{challenge}".encode(), "sha256").hex()


def server_proof(token: str, challenge: str) -> str:
    """Prove knowledge of the persistent token without sending it to an untrusted port."""
    return hmac.digest(token.encode(), f"computedeck-server:{challenge}".encode(), "sha256").hex()


def browser_proof(session_token: str, challenge: str) -> str:
    """What the page checks before it sends its stored session token (see web/src/token.ts)."""
    message = f"computedeck-browser:{challenge}".encode()
    return hmac.digest(session_token.encode(), message, "sha256").hex()


def _ping(connection: http.client.HTTPConnection, challenge: str) -> tuple[str, Any]:
    """The listener's session nonce and its reply to a ping with this challenge."""
    connection.request("GET", f"/api/ping?challenge={challenge}")
    response = connection.getresponse()
    reply = json.loads(response.read(4096))
    nonce = reply.get("nonce") if isinstance(reply, dict) else None
    if response.status != 200 or not isinstance(nonce, str) or len(nonce) != 64:
        raise ValueError("The listener did not prove it is your ComputeDeck service.")
    return nonce, reply


def service_nonce(port: int) -> str | None:
    """The session nonce of the ComputeDeck service on a port, or None."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        return _ping(connection, secrets.token_hex(32))[0]
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        connection.close()


def browser_session(port: int, token: str, expected_nonce: str | None = None) -> str | None:
    """Authenticate the listener, then exchange credentials on that same TCP connection.
    None when the service asks for no token.

    With ``expected_nonce`` the listener must be the service process that has it, not
    another service of the same data directory behind someone else's relay.
    """
    challenge = secrets.token_hex(32)
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        nonce, reply = _ping(connection, challenge)
        if expected_nonce is not None and not matches(expected_nonce, nonce):
            raise ValueError(f"Another program answers on port {port}, not this service.")
        # Proved even when the service asks for no token, so a program on the port cannot
        # get its own page opened just by saying it needs none.
        if not matches(server_proof(token, f"{nonce}:{challenge}"), reply.get("proof")):
            raise ValueError("The listener did not prove it is your ComputeDeck service.")
        if reply.get("token_required") is False:
            # Nothing to sign in to: no credential is sent and the page opens directly.
            return None
        # Never reconnect after verification: a different process may have taken the port.
        if connection.sock is None:
            raise ValueError("The verified service closed the connection.")
        connection.request(
            "POST",
            SESSION_PATH,
            json.dumps(
                {
                    "challenge": challenge,
                    "nonce": nonce,
                    "proof": session_proof(token, f"{nonce}:{challenge}"),
                }
            ),
            {"Content-Type": "application/json", "X-ComputeDeck": "1"},
        )
        response = connection.getresponse()
        reply = json.loads(response.read(4096))
        if response.status != 200 or not isinstance(reply.get("token"), str):
            raise ValueError("The service refused the browser session.")
        return str(reply["token"])
    except (OSError, http.client.HTTPException, ValueError, AttributeError) as error:
        raise ValueError(f"Cannot safely open ComputeDeck: {error}") from None
    finally:
        connection.close()


def safe_next(value: str | None) -> str:
    """Only same-site paths; never an absolute or protocol-relative URL."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    return value


def launcher(data_dir: Path, port: int, token: str, *, next_path: str = "/", name: str) -> Path:
    """A private page (mode 0600) that hands the token to the service by POST.

    Opening a URL starts a browser process whose arguments other local users can list, and
    URLs end up in browser history. Only this file's path is ever opened.
    """
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = data_dir / name
    path.unlink(missing_ok=True)
    action = html.escape(f"http://127.0.0.1:{port}{SESSION_PATH}")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(
            '<!doctype html><meta charset="utf-8"><title>ComputeDeck</title>'
            f'<form method="post" action="{action}">'
            f'<input type="hidden" name="token" value="{html.escape(token)}">'
            f'<input type="hidden" name="next" value="{html.escape(safe_next(next_path))}">'
            '<button type="submit">Open ComputeDeck</button></form>'
            "<script>document.forms[0].submit()</script>\n"
        )
    return path


def _script_value(value: str) -> str:
    # JSON is valid JavaScript; escaping "<" keeps "</script>" from ending the block.
    return json.dumps(value).replace("<", "\\u003c")


def handoff_page(token: str, next_path: str) -> str:
    """The service's answer to the launcher: keep the token for this origin, then continue."""
    return (
        '<!doctype html><meta charset="utf-8"><title>ComputeDeck</title><script>'
        f"try {{ localStorage.setItem({_script_value(STORAGE_KEY)}, {_script_value(token)}) }}"
        " catch (error) {}"
        f"location.replace({_script_value(safe_next(next_path))})</script>\n"
    )
