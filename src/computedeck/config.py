"""Import and export sources, manual instances and settings as TOML.

Runtime state (last collection, errors, snapshots) is never exported, and an import
keeps the runtime state of sources that already exist.
"""

import json
import re
import tomllib
from typing import Any

from pydantic import ValidationError

from . import credentials, drivers
from .errors import SourceError
from .nodes import NodeInput, node_record
from .records import (
    SLUG,
    InstanceInput,
    SettingsInput,
    SourceInput,
    instance_record,
    slug,
    source_record,
)
from .ssh_config import render_config
from .store import Store, now

_SOURCE_KEYS = (
    "username",
    "ssh_alias",
    "credential",
    "options",
    "node",
    "enabled",
    "interval_minutes",
)
_NODE_KEYS = ("id", "name", "ssh_alias", "command")
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
_ENDPOINT_KEYS = ("host", "port", "username", "identity_file", "existing_alias")


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
    unknown = set(data) - {"language", "server_name", "cluster", "cloud", "instance", "node"}
    if unknown:
        raise ConfigError(f"Unknown top-level keys: {', '.join(sorted(unknown))}")
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
            body = NodeInput(
                **{key: row[key] for key in ("name", "ssh_alias", "command") if key in row}
            )
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
        settings = SettingsInput(
            **{key: data[key] for key in ("language", "server_name") if key in data}
        )
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
        "sources": _sources(data),
        "instances": instances,
        "nodes": machines,
    }


def apply(store: Store, text: str) -> dict[str, int]:
    """Create or update everything in the file. Nothing is deleted."""
    parsed = load(text)
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
    known_nodes = {node["id"] for node in [*store.nodes(), *parsed["nodes"]]}
    for record in sources:
        if record["node"] and record["node"] not in known_nodes:
            raise ConfigError(f"{record['name']}: no node {record['node']}")
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
                    if key in existing_node
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
                    warnings=[],
                    cluster_state="unknown",
                )
            existing.update({key: record[key] for key in ("name", *_SOURCE_KEYS)})
            record = existing
        record["next_due_at"] = now()
        if not record["enabled"]:
            record["status"] = "unconfigured"
        store.save_source(record)
    for instance in instances:
        old = next((row for row in store.manual_instances() if row["id"] == instance["id"]), None)
        if old and all(old.get(key) == instance.get(key) for key in _ENDPOINT_KEYS):
            # Keep the latest observations of an endpoint that did not change.
            for key in ("state", "ssh_status", "observed_at", "last_probe_attempt"):
                if key in old:
                    instance[key] = old[key]
        store.save_instance(instance)
    store.save_settings(parsed["settings"].model_dump(exclude_unset=True))
    return {"sources": len(sources), "instances": len(instances), "nodes": len(parsed["nodes"])}


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
    for key in ("language", "server_name"):
        if settings.get(key) is not None:
            lines.append(f"{key} = {_value(settings[key])}")
    for node in store.nodes():
        lines += ["", "[[node]]"]
        for key in _NODE_KEYS:
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
