"""Plugin marketplaces: catalogs of installable plugins, and installing from them.

A marketplace is a ``computedeck-marketplace.json`` catalog, served at an HTTPS address,
kept in a git repository or in a local folder. The format follows Claude Code's
``marketplace.json``: a name, an owner and a list of plugins, each with a ``source``
pinned to an exact version and, where possible, a hash.

Plugins are Python packages and run with the service's permissions, so installing is
done from the command line by the machine's owner, never from the web app. The tier
(official, internal, community, local) comes from where the catalog was added, never
from what the catalog says about itself.
"""

import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Callable
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, distribution, entry_points, version
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .versions import core_version, numbers, satisfies, valid_range

CATALOG = "computedeck-marketplace.json"
# Catalogs published by the ComputeDeck project. Empty until the official catalog exists.
OFFICIAL_SOURCES: tuple[str, ...] = ()
NAME = r"^[a-z0-9][a-z0-9-]{0,63}$"
Text = dict[str, str]


class MarketplaceError(RuntimeError):
    """A user-facing failure; the message is shown as is."""


# ---- Catalog format ----


class Source(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["pypi", "wheel", "git", "path"]
    package: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    version: str | None = Field(default=None, pattern=r"^[0-9][0-9A-Za-z.+-]*$")
    url: str | None = None
    sha256: list[str] = Field(default_factory=list)
    sha: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    subdirectory: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._/-]+$")
    path: str | None = None

    @model_validator(mode="before")
    @classmethod
    def one_hash_or_many(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("sha256"), str):
            data = {**data, "sha256": [data["sha256"]]}
        return data

    @model_validator(mode="after")
    def complete(self) -> "Source":
        if any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in self.sha256):
            raise ValueError("sha256 must be 64 lowercase hex digits")
        if self.type == "pypi" and not (self.package and self.version):
            raise ValueError("a pypi source needs package and version")
        if self.type == "wheel":
            if not (self.url and self.url.startswith("https://") and self.url.endswith(".whl")):
                raise ValueError("a wheel source needs an https URL ending in .whl")
            if not self.sha256:
                raise ValueError("a wheel source needs its sha256")
        if self.type == "git":
            if not self.url or not re.match(r"^(https://|git@|ssh://)", self.url):
                raise ValueError("a git source needs an https or ssh URL")
            if not self.sha:
                raise ValueError("a git source must be pinned to a commit (sha)")
            parsed = urlsplit(self.url)
            path = self.url.split(":", 1)[-1] if self.url.startswith("git@") else parsed.path
            if "#" in self.url or "?" in self.url or "@" in path:
                raise ValueError("a git source URL cannot contain a revision, query or fragment")
        if self.type == "path":
            if not self.path or self.path.startswith("/") or ".." in Path(self.path).parts:
                raise ValueError("a path source must stay inside the marketplace folder")
        return self


class Entry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(pattern=NAME)
    display_name: Text | None = None
    description: Text | None = None
    version: str = Field(pattern=r"^[0-9][0-9A-Za-z.+-]*$")
    source: Source
    # The distribution name, when the source does not give it (git); read from a path source.
    package: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    permissions: list[Text] = Field(default_factory=list)
    requires: str | None = None
    homepage: str | None = None
    license: str | None = None
    author: str | None = None

    @model_validator(mode="before")
    @classmethod
    def author_name(cls, data: Any) -> Any:
        if isinstance(data, dict) and isinstance(data.get("author"), dict):
            data = {**data, "author": data["author"].get("name")}
        return data

    @model_validator(mode="after")
    def ranges(self) -> "Entry":
        if self.requires and not valid_range(self.requires):
            raise ValueError(f"{self.name}: requires is not a version range")
        return self


class Catalog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(pattern=NAME)
    owner: dict[str, str] = Field(default_factory=dict)
    description: Text | None = None
    plugins: list[Entry] = Field(default_factory=list)
    renames: dict[str, str | None] = Field(default_factory=dict)

    @model_validator(mode="after")
    def unique(self) -> "Catalog":
        names = [entry.name for entry in self.plugins]
        if len(names) != len(set(names)):
            raise ValueError("plugin names must be unique within a marketplace")
        return self


def parse_catalog(text: str) -> Catalog:
    try:
        return Catalog.model_validate(json.loads(text))
    except (ValueError, ValidationError) as error:
        raise MarketplaceError(f"Not a valid {CATALOG}: {error}") from None
    except RecursionError:
        raise MarketplaceError(f"Not a valid {CATALOG}: it is nested too deeply") from None


