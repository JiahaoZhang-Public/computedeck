"""Where notifications go. Built-in: SMTP email and webhooks; plugins can add more.

Secrets (SMTP passwords, webhook URLs that embed a token) are credential references,
resolved when a message is sent and never stored.
"""

import asyncio
import ipaddress
import smtplib
import socket
import ssl
import threading
from collections.abc import Callable, Coroutine
from contextlib import suppress
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any
from urllib.parse import urlparse

import httpx

from .. import credentials
from ..errors import SourceError
from ..plugins import SettingField, Text


@dataclass(frozen=True)
class Message:
    subject: str
    body: str
    event: dict[str, Any] | None = None


Sender = Callable[[dict[str, Any], Message], Coroutine[Any, Any, None]]


@dataclass(frozen=True)
class ChannelKind:
    kind: str
    label: Text
    fields: tuple[SettingField, ...]
    send: Sender
    # Checks a channel's settings before they are saved; raise ValueError(code).
    validate: Callable[[dict[str, Any]], None] | None = None


_KINDS: dict[str, ChannelKind] = {}


def register(kind: ChannelKind) -> None:
    """Add a channel kind. Plugins call this from their setup."""
    if kind.kind in _KINDS and _KINDS[kind.kind] is not kind:
        raise ValueError(f"Channel kind already registered: {kind.kind}")
    _KINDS[kind.kind] = kind


def kinds() -> list[ChannelKind]:
    return list(_KINDS.values())


def get(kind: str) -> ChannelKind:
    try:
        return _KINDS[kind]
    except KeyError:
        raise SourceError("channel_kind_unknown", kind=kind) from None


async def in_daemon_thread[T](work: Callable[[], T], name: str = "computedeck-worker") -> T:
    """Run blocking work in a daemon thread and wait for its result.

    Unlike ``asyncio.to_thread``, a thread that is still blocked (a keychain prompt, a
    stalled server) never holds up the service's exit. Cancelling the wait abandons the
    thread; the work must end on its own or be cut off by the caller.
    """
    loop = asyncio.get_running_loop()
    done: asyncio.Future[T] = loop.create_future()

    def succeed(result: T) -> None:
        if not done.done():  # else the caller was cancelled
            done.set_result(result)

    def fail(error: BaseException) -> None:
        if not done.done():
            done.set_exception(error)

    def reply(callback: Callable[[Any], None], value: Any) -> None:
        with suppress(RuntimeError):  # the event loop has already closed
            loop.call_soon_threadsafe(callback, value)

    def run() -> None:
        try:
            result = work()
        except BaseException as error:
            reply(fail, error)
        else:
            reply(succeed, result)

    threading.Thread(target=run, name=name, daemon=True).start()
    return await done


def _secret(reference: str) -> str:
    value = credentials.resolve(reference) if reference else None
    if not value:
        raise SourceError("credential_unavailable", reference=reference)
    return value


async def secret(reference: str) -> str:
    """Resolve a credential reference without tying up the default executor; a keychain
    can wait for the user, and the caller's deadline bounds that wait."""
    return await in_daemon_thread(lambda: _secret(reference), "computedeck-secret")


# ---- Email ----

EMAIL_FIELDS = (
    SettingField(
        key="host",
        label={"en": "SMTP server", "zh-CN": "SMTP 服务器"},
        placeholder="smtp.example.com",
        required=True,
    ),
    SettingField(key="port", label={"en": "Port", "zh-CN": "端口"}, kind="number", default=587),
    SettingField(
        key="security",
        label={"en": "Encryption", "zh-CN": "加密方式"},
        kind="select",
        choices=["starttls", "ssl", "none"],
        default="starttls",
        required=True,
    ),
    SettingField(key="username", label={"en": "Login", "zh-CN": "登录名"}),
    SettingField(
        key="password",
        label={"en": "Password reference", "zh-CN": "密码引用"},
        kind="credential",
        placeholder="env:SMTP_PASSWORD",
        hint={
            "en": "Where to read the password, e.g. env:SMTP_PASSWORD or "
            "keychain:computedeck/smtp.",
            "zh-CN": "填写读取密码的位置，例如 env:SMTP_PASSWORD 或 keychain:computedeck/smtp。",
        },
    ),
    SettingField(
        key="sender",
        label={"en": "From", "zh-CN": "发件人"},
        placeholder="computedeck@example.com",
        required=True,
    ),
    SettingField(
        key="recipients",
        label={"en": "To", "zh-CN": "收件人"},
        placeholder="alice@example.com, ops@example.com",
        hint={"en": "Separate addresses with commas.", "zh-CN": "多个地址用逗号分隔。"},
        required=True,
    ),
)


