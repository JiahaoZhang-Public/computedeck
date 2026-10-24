"""Dashboard figures shared by live data, examples and recorded history."""

from datetime import UTC, datetime, timedelta
from typing import Any

from .drivers.base import node_health, requires_partition
from .drivers.cloud import instance_lifecycle
from .host_identity import host_address, short_hostname

RUNNING = {"RUNNING", "R", "CONFIGURING", "CF", "COMPLETING", "CG"}
PENDING = {"PENDING", "PD", "Q", "PEND", "QUEUED"}
PROBE_INTERVAL = timedelta(minutes=10)


def gpu_allocation(row: dict[str, Any]) -> int | None:
    """SSH hosts count GPUs with visible processes or significant memory use.

    Unreadable processes, or missing memory without visible processes, leave use unknown.
    Cloud instances count allocations.
    A machine added by hand counts only what an SSH check measured, never the GPUs typed in.
    """
    return (
        row.get("gpu_allocated")
        if row.get("manual") or row.get("metrics_scope") == "host_visible"
        else row.get("gpu_count")
    )


def timestamp(value: Any) -> str | None:
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
    observed = timestamp(row.get("observed_at"))
    if row.get("ssh_status") != "reachable" or observed is None:
        return "unknown"
    age = datetime.now(UTC) - datetime.fromisoformat(observed)
    return "running" if age < 2 * PROBE_INTERVAL else "unknown"


def ssh_sampled_at(row: dict[str, Any]) -> str | None:
    """When SSH last measured this machine: the reading of a machine read over SSH, or the
    last check of an instance a provider lists, whose listing time measures nothing on it."""
    if row.get("manual") or row.get("metrics_scope") == "host_visible":
        return timestamp(row.get("observed_at"))
    return timestamp(row.get("last_probe_attempt"))


def fresh(source: dict[str, Any], capability: str | None = None) -> bool:
    return bool(
        source["enabled"]
        and source.get("last_success")
        and not source.get("stale")
        and not source.get("error")
        and source.get("status") in ("ready", "syncing")
        and (capability is None or capability in source.get("capabilities", []))
    )


def freshness(sources: list[dict[str, Any]]) -> dict[str, Any]:
    """Fleet age excludes disabled sources and probes; a missing success stays unknown."""
    enabled = [source for source in sources if source["enabled"]]
    successes = [source["last_success"] for source in enabled if source.get("last_success")]
    return {
        "as_of": min(successes, key=datetime.fromisoformat)
        if successes and len(successes) == len(enabled)
        else None,
        "behind": sorted(source["id"] for source in enabled if not fresh(source)),
    }


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


def summarize_nodes(
    nodes: list[dict[str, Any]], *, partition_sources: set[str] | None = None
) -> dict[str, Any]:
    """Current enabled observations only; callers filter before deduplicating."""
    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for node in nodes:
        key = (node.get("cluster_id", ""), node.get("name", node["id"]))
        if key not in unique or (node.get("observed_at") or "") >= (
            unique[key].get("observed_at") or ""
        ):
            unique[key] = node
    rows = [
        {
            **n,
            "health": node_health(
                n.get("state", ""),
                partitions=n.get("partitions", [])
                if partition_sources and n.get("source_id") in partition_sources
                else None,
            ),
        }
        for n in unique.values()
    ]
    usable = [n for n in rows if n["health"] == "usable"]
    unavailable = [n for n in rows if n["health"] == "unavailable"]
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
    if any(n["health"] == "unknown" for n in rows):
        usable_gpus = allocated = free = None
    return {
        "nodes": len(rows),
        "capacity": capacity,
        "usable": usable_gpus,
        "known_usable": known_usable,
        "on_demand": _sum([n.get("gpu_count") for n in rows if n["health"] == "on_demand"])
        if rows
        else None,
        "unavailable": _sum([n.get("gpu_count") for n in unavailable]) if rows else None,
        "allocated": allocated,
        "unallocated": free,
        "abnormal": sum(n["health"] == "unavailable" for n in rows),
        "unknown": sum(
            n["health"] == "unknown" or n.get("gpu_count") is None or n.get("gpu_allocated") is None
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
    rates: dict[str, float] = {}
    priced = 0
    spend_sources = [s for s in sources if s["kind"] == "cloud" and s.get("driver") != "ssh"]
    unpriced = [
        _missing(s, "source", _source_reason(s)) for s in spend_sources if not fresh(s, "instances")
    ]
    # Choose among current observations before deduplicating twin cloud logins.
    spend_instances = _unique(
        [
            i
            for i in data["instances"]
            if (i.get("manual") and i.get("hourly_cost") is not None)
            or (
                not i.get("manual")
                and by_id.get(i["source_id"], {}).get("driver") != "ssh"
                and i["source_id"] not in disabled
                and (i["source_id"] not in by_id or fresh(by_id[i["source_id"]], "instances"))
            )
        ]
    )
    for item in spend_instances:
        source = by_id.get(item["source_id"])
        state = manual_state(item) if item.get("manual") else item.get("state")
        lifecycle = instance_lifecycle(state)
        if lifecycle == "not_held":
            continue
        if not item.get("manual") and source is None:
            reason = "summary_not_collected"
        elif lifecycle == "unknown":
            reason = "summary_lifecycle_unknown"
        elif item.get("hourly_cost") is None or not item.get("currency"):
            reason = "summary_price_missing"
        else:
            currency = item["currency"]
            rates[currency] = rates.get(currency, 0) + item["hourly_cost"]
            priced += 1
            continue
        unpriced.append(_missing(item, "instance", reason))
    shortcuts = [i for i in all_instances if i.get("manual") and not i.get("monitoring")]
    instances = [
        i
        for i in all_instances
        if not i.get("same_node") and (not i.get("manual") or i.get("monitoring"))
    ]
    linked_sources = {
        s["id"]
        for s in sources
        if s.get("driver") == "ssh"
        and (rows := [i for i in all_instances if i["source_id"] == s["id"]])
        and all(i.get("same_node") for i in rows)
    }
    fresh_ids = {
        s["id"] for s in sources if fresh(s, "jobs" if s["kind"] == "cluster" else "instances")
    }
    unmeasured = [
        _missing(s, "source", _source_reason(s))
        for s in sources
        if s["id"] not in fresh_ids and s["id"] not in linked_sources
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
    known_allocated = (
        sum(counted)
        if fresh_ids or counted or any(i.get("same_node") for i in all_instances)
        else None
    )
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
        "spend": {
            "applies": bool(spend_sources or spend_instances),
            "rates": rates,
            "priced": priced,
            "unpriced": unpriced,
        },
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
            ],
            partition_sources={s["id"] for s in sources if requires_partition(s)},
        ),
        "jobs": {
            **(
                {
                    "current_ids": [j["id"] for j in current],
                    "listed_ids": [j["id"] for j in [*current, *old]],
                    "running_ids": [
                        j["id"] for j in [*current, *old] if j.get("state", "").upper() in RUNNING
                    ],
                    "pending_ids": [
                        j["id"] for j in [*current, *old] if j.get("state", "").upper() in PENDING
                    ],
                }
                if include_job_ids
                else {}
            ),
            "missing_source_ids": [s["id"] for s in missing_jobs],
            "known": len(current),
            "total": None if missing_jobs else len(current),
        },
    }


