"""Dashboard figures shared by live data, examples and recorded history."""

from datetime import UTC, datetime, timedelta
from typing import Any

from .drivers.base import node_health
from .drivers.cloud import instance_lifecycle

RUNNING = {"RUNNING", "R", "CONFIGURING", "CF", "COMPLETING", "CG"}
PENDING = {"PENDING", "PD", "Q", "PEND", "QUEUED"}
PROBE_INTERVAL = timedelta(minutes=10)


def gpu_allocation(row: dict[str, Any]) -> int | None:
    """SSH hosts count GPUs with compute processes; cloud instances count allocations.

    A machine added by hand counts only what an SSH check measured, never the GPUs typed in.
    """
    return (
        row.get("gpu_allocated")
        if row.get("manual") or row.get("metrics_scope") == "host_visible"
        else row.get("gpu_count")
    )


def _timestamp(value: Any) -> str | None:
    """A stored time the readers can compare, or None."""
    try:
        if isinstance(value, str) and datetime.fromisoformat(value).tzinfo is not None:
            return value
    except ValueError:
        pass
    return None


def manual_state(row: dict[str, Any]) -> str:
    """A machine added by hand has no provider lifecycle. It is running while its last SSH
    check reached it within two check intervals, and unknown otherwise, never stopped."""
    observed = _timestamp(row.get("observed_at"))
    if row.get("ssh_status") != "reachable" or observed is None:
        return "unknown"
    age = datetime.now(UTC) - datetime.fromisoformat(observed)
    return "running" if age < 2 * PROBE_INTERVAL else "unknown"


def ssh_sampled_at(row: dict[str, Any]) -> str | None:
    """When SSH last measured this machine: the reading of a machine read over SSH, or the
    last check of an instance a provider lists, whose listing time measures nothing on it."""
    if row.get("manual") or row.get("metrics_scope") == "host_visible":
        return _timestamp(row.get("observed_at"))
    return _timestamp(row.get("last_probe_attempt"))


def fresh(source: dict[str, Any], capability: str) -> bool:
    return bool(
        source["enabled"]
        and source.get("last_success")
        and not source.get("stale")
        and not source.get("error")
        and source.get("status") in ("ready", "syncing")
        and capability in source.get("capabilities", [])
    )


