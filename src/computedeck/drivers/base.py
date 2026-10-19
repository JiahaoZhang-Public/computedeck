"""Shared driver types. A driver turns one configured source into one collection batch."""

import json
import math
import re
from datetime import UTC, datetime
from typing import Any, ClassVar, Literal, Protocol

from pydantic import BaseModel, Field

from ..errors import SourceError, message

__all__ = [
    "EMPTY",
    "Batch",
    "Driver",
    "DriverCheck",
    "DriverField",
    "DriverInfo",
    "SourceError",
    "integer",
    "message",
    "now",
    "number",
    "credential_field",
    "options",
    "ssh_alias_field",
    "username_field",
]

# Values Slurm and cloud APIs use for "not set"; never interpreted as zero.
EMPTY = {"", "N/A", "(null)", "None", "NONE", "Unknown", "UNKNOWN"}


def now() -> str:
    return datetime.now(UTC).isoformat()


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def integer(value: Any) -> int | None:
    result = number(value)
    return int(result) if result is not None and result.is_integer() and result >= 0 else None


# Row fields the web app shows as text, across jobs, failures, nodes and instances.
TEXT_FIELDS = (
    "source_id",
    "state",
    "cluster_id",
    "name",
    "end",
    "user",
    "account",
    "partition",
    "qos",
    "gpu_type",
    "node",
    "elapsed",
    "reason",
    "exit_code",
    "platform",
    "host",
    "username",
    "ssh_alias",
    "identity_file",
    "currency",
    "ssh_status",
    "external_id",
    "metrics_scope",
    "observed_at",
    "last_probe_attempt",
)


def _text(value: Any, what: str) -> str | None:
    """Text or None; a number becomes its text, anything else is refused."""
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        return str(value)
    raise ValueError(f"Invalid collection text: {what}")


def _check_message(value: Any, what: str) -> None:
    """A translatable message: a code with plain parameters, or plain text."""
    if value is None or isinstance(value, str):
        return
    if not isinstance(value, dict) or not isinstance(value.get("code"), str):
        raise ValueError(f"Invalid collection message: {what}")
    for key, item in value.items():
        if not isinstance(key, str) or not (item is None or isinstance(item, str | int | float)):
            raise ValueError(f"Invalid collection message: {what}")


def validate_row(row: dict[str, Any], *, complete: bool = False) -> None:
    """Check fields consumed by the dashboard and arithmetic, before storing a row.

    Numbers in text fields are stored as text; other kinds of value reject the row.
    """
    json.dumps(row, allow_nan=False, ensure_ascii=False).encode("utf-8")
    for key in ("id", "source_id", "state") if complete else ("id",):
        if not isinstance(row.get(key), str) or not row[key]:
            raise ValueError(f"Collection row needs a nonempty {key}")
    for key in TEXT_FIELDS:
        if key in row:
            row[key] = _text(row[key], key)
    if row.get("partitions") is not None:
        if not isinstance(row["partitions"], list):
            raise ValueError("Invalid collection text: partitions")
        row["partitions"] = [_text(item, "partitions") for item in row["partitions"]]
    port = row.get("port")
    if port is not None and (isinstance(port, bool) or not isinstance(port, int)):
        raise ValueError("Invalid collection port")
    _check_message(row.get("ssh_error"), "ssh_error")
    for key in ("gpu_count", "gpu_allocated", "gpu_observed_count"):
        value = row.get(key)
        if value is not None and (
            isinstance(value, bool) or not isinstance(value, int) or value < 0
        ):
            raise ValueError(f"Invalid collection count: {key}")
    for key in (
        "cpu_count",
        "cpu_allocated",
        "gpu_utilization",
        "cpu_utilization",
        "memory_utilization",
        "hourly_cost",
    ):
        value = row.get(key)
        if value is not None and (
            number(value) is None or not isinstance(value, int | float) or value < 0
        ):
            raise ValueError(f"Invalid collection measurement: {key}")
    if row.get("observed_at") is not None:
        timestamp = datetime.fromisoformat(row["observed_at"])
        if timestamp.tzinfo is None:
            raise ValueError("Collection timestamp needs a timezone")


def cluster_state(
    nodes: list[dict[str, Any]] | None,
) -> Literal["available", "degraded", "unavailable", "unknown"]:
    """Availability of the visible inventory; power-saving alone is not an outage."""
    if not nodes:
        return "unknown"
    unavailable = 0
    known = 0
    for node in nodes:
        state = re.sub(r"power(?:ed|ing)?_(?:down|up)", "", node["state"], flags=re.I)
        if re.search(
            r"down|drain|not_resp|not_ready|offline|unavail|unreach|fail|maint|cordon|inval",
            state,
            re.I,
        ):
            unavailable += 1
            known += 1
        elif re.search(r"idle|mixed|alloc|busy|free|ready|ok|job", state, re.I):
            known += 1
    if unavailable == len(nodes):
        return "unavailable"
    if known < len(nodes):
        return "unknown"
    return "degraded" if (len(nodes) - unavailable) / len(nodes) < 0.2 else "available"


