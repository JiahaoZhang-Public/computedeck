"""The stable surface for plugins and drivers. Import from here, not from internal modules.

Everything named in ``__all__`` keeps working across releases with the same
``PLUGIN_API``; a change that breaks it raises ``PLUGIN_API``, and plugins declare the API
they were written for in ``Plugin.api``. See docs/plugins.md.

A tool::

    from computedeck.sdk import Plugin, PluginContext, SettingField

    def setup(ctx: PluginContext) -> None:
        @ctx.router.get("/hello")
        async def hello() -> dict[str, str]:
            return {"greeting": ctx.settings()["greeting"]}

    plugin = Plugin(
        id="hello",
        setup=setup,
        name={"en": "Hello", "zh-CN": "你好"},
        settings=(SettingField(key="greeting", label={"en": "Greeting"}, default="hi"),),
    )

registered in the package's pyproject.toml::

    [project.entry-points."computedeck.plugins"]
    hello = "hello_plugin:plugin"
"""

from .credentials import resolve as resolve_credential
from .drivers import ssh
from .drivers.base import (
    Batch,
    Driver,
    DriverCheck,
    DriverField,
    DriverInfo,
    SourceError,
    credential_field,
    integer,
    message,
    now,
    number,
    options,
    ssh_alias_field,
    username_field,
)
from .drivers.cloud import Account, Api, CloudDriver, CloudInstance, ssh_command
from .events import TYPES as EVENT_TYPES
from .plugins import PLUGIN_API, Plugin, PluginContext, SettingField, Text
from .tools.channels import ChannelKind, Message
from .tools.channels import register as register_channel

__all__ = [
    "Account",
    "Api",
    "CloudDriver",
    "CloudInstance",
    "EVENT_TYPES",
    "PLUGIN_API",
    "Batch",
    "ChannelKind",
    "Driver",
    "DriverCheck",
    "DriverField",
    "DriverInfo",
    "Message",
    "Plugin",
    "PluginContext",
    "SettingField",
    "SourceError",
    "Text",
    "credential_field",
    "integer",
    "message",
    "now",
    "number",
    "options",
    "register_channel",
    "resolve_credential",
    "ssh",
    "ssh_command",
    "ssh_alias_field",
    "username_field",
]
