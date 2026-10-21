"""Optional server plugins: extra routes, background loops and storage on the shared service.

A plugin is an installed package exposing a ``Plugin`` object through the
``computedeck.plugins`` entry point group. The core never refers to a plugin by name.

A plugin can be switched off in the Toolbox. While it is off its routes answer 404,
its background loops are stopped, it receives no events, its startup callbacks do not
run and its credential schemes resolve nothing. Plugins shipped with the core start off;
a separately installed package starts on, since installing it is the owner's choice.
"""

import asyncio
import json
import logging
import os
import re
import sqlite3
from collections.abc import Callable, Coroutine, Iterable, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field, replace
from importlib.metadata import entry_points
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .errors import message
from .events import for_handler

if TYPE_CHECKING:
    from .store import Store

logger = logging.getLogger("computedeck")
ENTRY_POINT_GROUP = "computedeck.plugins"
# The plugin API this core provides. A plugin written for a newer API is not loaded.
PLUGIN_API = 1


def compatibility(plugin: "Plugin") -> dict[str, Any] | None:
    """Why a plugin cannot run on this core, as a message, or None when it can."""
    from .versions import core_version, satisfies, valid_range

    if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", plugin.id):
        return message("plugin_id_invalid", plugin=plugin.id)
    if plugin.api > PLUGIN_API:
        return message("plugin_api_newer", api=plugin.api, supported=PLUGIN_API)
    if plugin.requires:
        if not valid_range(plugin.requires):
            return message("plugin_requires_invalid", requires=plugin.requires)
        if not satisfies(core_version(), plugin.requires):
            return message("plugin_requires_core", requires=plugin.requires, version=core_version())
    return None


def web_bundle(plugin: "Plugin") -> Path | None:
    """The plugin's built web folder, when it declares one and index.js is there."""
    if plugin.web is None or not (Path(plugin.web) / "index.js").is_file():
        return None
    return Path(plugin.web)


# Localized text: {"en": "...", "zh-CN": "..."}. English is required.
Text = dict[str, str]
EventHandler = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


class SettingField(BaseModel):
    """One setting of a plugin, edited in the Toolbox without any plugin web code."""

    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: Text
    hint: Text = Field(default_factory=dict)
    kind: Literal["text", "textarea", "number", "boolean", "select", "credential"] = "text"
    default: str | int | float | bool | None = None
    required: bool = False
    choices: list[str] | None = None
    placeholder: str = ""


@dataclass(frozen=True)
class Plugin:
    id: str
    setup: Callable[["PluginContext"], None]
    name: Text | None = None
    description: Text | None = None
    # Tools shipped with the core start off; an installed package is on until switched off.
    default_enabled: bool = True
    settings: tuple[SettingField, ...] = ()
    # The web page that belongs to the plugin, if the web app has one.
    page: str | None = None
    # An icon name for the Toolbox: bell, chat, transfer, network, users, key, mail, chart,
    # shield, server, cloud, bot, wrench or puzzle (the default).
    icon: str | None = None
    # Shown in the Toolbox: what turning the plugin on lets it do, e.g. "writes files".
    permissions: tuple[Text, ...] = field(default_factory=tuple)
    # The plugin API this plugin was written against, and the core versions it supports.
    api: int = 1
    requires: str | None = None
    author: str | None = None
    homepage: str | None = None
    # A folder with a prebuilt web bundle (index.js, optional index.css) that registers
    # pages with the web app at run time; see docs/plugins.md.
    web: Path | None = None
    # Filled in on discovery from the installed distribution.
    package: str | None = None
    version: str | None = None
    # A failed import stays visible in diagnostics and the Toolbox.
    load_error: str | None = None


