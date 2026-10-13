"""Independent, bounded background collection. API requests only read committed snapshots."""

import asyncio
import logging
import math
from collections.abc import Coroutine
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from typing import Any

from . import drivers, events, nodes
from .errors import SourceError, message
from .hardware import probe_instance
from .plugins import Runtime
from .ssh_config import write_config
from .store import Store, now

logger = logging.getLogger("computedeck")
# Settings whose change means an in-flight result belongs to an old connection.
CONNECTION_KEYS = ("ssh_alias", "enabled", "credential", "username", "options", "node")
PERCENTAGES = ("gpu_utilization", "cpu_utilization", "memory_utilization")


def measured(instance_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """A probe result with each impossible percentage left unknown, never stored.

    A container can report more memory available than in total: below 0 percent.
    """
    for key in PERCENTAGES:
        value = result.get(key)
        if value is not None and not (
            isinstance(value, int | float)
            and not isinstance(value, bool)
            and math.isfinite(value)
            and 0 <= value <= 100
        ):
            logger.warning("Probe of %s measured %s %r; left unknown", instance_id, key, value)
            result[key] = None
    return result


class NodeChanged(Exception):
    """The collection node was edited or deleted while its request was running."""


class ProbeConflict(Exception):
    """The instance changed or is already being checked."""


class Collector:
    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime
        self.pending: set[str] = set()
        self.probes: set[str] = set()
        self.tasks: set[asyncio.Task[Any]] = set()

    @property
    def store(self) -> Store:
        return self.runtime.store

    def spawn(self, coroutine: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def enqueue(self, source_id: str) -> bool:
        if source_id in self.pending:
            return False
        self.pending.add(source_id)
        self.spawn(self.collect(source_id))
        return True

    async def collect(self, source_id: str) -> None:
        try:
            source = self.store.source(source_id)
            if not source:
                return
            async with self.runtime.semaphore, self.runtime.cluster_lock(source["cluster_id"]):
                await self._collect(source_id)
        except Exception:
            logger.exception("Collection could not be committed for %s", source_id)
        finally:
            self.pending.discard(source_id)

    async def _collect(self, source_id: str) -> None:
        source = self.store.source(source_id)
        if not source or not source["enabled"]:
            return
        status_before = source.get("status")
        if (source.get("error") or {}).get("code") == "collection_interrupted":
            status_before = "ready"
        source.update(status="syncing", last_attempt=now())
        self.store.save_source(source)
        changes: list[dict[str, Any]] = []
        try:
            batch = await asyncio.wait_for(self._batch(source), timeout=120)
            batch.validate_rows()
            current = self.store.source(source_id)
            if not current or any(current.get(key) != source.get(key) for key in CONNECTION_KEYS):
                # The response belongs to a deleted source or an old connection. New
                # settings are collected on the next scheduler tick.
                return
            changes = events.collected(
                {**source, "status_before": status_before},
                self.store.snapshot(source_id),
                batch,
                first=not source.get("last_success"),
            )
            # Write only a successful collection. Failures preserve last good snapshots.
            self.store.save_snapshot(source_id, batch.snapshot())
            source.update(
                status="ready",
                last_success=now(),
                error=None,
                failures=0,
                capabilities=batch.capabilities,
                warnings=batch.warnings,
                cluster_state=batch.cluster_state,
            )
            if batch.qos is not None:
                source["qos"] = batch.qos
            if batch.account is not None:
                source["account"] = {**batch.account, "observed_at": now()}
        except NodeChanged:
            current = self.store.source(source_id)
            if current and all(current.get(key) == source.get(key) for key in CONNECTION_KEYS):
                current.update(status=status_before, next_due_at=now())
                self.store.save_source(current)
            return
        except Exception as error:
            source.update(
                status="error", error=_error(error), failures=source.get("failures", 0) + 1
            )
            changes = events.failed({**source, "status_before": status_before}, source["error"])
        delay = source["interval_minutes"] * 60
        if source.get("failures", 0):
            delay = max(delay, min(1800, 60 * 2 ** min(source["failures"], 5)))
        source["next_due_at"] = (datetime.now(UTC) + timedelta(seconds=delay)).isoformat()
        current = self.store.source(source_id)
        if not current or any(current.get(key) != source.get(key) for key in CONNECTION_KEYS):
            # Deleted, or reconnected while this attempt ran: the edit already reset the
            # source, and this attempt's outcome describes the old connection.
            return
        # Keep other edits made meanwhile, and collect again under the new settings.
        if any(current.get(key) != source.get(key) for key in ("interval_minutes", "name")):
            source.update(interval_minutes=current["interval_minutes"], name=current["name"])
            source["next_due_at"] = now()
        self.store.save_source(source)
        if changes:
            self.store.add_events(changes)
        if source["status"] == "ready":
            self.store.record_history()
            write_config(self.store.dashboard()["instances"], self.runtime.data_dir)

    async def _batch(self, source: dict[str, Any]) -> drivers.Batch:
        """Collect here, or on the node the source names."""
        node_id = source.get("node") or ""
        if not node_id:
            return await drivers.get(source["driver"]).collect(source)
        node = self.store.node(node_id)
        if node is None:
            raise SourceError("node_not_found", node=node_id)

        def current_node() -> dict[str, Any]:
            current = self.store.node(node_id)
            if current is None or any(
                current.get(key) != node.get(key) for key in ("ssh_alias", "command")
            ):
                raise NodeChanged
            return current

        try:
            batch = await nodes.collect(node, source)
        except SourceError as error:
            current = current_node()
            if error.code.startswith("node_"):
                self.store.save_node({**current, "status": "error", "error": error.message()})
            raise
        current = current_node()
        self.store.save_node({**current, "status": "ok", "error": None, "last_collected_at": now()})
        return batch

    async def probe(self, instance_id: str) -> dict[str, Any]:
        instance = self._instance(instance_id)
        if instance is None:
            raise LookupError(instance_id)
        if instance_id in self.probes:
            raise ProbeConflict("probe_in_progress")
        self.probes.add(instance_id)
        attempt = now()
        endpoint = {
            key: instance.get(key)
            for key in ("host", "port", "username", "identity_file", "existing_alias")
        }

        def persist(updates: dict[str, Any]) -> dict[str, Any]:
            current = self._instance(instance_id)
            if not current or any(current.get(key) != value for key, value in endpoint.items()):
                raise ProbeConflict("endpoint_changed")
            current.update(updates, last_probe_attempt=attempt)
            if instance.get("manual"):
                self.store.save_instance(current)
            else:
                self.store.update_cloud_metrics(
                    instance_id, endpoint, {**updates, "last_probe_attempt": attempt}
                )
            return current

        try:
            async with self.runtime.semaphore:
                result = measured(
                    instance_id, await asyncio.wait_for(probe_instance(instance), timeout=45)
                )
            current = persist({**result, "ssh_error": None})
            self.store.record_history()
            return current
        except ProbeConflict:
            raise
        except Exception as error:
            persist({"ssh_status": "error", "ssh_error": _error(error)})
            raise
        finally:
            self.probes.discard(instance_id)

    def _instance(self, instance_id: str) -> dict[str, Any] | None:
        return next(
            (row for row in self.store.dashboard()["instances"] if row["id"] == instance_id), None
        )

    def recover(self) -> None:
        for source in self.store.sources():
            if source.get("status") == "syncing":
                # A source that was already failing keeps its error, so the next result
                # is compared with that and not with an interrupted healthy collection.
                error = source.get("error") or message("collection_interrupted")
                source.update(status="error", error=error, next_due_at=now())
                self.store.save_source(source)

    async def run(self) -> None:
        while True:
            try:
                self._schedule()
            except Exception:
                # One bad row must not stop collection for every other source.
                logger.exception("Scheduling pass failed")
            await asyncio.sleep(15)

    def _schedule(self) -> None:
        for source in self.store.sources():
            if source["enabled"]:
                due = source.get("next_due_at")
                if not due or datetime.fromisoformat(due) <= datetime.now(UTC):
                    self.enqueue(source["id"])
        for instance in self.store.manual_instances():
            if instance.get("monitoring") and instance["id"] not in self.probes:
                attempted = instance.get("last_probe_attempt")
                if (
                    not attempted
                    or (datetime.now(UTC) - datetime.fromisoformat(attempted)).total_seconds()
                    >= 600
                ):
                    self.spawn(self._auto_probe(instance["id"]))

    async def _auto_probe(self, instance_id: str) -> None:
        with suppress(Exception):
            await self.probe(instance_id)

    async def close(self, seconds: float | None = None) -> None:
        """Cancel collections and probes in flight; wait for them at most ``seconds``."""
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.wait(list(self.tasks), timeout=seconds)


def _error(error: BaseException) -> dict[str, Any]:
    if isinstance(error, SourceError):
        return error.message()
    if isinstance(error, TimeoutError):
        return message("timeout")
    return message("collection_failed", detail=f"{type(error).__name__}: {str(error)[:300]}")