def _read_catalog(file: Path) -> Catalog:
    try:
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise MarketplaceError(f"Cannot read {file}: {error}") from None
    return parse_catalog(text)


# ---- Policy ----


class Policy(BaseModel):
    """``policy.toml`` in the data directory, written by the machine's owner or admin."""

    model_config = ConfigDict(extra="forbid")
    allowed_marketplaces: list[str] | None = None
    blocked_marketplaces: list[str] = Field(default_factory=list)
    internal_marketplaces: list[str] = Field(default_factory=list)
    blocked_plugins: list[str] = Field(default_factory=list)
    allow_local: bool = True


def load_policy(data_dir: Path) -> Policy:
    path = data_dir / "policy.toml"
    try:
        return Policy.model_validate(tomllib.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return Policy()
    except (OSError, UnicodeError, tomllib.TOMLDecodeError, ValidationError) as error:
        raise MarketplaceError(f"{path}: {error}") from None
    except RecursionError:
        raise MarketplaceError(f"{path}: nested too deeply") from None


def _matches(value: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(value, pattern) for pattern in patterns)


def normalize(name: str) -> str:
    """A package or plugin name as Python packaging compares it: Evil.Pkg is evil-pkg."""
    return re.sub(r"[-_.]+", "-", name.lower())


def plugin_blocked(policy: Policy, name: str, marketplace: str = "", package: str = "") -> bool:
    keys = [name, f"{name}@{marketplace}", package]
    patterns = [normalize(pattern) for pattern in policy.blocked_plugins]
    return any(key and _matches(normalize(key), patterns) for key in keys)


# ---- Marketplace registry (data directory) ----


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, UnicodeError, ValueError) as error:
        raise MarketplaceError(f"Cannot read {path.name}: {error}") from None
    except RecursionError:
        raise MarketplaceError(f"Cannot read {path.name}: nested too deeply") from None


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.unlink(missing_ok=True)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, indent=2, ensure_ascii=False))
    temporary.replace(path)


def registry(data_dir: Path) -> dict[str, dict[str, Any]]:
    records = _read(data_dir / "marketplaces.json", {})
    if not isinstance(records, dict) or any(
        not isinstance(record, dict)
        or not {"name", "kind", "source", "tier", "catalog"}.issubset(record)
        for record in records.values()
    ):
        raise MarketplaceError("marketplaces.json contains an invalid marketplace record.")
    return records


def stored_catalog(record: dict[str, Any]) -> Catalog:
    """A saved catalog, checked again: an older ComputeDeck may have saved one this one rejects."""
    try:
        return Catalog.model_validate(record["catalog"])
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(part) for part in first["loc"])
        raise MarketplaceError(
            f"The saved catalog of {record['name']} is not valid for this version of "
            f"ComputeDeck ({where}: {first['msg']}). Read it again with: "
            f"computedeck plugin marketplace update {record['name']}"
        ) from None


def problems(data_dir: Path) -> dict[str, str]:
    """Why the saved catalog of a marketplace cannot be used, by marketplace name."""
    found = {}
    for record in registry(data_dir).values():
        try:
            stored_catalog(record)
        except MarketplaceError as error:
            found[record["name"]] = str(error)
    return found


def installed(data_dir: Path) -> dict[str, dict[str, Any]]:
    records = _read(data_dir / "installed-plugins.json", {})
    if not isinstance(records, dict) or any(
        not isinstance(record, dict) or not isinstance(record.get("package"), str)
        for record in records.values()
    ):
        raise MarketplaceError("installed-plugins.json contains an invalid package record.")
    return records


def classify(source: str) -> tuple[Literal["url", "git", "path"], str]:
    """What kind of marketplace source this is, and its normalised form."""
    # URL schemes are case-insensitive: HTTPS://... is https://...
    source = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://", lambda match: match[0].lower(), source)
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source) and not Path(source).exists():
        return "git", f"https://github.com/{source}.git"
    if source.startswith("https://") and source.endswith(".json"):
        return "url", source
    if re.match(r"^(https://|git@|ssh://)", source):
        return "git", source
    if source.startswith("http://"):
        raise MarketplaceError("Use https for a marketplace address.")
    return "path", str(Path(source).expanduser().resolve())


def display_source(source: str) -> str:
    """The source without any user name, token, query or fragment embedded in a URL."""
    parsed = urlsplit(source)
    if parsed.scheme and parsed.netloc:
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, "", ""))
    return source


