"""Current faults derived on read, with optional acknowledgement and snooze state."""

import hashlib
import json
from datetime import datetime
from typing import Any

IMMUTABLE_KINDS = {"service_loop_failed", "unreadable_rows"}


def _source_name(source: dict[str, Any]) -> str:
    name = source["name"]
    return f"{name} · {source['username']}" if source.get("username") else name


def derive(
    dashboard: dict[str, Any],
    drivers: list[dict[str, Any]],
    *,
    now: datetime,
    loop_errors: dict[str, dict[str, str]] | None = None,
    unreadable_rows: dict[str, int] | None = None,
    plugin_status: dict[str, dict[str, Any]] | None = None,
    state: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    sources = {source["id"]: source for source in dashboard["sources"]}
    descriptions = {driver["name"]: driver for driver in drivers}
    plugins = plugin_status or {}

    def add(
        kind: str,
        subject: dict[str, str],
        severity: str,
        *,
        since: str | None = None,
        observed_at: str | None = None,
        next_attempt: str | None = None,
        details: list[Any] | None = None,
        action: str = "diagnose",
        suffix: str = "",
        **params: Any,
    ) -> None:
        # Only structured causes count: changing stderr, names or observation times
        # must not reopen a fault. Sort details so warning order does not matter.
        causes = sorted(
            json.dumps(
                {key: detail[key] for key in ("code", "status") if key in detail}, sort_keys=True
            )
            for detail in (details or [])
            if isinstance(detail, dict)
        )
        cause_params = {key: value for key, value in params.items() if key != "channel"}
        fingerprint = hashlib.sha256(
            json.dumps([kind, severity, cause_params, causes], sort_keys=True).encode()
        ).hexdigest()
        key = f"{kind}:{subject['id']}{suffix}"
        saved = (state or {}).get(key, {})
        mutable = kind not in IMMUTABLE_KINDS
        muted = None
        if mutable and saved.get("fingerprint") == fingerprint:
            until = saved.get("snooze_until")
            if until is None or datetime.fromisoformat(until) > now:
                muted = {
                    "state": "snoozed" if until else "acknowledged",
                    "at": saved["acknowledged_at"],
                    "until": until,
                }
        items.append(
            {
                "key": key,
                "fingerprint": fingerprint,
                "muted": muted,
                "mutable": mutable,
                "kind": kind,
                "subject": subject,
                "severity": severity,
                "message": {"code": f"attention_{kind}", "name": subject["name"], **params},
                "details": details or [],
                "since": since,
                "observed_at": observed_at,
                "next_attempt": next_attempt,
                "action": action,
            }
        )

    clusters: dict[str, dict[str, Any]] = {}
    for source in sources.values():
        if not source["enabled"]:
            continue
        subject = {"kind": "source", "id": source["id"], "name": _source_name(source)}
        since = source.get("last_success")
        next_attempt = source.get("next_due_at")
        timing = {"observed_at": since, "next_attempt": next_attempt}
        if source.get("error") or source.get("status") == "error":
            add(
                "source_failed",
                subject,
                "error" if source.get("failures", 0) >= 2 or source.get("stale") else "warn",
                details=[source["error"]] if source.get("error") else [],
                since=since,
                observed_at=source.get("last_attempt"),
                next_attempt=next_attempt,
            )
            continue
        elif source.get("stale"):
            age = (now - datetime.fromisoformat(source["last_success"])).total_seconds()
            severity = "error" if age > 3 * source["interval_minutes"] * 60 else "warn"
            add("source_stale", subject, severity, since=since, **timing)
            continue

        # Failed/stale source items above replace retained conditions.
        # A shared cluster needs only one item across its logins.
        cluster = source.get("cluster_id") or source["id"]
        cluster_state = source.get("cluster_state")
        if (
            source.get("last_success")
            and "nodes" in source.get("capabilities", [])
            and cluster_state in {"unavailable", "degraded"}
        ):
            if cluster not in clusters or cluster_state == "unavailable":
                clusters[cluster] = source

        checks = descriptions.get(source["driver"], {}).get("checks", [])
        capabilities = {
            check["warning"]: check["capability"] for check in checks if check.get("warning")
        }
        commands = {check["capability"]: check["command"] for check in checks}
        seen = set(source.get("capabilities_seen", [])) | set(source.get("capabilities", []))
        partial = []
        regressed: dict[str, list[Any]] = {}
        for warning in source.get("warnings", []):
            capability = (
                capabilities.get(warning.get("code")) if isinstance(warning, dict) else None
            )
            if capability is None:
                partial.append(warning)
            elif capability in seen:
                regressed.setdefault(capability, []).append(warning)
        for capability, warnings in regressed.items():
            add(
                "capability_regressed",
                subject,
                "warn",
                details=warnings,
                suffix=f":{capability}",
                capability=capability,
                command=commands[capability],
                **timing,
            )
        if partial:
            add("partial_data", subject, "warn", details=partial, **timing)

    for source in clusters.values():
        cluster_state = source["cluster_state"]
        add(
            f"cluster_{cluster_state}",
            {"kind": "source", "id": source["id"], "name": _source_name(source)},
            "error" if cluster_state == "unavailable" else "warn",
            observed_at=source.get("last_success"),
            next_attempt=source.get("next_due_at"),
        )

    for instance in dashboard["instances"]:
        source = sources.get(instance.get("source_id"))
        if instance.get("manual") and not instance.get("monitoring"):
            continue
        if source and not source["enabled"]:
            continue
        if instance.get("ssh_status") == "error":
            add(
                "instance_ssh_failed",
                {"kind": "instance", "id": instance["id"], "name": instance["name"]},
                "error",
                observed_at=instance.get("last_probe_attempt"),
                details=[instance["ssh_error"]] if instance.get("ssh_error") else [],
                action="instance",
            )

    for key, error in (loop_errors or {}).items():
        name = key
        collector = key == "collector" or key.startswith("collector:")
        if key.startswith("collector:commit:"):
            source = sources.get(key.removeprefix("collector:commit:"))
            if not source or not source["enabled"]:
                continue
            name = _source_name(source)
        if not collector and not plugins.get(key.split(":")[0], {}).get("enabled"):
            continue
        add(
            "service_loop_failed",
            {"kind": "service", "id": key, "name": name},
            "error",
            observed_at=error.get("at"),
            details=[error["error"]],
            action="health" if collector else "toolbox",
        )
    for table, count in (unreadable_rows or {}).items():
        if count:
            add(
                "unreadable_rows",
                {"kind": "service", "id": table, "name": table},
                "error",
                count=count,
                action="health",
            )
    for key, status in plugins.items():
        if status.get("enabled") and status.get("error"):
            add(
                "plugin_error",
                {"kind": "plugin", "id": key, "name": key},
                "error",
                details=[status["error"]],
                action="toolbox",
            )
    notify = plugins.get("notify", {})
    if notify.get("enabled"):
        for failure in notify.get("delivery_failures", []):
            add(
                "notification_failed",
                {"kind": "plugin", "id": "notify", "name": "Notifications"},
                "warn",
                suffix=f":{failure['channel']}",
                channel=failure["channel_name"],
                error_code=failure["error_code"],
                observed_at=failure["at"],
                action="notify",
            )
    return items