def _addresses(value: str) -> list[str]:
    return [item.strip() for item in value.replace(";", ",").split(",") if item.strip()]


def _validate_email(config: dict[str, Any]) -> None:
    for address in [config.get("sender") or "", *_addresses(config.get("recipients") or "")]:
        if "@" not in address or any(char in address for char in "\r\n<>"):
            raise ValueError("email_address_invalid")
    if not _addresses(config.get("recipients") or ""):
        raise ValueError("email_address_invalid")
    port = config.get("port")
    if port is not None and not (
        isinstance(port, int) and not isinstance(port, bool) and 0 < port < 65536
    ):
        raise ValueError("setting_invalid")


def email_port(config: dict[str, Any]) -> Any:
    """The port of an email channel: as set, or 465 for SSL and 587 otherwise.

    SSL on 587 means 465: 587 is the STARTTLS port that forms fill in by default, and an
    SSL connection to it cannot work.
    """
    use_ssl = config.get("security") == "ssl"
    port = config.get("port")
    if port is None or port == "" or (use_ssl and port == 587):
        return 465 if use_ssl else 587
    return port


# Seconds for each network step of an SMTP session; the caller bounds the whole session.
SMTP_STEP_TIMEOUT = 20


class _Session:
    """The SMTP client of a worker thread, so the event loop can cut it off."""

    def __init__(self) -> None:
        self.client: smtplib.SMTP | None = None
        self.cancelled = threading.Event()

    def open(self, cls: type[smtplib.SMTP], *args: Any, **kwargs: Any) -> smtplib.SMTP:
        # The client is known before its __init__ connects and reads the greeting, so a
        # server that drips its greeting can be cut off as well.
        client = cls.__new__(cls)
        self.client = client
        cls.__init__(client, *args, **kwargs)
        return client

    def check(self) -> None:
        """Stop before the next step once cut off. A connection or TLS handshake has no
        socket to shut down yet, and must not go on to send after the attempt was given up
        (it would be sent again on the retry)."""
        if self.cancelled.is_set():
            raise ConnectionAbortedError("the send was cut off")

    def cut_off(self) -> None:
        """End the session: no further step runs, and a blocked read or write fails."""
        self.cancelled.set()
        sock = getattr(self.client, "sock", None)
        if isinstance(sock, socket.socket):
            # The plain socket's shutdown also ends a TLS connection, without touching
            # the TLS state the worker thread is using.
            with suppress(OSError):
                socket.socket.shutdown(sock, socket.SHUT_RDWR)


def _send_email_now(
    config: dict[str, Any], message: Message, password: str | None, session: _Session
) -> None:
    mail = EmailMessage()
    mail["Subject"] = message.subject.replace("\r", " ").replace("\n", " ")[:200]
    mail["From"] = formataddr(("ComputeDeck", config["sender"]))
    mail["To"] = ", ".join(_addresses(config["recipients"]))
    mail["Message-ID"] = make_msgid(domain="computedeck.local")
    mail.set_content(message.body)
    host = str(config["host"])
    port = int(email_port(config))
    context = ssl.create_default_context()
    smtp: smtplib.SMTP
    if config.get("security") == "ssl":
        smtp = session.open(
            smtplib.SMTP_SSL, host, port, timeout=SMTP_STEP_TIMEOUT, context=context
        )
    else:
        smtp = session.open(smtplib.SMTP, host, port, timeout=SMTP_STEP_TIMEOUT)
    with smtp:
        if config.get("security", "starttls") == "starttls":
            session.check()
            smtp.starttls(context=context)
        if config.get("username"):
            session.check()
            smtp.login(str(config["username"]), password or "")
        session.check()
        smtp.send_message(mail)