class Runtime:
    """Service state shared by the core collector and plugins; filled in at startup."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._store: Store | None = None
        # Bounds concurrent remote work across collectors and plugins.
        self.semaphore = asyncio.Semaphore(3)
        self._cluster_locks: dict[str, asyncio.Lock] = {}
        # Latest failure of each supervised background loop, reported by /api/health.
        self.loop_errors: dict[str, dict[str, str]] = {}

    @property
    def store(self) -> "Store":
        if self._store is None:
            raise RuntimeError("The service has not started")
        return self._store

    @store.setter
    def store(self, value: "Store") -> None:
        self._store = value

    def cluster_lock(self, cluster_id: str) -> asyncio.Lock:
        """Different identities on one cluster share a single connection budget."""
        return self._cluster_locks.setdefault(cluster_id, asyncio.Lock())

    def report(self, name: str, error: BaseException) -> None:
        from .store import now

        self.loop_errors[name] = {"at": now(), "error": failure(error)}


def failure(error: BaseException) -> str:
    return f"{type(error).__name__}: {str(error)[:300]}"


class PluginContext:
    def __init__(self, plugin: Plugin, runtime: Runtime) -> None:
        self.id = plugin.id
        self.plugin = plugin
        self.runtime = runtime
        # Set when the plugin cannot run on this core; it is then listed but never set up.
        self.rejected: dict[str, Any] | None = None
        self.router = APIRouter(
            prefix=f"/api/plugins/{plugin.id}", dependencies=[Depends(self._require_enabled)]
        )
        self.loops: list[Callable[[], Coroutine[Any, Any, None]]] = []
        self.startup: list[Callable[[], None]] = []
        self.shutdown: list[Callable[[], None]] = []
        self.health: Callable[[], dict[str, Any]] | None = None
        self.handlers: list[tuple[frozenset[str] | None, EventHandler]] = []
        self.validator: Callable[[dict[str, Any]], dict[str, Any]] | None = None
        # Set when the plugin is switched on or off, or its settings change.
        self.changed = asyncio.Event()
        # Whether the startup callbacks ran in this process.
        self.started = False

    @property
    def store(self) -> "Store":
        return self.runtime.store

    @property
    def enabled(self) -> bool:
        if self.rejected is not None:
            return False
        if self.runtime._store is None:
            # A command-line run without a database: nothing was switched yet.
            return self.plugin.default_enabled
        return self.store.plugin_enabled(self.id, self.plugin.default_enabled)

    def start(self) -> None:
        """Run the startup callbacks once, the first time the plugin is on.

        A failing callback is logged and reported on this plugin; the service keeps running.
        """
        if self.started or not self.enabled:
            return
        self.started = True
        for callback in self.startup:
            try:
                callback()
            except Exception as error:
                logger.exception("Plugin %s failed to start", self.id)
                self.runtime.report(f"{self.id}:startup", error)
                break

    def status(self) -> dict[str, Any]:
        """The plugin's own health while it runs; a failing report is itself the report."""
        if not (self.health and self.started and self.enabled):
            return {}
        try:
            status = self.health()
            if not isinstance(status, dict):
                error_message = f"{type(status).__name__} is not a health dict"
                logger.warning("Plugin %s: %s", self.id, error_message)
                return {"error": error_message}
            return status
        except Exception as error:
            # Asked on every health/dashboard poll: a warning, not a traceback each time.
            logger.warning("Plugin %s could not report its health: %s", self.id, failure(error))
            return {"error": failure(error)}

    def settings(self) -> dict[str, Any]:
        """Saved settings over the declared defaults."""
        values = {item.key: item.default for item in self.plugin.settings}
        values.update(self.store.plugin_settings(self.id))
        return values

    def validate_settings(self, validator: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        """Check settings beyond their declared kinds; raise ValueError with a message code."""
        self.validator = validator

    def on_event(self, handler: EventHandler, types: Iterable[str] | None = None) -> None:
        """Receive events such as ``job.failed`` while the plugin is on.

        Events are stored before delivery, so one raised during a short restart is
        still delivered. Each plugin keeps its own position in the event log.
        """
        self.handlers.append((None if types is None else frozenset(types), handler))

    async def _require_enabled(self) -> None:
        if not self.enabled:
            raise HTTPException(404, message("plugin_disabled", plugin=self.id))
        self.start()

    @property
    def data_dir(self) -> Path:
        """Private files for this plugin, separate from the service's configuration."""
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", self.id):
            raise ValueError("Invalid plugin id")
        directory = self.runtime.data_dir / "plugins" / self.id
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        return directory

    @contextmanager
    def database(self) -> Iterator[sqlite3.Connection]:
        """A transaction on this plugin's SQLite database; closes on exit.

        Plugins may create their own tables here with the standard sqlite3 API.
        """
        path = self.data_dir / "storage.sqlite"
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.fchmod(descriptor, 0o600)
        os.close(descriptor)
        db = sqlite3.connect(path)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get_state(self, key: str, default: Any = None) -> Any:
        """Read a JSON value from this plugin's key/value storage."""
        with self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS plugin_state (key TEXT PRIMARY KEY, value TEXT)")
            row = db.execute("SELECT value FROM plugin_state WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_state(self, key: str, value: Any) -> None:
        """Save a JSON value, committing it before this call returns."""
        encoded = json.dumps(value, allow_nan=False)
        with self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS plugin_state (key TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT OR REPLACE INTO plugin_state VALUES (?, ?)", (key, encoded))

    def sources(self) -> list[dict[str, Any]]:
        """Read the configured sources without importing the core Store type."""
        return self.store.sources()

    def source(self, source_id: str) -> dict[str, Any] | None:
        return self.store.source(source_id)

    def background(self, loop: Callable[[], Coroutine[Any, Any, None]]) -> None:
        """Run a long-lived coroutine from startup until the service stops."""
        self.loops.append(loop)

    def credential_scheme(
        self, scheme: str, resolver: Callable[[str], str | None], pattern: str | None = None
    ) -> None:
        """Let sources reference secrets as ``scheme:name`` through this resolver."""
        from . import credentials

        def resolve(name: str) -> str | None:
            if not self.enabled:
                raise credentials.DisabledSchemeError(scheme, self.id)
            return resolver(name)

        if pattern is None:
            credentials.register(scheme, resolve)
        else:
            credentials.register(scheme, resolve, pattern)

    def on_startup(self, callback: Callable[[], None]) -> None:
        self.startup.append(callback)

    def on_shutdown(self, callback: Callable[[], None]) -> None:
        self.shutdown.append(callback)


# A restarted loop that runs this long without failing again has recovered.
RECOVERED_AFTER = 60.0


async def supervise(
    name: str, loop: Callable[[], Coroutine[Any, Any, None]], runtime: Runtime
) -> None:
    """Keep a background loop alive: log a crash, report it in health, restart it.

    The report is withdrawn once the restarted loop has run for a minute without failing.
    """
    while True:
        task = asyncio.ensure_future(loop())
        try:
            if name in runtime.loop_errors:
                await asyncio.wait([task], timeout=RECOVERED_AFTER)
                if not task.done():
                    runtime.loop_errors.pop(name, None)
            await task
            return
        except asyncio.CancelledError:
            task.cancel()
            raise
        except Exception as error:
            logger.exception("Background loop %s failed; restarting in 30 seconds", name)
            runtime.report(name, error)
            await asyncio.sleep(30)


def _entry_names_by_package() -> dict[str, set[str]]:
    """Plugin and driver entry-point names of each installed distribution, without importing."""
    from .marketplace import normalize

    names: dict[str, set[str]] = {}
    for group in (ENTRY_POINT_GROUP, "computedeck.drivers"):
        for entry in entry_points(group=group):
            dist = getattr(entry, "dist", None)
            if dist is None or not dist.metadata["Name"]:
                continue
            found = names.setdefault(normalize(dist.metadata["Name"]), set())
            found.add(entry.name)
            found.update(
                item.name
                for item in getattr(dist, "entry_points", None) or ()
                if item.group in (ENTRY_POINT_GROUP, "computedeck.drivers")
            )
    return names


def policy_check(data_dir: Path) -> Callable[[Plugin], bool]:
    """Whether policy.toml blocks a plugin, before any of its package's code is imported.

    A pattern can name the entry point, the distribution, or the catalog name and
    marketplace a plugin was installed from (``name``, ``name@market``, ``*@market``).
    Importing one entry point runs its package's code, so blocking one blocks them all.
    """
    from . import marketplace
    from .marketplace import normalize

    try:
        policy = marketplace.load_policy(data_dir)
        installed = marketplace.installed(data_dir)
    except marketplace.MarketplaceError as error:
        # The message says what is wrong; a traceback would only bury it.
        logger.error("Plugin policy cannot be read; only built-in plugins are loaded: %s", error)
        return lambda plugin: plugin.package != "computedeck"
    origins: dict[str, list[tuple[str, str]]] = {}
    for catalog_name, record in installed.items():
        origins.setdefault(normalize(record["package"]), []).append(
            (catalog_name, str(record.get("marketplace") or ""))
        )
    siblings = _entry_names_by_package()

    def one(name: str, package: str) -> bool:
        found = origins.get(normalize(package), []) if package else []
        if not found and name in installed:
            found = [(name, str(installed[name].get("marketplace") or ""))]
        if not found:
            return marketplace.plugin_blocked(policy, name, "", package)
        return any(
            marketplace.plugin_blocked(policy, name, market, package)
            or marketplace.plugin_blocked(policy, catalog_name, market, package)
            for catalog_name, market in found
        )

    def blocked(plugin: Plugin) -> bool:
        package = plugin.package or ""
        names = {plugin.id}
        # The core's own tools are separate: its code runs anyway.
        if package and normalize(package) != "computedeck":
            names |= siblings.get(normalize(package), set())
        return any(one(name, package) for name in sorted(names))

    return blocked


def discover(data_dir: Path | None = None) -> list[Plugin]:
    from . import paths

    blocked = policy_check(data_dir or paths.data_dir())
    plugins = []
    for entry in sorted(entry_points(group=ENTRY_POINT_GROUP), key=lambda item: item.name):
        dist = getattr(entry, "dist", None)
        candidate = Plugin(
            id=entry.name,
            setup=lambda context: None,
            package=dist.metadata["Name"] if dist is not None else None,
        )
        if blocked(candidate):
            plugins.append(candidate)
            continue
        try:
            plugin = entry.load()
        except Exception as error:
            detail = type(error).__name__
            logger.error("Plugin %s could not be loaded: %s", entry.name, detail)
            plugins.append(replace(candidate, load_error=detail))
            continue
        if not isinstance(plugin, Plugin):
            logger.error("Entry point %s is not a computedeck Plugin", entry.name)
            plugins.append(replace(candidate, load_error="Invalid plugin entry point"))
            continue
        dist = getattr(entry, "dist", None)
        if dist is not None:
            plugin = replace(
                plugin,
                package=dist.metadata["Name"],
                version=plugin.version or dist.version,
            )
        plugins.append(plugin)
    return plugins


def load(
    plugins: Iterable[Plugin],
    runtime: Runtime,
    blocked: Callable[[Plugin], bool] | None = None,
) -> list[PluginContext]:
    blocked = blocked or policy_check(runtime.data_dir)
    contexts = []
    seen: set[str] = set()
    for plugin in plugins:
        if plugin.id in seen:
            raise ValueError(f"Duplicate plugin id: {plugin.id}")
        seen.add(plugin.id)
        context = PluginContext(plugin, runtime)
        context.rejected = message("plugin_blocked") if blocked(plugin) else compatibility(plugin)
        if context.rejected is None and plugin.load_error is not None:
            context.rejected = message("plugin_load_failed", detail=plugin.load_error)
        if context.rejected is not None:
            logger.error("Plugin %s is not loaded: %s", plugin.id, context.rejected)
        else:
            try:
                plugin.setup(context)
            except Exception as error:
                # Listed with the reason, like a plugin this core cannot run.
                logger.exception("Plugin %s could not be set up", plugin.id)
                context.rejected = message("plugin_setup_failed", detail=failure(error))
        contexts.append(context)
    return contexts


def track(contexts: list[PluginContext], store: "Store") -> None:
    """Start a plugin the last run did not load (new, reinstalled or no longer blocked) at
    the head of the event log, not with the backlog since its previous installation."""
    loaded = sorted(context.id for context in contexts if context.rejected is None)
    previous = store.loaded_plugins()
    if previous is not None:
        head = store.last_event_id()
        for plugin_id in loaded:
            if plugin_id not in previous:
                store.set_plugin_cursor(plugin_id, head)
    store.set_loaded_plugins(loaded)


async def _stop(tasks: list[asyncio.Task[Any]]) -> None:
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def run(context: PluginContext, runtime: Runtime) -> None:
    """Run a plugin's loops and event delivery while it is on; stop them while it is off."""
    if context.rejected is not None:
        return
    tasks: list[asyncio.Task[Any]] = []
    try:
        while True:
            enabled = context.enabled
            if enabled and not tasks:
                context.start()
                tasks = [
                    asyncio.create_task(supervise(f"{context.id}:{index}", loop, runtime))
                    for index, loop in enumerate(context.loops)
                ]
                if context.handlers:
                    tasks.append(
                        asyncio.create_task(
                            supervise(f"{context.id}:events", lambda: deliver(context), runtime)
                        )
                    )
            elif not enabled and tasks:
                await _stop(tasks)
                tasks = []
            context.changed.clear()
            # Also look again now and then: an import from the command line can switch it.
            with suppress(TimeoutError):
                async with asyncio.timeout(30):
                    await context.changed.wait()
    finally:
        await _stop(tasks)


async def deliver(context: PluginContext, poll: float = 2.0) -> None:
    """Hand stored events to the plugin's handlers, in order, from its own cursor."""
    store = context.store
    cursor = store.plugin_cursor(context.id)
    if cursor is None:
        # A plugin that was never on starts with what happens from now on.
        cursor = store.last_event_id()
        store.set_plugin_cursor(context.id, cursor)
    while True:
        handled = failed = False
        for event in store.events(after=cursor, limit=100):
            if not event["silent"]:
                for types, handler in context.handlers:
                    if (delivery := for_handler(event, types)) is not None:
                        try:
                            await handler(delivery)
                            handled = True
                        except asyncio.CancelledError:
                            raise
                        except Exception as error:
                            # One bad event must not block every later one.
                            logger.exception(
                                "Plugin %s failed on event %s", context.id, event["id"]
                            )
                            context.runtime.report(f"{context.id}:events", error)
                            failed = True
            cursor = event["id"]
            store.set_plugin_cursor(context.id, cursor)
        if handled and not failed:
            # Delivering again: an earlier failure is no longer current.
            context.runtime.loop_errors.pop(f"{context.id}:events", None)
        await asyncio.sleep(poll)
