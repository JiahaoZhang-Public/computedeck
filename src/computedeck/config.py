"""Import and export sources, manual instances and settings as TOML.

Runtime state (last collection, errors, snapshots) is never exported, and an import
keeps the runtime state of sources that already exist.
"""

import json
import re
import tomllib
from typing import Any

from pydantic import ValidationError

from . import credentials, drivers, routes
from .errors import SourceError
from .nodes import NodeInput, node_record
from .records import (
    SLUG,
    InstanceInput,
    SettingsInput,
    SourceInput,
    instance_record,
    keep_instance_probe,
    slug,
    source_record,
)
from .ssh_config import render_config
from .store import DEFAULT_SETTINGS, Store, now

_SOURCE_KEYS = (
    "username",
    "ssh_alias",
    "credential",
    "options",
    "node",
    "enabled",
    "interval_minutes",
)
_NODE_KEYS = ("id", "name", "ssh_alias", "command", "mode")
_INSTANCE_KEYS = (
    "name",
    "host",
    "port",
    "username",
    "identity_file",
    "existing_alias",
    "gpu_count",
    "gpu_type",
    "hourly_cost",
    "currency",
    "monitoring",
)


class ConfigError(ValueError):
    pass


_GROUP_KEYS = {"id", "label", "driver", "identity", *_SOURCE_KEYS}


def _check_keys(table: dict[str, Any], allowed: set[str], where: str) -> None:
    # A misspelt key would otherwise be dropped without a word.
    unknown = set(table) - allowed
    if unknown:
        raise ConfigError(f"{where}: unknown keys {', '.join(sorted(unknown))}")


def _sources(data: dict[str, Any]) -> list[SourceInput]:
    result = []
    for section, default_driver in (("cluster", "slurm"), ("cloud", "runpod")):
        for group in data.get(section, []):
            if not isinstance(group, dict):
                raise ConfigError(f"[[{section}]] must be a table")
            label = group.get("label") or group.get("id")
            if not label:
                raise ConfigError(f"[[{section}]] needs an id or a label")
            _check_keys(group, _GROUP_KEYS, f"[[{section}]] {label}")
            identities = group.get("identity") or [
                {key: group[key] for key in _SOURCE_KEYS if key in group}
            ]
            if not isinstance(identities, list):
                raise ConfigError(f"[[{section}.identity]] in {label} must be a table array")
            for identity in identities:
                if not isinstance(identity, dict):
                    raise ConfigError(f"[[{section}.identity]] must be a table")
                _check_keys(identity, {"name", *_SOURCE_KEYS}, f"[[{section}.identity]] in {label}")
                fields = {
                    key: identity.get(key, group.get(key))
                    for key in _SOURCE_KEYS
                    if key in identity or key in group
                }
                try:
                    result.append(
                        SourceInput(
                            name=identity.get("name") or label,
                            driver=group.get("driver", default_driver),
                            cluster_id=group.get("id"),
                            **fields,
                        )
                    )
                except ValidationError as error:
                    raise ConfigError(f"{section} {label}: {error}") from None
    return result


def load(text: str) -> dict[str, Any]:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(str(error)) from None
    except RecursionError:
        raise ConfigError("The file nests arrays or tables too deeply") from None
    unknown = set(data) - {
        *DEFAULT_SETTINGS,
        "cluster",
        "cloud",
        "instance",
        "node",
        "identity_slots",
    }
    if unknown:
        raise ConfigError(f"Unknown top-level keys: {', '.join(sorted(unknown))}")
    slots = data.get("identity_slots", {})
    if not isinstance(slots, dict) or any(
        type(value) is not int or not 1 <= value <= 6 for value in slots.values()
    ):
        raise ConfigError("identity_slots must map group keys to integers from 1 to 6")
    for section in ("cluster", "cloud", "instance", "node"):
        if section in data and (
            not isinstance(data[section], list)
            or any(not isinstance(row, dict) for row in data[section])
        ):
            raise ConfigError(f"[[{section}]] must be a table array ([[section]])")
    for row in data.get("instance", []):
        _check_keys(row, {"platform", "id", *_INSTANCE_KEYS}, f"[[instance]] {row.get('id', '')}")
    machines = []
    for row in data.get("node", []):
        _check_keys(row, set(_NODE_KEYS), f"[[node]] {row.get('name', '')}")
        try:
            body = NodeInput(**{key: row[key] for key in _NODE_KEYS[1:] if key in row})
            node_id = row.get("id") or slug(body.name)
            # The rule of the app: an id it can show, edit and delete.
            if not isinstance(node_id, str) or not re.fullmatch(SLUG, node_id):
                raise ValueError(
                    f"id {node_id!r} must be lowercase letters, digits and dashes (up to 40)"
                )
            machines.append(node_record(body, node_id))
        except (ValidationError, ValueError) as error:
            raise ConfigError(f"node {row.get('name', '')}: {error}") from None
    try:
        settings = SettingsInput(**{key: data[key] for key in DEFAULT_SETTINGS if key in data})
        instances = [
            InstanceInput(
                platform=row.get("platform", ""),
                external_id=row.get("id", ""),
                **{key: row[key] for key in _INSTANCE_KEYS if key in row},
            )
            for row in data.get("instance", [])
        ]
    except ValidationError as error:
        raise ConfigError(str(error)) from None
    return {
        "settings": settings,
        "identity_slots": slots,
        "sources": _sources(data),
        "instances": instances,
        "nodes": machines,
    }