def _redact(text: str) -> str:
    """Drop credentials from every URL in a message, such as git's error output."""
    return re.sub(
        r"(?i)\b[a-z][a-z0-9+.-]*://[^\s'\"]+", lambda match: display_source(match[0]), text
    )


# Terminal escape sequences: CSI, OSC and string commands (7- and 8-bit), other ESC pairs.
_ESCAPES = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]"
    r"|(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?"
    r"|\x1b[ -~]?"
)
# Control characters and the invisible marks that reorder text on screen.
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]")


def plain(text: Any, *, lines: bool = False) -> str:
    """Text from a catalog or a remote as a terminal will show it: escape sequences and
    control characters removed, tabs and line breaks made spaces unless ``lines``."""
    text = _CONTROLS.sub("", _ESCAPES.sub("", str(text)))
    return re.sub(r"\t" if lines else r"[\t\n]", " ", text)


def tier(policy: Policy, kind: str, source: str) -> str:
    if _matches(source, policy.internal_marketplaces):
        return "internal"
    if source in OFFICIAL_SOURCES:
        return "official"
    return "local" if kind == "path" else "community"


Fetch = Callable[[str], str]
Git = Callable[[list[str]], None]


def _fetch(url: str) -> str:
    try:
        response = httpx.get(url, timeout=20, follow_redirects=True)
    except httpx.HTTPError as error:
        raise MarketplaceError(
            f"Could not download {display_source(url)}: {type(error).__name__}"
        ) from None
    if response.status_code != 200:
        raise MarketplaceError(
            f"Could not download {display_source(url)}: HTTP {response.status_code}"
        )
    return response.text


def _git(args: list[str]) -> None:
    done = subprocess.run(["git", *args], capture_output=True, text=True, timeout=120)
    if done.returncode:
        raise MarketplaceError(f"git {args[0]} failed: {_redact(done.stderr.strip())[:300]}")


def _catalog_file(folder: Path) -> Path:
    for candidate in (folder / CATALOG, folder / ".computedeck" / "marketplace.json"):
        if candidate.is_file():
            return candidate
    raise MarketplaceError(f"No {CATALOG} in {folder}")


def _read_source(
    data_dir: Path, kind: str, source: str, folder: Path | None, fetch: Fetch, git: Git
) -> tuple[Catalog, Path | None]:
    if kind == "url":
        return parse_catalog(fetch(source)), None
    if kind == "path":
        path = Path(source)
        file = path if path.is_file() else _catalog_file(path)
        return _read_catalog(file), file.parent
    assert folder is not None
    if (folder / ".git").is_dir():
        git(["-C", str(folder), "pull", "--ff-only", "--quiet"])
    else:
        folder.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        git(["clone", "--depth", "1", "--quiet", "--", source, str(folder)])
    file = _catalog_file(folder)
    return _read_catalog(file), file.parent


def add_marketplace(
    data_dir: Path, source: str, *, fetch: Fetch = _fetch, git: Git = _git
) -> dict[str, Any]:
    policy = load_policy(data_dir)
    kind, normalised = classify(source)
    if policy.allowed_marketplaces is not None and not _matches(
        normalised, policy.allowed_marketplaces
    ):
        raise MarketplaceError(
            f"{display_source(normalised)} is not an allowed marketplace (policy.toml)."
        )
    if _matches(normalised, policy.blocked_marketplaces):
        raise MarketplaceError(f"{display_source(normalised)} is blocked (policy.toml).")
    if kind == "path" and not policy.allow_local:
        raise MarketplaceError("Local marketplaces are not allowed (policy.toml).")
    staging = None
    if kind == "git":
        staging = Path(tempfile.mkdtemp(prefix="marketplace-", dir=_ensure(data_dir)))
        shutil.rmtree(staging)
    try:
        catalog, folder = _read_source(data_dir, kind, normalised, staging, fetch, git)
        markets = registry(data_dir)
        if catalog.name in markets and markets[catalog.name]["source"] != normalised:
            raise MarketplaceError(
                f"A marketplace named {catalog.name} is already added from "
                f"{display_source(markets[catalog.name]['source'])}."
            )
        if kind == "git" and staging is not None:
            final = data_dir / "marketplaces" / catalog.name
            final.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if final.exists():
                shutil.rmtree(final)
            staging.rename(final)
            folder = (
                final
                if folder is None or folder == staging
                else final / folder.relative_to(staging)
            )
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)
    record = {
        "name": catalog.name,
        "kind": kind,
        "source": normalised,
        "tier": tier(policy, kind, normalised),
        "folder": str(folder) if folder else None,
        "added_at": markets.get(catalog.name, {}).get("added_at", _now()),
        "updated_at": _now(),
        "catalog": catalog.model_dump(),
    }
    markets[catalog.name] = record
    _write(data_dir / "marketplaces.json", markets)
    return record