async def send_email(config: dict[str, Any], message: Message) -> None:
    password = await secret(config["password"]) if config.get("password") else None
    session = _Session()
    try:
        await in_daemon_thread(
            lambda: _send_email_now(config, message, password, session), "computedeck-smtp"
        )
    except (OSError, smtplib.SMTPException) as error:
        # SMTP replies can quote the request; keep only the class and code.
        code = getattr(error, "smtp_code", None)
        raise SourceError(
            "send_failed", f"{type(error).__name__}{f' {code}' if code else ''}"
        ) from None
    finally:
        # Cancelled, e.g. past the sender's deadline or at shutdown: end the connection,
        # and with it the thread. After a finished session this does nothing.
        session.cut_off()


# ---- Webhooks ----

WEBHOOK_FORMATS = ["json", "slack", "discord", "feishu", "dingtalk", "wecom"]
WEBHOOK_FIELDS = (
    SettingField(
        key="url",
        label={"en": "Webhook URL reference", "zh-CN": "Webhook 地址引用"},
        kind="credential",
        placeholder="env:TEAM_WEBHOOK_URL",
        required=True,
        hint={
            "en": "Webhook URLs usually contain a secret, so give where to read it: "
            "env:NAME or keychain:service/account.",
            "zh-CN": "Webhook 地址通常含有密钥，因此填写读取位置："
            "env:变量名 或 keychain:服务/账户。",
        },
    ),
    SettingField(
        key="format",
        label={"en": "Format", "zh-CN": "格式"},
        kind="select",
        choices=WEBHOOK_FORMATS,
        default="json",
        required=True,
        hint={
            "en": "json posts {subject, text, event}; the others use each service's text message.",
            "zh-CN": "json 发送 {subject, text, event}；其余格式使用各服务的文本消息。",
        },
    ),
)


def webhook_payload(kind: str, message: Message) -> dict[str, Any]:
    text = f"{message.subject}\n\n{message.body}"
    if kind == "slack":
        return {"text": text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")}
    if kind == "discord":
        return {"content": text[:2000], "allowed_mentions": {"parse": []}}
    if kind == "feishu":
        return {"msg_type": "text", "content": {"text": text}}
    if kind in ("dingtalk", "wecom"):
        return {"msgtype": "text", "text": {"content": text}}
    return {"subject": message.subject, "text": message.body, "event": message.event}


def _safe_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    local = host == "localhost"
    try:
        local = local or ipaddress.ip_address(host).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        # Plain http would expose the message, and often the URL's token, on the network.
        raise SourceError("webhook_url_invalid")
    return url


async def send_webhook(config: dict[str, Any], message: Message) -> None:
    url = _safe_url(await secret(config["url"]))
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.post(
                url, json=webhook_payload(config.get("format") or "json", message)
            )
    except httpx.HTTPError as error:
        raise SourceError("send_failed", type(error).__name__) from None
    if response.status_code >= 300:
        # The body may echo the URL token; report the status only.
        raise SourceError("http_status", status=response.status_code)


register(
    ChannelKind(
        kind="email",
        label={"en": "Email (SMTP)", "zh-CN": "邮件（SMTP）"},
        fields=EMAIL_FIELDS,
        send=send_email,
        validate=_validate_email,
    )
)
register(
    ChannelKind(
        kind="webhook",
        label={"en": "Webhook", "zh-CN": "Webhook"},
        fields=WEBHOOK_FIELDS,
        send=send_webhook,
    )
)