class Batch(BaseModel):
    """One collection result. ``None`` means "not collected", never "there are none"."""

    jobs: list[dict[str, Any]] | None = None
    nodes: list[dict[str, Any]] | None = None
    instances: list[dict[str, Any]] | None = None
    failures: list[dict[str, Any]] | None = None
    qos: list[dict[str, Any]] | None = None
    cluster_state: Literal["available", "degraded", "unavailable", "unknown"] = "unknown"
    # What a cloud provider says about the account, e.g. {"balance": 12.5, "currency": "USD"}.
    account: dict[str, Any] | None = None
    capabilities: list[str] = Field(default_factory=list)
    warnings: list[dict[str, Any]] = Field(default_factory=list)
    observed_at: str = Field(default_factory=now)

    def validate_rows(self) -> None:
        """Reject malformed driver rows before events or the last-good snapshot change."""
        json.dumps(self.model_dump(), allow_nan=False, ensure_ascii=False).encode("utf-8")
        for rows in (self.jobs, self.nodes, self.instances, self.failures):
            for row in rows or []:
                validate_row(row, complete=True)
        for entry in self.qos or []:
            if not isinstance(entry.get("name"), str) or not entry["name"]:
                raise ValueError("QoS entry needs a nonempty name")
            entry["origin"] = _text(entry.get("origin"), "origin")
            entry.setdefault("access", "unknown")
            if entry["access"] not in {"verified", "not_associated", "unknown"}:
                raise ValueError("Invalid QoS access state")
            for key in ("limits", "usage"):
                values = entry.get(key)
                if values is None:
                    continue
                if not isinstance(values, dict):
                    raise ValueError(f"Invalid QoS {key}")
                entry[key] = {name: _text(value, key) for name, value in values.items()}
        for warning in self.warnings:
            _check_message(warning, "warnings")
        if self.account is not None:
            if self.account.get("balance") is not None and (
                number(self.account["balance"]) is None
                or not isinstance(self.account["balance"], int | float)
            ):
                raise ValueError("Invalid account balance")
            self.account["currency"] = _text(self.account.get("currency"), "currency")

    def snapshot(self) -> dict[str, Any]:
        """Fields to merge into the stored snapshot; absent inventories keep old data."""
        return {
            key: value
            for key, value in self.model_dump(
                include={"jobs", "nodes", "instances", "failures"}
            ).items()
            if value is not None
        }


# Localized text: {"en": "...", "zh-CN": "..."}. English is required; others fall back to it.
Text = dict[str, str]
# Source fields every driver may use; any other field key is stored in ``source["options"]``.
COMMON_FIELDS = ("username", "ssh_alias", "credential")


class DriverField(BaseModel):
    """One input of the add-source form. ``key`` is a common field or an option name."""

    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: Text
    hint: Text = Field(default_factory=dict)
    placeholder: str = ""
    default: str = ""
    required: bool = False
    # An HTML input pattern; the driver's ``validate`` remains the authority.
    pattern: str | None = None
    choices: list[str] | None = None
    # Identifies one login of a cluster, so two logins of one cluster get distinct ids.
    identity: bool = False


class DriverCheck(BaseModel):
    """A capability the first collection reports, shown as a check and as a tag."""

    capability: str
    command: str
    label: Text
    # The warning code a driver adds when this optional capability is missing.
    warning: str | None = None


class DriverInfo(BaseModel):
    """How the web app presents a driver: its name, form fields and checks."""

    label: Text
    # One line on the type card.
    description: Text = Field(default_factory=dict)
    # What the driver reads and how, above the form. ``{where}`` names the service machine.
    details: Text = Field(default_factory=dict)
    fields: list[DriverField] = Field(default_factory=list)
    checks: list[DriverCheck] = Field(default_factory=list)
    default_name: str = ""
    name_placeholder: str = ""
    beta: bool = False


def username_field(**changes: Any) -> DriverField:
    """The login of a cluster; two logins of one cluster are two sources."""
    field = DriverField(
        key="username",
        label={"en": "Login username", "zh-CN": "登录用户名"},
        placeholder="alice",
        required=True,
        identity=True,
    )
    return field.model_copy(update=changes)


def ssh_alias_field(**changes: Any) -> DriverField:
    """A Host of the user's SSH configuration on the machine that collects."""
    field = DriverField(
        key="ssh_alias",
        label={"en": "SSH host alias", "zh-CN": "SSH Host 别名"},
        hint={
            "en": "A Host in ~/.ssh/config on {where}. Connections are non-interactive; "
            "accept the host key with a normal ssh login first.",
            "zh-CN": "{where} ~/.ssh/config 里已有的 Host。采集是非交互的，"
            "首次使用前请先用 ssh 正常登录一次，确认主机密钥。",
        },
        placeholder="cluster-a",
        required=True,
        pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*",
    )
    return field.model_copy(update=changes)


def credential_field(default: str, **changes: Any) -> DriverField:
    """A reference to a secret, never the secret itself."""
    field = DriverField(
        key="credential",
        label={"en": "API key reference", "zh-CN": "API Key 引用"},
        hint={
            "en": "Where to read the key, not the key itself: env:NAME for an environment "
            "variable of the service on {where}, or keychain:service/account for the "
            "system keychain.",
            "zh-CN": "填写读取位置，不是 Key 本身：env:变量名 表示{where}服务进程的环境变量，"
            "keychain:服务/账户 表示系统钥匙串。",
        },
        default=default,
        required=True,
        pattern="[a-z][a-z0-9-]*:.+",
    )
    return field.model_copy(update=changes)


def options(source: dict[str, Any]) -> dict[str, str]:
    """Driver-specific settings of a source; always a dict of strings."""
    value = source.get("options")
    return value if isinstance(value, dict) else {}


class Driver(Protocol):
    name: ClassVar[str]
    kind: ClassVar[Literal["cluster", "cloud"]]
    info: ClassVar[DriverInfo]

    def validate(self, source: dict[str, Any]) -> None:
        """Raise SourceError when an enabled source lacks required connection settings."""

    async def collect(self, source: dict[str, Any]) -> Batch: ...
