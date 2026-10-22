"""Validated inputs and the stored records built from them; shared by the API and config import."""

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SLUG = r"[a-z0-9][a-z0-9-]{0,39}"
USERNAME = r"^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$|^$"


def slug(value: str) -> str:
    """Stable identifier from a display name. Raises ValueError if nothing usable remains."""
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:40].strip("-")
    if not result:
        raise ValueError("name_required")
    return result


class SourceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=80)
    username: str | None = Field(default=None, max_length=80, pattern=USERNAME)
    ssh_alias: str | None = Field(default=None, max_length=128, pattern=r"^[a-zA-Z0-9_.-]*$")
    credential: str | None = Field(default=None, max_length=256)
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    # Driver-specific settings, such as a Kubernetes context or a cloud region.
    options: dict[str, str] | None = None
    # The collection node that collects this source; "" is the machine running the service.
    node: str | None = Field(default=None, pattern=f"^({SLUG})?$")

    @field_validator("options")
    @classmethod
    def safe_options(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        if value is None:
            return None
        if len(value) > 20:
            raise ValueError("Too many options")
        for key, item in value.items():
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", key):
                raise ValueError(f"Unsupported option name: {key}")
            if len(item) > 512 or any(ord(char) < 32 for char in item):
                raise ValueError(f"Unsupported value for option {key}")
        # Empty values mean "not set"; keep stored options small and comparable.
        return {key: item.strip() for key, item in value.items() if item.strip()}


class SourceInput(SourceUpdate):
    name: str = Field(min_length=1, max_length=80)
    driver: str = Field(pattern=r"^[a-z][a-z0-9-]*$")
    cluster_id: str | None = Field(default=None, pattern=f"^{SLUG}$")


class InstanceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    platform: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=100)
    external_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", pattern=r"^[a-zA-Z_][a-zA-Z0-9_.-]*$")
    identity_file: str | None = Field(default=None, max_length=512)
    existing_alias: bool = False
    gpu_count: int | None = Field(default=None, ge=0, le=1024)
    gpu_type: str | None = Field(default=None, max_length=100)
    hourly_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    monitoring: bool = False

    @field_validator("host")
    @classmethod
    def safe_host(cls, value: str) -> str:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.:_-]*", value):
            raise ValueError("Host must be a hostname, IP address or SSH alias, without options")
        return value

    @field_validator("identity_file")
    @classmethod
    def safe_path(cls, value: str | None) -> str | None:
        if value and (any(ord(c) < 32 for c in value) or '"' in value or "%" in value):
            raise ValueError("Identity path contains unsupported characters")
        return value or None


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    language: Literal["en", "zh-CN"] | None = None
    server_name: str | None = Field(default=None, max_length=80)
    low_use_threshold: int = Field(default=10, ge=1, le=50, strict=True)
    low_use_window_minutes: int = Field(default=60, ge=30, le=360, strict=True)


def source_record(body: SourceInput) -> dict[str, Any]:
    cluster_id = body.cluster_id or slug(body.name)
    enabled = body.enabled if body.enabled is not None else True
    return {
        "id": f"{cluster_id}-{slug(body.username or body.driver)}",
        "name": body.name,
        "driver": body.driver,
        "cluster_id": cluster_id,
        "username": body.username or "",
        "ssh_alias": body.ssh_alias or "",
        "credential": body.credential or "",
        "options": body.options or {},
        "node": body.node or "",
        "enabled": enabled,
        "interval_minutes": body.interval_minutes or 10,
        "status": "ready" if enabled else "unconfigured",
        "last_success": None,
        "last_attempt": None,
        "error": None,
        "capabilities": [],
        "qos": [],
        "warnings": [],
    }


def instance_id(body: InstanceInput) -> str:
    return f"manual:{slug(body.platform)}-{body.external_id}"


def instance_record(body: InstanceInput) -> dict[str, Any]:
    return {
        **body.model_dump(exclude={"external_id"}),
        "id": instance_id(body),
        "external_id": body.external_id,
        "source_id": "manual",
        # An existing alias keeps the user's own Host block, including any ProxyJump.
        "ssh_alias": body.host
        if body.existing_alias
        else f"cd-{slug(body.platform)}-{body.external_id}",
        "state": "unknown",
        "ssh_status": "unverified",
        "manual": True,
        "observed_at": None,
        "gpu_utilization": None,
        "cpu_utilization": None,
        "memory_utilization": None,
    }


def keep_instance_probe(record: dict[str, Any], old: dict[str, Any] | None) -> None:
    """Keep a manual machine's measurements only while its connection stays the same."""
    if old is None or any(
        old.get(key) != record.get(key)
        for key in ("host", "port", "username", "identity_file", "existing_alias")
    ):
        return
    for key in (
        "state",
        "ssh_status",
        "ssh_error",
        "observed_at",
        "last_probe_attempt",
        "gpu_allocated",
        "gpu_observed_count",
        "probe_warnings",
        "ssh_endpoint",
        "metrics_scope",
        "gpu_utilization",
        "cpu_utilization",
        "memory_utilization",
    ):
        if key in old:
            record[key] = old[key]