def _ensure(data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    return data_dir


def update_marketplace(
    data_dir: Path, name: str, *, fetch: Fetch = _fetch, git: Git = _git
) -> dict[str, Any]:
    markets = registry(data_dir)
    if name not in markets:
        raise MarketplaceError(f"No marketplace named {name}.")
    record = markets[name]
    folder = Path(record["folder"]) if record.get("folder") else None
    if record["kind"] == "git":
        folder = data_dir / "marketplaces" / name
    catalog, _ = _read_source(data_dir, record["kind"], record["source"], folder, fetch, git)
    if catalog.name != name:
        raise MarketplaceError(
            f"The catalog at {display_source(record['source'])} is now named {catalog.name}."
        )
    record.update(catalog=catalog.model_dump(), updated_at=_now())
    markets[name] = record
    _write(data_dir / "marketplaces.json", markets)
    return record


def remove_marketplace(data_dir: Path, name: str) -> None:
    markets = registry(data_dir)
    if markets.pop(name, None) is None:
        raise MarketplaceError(f"No marketplace named {name}.")
    folder = data_dir / "marketplaces" / name
    if folder.is_dir():
        shutil.rmtree(folder)
    _write(data_dir / "marketplaces.json", markets)


# ---- Browsing ----


def _installed_version(package: str | None) -> str | None:
    if not package:
        return None
    try:
        return version(package)
    except PackageNotFoundError:
        return None


def listing(data_dir: Path) -> list[dict[str, Any]]:
    """Every plugin of every marketplace, with what is installed and whether it fits."""
    policy = load_policy(data_dir)
    current = core_version()
    records = installed(data_dir)
    rows = []
    for market in registry(data_dir).values():
        try:
            catalog = stored_catalog(market)
        except MarketplaceError:
            # Only this marketplace is left out; problems() says why.
            continue
        for entry in catalog.plugins:
            record = records.get(entry.name)
            package = (record or {}).get("package") or entry.package or entry.source.package
            have = _installed_version(package) if record or entry.source.package else None
            rows.append(
                {
                    **entry.model_dump(exclude={"source"}),
                    "source_type": entry.source.type,
                    "marketplace": market["name"],
                    "tier": market["tier"],
                    "installed_version": have,
                    "update": bool(have and numbers(have) < numbers(entry.version)),
                    "compatible": satisfies(current, entry.requires),
                    "blocked": plugin_blocked(policy, entry.name, market["name"], package or ""),
                    "command": f"computedeck plugin install {entry.name}@{market['name']}",
                }
            )
    return rows


def find(data_dir: Path, spec: str) -> tuple[dict[str, Any], Entry]:
    name, _, market = spec.partition("@")
    candidates = []
    unreadable = []
    for record in registry(data_dir).values():
        if market and record["name"] != market:
            continue
        try:
            catalog = stored_catalog(record)
        except MarketplaceError as error:
            if market:
                raise
            unreadable.append(str(error))
            continue
        renamed = catalog.renames.get(name, name) if name in catalog.renames else name
        if renamed is None:
            raise MarketplaceError(f"{name} was removed from {record['name']}.")
        candidates += [(record, entry) for entry in catalog.plugins if entry.name == renamed]
    if not candidates:
        raise MarketplaceError(
            " ".join([f"No plugin named {spec} in the added marketplaces.", *unreadable])
        )
    if len(candidates) > 1:
        names = ", ".join(f"{name}@{record['name']}" for record, _ in candidates)
        raise MarketplaceError(f"{name} is in several marketplaces; choose one of {names}.")
    return candidates[0]


# ---- Installing ----

Runner = Callable[[list[str]], int]


def installer() -> list[str]:
    """How to install into the Python environment this command runs in."""
    if shutil.which("uv"):
        # A plugin's own [tool.uv.sources] describe its development workspace; they do not
        # resolve once its folder is copied elsewhere, and must not redirect what is installed.
        return ["uv", "pip", "install", "--python", sys.executable, "--no-sources"]
    if importlib.util.find_spec("pip") is None:
        raise MarketplaceError(
            "Neither uv nor pip is available for this Python environment. Install uv, or "
            "add the plugin to the environment yourself (e.g. uv tool install computedeck "
            "--with <package>)."
        )
    return [sys.executable, "-m", "pip", "install"]


def _run(command: list[str]) -> int:
    return subprocess.run(command).returncode


def _download(url: str, folder: Path, hashes: list[str]) -> Path:
    name = url.rsplit("/", 1)[-1].split("?")[0]
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.whl", name):
        raise MarketplaceError(f"Unexpected wheel file name in {display_source(url)}")
    try:
        response = httpx.get(url, timeout=120, follow_redirects=True)
    except httpx.HTTPError as error:
        raise MarketplaceError(
            f"Could not download {display_source(url)}: {type(error).__name__}"
        ) from None
    if response.status_code != 200:
        raise MarketplaceError(
            f"Could not download {display_source(url)}: HTTP {response.status_code}"
        )
    digest = hashlib.sha256(response.content).hexdigest()
    if digest not in hashes:
        raise MarketplaceError(f"{name} does not match the sha256 in the marketplace.")
    path = folder / name
    path.write_bytes(response.content)
    return path


def _pypi_wheel(package: str, wanted: str, hashes: list[str]) -> str:
    """The URL of a wheel of package==version on PyPI whose sha256 the catalog lists."""
    data = json.loads(_fetch(f"https://pypi.org/pypi/{package}/{wanted}/json"))
    for file in data.get("urls", []):
        if (
            file.get("packagetype") == "bdist_wheel"
            and file.get("digests", {}).get("sha256") in hashes
        ):
            return str(file["url"])
    raise MarketplaceError(f"No wheel of {package} {wanted} on PyPI matches the listed sha256.")


def install_command(entry: Entry, folder: Path | None, scratch: Path) -> tuple[list[str], str]:
    """Installer arguments and a one-line note on what will be installed."""
    source = entry.source
    if source.type == "pypi":
        assert source.package and source.version
        if source.sha256:
            url = _pypi_wheel(source.package, source.version, source.sha256)
            return [str(_download(url, scratch, source.sha256))], "a hash-checked wheel from PyPI"
        return (
            [f"{source.package}=={source.version}", "--only-binary", ":all:"],
            "a wheel from PyPI (no hash in the marketplace)",
        )
    if source.type == "wheel":
        assert source.url
        return [str(_download(source.url, scratch, source.sha256))], "a hash-checked wheel"
    if source.type == "git":
        assert source.url and source.sha
        target = f"git+{source.url}@{source.sha}"
        if source.subdirectory:
            target += f"#subdirectory={source.subdirectory}"
        return [target], "built from source at a pinned commit"
    if folder is None:
        raise MarketplaceError("A path source needs a marketplace folder.")
    path = (folder / (source.path or "")).resolve()
    if not path.is_relative_to(folder.resolve()):
        raise MarketplaceError("The path source leaves the marketplace folder.")
    return [str(path)], "built from a local folder"


def _project_name(folder: Path | None, entry: Entry) -> str | None:
    if entry.source.type != "path" or folder is None:
        return None
    pyproject = folder / (entry.source.path or "") / "pyproject.toml"
    try:
        name = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["name"]
    except (OSError, KeyError, tomllib.TOMLDecodeError):
        return None
    return str(name)


def install(
    data_dir: Path, spec: str, *, run: Runner = _run, confirm: Callable[[str], bool]
) -> dict[str, Any]:
    policy = load_policy(data_dir)
    record, entry = find(data_dir, spec)
    folder = Path(record["folder"]) if record.get("folder") else None
    source_package = entry.source.package or _project_name(folder, entry)
    if entry.package and source_package and normalize(entry.package) != normalize(source_package):
        raise MarketplaceError("The package name disagrees with the source.")
    package = source_package or entry.package or entry.name
    if plugin_blocked(policy, entry.name, record["name"], package):
        raise MarketplaceError(f"{entry.name} is blocked (policy.toml).")
    if normalize(package) in protected_packages(data_dir):
        raise MarketplaceError(
            f"{package} is part of ComputeDeck or one of its dependencies, not a plugin."
        )
    # Only what the marketplace installed is ever uninstalled by it.
    if _installed_version(package) is not None and not any(
        normalize(other["package"]) == normalize(package) for other in installed(data_dir).values()
    ):
        raise MarketplaceError(
            f"{package} is already installed, but not from a marketplace; remove it first."
        )
    if entry.source.type == "path" and not policy.allow_local:
        raise MarketplaceError("Installing from local folders is not allowed (policy.toml).")
    if not satisfies(core_version(), entry.requires):
        raise MarketplaceError(
            f"{entry.name} {entry.version} needs ComputeDeck {entry.requires}; this is "
            f"{core_version()}."
        )
    with tempfile.TemporaryDirectory(dir=_ensure(data_dir)) as scratch:
        targets, how = install_command(entry, folder, Path(scratch))
        summary = describe(entry, record, how)
        if not confirm(summary):
            raise MarketplaceError("Not installed.")
        if entry.source.type in ("wheel", "git", "path") or (
            entry.source.type == "pypi" and entry.source.sha256
        ):
            # A named direct reference makes the installer check the distribution's
            # metadata, instead of trusting the catalog for later uninstall commands.
            target = targets[0]
            if Path(target).is_absolute():
                target = Path(target).as_uri()
            targets[0] = f"{package} @ {target}"
        code = run([*installer(), *targets])
    if code:
        raise MarketplaceError(f"The installer exited with status {code}.")
    records = installed(data_dir)
    records[entry.name] = {
        "marketplace": record["name"],
        "tier": record["tier"],
        "package": package,
        "version": entry.version,
        "source": entry.source.model_dump(exclude_none=True),
        "installed_at": _now(),
    }
    _write(data_dir / "installed-plugins.json", records)
    return records[entry.name]


def describe(entry: Entry, record: dict[str, Any], how: str) -> str:
    lines = [
        plain(f"{entry.name} {entry.version} from {record['name']} ({record['tier']}), {how}."),
        "A plugin runs inside ComputeDeck with your user's permissions on this machine.",
    ]
    if entry.permissions:
        lines.append("It says it will:")
        lines += [
            f"  - {plain(item.get('en', next(iter(item.values()), '')))}"
            for item in entry.permissions
        ]
    return "\n".join(lines)


def _requirements(package: str, extras: frozenset[str]) -> list[tuple[str, frozenset[str]]]:
    """What an installed distribution depends on, with the extras it asks for."""
    try:
        lines = distribution(package).requires or []
    except PackageNotFoundError:
        return []
    found = []
    for line in lines:
        requirement, _, marker = line.partition(";")
        match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?", requirement)
        wanted = {normalize(extra) for extra in re.findall(r"extra\s*==\s*[\"']([^\"']+)", marker)}
        if match is None or (wanted and not wanted & extras):
            continue
        asked = frozenset(normalize(item) for item in (match[2] or "").split(",") if item.strip())
        found.append((match[1], asked))
    return found


def protected_packages(data_dir: Path) -> set[str]:
    """ComputeDeck, packages that brought plugins or drivers without the marketplace, and
    everything they depend on. None of these is installed or uninstalled as a plugin."""
    recorded = {normalize(record["package"]) for record in installed(data_dir).values()}
    roots = {"computedeck"}
    for group in ("computedeck.plugins", "computedeck.drivers"):
        for item in entry_points(group=group):
            dist = getattr(item, "dist", None)
            name = dist.metadata["Name"] if dist is not None else None
            if name and normalize(name) not in recorded:
                roots.add(normalize(name))
    seen: set[tuple[str, frozenset[str]]] = set()
    stack = [(root, frozenset[str]()) for root in roots]
    while stack:
        package, extras = stack.pop()
        if (normalize(package), extras) not in seen:
            seen.add((normalize(package), extras))
            stack.extend(_requirements(package, extras))
    return {package for package, _ in seen}


def uninstall(data_dir: Path, name: str, *, run: Runner = _run) -> None:
    records = installed(data_dir)
    record = records.get(name)
    if record is None:
        raise MarketplaceError(f"{name} is not an installed plugin.")
    package = record.get("package")
    if not isinstance(package, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", package):
        raise MarketplaceError(f"{name} has no valid installed package.")
    if normalize(package) in protected_packages(data_dir):
        raise MarketplaceError("ComputeDeck and its dependencies cannot be uninstalled as plugins.")
    base = installer()
    command = (
        ["uv", "pip", "uninstall", "--python", sys.executable, package]
        if base[0] == "uv"
        else [sys.executable, "-m", "pip", "uninstall", "--yes", package]
    )
    code = run(command)
    if code:
        raise MarketplaceError(f"The uninstaller exited with status {code}.")
    records.pop(name, None)
    _write(data_dir / "installed-plugins.json", records)