def _unique(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    newest: dict[str, dict[str, Any]] = {}
    for row in rows:
        previous = newest.get(row["id"])
        if previous is None or (row.get("observed_at") or "") >= (
            previous.get("observed_at") or ""
        ):
            newest[row["id"]] = row
    return list(newest.values())


def _sum(values: list[int | None]) -> int | None:
    return None if None in values else sum(value for value in values if value is not None)


def _mean(values: list[float | None]) -> float | None:
    known = [value for value in values if value is not None]
    return sum(known) / len(known) if known else None


def _missing(row: dict[str, Any], kind: str, code: str) -> dict[str, Any]:
    name = row.get("name") or row["id"]
    if kind == "source" and row.get("username") and row["username"] != name:
        name = f"{name} · {row['username']}"
    return {"subject": {"kind": kind, "id": row["id"], "name": name}, "reason": {"code": code}}


def _source_reason(source: dict[str, Any]) -> str:
    if source.get("error") or source.get("status") == "error":
        return "summary_source_failed"
    if not source.get("last_success"):
        return "summary_not_collected"
    if source.get("stale"):
        return "summary_source_stale"
    return "summary_capability_missing"


def summarize_nodes(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    """Current enabled observations only; callers filter before deduplicating."""
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for node in nodes:
        key = (node.get("cluster_id", ""), node.get("name", node["id"]))
        if key not in unique or (node.get("observed_at") or "") >= (
            unique[key].get("observed_at") or ""
        ):
            unique[key] = node
    rows = list(unique.values())
    usable = [n for n in rows if node_health(n.get("state", "")) == "usable"]
    unavailable = [n for n in rows if node_health(n.get("state", "")) == "unavailable"]
    capacity = _sum([n.get("gpu_count") for n in rows]) if rows else None
    usable_gpus = _sum([n.get("gpu_count") for n in usable]) if rows else None
    known_usable = (
        sum(n["gpu_count"] for n in usable if n.get("gpu_count") is not None) if rows else None
    )
    allocated = _sum([n.get("gpu_allocated") for n in usable]) if rows else None
    free = (
        _sum(
            [
                n["gpu_count"] - n["gpu_allocated"]
                if n.get("gpu_count") is not None
                and n.get("gpu_allocated") is not None
                and n["gpu_count"] >= n["gpu_allocated"]
                else None
                for n in usable
            ]
        )
        if rows
        else None
    )
    if any(node_health(n.get("state", "")) == "unknown" for n in rows):
        usable_gpus = allocated = free = None
    return {
        "nodes": len(rows),
        "capacity": capacity,
        "usable": usable_gpus,
        "known_usable": known_usable,
        "unavailable": _sum([n.get("gpu_count") for n in unavailable]) if rows else None,
        "allocated": allocated,
        "unallocated": free,
        "abnormal": len(unavailable),
        "unknown": sum(
            node_health(n.get("state", "")) == "unknown"
            or n.get("gpu_count") is None
            or n.get("gpu_allocated") is None
            for n in rows
        ),
        "observed_at": min((n["observed_at"] for n in rows if n.get("observed_at")), default=None),
        "ratio": (allocated / usable_gpus * 100 if usable_gpus else 0)
        if usable_gpus is not None and allocated is not None and free is not None
        else None,
    }


def _scope(data: dict[str, Any], *, include_job_ids: bool = False) -> dict[str, Any]:
    sources = [s for s in data["sources"] if s["enabled"]]
    by_id = {s["id"]: s for s in sources}
    disabled = {s["id"] for s in data["sources"] if not s["enabled"]}
    current_ids = {s["id"] for s in sources if fresh(s, "jobs")}
    missing_jobs = [s for s in sources if s["kind"] == "cluster" and not fresh(s, "jobs")]
    stale_ids = {s["id"] for s in missing_jobs}
    current = _unique([j for j in data["jobs"] if j["source_id"] in current_ids])
    seen = {j["id"] for j in current}
    old = _unique([j for j in data["jobs"] if j["source_id"] in stale_ids and j["id"] not in seen])
    running = [j for j in current if j.get("state", "").upper() in RUNNING]
    pending = [j for j in current if j.get("state", "").upper() in PENDING]
    all_instances = _unique(
        [i for i in data["instances"] if i.get("manual") or i["source_id"] not in disabled]
    )
    shortcuts = [i for i in all_instances if i.get("manual") and not i.get("monitoring")]
    instances = [i for i in all_instances if not i.get("manual") or i.get("monitoring")]
    fresh_ids = {
        s["id"] for s in sources if fresh(s, "jobs" if s["kind"] == "cluster" else "instances")
    }
    unmeasured = [
        _missing(s, "source", _source_reason(s)) for s in sources if s["id"] not in fresh_ids
    ]
    queued_missing = [_missing(s, "source", _source_reason(s)) for s in missing_jobs]
    for rows, missing in ((running, unmeasured), (pending, queued_missing)):
        for source_id in dict.fromkeys(j["source_id"] for j in rows if j.get("gpu_count") is None):
            missing.append(_missing(by_id[source_id], "source", "summary_gpu_count_missing"))
    counted = [j["gpu_count"] for j in running if j.get("gpu_count") is not None]
    for item in instances:
        if item.get("manual"):
            if item.get("ssh_status") == "error":
                reason = "summary_probe_failed"
            elif not item.get("observed_at"):
                reason = "summary_not_probed_yet"
            elif manual_state(item) != "running":
                reason = "summary_probe_stale"
            elif gpu_allocation(item) is None:
                reason = "summary_gpu_processes_unavailable"
            else:
                counted.append(gpu_allocation(item))
                continue
        else:
            # A stale listing is named once by its login, not once per retained instance.
            if item["source_id"] in by_id and item["source_id"] not in fresh_ids:
                continue
            lifecycle = instance_lifecycle(item.get("state"))
            if lifecycle == "not_held":
                continue
            if lifecycle == "unknown":
                reason = "summary_lifecycle_unknown"
            elif gpu_allocation(item) is None:
                reason = (
                    "summary_gpu_processes_unavailable"
                    if item.get("metrics_scope") == "host_visible"
                    else "summary_gpu_count_missing"
                )
            elif item["source_id"] in fresh_ids:
                counted.append(gpu_allocation(item))
                continue
            else:
                reason = "summary_not_collected"
        unmeasured.append(_missing(item, "instance", reason))
    known_allocated = sum(counted) if fresh_ids or counted else None
    jobs_known = any(s["kind"] == "cluster" and fresh(s, "jobs") for s in sources)
    jobs_complete = jobs_known and not missing_jobs
    requested = _sum([j.get("gpu_count") for j in pending]) if jobs_complete else None
    known_requested = (
        sum(j["gpu_count"] for j in pending if j.get("gpu_count") is not None)
        if jobs_known and (not pending or any(j.get("gpu_count") is not None for j in pending))
        else None
    )
    sampled = [
        *running,
        *[
            i
            for i in instances
            if i.get("ssh_status") == "reachable"
            and (at := ssh_sampled_at(i))
            and (datetime.now(UTC) - datetime.fromisoformat(at)).total_seconds() < 720
        ],
    ]
    observed = [
        i
        for i in sampled
        if i.get("gpu_utilization") is not None
        and (i.get("gpu_observed_count", i.get("gpu_count")) or 0) > 0
    ]
    covered = sum(i.get("gpu_observed_count", i.get("gpu_count")) or 0 for i in observed)
    # Preserve history's source count for provider rows; manual machines have no source.
    instance_sources = {i["id"]: i["id"] if i.get("manual") else i["source_id"] for i in instances}
    return {
        "allocated": None if unmeasured else known_allocated,
        "known_allocated": known_allocated,
        "unknown_allocation_sources": len(
            {
                instance_sources.get(entry["subject"]["id"], entry["subject"]["id"])
                if entry["subject"]["kind"] == "instance"
                else entry["subject"]["id"]
                for entry in unmeasured
            }
        ),
        "unmeasured": unmeasured,
        "unmonitored": len(shortcuts),
        "requested": requested,
        "known_requested": known_requested,
        "queued_unmeasured": queued_missing,
        "running": len(running) if jobs_complete else None,
        "known_running": len(running),
        "pending": len(pending) if jobs_complete else None,
        "known_pending": len(pending),
        "utilization": sum(
            i["gpu_utilization"] * (i.get("gpu_observed_count", i.get("gpu_count")) or 0)
            for i in observed
        )
        / covered
        if covered
        else None,
        "covered": covered,
        "cpu_utilization": _mean([i.get("cpu_utilization") for i in sampled]),
        "memory_utilization": _mean([i.get("memory_utilization") for i in sampled]),
        "nodes": summarize_nodes(
            [
                n
                for n in data["nodes"]
                if n["source_id"] in by_id and fresh(by_id[n["source_id"]], "nodes")
            ]
        ),
        "jobs": {
            **(
                {
                    "current_ids": [j["id"] for j in current],
                    "listed_ids": [j["id"] for j in [*current, *old]],
                }
                if include_job_ids
                else {}
            ),
            "missing_source_ids": [s["id"] for s in missing_jobs],
            "known": len(current),
            "total": None if missing_jobs else len(current),
        },
    }


def summarize(data: dict[str, Any]) -> dict[str, Any]:
    """One set of figures for the fleet, each group and each configured login."""
    source_groups = {s["id"]: s["cluster_id"] for s in data["sources"]}

    def instance_group(item: dict[str, Any]) -> str:
        return source_groups.get(
            item["source_id"], f"platform:{item.get('platform', '').strip().lower()}"
        )

    keys = dict.fromkeys([*source_groups.values(), *map(instance_group, data["instances"])])
    groups = {}
    for key in keys:
        groups[key] = _scope(
            {
                **data,
                "sources": [s for s in data["sources"] if s["cluster_id"] == key],
                "jobs": [j for j in data["jobs"] if source_groups.get(j["source_id"]) == key],
                "nodes": [n for n in data["nodes"] if source_groups.get(n["source_id"]) == key],
                "instances": [i for i in data["instances"] if instance_group(i) == key],
            }
        )
    logins = {
        s["id"]: _scope(
            {
                **data,
                "sources": [s],
                **{
                    key: [row for row in data[key] if row["source_id"] == s["id"]]
                    for key in ("jobs", "nodes", "instances")
                },
            }
        )
        for s in data["sources"]
    }
    return {**_scope(data, include_job_ids=True), "groups": groups, "sources": logins}