def migrated(text: str, alias: str, route: str, command: str = "computedeck") -> dict[str, Any]:
    """Another server's export, parsed so that its sources are collected from here.

    ``collect`` adds a collection machine for ``alias`` and sets it on every source; ``jump``
    adds a jump host for it and sets it on the sources that connect over SSH; ``direct``
    sets none. Settings, hand-added machines and identity slots describe the other server
    and are left out.
    """
    parsed = load(text)
    chained = sorted({body.name for body in parsed["sources"] if body.node})
    if chained:
        raise ConfigError(
            f"{alias} collects {', '.join(chained)} through its own nodes; "
            "routes through two machines are not supported"
        )
    machines = []
    sources = parsed["sources"]
    if route != "direct":
        try:
            body = NodeInput.model_validate(
                {"name": alias, "ssh_alias": alias, "command": command, "mode": route}
            )
            node = node_record(body, slug(alias))
        except (ValidationError, ValueError) as error:
            raise ConfigError(f"node {alias}: {error}") from None
        machines.append(node)
        sources = [
            source.model_copy(update={"node": node["id"]})
            if route == "collect"
            or routes.applies({"driver": source.driver, "ssh_alias": source.ssh_alias})
            else source
            for source in sources
        ]
    return {
        "settings": SettingsInput(),
        "identity_slots": {},
        "sources": sources,
        "instances": [],
        "nodes": machines,
    }


def apply(store: Store, text: str) -> dict[str, int]:
    """Create or update everything in the file. Nothing is deleted."""
    return apply_parsed(store, load(text))


def apply_parsed(store: Store, parsed: dict[str, Any]) -> dict[str, int]:
    """Create or update everything ``load`` read. Nothing is deleted."""
    sources = []
    for body in parsed["sources"]:
        try:
            record = source_record(body)
            driver = drivers.get(record["driver"])
            if record["credential"]:
                credentials.validate_reference(record["credential"])
            if record["enabled"]:
                driver.validate(record)
        except (ValueError, SourceError) as error:
            raise ConfigError(f"{body.name} ({body.username or body.driver}): {error}") from None
        sources.append(record)
    # The file's nodes replace the stored ones of the same id.
    known_nodes = {node["id"]: node for node in [*store.nodes(), *parsed["nodes"]]}
    for record in sources:
        if record["node"] and record["node"] not in known_nodes:
            raise ConfigError(f"{record['name']}: no node {record['node']}")
    # The sources after the import: the file's replace the stored ones of the same id.
    after = {source["id"]: source for source in [*store.sources(), *sources]}
    in_use = {source.get("node") for source in after.values()}
    for node in parsed["nodes"]:
        stored = store.node(node["id"])
        if stored is not None and stored["mode"] != node["mode"] and node["id"] in in_use:
            # As in the app: where its sources are collected would change under them.
            raise ConfigError(f"node {node['name']}: cannot change mode while sources use it")
    for record in sources:
        node = known_nodes.get(record["node"])
        if node is not None and routes.mode(node) == "jump" and not routes.applies(record):
            raise ConfigError(
                f"{record['name']}: node {node['name']} is an SSH jump host, "
                "and this source makes no SSH connection"
            )
    clusters: dict[str, str] = {}
    for record in [*store.sources(), *sources]:
        if clusters.setdefault(record["cluster_id"], record["driver"]) != record["driver"]:
            raise ConfigError(f"Cluster {record['cluster_id']} mixes drivers")
    instances = []
    for instance_input in parsed["instances"]:
        try:
            instances.append(instance_record(instance_input))
        except ValueError as error:
            raise ConfigError(f"instance {instance_input.external_id}: {error}") from None
    imported = {instance["id"] for instance in instances}
    kept = [row for row in store.dashboard()["instances"] if row["id"] not in imported]
    try:
        # The same check as adding an endpoint in the app, over the combined set.
        render_config([*kept, *instances])
    except ValueError as error:
        raise ConfigError(f"SSH endpoints: {error}") from None
    # Everything is validated; nothing below can reject the file half-way.
    for node in parsed["nodes"]:
        existing_node = store.node(node["id"]) or {}
        store.save_node(
            {
                **existing_node,
                **node,
                **{
                    key: existing_node[key]
                    for key in ("status", "version", "drivers", "checked_at", "error")
                    if key in existing_node and existing_node["mode"] == node["mode"]
                },
            }
        )
    for record in sources:
        existing = store.source(record["id"])
        if existing:
            if any(
                existing.get(key) != record[key]
                for key in ("ssh_alias", "credential", "username", "options", "node")
            ):
                # Same as an edit in the app: earlier results belong to the old connection.
                existing.update(
                    last_success=None,
                    error=None,
                    status=record["status"],
                    failures=0,
                    capabilities=[],
                    capabilities_seen=[],
                    history_window_seconds=None,
                    warnings=[],
                    cluster_state="unknown",
                )
            if existing["enabled"] != record["enabled"]:
                existing.update(
                    status="ready" if record["enabled"] else "unconfigured",
                    error=None,
                    failures=0,
                    last_success=None,
                )
            existing.update({key: record[key] for key in ("name", *_SOURCE_KEYS)})
            record = existing
        record["next_due_at"] = now()
        if not record["enabled"]:
            record["status"] = "unconfigured"
        store.save_source(record)
    for instance in instances:
        old = next((row for row in store.manual_instances() if row["id"] == instance["id"]), None)
        keep_instance_probe(instance, old)
        store.save_instance(instance)
    store.save_settings(parsed["settings"].model_dump(exclude_unset=True))
    store.identity_slots(parsed["identity_slots"])
    counts = {"sources": len(sources), "instances": len(instances), "nodes": len(parsed["nodes"])}
    store.add_change("change.import", "config", "", "imported", [], counts=counts)
    return counts


