"""The Toolbox: list plugins, switch them on or off and edit their declared settings."""

import math
from typing import Any

from pydantic import BaseModel, ConfigDict

from . import credentials
from .errors import SourceError, message
from .plugins import PluginContext, Runtime, SettingField, web_bundle


class ToolboxUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    settings: dict[str, Any] | None = None


class SettingsError(ValueError):
    """A setting was rejected; ``args[0]`` is a message code, ``params`` its parameters."""

    def __init__(self, code: str, **params: Any) -> None:
        super().__init__(code)
        self.params = params


def origin(context: PluginContext) -> dict[str, Any]:
    """Where a plugin came from: shipped with the core, a marketplace, or installed directly.
    Unknown, with the reason, while installed-plugins.json cannot be read."""
    from . import marketplace

    package = context.plugin.package
    if package in (None, "computedeck"):
        return {"kind": "builtin"}
    try:
        records = marketplace.installed(context.data_dir)
    except marketplace.MarketplaceError as error:
        return {"kind": "unknown", "reason": str(error)}
    for name, record in records.items():
        if record.get("package") == package:
            return {
                "kind": "marketplace",
                "plugin": name,
                "marketplace": record.get("marketplace"),
                "tier": record.get("tier"),
            }
    return {"kind": "direct"}


def entry(context: PluginContext, runtime: Runtime) -> dict[str, Any]:
    plugin = context.plugin
    enabled = context.enabled
    found = origin(context)
    notes = [message("plugin_web_missing")] if plugin.web and not web_bundle(plugin) else []
    if found["kind"] == "unknown":
        notes.append(message("plugin_origin_unknown", detail=found.pop("reason")))
    return {
        "origin": found,
        "id": plugin.id,
        "name": plugin.name or {"en": plugin.id},
        "description": plugin.description or {},
        "enabled": enabled,
        "default_enabled": plugin.default_enabled,
        "page": plugin.page,
        "icon": plugin.icon or "puzzle",
        "permissions": list(plugin.permissions),
        "version": plugin.version,
        "package": plugin.package,
        "author": plugin.author,
        "homepage": plugin.homepage,
        "requires": plugin.requires,
        "rejected": context.rejected,
        "web": (
            f"/plugin-web/{plugin.package}/" if web_bundle(plugin) and plugin.package else None
        ),
        # E.g. declared but not built: the plugin runs without its pages.
        "notes": notes,
        "settings": [item.model_dump() for item in plugin.settings],
        "values": context.settings(),
        "health": context.status(),
        "errors": {
            name: error
            for name, error in runtime.loop_errors.items()
            if name.startswith(f"{plugin.id}:")
        },
    }


def _coerce(item: SettingField, value: Any) -> Any:
    if value is None:
        return None
    if item.kind == "boolean":
        if not isinstance(value, bool):
            raise SettingsError("setting_invalid", setting=item.key)
        return value
    if item.kind == "number":
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
        ):
            raise SettingsError("setting_invalid", setting=item.key)
        return value
    if not isinstance(value, str):
        raise SettingsError("setting_invalid", setting=item.key)
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise SettingsError("setting_invalid", setting=item.key) from None
    value = value.strip()
    limit = 20000 if item.kind == "textarea" else 1000
    if len(value) > limit or (item.kind != "textarea" and any(ord(char) < 32 for char in value)):
        raise SettingsError("setting_invalid", setting=item.key)
    if item.kind == "select" and value and value not in (item.choices or []):
        raise SettingsError("setting_invalid", setting=item.key)
    if item.kind == "credential" and value:
        try:
            credentials.validate_reference(value)
        except SourceError:
            raise SettingsError("setting_invalid", setting=item.key) from None
    return value


def update(context: PluginContext, body: ToolboxUpdate) -> None:
    """Validate everything first, then save; a rejected update changes nothing."""
    if context.rejected is not None:
        raise SettingsError(
            context.rejected["code"],
            **{key: value for key, value in context.rejected.items() if key != "code"},
        )
    store = context.store
    declared = {item.key: item for item in context.plugin.settings}
    values = context.settings()
    if body.settings is not None:
        for key, value in body.settings.items():
            if key not in declared:
                raise SettingsError("setting_unknown", setting=key)
            values[key] = _coerce(declared[key], value)
    enabled = context.enabled if body.enabled is None else body.enabled
    if enabled:
        for item in context.plugin.settings:
            if item.required and values.get(item.key) in (None, ""):
                raise SettingsError("setting_required", setting=item.key)
    if context.validator is not None and body.settings is not None:
        try:
            values = context.validator(values)
        except ValueError as error:
            raise SettingsError(str(error) or "setting_invalid") from None
    if body.settings is not None:
        store.save_plugin_settings(
            context.id, {key: values.get(key) for key in declared if key in values}
        )
    if body.enabled is not None and body.enabled != context.enabled:
        if body.enabled:
            # Switching on starts with what happens from now on, not a backlog.
            store.set_plugin_cursor(context.id, store.last_event_id())
        store.set_plugin_enabled(context.id, body.enabled)
    context.start()
    context.changed.set()
