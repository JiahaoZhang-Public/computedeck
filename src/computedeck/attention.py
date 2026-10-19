"""Current faults derived on read. No inbox state or additional collection work."""

from datetime import datetime
from typing import Any


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
        items.append(
            {
                "key": f"{kind}:{subject['id']}{suffix}",
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
        if source.get("error") and (source.get("failures", 0) >= 2 or source.get("stale")):
            add(
                "source_failed",
                subject,
                "error",
                details=[source["error"]],
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

        # Keep known faults through the first failed attempt while observations are
        # still recent. Failed/stale source items above replace retained conditions.
        # A shared cluster needs only one item across its logins.
        cluster = source.get("cluster_id") or source["id"]
        state = source.get("cluster_state")
        if (
            source.get("last_success")
            and "nodes" in source.get("capabilities", [])
            and state in {"unavailable", "degraded"}
        ):
            if cluster not in clusters or state == "unavailable":
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
        state = source["cluster_state"]
        add(
            f"cluster_{state}",
            {"kind": "source", "id": source["id"], "name": _source_name(source)},
            "error" if state == "unavailable" else "warn",
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
    return items