def link_machine_nodes(data: dict[str, Any]) -> None:
    """Annotate machines before scoping, so all summaries use the same exclusion.

    Retained nodes still establish identity during an outage; the scheduler's existing
    freshness rules then keep its allocation unknown rather than substituting host use.
    """
    sources = {s["id"]: s for s in data["sources"]}
    nodes: dict[str, dict[str, Any]] = {}
    for node in data["nodes"]:
        source = sources.get(node["source_id"], {})
        if (
            source.get("kind") != "cluster"
            or not source.get("enabled")
            or not source.get("last_success")
        ):
            continue
        previous = nodes.get(node["id"])
        if previous is None or (node.get("observed_at") or "") > (
            previous.get("observed_at") or ""
        ):
            nodes[node["id"]] = node
    addresses: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
    for node in nodes.values():
        source = sources[node["source_id"]]
        values = node.get("host_addresses")
        for value in values if isinstance(values, list) else []:
            address = host_address(value)
            if address:
                addresses.setdefault((source.get("node") or "", address), {})[node["id"]] = node
    for item in data["instances"]:
        item.pop("same_node", None)
        source = sources.get(item["source_id"], {})
        if not item.get("manual") and (
            source.get("driver") != "ssh" or not source.get("last_success")
        ):
            continue
        endpoint = item.get("ssh_endpoint")
        if not isinstance(endpoint, dict) or endpoint.get("port") != 22:
            continue
        address = host_address(endpoint.get("host"))
        if not address:
            continue
        matches = addresses.get((source.get("node") or "", address), {})
        if len(matches) != 1:
            continue
        node = next(iter(matches.values()))
        # Separate networks can reuse an IP even on the same collection computer.
        # Require an independently observed hostname as well, never a name alone.
        hostname = short_hostname(item.get("host_name"))
        values = node.get("host_names")
        names = [node.get("name"), *(values if isinstance(values, list) else [])]
        if not hostname or not any(hostname == short_hostname(name) for name in names):
            continue
        cluster = sources[node["source_id"]]
        item["same_node"] = {
            "id": node["id"],
            "name": node.get("name") or node["id"],
            "cluster_id": cluster["cluster_id"],
            "cluster_name": cluster["name"],
        }


def summarize(data: dict[str, Any]) -> dict[str, Any]:
    """One set of figures for the fleet, each group and each configured login."""
    link_machine_nodes(data)
    source_groups = {s["id"]: s["cluster_id"] for s in data["sources"]}

    def instance_group(item: dict[str, Any]) -> str:
        group = source_groups.get(item["source_id"])
        return (
            group
            if group is not None
            else f"platform:{(item.get('platform') or '').strip().lower()}"
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
