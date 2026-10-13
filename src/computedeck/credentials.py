"""Credential references. Secrets are looked up when needed and never stored by ComputeDeck.

A reference is ``scheme:name``. Built-in schemes:

- ``env:RUNPOD_API_KEY`` reads an environment variable of the service process.
- ``keychain:computedeck/runpod`` reads the OS keychain (service ``computedeck``, account
  ``runpod``) through the ``keyring`` package.
- ``file:~/.config/computedeck/runpod`` reads a file that only its owner can read (for
  machines without a keychain, such as a collection node reached over SSH).

Plugins can register further schemes.
"""

import os
import re
from collections.abc import Callable
from pathlib import Path

from .errors import SourceError

Resolver = Callable[[str], str | None]
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_KEYCHAIN = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.@-]{1,100}\Z")


def _env(name: str) -> str | None:
    return os.environ.get(name) or None


def _keychain(name: str) -> str | None:
    service, _, account = name.partition("/")
    try:
        import keyring
        from keyring.errors import KeyringError
    except ImportError:
        raise SourceError("keychain_unavailable") from None
    try:
        return keyring.get_password(service, account)
    except KeyringError as error:
        raise SourceError("keychain_unavailable", type(error).__name__) from None


_FILE = re.compile(r"(~/|/)[A-Za-z0-9_./@+-]{1,300}\Z")


def _file(name: str) -> str | None:
    if ".." in Path(name).parts:
        raise SourceError("invalid_credential_reference", reference=f"file:{name}")
    path = Path(name).expanduser()
    try:
        info = path.stat()
    except FileNotFoundError:
        return None
    if info.st_mode & 0o077:
        # A key others can read is not a secret any more; refuse rather than use it.
        raise SourceError("credential_file_open", reference=f"file:{name}")
    return path.read_text(encoding="utf-8").strip() or None


_RESOLVERS: dict[str, tuple[Resolver, re.Pattern[str]]] = {
    "env": (_env, _NAME),
    "keychain": (_keychain, _KEYCHAIN),
    "file": (_file, _FILE),
}


_BUILT_IN = frozenset(_RESOLVERS)


class DisabledSchemeError(SourceError):
    """The plugin host, rather than a resolver, disabled this credential scheme."""

    def __init__(self, scheme: str, plugin: str) -> None:
        super().__init__("credential_scheme_off", scheme=scheme, plugin=plugin)


def register(scheme: str, resolver: Resolver, pattern: str = r"[A-Za-z0-9_.@/-]{1,200}") -> None:
    if not re.fullmatch(r"[a-z][a-z0-9-]*", scheme) or scheme in _BUILT_IN:
        raise ValueError(f"Credential scheme cannot be registered: {scheme}")
    _RESOLVERS[scheme] = (resolver, re.compile(pattern + r"\Z"))


def schemes() -> list[str]:
    return sorted(_RESOLVERS)


def validate_reference(reference: str) -> str:
    scheme, separator, name = reference.partition(":")
    entry = _RESOLVERS.get(scheme)
    if not separator or not entry or not entry[1].match(name):
        raise SourceError("invalid_credential_reference", reference=reference)
    return reference


def resolve(reference: str) -> str | None:
    validate_reference(reference)
    scheme, _, name = reference.partition(":")
    try:
        return _RESOLVERS[scheme][0](name)
    except DisabledSchemeError:
        raise
    except SourceError:
        if scheme in _BUILT_IN:
            raise
    except Exception:
        pass
    # A resolver or keyring backend may quote a secret in its exception. Only the
    # core's own actionable errors above may leave this boundary.
    raise SourceError("credential_unavailable", reference=reference) from None
