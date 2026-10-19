"""Loopback API, background collection and optional plugins on one service."""

import asyncio
import fcntl
import json
import logging
import os
import platform
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.utils import is_body_allowed_for_status_code
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import attention, auth, credentials, demo, drivers, marketplace, nodes, paths, toolbox
from . import plugins as plugin_host
from .collector import Collector, ProbeConflict
from .errors import SourceError, message
from .records import (
    InstanceInput,
    SettingsInput,
    SourceInput,
    SourceUpdate,
    instance_id,
    instance_record,
    slug,
    source_record,
)
from .ssh_config import install_config, quote_path, render_config, write_config
from .store import Store, now

logger = logging.getLogger("computedeck")
# How long stopping waits for requests in flight, then for background work to end.
SHUTDOWN_SECONDS = 10


class RefreshInput(BaseModel):
    source_id: str | None = None


class ConfirmInput(BaseModel):
    confirm: bool


class EncodableJSON(JSONResponse):
    """JSON that can always be sent: text UTF-8 cannot encode (a lone surrogate) is escaped."""

    def render(self, content: Any) -> bytes:
        try:
            return super().render(content)
        except UnicodeEncodeError:
            return json.dumps(content, allow_nan=False, separators=(",", ":")).encode()


def encodable(body: bytes) -> bool:
    """False when a JSON body holds text UTF-8 cannot encode, which nothing could store or send."""
    try:
        json.dumps(json.loads(body), ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        return False
    except (ValueError, RecursionError):
        # Not JSON at all: the route itself rejects it.
        pass
    return True


def validate_source(source: dict[str, Any]) -> None:
    try:
        driver = drivers.get(source["driver"])
        if source.get("credential"):
            if source.get("node"):
                # Resolved on the node, which may have schemes this machine lacks.
                if not re.fullmatch(r"[a-z][a-z0-9-]*:[^\s]{1,250}", source["credential"]):
                    raise SourceError(
                        "invalid_credential_reference", reference=source["credential"]
                    )
            else:
                credentials.validate_reference(source["credential"])
        if source["enabled"]:
            driver.validate(source)
    except SourceError as error:
        raise HTTPException(422, error.message()) from None


def create_app(
    data_dir: Path | None = None,
    *,
    polling: bool = True,
    plugins: Iterable[plugin_host.Plugin] | None = None,
) -> FastAPI:
    data_dir = data_dir or paths.data_dir()
    paths.secure_data_dir(data_dir)
    drivers._policy_dir = data_dir
    runtime = plugin_host.Runtime(data_dir)
    collector = Collector(runtime)
    contexts = plugin_host.load(
        plugin_host.discover(data_dir) if plugins is None else plugins, runtime
    )
    token = auth.ensure_token(data_dir) if auth.enabled() else None
    browser_token = secrets.token_urlsafe(32)
    session_nonce = secrets.token_hex(32)
    started = now()
    background: list[asyncio.Task[Any]] = []

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(data_dir / "server.lock", os.O_WRONLY | os.O_CREAT, 0o600)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as lock_file:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise RuntimeError(
                    "Another ComputeDeck service is using this data directory"
                ) from error
            store = Store(data_dir / "computedeck.sqlite")
            runtime.store = store
            plugin_host.track(contexts, store)
            collector.recover()
            write_config(store.dashboard()["instances"], data_dir)
            # A plugin that is off starts when it is switched on.
            for context in contexts:
                context.start()
            if polling:
                background.append(
                    asyncio.create_task(plugin_host.supervise("collector", collector.run, runtime))
                )
                # Each plugin's loops and events run only while it is switched on.
                background.extend(
                    asyncio.create_task(plugin_host.run(context, runtime)) for context in contexts
                )
            try:
                yield
            finally:
                for task in background:
                    task.cancel()
                if background:
                    # A loop slow to stop must not keep the service running.
                    await asyncio.wait(background, timeout=SHUTDOWN_SECONDS)
                await collector.close(SHUTDOWN_SECONDS)
                for context in contexts:
                    if context.started:
                        for callback in context.shutdown:
                            callback()
                store.db.close()

    app = FastAPI(
        title="ComputeDeck",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        default_response_class=EncodableJSON,
    )
    # Lets `serve --open` tell this process from anything else answering on its port.
    app.state.session_nonce = session_nonce
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    # Rejections echo the request, and their details may quote stored text.
    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, error: RequestValidationError) -> Response:
        return EncodableJSON({"detail": jsonable_encoder(error.errors())}, 422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, error: StarletteHTTPException) -> Response:
        headers = getattr(error, "headers", None)
        if not is_body_allowed_for_status_code(error.status_code):
            return Response(status_code=error.status_code, headers=headers)
        return EncodableJSON({"detail": error.detail}, error.status_code, headers=headers)

    @app.middleware("http")
    async def local_requests(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        path = request.url.path
        if (
            token is not None
            and path.startswith("/api/")
            and path not in ("/api/ping", auth.SESSION_PATH)
            and not any(
                auth.matches(secret, request.headers.get(auth.HEADER))
                for secret in (token, browser_token)
            )
        ):
            return JSONResponse({"detail": message("token_required")}, 401)
        # The session endpoint checks its own callers: it must accept the launcher's form.
        if request.method not in ("GET", "HEAD", "OPTIONS") and path != auth.SESSION_PATH:
            port = str(paths.port())
            allowed = {
                f"http://{host}:{p}" for host in ("localhost", "127.0.0.1") for p in ("5173", port)
            }
            # An SSH tunnel may expose this loopback service at a different
            # client port; the browser origin must match its exact host header.
            if request.url.hostname in ("127.0.0.1", "localhost"):
                allowed.add(f"http://{request.headers['host']}")
            # Custom headers force a CORS preflight, so other sites cannot send these.
            # Uploads (team message files) send raw bytes instead of JSON.
            kind = request.headers.get("content-type", "").split(";")[0]
            if (
                request.headers.get("origin") not in allowed
                or request.headers.get("x-computedeck") != "1"
                or kind not in ("application/json", "application/octet-stream")
            ):
                return JSONResponse({"detail": message("local_app_required")}, 403)
            # Checked once here rather than in every input model, plugins' included.
            if kind == "application/json" and not encodable(await request.body()):
                return JSONResponse({"detail": message("text_invalid")}, 422)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path.startswith("/assets/"):
            # Vite names assets by content hash.
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            # index.html must be revalidated so a new build reaches open browsers.
            response.headers["Cache-Control"] = "no-cache"
        return response

    def store() -> Store:
        return runtime.store

    @app.post(auth.SESSION_PATH)
    async def session(request: Request) -> Response:
        """Check a token and hand it to the page origin; never set a cookie.

        Cookies for 127.0.0.1 reach every port, so the token is kept in localStorage,
        which belongs to this origin (scheme, host and port) only.
        """
        kind = request.headers.get("content-type", "").split(";")[0].strip()
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 4096:
                return JSONResponse({"detail": message("token_invalid")}, 413)
            body.extend(chunk)
        form = kind == "application/x-www-form-urlencoded"
        supplied: str | None = None
        proved = False
        if form:
            # A top-level form POST from the private launcher page (origin "null").
            try:
                fields = parse_qs(body.decode("utf-8", "replace"), max_num_fields=4)
            except ValueError:
                return JSONResponse({"detail": message("token_invalid")}, 400)
            supplied = next(iter(fields.get("token", [])), None)
            next_path = auth.safe_next(next(iter(fields.get("next", [])), "/"))
        elif kind == "application/json" and request.headers.get("x-computedeck") == "1":
            # The token form in the page checks a pasted token before storing it.
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            value = data.get("token") if isinstance(data, dict) else None
            supplied = value if isinstance(value, str) else None
            challenge = data.get("challenge") if isinstance(data, dict) else None
            if (
                token is not None
                and isinstance(challenge, str)
                and 0 < len(challenge) <= 128
                and data.get("nonce") == session_nonce
            ):
                proved = auth.matches(
                    auth.session_proof(token, f"{session_nonce}:{challenge}"), data.get("proof")
                )
            next_path = "/"
        else:
            return JSONResponse({"detail": message("token_invalid")}, 400)
        if (
            token is not None
            and not proved
            and not any(auth.matches(secret, supplied) for secret in (token, browser_token))
        ):
            return JSONResponse({"detail": message("token_invalid")}, 401)
        if not form:
            return JSONResponse({"token": browser_token})
        if token is None:
            return RedirectResponse(next_path, 303)
        page = HTMLResponse(auth.handoff_page(browser_token, next_path))
        page.headers["Cache-Control"] = "no-store"
        return page

    @app.get("/api/ping")
    async def ping(
        challenge: str = Query(default="", max_length=128),
        session_challenge: str = Query(default="", max_length=128),
    ) -> dict[str, Any]:
        """Liveness; with a challenge, this process's nonce and a proof for a launcher that
        knows the persistent token. With a session challenge, a proof for a page that holds
        this process's browser session token, before it sends that token."""
        reply: dict[str, Any] = {"status": "ok", "token_required": token is not None}
        if challenge:
            reply["nonce"] = session_nonce
            # Without the token switched on, the data directory's token (read by `connect`)
            # still proves this is the service a launcher means to open.
            secret = token if token is not None else auth.existing_token(data_dir)
            if secret is not None:
                reply["proof"] = auth.server_proof(secret, f"{session_nonce}:{challenge}")
        if session_challenge and token is not None:
            reply["session_proof"] = auth.browser_proof(browser_token, session_challenge)
        return reply

    @app.get("/api/dashboard")
    async def dashboard(demo: bool = False) -> dict[str, Any]:
        if demo:
            return demo_dashboard()
        result = store().dashboard()
        result["refreshing"] = bool(collector.pending)
        result["collecting"] = sorted(collector.pending)
        result["attention"] = attention.derive(
            result,
            [drivers.describe(name) for name in drivers.names()],
            now=datetime.now(UTC),
            loop_errors=runtime.loop_errors,
            unreadable_rows=store().unreadable_rows(),
            plugin_status={
                context.id: {**context.status(), "enabled": context.enabled} for context in contexts
            },
        )
        return result

    @app.get("/api/history")
    async def history(
        hours: int = Query(default=24, ge=1, le=168), demo: bool = False
    ) -> dict[str, Any]:
        """Allocation and utilization points for the chart's time range (up to 7 days)."""
        points = demo_history(hours) if demo else store().history(hours)
        return {"hours": hours, "points": points}

    @app.post("/api/refresh", status_code=202)
    async def refresh(body: RefreshInput) -> dict[str, str]:
        sources = [source for source in store().sources() if source["enabled"]]
        if body.source_id:
            if not store().source(body.source_id):
                raise HTTPException(404, message("source_not_found"))
            sources = [source for source in sources if source["id"] == body.source_id]
        queued = False
        for source in sources:
            queued = collector.enqueue(source["id"]) or queued
        return {"status": "queued" if queued else "running" if collector.pending else "idle"}

    @app.get("/api/drivers")
    async def driver_list() -> list[dict[str, Any]]:
        return [drivers.describe(name) for name in drivers.names()]

    @app.post("/api/sources/{source_id}/check")
    async def check_source_now(source_id: str) -> list[dict[str, Any]]:
        from .doctor import source_checks

        source = store().source(source_id)
        if source is None:
            raise HTTPException(404, message("source_not_found"))
        async with runtime.semaphore:
            return await source_checks(source, store().node(source.get("node", "")))

    @app.post("/api/sources", status_code=201)
    async def add_source(body: SourceInput) -> dict[str, Any]:
        try:
            source = source_record(body)
        except ValueError as error:
            raise HTTPException(422, message(str(error))) from None
        cluster_id = source["cluster_id"]
        if store().source(source["id"]):
            raise HTTPException(409, message("source_exists"))
        if any(
            other["cluster_id"] == cluster_id and other["driver"] != body.driver
            for other in store().sources()
        ):
            raise HTTPException(409, message("cluster_driver_mismatch"))
        check_node(source)
        validate_source(source)
        if source["enabled"]:
            source["next_due_at"] = now()
        store().save_source(source)
        return store().source(source["id"]) or source

    @app.put("/api/sources/{source_id}")
    async def update_source(source_id: str, body: SourceUpdate) -> dict[str, Any]:
        source = store().source(source_id)
        if not source:
            raise HTTPException(404, message("source_not_found"))
        changes = body.model_dump(exclude_none=True)
        # Sources saved before options existed have none; an empty dict is the same.
        source.setdefault("options", {})
        source.setdefault("node", "")
        connection_changed = any(
            key in changes and changes[key] != source.get(key)
            for key in ("ssh_alias", "credential", "username", "options", "node")
        )
        enabled_changed = "enabled" in changes and changes["enabled"] != source["enabled"]
        source.update(changes)
        check_node(source)
        validate_source(source)
        source["next_due_at"] = now()
        if connection_changed or enabled_changed:
            source.update(
                status="ready" if source["enabled"] else "unconfigured", error=None, failures=0
            )
        if connection_changed:
            source.update(
                last_success=None,
                capabilities=[],
                capabilities_seen=[],
                warnings=[],
                cluster_state="unknown",
            )
        store().save_source(source)
        collector.clear_inactive_commit_errors()
        return store().source(source_id) or source

    def check_node(source: dict[str, Any]) -> None:
        if source.get("node") and store().node(source["node"]) is None:
            raise HTTPException(422, message("node_not_found", node=source["node"]))

    @app.get("/api/nodes")
    async def node_list(demo: bool = False) -> list[dict[str, Any]]:
        return demo_nodes() if demo else store().nodes()

    @app.post("/api/nodes", status_code=201)
    async def add_node(body: nodes.NodeInput) -> dict[str, Any]:
        try:
            node = nodes.node_record(body, slug(body.name))
        except ValueError as error:
            raise HTTPException(422, message(str(error))) from None
        if store().node(node["id"]):
            raise HTTPException(409, message("node_exists"))
        store().save_node(node)
        return node

    @app.put("/api/nodes/{node_id}")
    async def update_node(node_id: str, body: nodes.NodeInput) -> dict[str, Any]:
        current = store().node(node_id)
        if current is None:
            raise HTTPException(404, message("node_not_found", node=node_id))
        try:
            node = {**current, **nodes.node_record(body, node_id)}
        except ValueError as error:
            raise HTTPException(422, message(str(error))) from None
        store().save_node(node)
        for source in store().sources():
            if source.get("node") == node_id:
                # A different machine or command is a different connection.
                store().save_source({**source, "next_due_at": now()})
        return node

    @app.delete("/api/nodes/{node_id}")
    async def delete_node(node_id: str) -> dict[str, bool]:
        if any(source.get("node") == node_id for source in store().sources()):
            raise HTTPException(409, message("node_in_use"))
        if not store().delete_node(node_id):
            raise HTTPException(404, message("node_not_found", node=node_id))
        return {"deleted": True}

    @app.post("/api/nodes/{node_id}/check")
    async def check_node_now(node_id: str) -> dict[str, Any]:
        node = store().node(node_id)
        if node is None:
            raise HTTPException(404, message("node_not_found", node=node_id))
        try:
            result = {**await nodes.info(node), "status": "ok", "error": None}
        except SourceError as error:
            result = {"status": "error", "error": error.message()}
        # Read again: the node may have been deleted or edited while it was checked.
        current = store().node(node_id)
        if current is None:
            raise HTTPException(404, message("node_not_found", node=node_id))
        if any(current.get(key) != node.get(key) for key in ("ssh_alias", "command")):
            # The answer describes the old connection.
            raise HTTPException(409, message("node_changed", node=current["name"]))
        current.update(result, checked_at=now())
        store().save_node(current)
        return current

    @app.delete("/api/sources/{source_id}")
    async def delete_source(source_id: str) -> dict[str, bool]:
        if not store().delete_source(source_id):
            raise HTTPException(404, message("source_not_found"))
        collector.clear_inactive_commit_errors()
        write_config(store().dashboard()["instances"], data_dir)
        return {"deleted": True}

    def save_manual(body: InstanceInput, existing: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            instance = instance_record(body)
        except ValueError as error:
            raise HTTPException(422, message(str(error))) from None
        if existing and existing["id"] != instance["id"]:
            raise HTTPException(400, message("instance_identity_fixed"))
        try:
            render_config([instance])
        except ValueError as error:
            raise HTTPException(422, message("invalid_endpoint", detail=str(error))) from error
        rows = [row for row in store().dashboard()["instances"] if row["id"] != instance["id"]]
        write_config([*rows, instance], data_dir)
        store().save_instance(instance)
        return instance

    def manual(instance_id: str) -> dict[str, Any]:
        instance = next((r for r in store().manual_instances() if r["id"] == instance_id), None)
        if not instance:
            raise HTTPException(404, message("instance_not_found"))
        return instance

    @app.post("/api/instances", status_code=201)
    async def add_instance(body: InstanceInput) -> dict[str, Any]:
        try:
            key = instance_id(body)
        except ValueError as error:
            raise HTTPException(422, message(str(error))) from None
        if any(row["id"] == key for row in store().manual_instances()):
            raise HTTPException(409, message("instance_exists"))
        return save_manual(body)

    @app.put("/api/instances/{instance_id}")
    async def update_instance(instance_id: str, body: InstanceInput) -> dict[str, Any]:
        return save_manual(body, manual(instance_id))

    @app.delete("/api/instances/{instance_id}")
    async def delete_instance(instance_id: str) -> dict[str, bool]:
        manual(instance_id)
        store().delete_instance(instance_id)
        write_config(store().dashboard()["instances"], data_dir)
        return {"deleted": True}

    @app.post("/api/instances/{instance_id}/probe")
    async def probe(instance_id: str) -> dict[str, Any]:
        try:
            return await collector.probe(instance_id)
        except LookupError:
            raise HTTPException(404, message("instance_not_found")) from None
        except ProbeConflict as conflict:
            raise HTTPException(409, message(str(conflict))) from None
        except SourceError as error:
            raise HTTPException(502, error.message()) from None
        except Exception as error:
            raise HTTPException(
                502, message("probe_failed", detail=str(error)[:300] or type(error).__name__)
            ) from None

    def ssh_state() -> dict[str, Any]:
        path = data_dir / "computedeck.conf"
        config = render_config(store().dashboard()["instances"], strict=False)
        user_config = Path.home() / ".ssh/config"
        prefix = f"# ComputeDeck managed endpoints\nInclude {quote_path(path.resolve())}\n\n"
        try:
            installed = user_config.read_text(encoding="utf-8").startswith(prefix)
        except (OSError, UnicodeError):
            installed = False
        return {"config": config, "path": str(path), "installed": installed}

    @app.get("/api/ssh/config")
    async def ssh_config() -> dict[str, Any]:
        return ssh_state()

    @app.post("/api/ssh/install")
    async def ssh_install(body: ConfirmInput) -> dict[str, Any]:
        if not body.confirm:
            raise HTTPException(400, message("confirm_required"))
        path = write_config(store().dashboard()["instances"], data_dir)
        try:
            install_config(path, Path.home() / ".ssh")
        except (ValueError, OSError) as error:
            raise HTTPException(422, message("ssh_install_failed", detail=str(error))) from error
        return ssh_state()

    @app.get("/api/settings")
    async def settings() -> dict[str, Any]:
        return store().settings()

    @app.put("/api/settings")
    async def save_settings(body: SettingsInput) -> dict[str, Any]:
        return store().save_settings(body.model_dump(exclude_unset=True))

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        sources = store().sources()
        enabled = {source["id"] for source in sources if source["enabled"]}
        return {
            "status": "ok",
            "application": "ComputeDeck",
            "server_host": platform.node(),
            "server_name": store().settings()["server_name"],
            "started_at": started,
            "database_path": str(store().path),
            "polling": polling,
            "ssh_installed": ssh_state()["installed"],
            "source_count": len(sources),
            "plugins": {
                context.id: {**context.status(), "enabled": context.enabled} for context in contexts
            },
            "background_errors": {
                key: error
                for key, error in runtime.loop_errors.items()
                if not key.startswith("collector:commit:")
                or key.removeprefix("collector:commit:") in enabled
            },
            "unreadable_rows": store().unreadable_rows(),
        }

    def plugin_context(plugin_id: str) -> plugin_host.PluginContext:
        context = next((item for item in contexts if item.id == plugin_id), None)
        if context is None:
            raise HTTPException(404, message("plugin_not_found", plugin=plugin_id))
        return context

    @app.get("/api/toolbox")
    async def toolbox_list() -> list[dict[str, Any]]:
        return [toolbox.entry(context, runtime) for context in contexts]

    @app.put("/api/toolbox/{plugin_id}")
    async def toolbox_update(plugin_id: str, body: toolbox.ToolboxUpdate) -> dict[str, Any]:
        context = plugin_context(plugin_id)
        try:
            toolbox.update(context, body)
        except toolbox.SettingsError as error:
            raise HTTPException(422, message(str(error), **error.params)) from None
        return toolbox.entry(context, runtime)

    @app.get("/api/marketplace")
    async def marketplaces() -> dict[str, Any]:
        """What the added marketplaces offer. Installing happens on the command line."""
        try:
            plugins = marketplace.listing(data_dir)
            records = marketplace.registry(data_dir)
            problems = marketplace.problems(data_dir)
            policy_error = None
        except marketplace.MarketplaceError as error:
            plugins, records, problems, policy_error = [], {}, {}, str(error)
        return {
            "marketplaces": [
                {key: record.get(key) for key in ("name", "kind", "tier", "updated_at")}
                | {
                    "source": marketplace.display_source(record["source"]),
                    # A catalog saved by an older version that this one rejects.
                    "plugins": (
                        0 if record["name"] in problems else len(record["catalog"]["plugins"])
                    ),
                    "error": problems.get(record["name"]),
                }
                for record in records.values()
            ],
            "plugins": plugins,
            "policy_error": policy_error,
        }

    @app.get("/api/events")
    async def recent_events(
        limit: int = Query(default=50, ge=1, le=200), demo: bool = False
    ) -> list[dict[str, Any]]:
        return demo_events()[:limit] if demo else store().recent_events(limit)

    @app.post("/api/backup")
    async def backup() -> dict[str, str]:
        return {"path": str(store().backup(data_dir / "backups", paths.backups_kept()))}

    for context in contexts:
        if context.rejected is None:
            app.include_router(context.router)
        web = plugin_host.web_bundle(context.plugin)
        if context.rejected is None and web is not None and context.plugin.package:
            # One bundle per package, shared by the package's plugins.
            path = f"/plugin-web/{context.plugin.package}"
            if not any(getattr(route, "path", None) == path for route in app.routes):
                app.mount(path, StaticFiles(directory=web), name=f"web:{context.plugin.package}")

    web_dir = paths.web_dir()
    if web_dir is not None:
        app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
    return app


def demo_dashboard() -> dict[str, Any]:
    return demo.dashboard()


def demo_nodes() -> list[dict[str, Any]]:
    return demo.nodes()


def demo_events() -> list[dict[str, Any]]:
    return demo.events()


def demo_history(hours: int) -> list[dict[str, Any]]:
    return demo.demo_history(hours)


def serve(
    host: str = "127.0.0.1",
    port: int | None = None,
    *,
    ready: Callable[[str], None] | None = None,
) -> bool:
    """Run the service until it stops; False when it could not start.

    ``ready`` is called with this process's session nonce once it listens.
    """
    import threading

    import uvicorn

    from .logging_setup import configure

    configure(paths.data_dir())
    app = create_app()
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=host,
            port=port or paths.port(),
            workers=1,
            access_log=False,
            log_config=None,
            # A hanging request (a browse of an unreachable host) must not delay stopping.
            timeout_graceful_shutdown=SHUTDOWN_SECONDS,
            log_level=os.environ.get("COMPUTEDECK_LOG_LEVEL", "info"),
        )
    )
    stopped = threading.Event()

    def when_listening(ready: Callable[[str], None]) -> None:
        while not server.started:
            if stopped.wait(0.1):
                return
        ready(app.state.session_nonce)

    if ready is not None:
        threading.Thread(target=when_listening, args=(ready,), daemon=True).start()
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        # uvicorn exits when the port is taken or startup fails; it has logged why.
        return False
    finally:
        stopped.set()
    return server.started