def _value(value: Any) -> str:
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{key} = {_value(item)}" for key, item in value.items()) + " }"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return repr(value)
    # JSON string escapes are valid TOML basic-string escapes, including control characters.
    # TOML cannot hold a lone surrogate an older version stored; it is written as "?".
    return json.dumps(str(value).encode("utf-8", "replace").decode(), ensure_ascii=False)


def export(store: Store) -> str:
    lines = ["# ComputeDeck configuration. Import with: computedeck import FILE", ""]
    settings = store.settings()
    for key in DEFAULT_SETTINGS:
        if (
            key in {"low_use_threshold", "low_use_window_minutes"}
            and settings[key] == DEFAULT_SETTINGS[key]
        ):
            continue
        if settings.get(key) is not None:
            lines.append(f"{key} = {_value(settings[key])}")
    overrides = store.identity_slot_overrides()
    if overrides:
        lines += ["", "[identity_slots]"]
        for key, slot in overrides.items():
            lines.append(f"{_value(key)} = {slot}")
    for node in store.nodes():
        lines += ["", "[[node]]"]
        for key in _NODE_KEYS:
            # Written only when it is not the default, so older versions can import the file.
            if key != "mode" or node["mode"] != "collect":
                lines.append(f"{key} = {_value(node[key])}")
    groups: dict[str, list[dict[str, Any]]] = {}
    for source in store.sources():
        groups.setdefault(source["cluster_id"], []).append(source)
    for cluster_id, members in groups.items():
        section = "cluster" if members[0]["kind"] == "cluster" else "cloud"
        lines += [
            "",
            f"[[{section}]]",
            f"id = {_value(cluster_id)}",
            f"label = {_value(members[0]['name'])}",
            f"driver = {_value(members[0]['driver'])}",
        ]
        for member in members:
            lines += ["", f"  [[{section}.identity]]", f"  name = {_value(member['name'])}"]
            for key in _SOURCE_KEYS:
                if member.get(key) not in (None, "", {}):
                    lines.append(f"  {key} = {_value(member[key])}")
    for instance in store.manual_instances():
        if not all(isinstance(instance.get(key), str) for key in ("platform", "external_id")):
            continue
        lines += [
            "",
            "[[instance]]",
            f"platform = {_value(instance['platform'])}",
            f"id = {_value(instance['external_id'])}",
        ]
        for key in _INSTANCE_KEYS:
            if instance.get(key) is not None:
                lines.append(f"{key} = {_value(instance[key])}")
    return "\n".join(lines) + "\n"
