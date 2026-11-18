"""Host aliases of the user's own OpenSSH configuration, offered when adding a source.

Reads ``~/.ssh/config`` and the files it includes, without running ssh. Only concrete Host
names are listed (no patterns or negations), each with the HostName, User and ProxyJump of
the blocks that name it; no other option, and never a key path. Wildcard blocks and Match
blocks are not evaluated. The file ComputeDeck writes for its own endpoints is skipped, so
managed aliases are not offered as sources. Reading never fails: a missing or unreadable
configuration is an empty list.
"""

import glob
import itertools
import os
import re
import shlex
from pathlib import Path
from typing import Any

from .ssh_config import validate_alias

MAX_HOSTS = 200
# Bounds that keep a huge or looping configuration cheap to read.
MAX_FILE_BYTES = 1 << 20
MAX_FILES = 64
MAX_DEPTH = 16  # OpenSSH's own Include depth limit.
MAX_VALUE = 255
MANAGED = "computedeck.conf"
# A keyword, then whitespace or one "=" with optional whitespace, then its arguments.
_LINE = re.compile(r"\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)")
_FIELDS = {"hostname": "hostname", "user": "user", "proxyjump": "proxy_jump"}


def _arguments(text: str) -> list[str]:
    """Arguments the way ssh_config reads them: quoted text may hold spaces, # starts a
    comment. Nothing when a quote does not close."""
    lexer = shlex.shlex(text, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = "#"
    try:
        return list(lexer)
    except ValueError:
        return []


def _value(text: str) -> str | None:
    """A value as shown: short printable text, or None."""
    if text.lower() == "none" or not 0 < len(text) <= MAX_VALUE or not text.isprintable():
        return None
    return text


class _Reader:
    def __init__(self, ssh_dir: Path) -> None:
        self.ssh_dir = ssh_dir
        self.seen: set[Path] = set()
        self.hosts: dict[str, dict[str, str | None]] = {}

    def read(self, path: Path, depth: int = 0, block: list[str] | None = None) -> bool:
        """Read one file; False when it cannot be read.

        ``block`` lists the aliases of the Host block an Include appeared in: until its own
        first Host or Match line, the included file continues that block, as in OpenSSH.
        """
        try:
            resolved = path.resolve()
            if resolved in self.seen:
                # Included twice, or including itself: read once.
                return True
            # Never a FIFO or a device, which could block or never end.
            if len(self.seen) >= MAX_FILES or not resolved.is_file():
                return False
            self.seen.add(resolved)
            with resolved.open("rb") as handle:
                text = handle.read(MAX_FILE_BYTES).decode("utf-8", errors="replace")
        except (OSError, RuntimeError):
            # RuntimeError: a symlink loop.
            return False
        # The aliases the following options belong to: those a Host line names, or none.
        block = block or []
        for line in text.splitlines():
            match = _LINE.match(line)
            if not match:
                # Blank lines, comments and keywords without arguments.
                continue
            keyword, arguments = match.group(1).lower(), _arguments(match.group(2))
            if keyword == "host":
                block = [name for name in arguments if self._concrete(name)]
                for name in block:
                    self.hosts.setdefault(name, dict.fromkeys(_FIELDS.values()))
            elif keyword == "match":
                # Its conditions are not evaluated, so its options belong to no alias.
                block = []
            elif keyword == "include":
                if depth < MAX_DEPTH:
                    for pattern in arguments:
                        for included in self._expand(pattern):
                            self.read(included, depth + 1, block)
            elif keyword in _FIELDS and arguments:
                for name in block:
                    # The first value obtained wins, as in OpenSSH.
                    fields = self.hosts[name]
                    if fields[_FIELDS[keyword]] is None:
                        fields[_FIELDS[keyword]] = _value(arguments[0])
        return True

    @staticmethod
    def _concrete(name: str) -> bool:
        if any(char in name for char in "*?!"):
            return False
        try:
            validate_alias(name)
        except ValueError:
            return False
        return True

    def _expand(self, pattern: str) -> list[Path]:
        """Files an Include names: relative to ~/.ssh, ~ expanded, globs sorted."""
        if pattern.startswith("~/"):
            pattern = str(self.ssh_dir.parent / pattern[2:])
        elif not os.path.isabs(pattern):
            pattern = str(self.ssh_dir / pattern)
        names = [pattern]
        if glob.has_magic(pattern):
            # A pattern such as /*/*/* stops being walked well before it could matter.
            names = sorted(itertools.islice(glob.iglob(pattern), MAX_FILES * 4))
        return [Path(name) for name in names if Path(name).name != MANAGED]


def discover(ssh_dir: Path) -> dict[str, Any]:
    """``{"hosts": [...], "readable": bool}`` from ``ssh_dir/config``."""
    reader = _Reader(ssh_dir)
    if not reader.read(ssh_dir / "config"):
        return {"hosts": [], "readable": False}
    aliases = sorted(reader.hosts, key=lambda alias: (alias.lower(), alias))[:MAX_HOSTS]
    return {
        "hosts": [{"alias": alias, **reader.hosts[alias]} for alias in aliases],
        "readable": True,
    }
