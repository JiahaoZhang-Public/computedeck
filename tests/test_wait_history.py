"""Own accounting waits: rolling history, conservative buckets and no queue predictions."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from computedeck.demo import dashboard
from computedeck.drivers.slurm import _FINISHED_FIELDS, parse_failures
from computedeck.store import Store
from computedeck.wait_history import gpu_bucket, summarize_waits, wait_sample

NOW = datetime(2026, 10, 20, tzinfo=UTC)
SOURCE = {
    "driver": "slurm",
    "id": "login-a",
    "kind": "cluster",
    "cluster_id": "cluster-a",
    "username": "alice",
    "capabilities": ["history"],
    "last_success": NOW.isoformat(),
}


def job(index: int = 0, *, current: datetime = NOW, **changes: Any) -> dict[str, Any]:
    started = current - timedelta(days=1)
    return {
        "id": f"cluster-a:{index}",
        "cluster_id": "cluster-a",
        "user": "alice",
        "state": "COMPLETED",
        "qos": "normal",
        "partition": "gpu",
        "gpu_count": 1,
        "submitted_at": (started - timedelta(minutes=10 * index)).isoformat(),
        "started_at": started.isoformat(),
        "ended_at": (started + timedelta(hours=1)).isoformat(),
        **changes,
    }


def samples(count: int, **changes: Any) -> list[dict[str, Any]]:
    result = []
    for index in range(count):
        sample = wait_sample(job(index, **changes), SOURCE)
        assert sample is not None
        result.append(sample)
    return result


def summary(rows: list[dict[str, Any]], **changes: Any) -> dict[str, Any]:
    return summarize_waits([{**SOURCE, **changes}], rows, now=NOW)[SOURCE["id"]]


@pytest.mark.parametrize("count", [0, 1, 7, 8, 12])
def test_eight_sample_threshold_and_inclusive_percentiles(count: int) -> None:
    result = summary(samples(count))
    assert result["status"] == "available"
    if count == 0:
        assert result["buckets"] == []
        return
    [bucket] = result["buckets"]
    assert bucket["samples"] == count
    assert bucket["p25_seconds"] == ((count - 1) * 600 * 0.25 if count >= 8 else None)
    assert bucket["p75_seconds"] == ((count - 1) * 600 * 0.75 if count >= 8 else None)


@pytest.mark.parametrize(
    ("count", "bounds"),
    [
        (0, (0, 0)),
        (1, (1, 1)),
        (2, (2, 2)),
        (3, (3, 4)),
        (4, (3, 4)),
        (5, (5, 8)),
        (8, (5, 8)),
        (9, (9, 16)),
        (1024, (513, 1024)),
    ],
)
def test_gpu_buckets(count: int, bounds: tuple[int, int]) -> None:
    assert gpu_bucket(count) == bounds


@pytest.mark.parametrize(
    "changes",
    [
        {"user": "bob"},
        {"cluster_id": "cluster-b"},
        {"gpu_count": None, "ended_at": job()["started_at"]},
        {"gpu_count": True},
        {"gpu_count": -1},
        {"gpu_count": 1.5},
        {"submitted_at": None},
        {"started_at": None},
        {"ended_at": None},
        {"submitted_at": "2026-10-18T10:00:00"},
        {"started_at": "Unknown"},
        {"submitted_at": NOW.isoformat()},
        {"ended_at": "2026-10-18T00:00:00Z"},
    ],
)
def test_invalid_or_other_users_records_are_excluded(changes: dict[str, Any]) -> None:
    assert wait_sample(job(**changes), SOURCE) is None


def test_timezone_normalization_and_zero_wait_are_valid() -> None:
    result = wait_sample(job(submitted_at="2026-10-19T04:00:00+04:00"), SOURCE)
    assert result and result["submitted_at"] == result["started_at"]
    assert summary([result])["buckets"][0]["samples"] == 1


def test_unknown_login_owner_cannot_supply_own_job_history() -> None:
    assert wait_sample(job(user=""), {**SOURCE, "username": ""}) is None


def test_rolling_window_uses_end_time_and_excludes_future() -> None:
    rows = []
    for days in (30, 30.01, -1, 0):
        row = wait_sample(job(current=NOW - timedelta(days=days - 1, hours=1)), SOURCE)
        assert row
        rows.append(row)
    assert summary(rows)["buckets"][0]["samples"] == 2


def test_scopes_and_twins_never_pool_other_logins_or_partitions() -> None:
    own = samples(8)
    rows = [
        *own,
        *own,
        *samples(3, qos="debug"),
        *samples(4, partition="other"),
        *samples(2, gpu_count=8),
    ]
    bob = {**SOURCE, "id": "bob", "username": "bob"}
    other = {**SOURCE, "id": "other", "cluster_id": "cluster-b"}
    twin = {**SOURCE, "id": "twin", "capabilities": [], "last_success": None}
    result = summarize_waits([SOURCE, bob, other, twin], rows, now=NOW)
    assert result["login-a"] == result["twin"]
    assert result["bob"]["buckets"] == result["other"]["buckets"] == []
    assert sorted(b["samples"] for b in result["login-a"]["buckets"]) == [2, 3, 4, 8]


def test_unavailable_uncollected_and_stale_history() -> None:
    assert summary([], capabilities=[])["status"] == "unavailable"
    assert summary([], capabilities=[], last_success=None)["status"] == "not_collected"
    old = (NOW - timedelta(days=2)).isoformat()
    result = summary(samples(8), last_success=old, stale=True, status="error")
    assert result["buckets"][0]["samples"] == 8
    assert result["observed_at"] == old


@pytest.mark.parametrize(
    ("tracked", "tres", "count"),
    [
        (False, "gres/gpu=1", 1),
        (True, "billing=4,cpu=4,mem=16G,node=1", 0),
        (False, "billing=4,cpu=4,mem=16G,node=1", None),
        (True, "", None),
    ],
)
def test_slurm_accounting_rows_supply_wait_times_without_another_query(
    tracked: bool, tres: str, count: int | None
) -> None:
    values = {
        "JobID": "42",
        "JobName": "training",
        "User": "alice",
        "Account": "research",
        "Partition": "gpu",
        "QOS": "normal",
        "State": "COMPLETED",
        "AllocTRES": tres,
        "NCPUS": "8",
        "NodeList": "gpu-01",
        "Elapsed": "00:30:00",
        "ExitCode": "0:0",
        "Timelimit": "01:00:00",
        "Submit": "2026-10-19T10:00:00+0400",
        "Start": "2026-10-19T10:20:00+0400",
        "End": "2026-10-19T10:50:00+0400",
    }
    [parsed] = parse_failures(
        "|".join(values[field] for field in _FINISHED_FIELDS),
        SOURCE,
        terminal=True,
        tracked=tracked,
    )
    assert parsed["gpu_count"] == count
    sample = wait_sample(parsed, SOURCE)
    assert sample and sample["started_at"] == "2026-10-19T06:20:00+00:00"
    result = summary([sample])
    if count is None:
        assert result["buckets"] == []
        assert result["unknown_gpu_samples"] == 1
    else:
        [bucket] = result["buckets"]
        assert bucket["samples"] == 1 and bucket["p25_seconds"] is None
        assert (bucket["gpu_min"], bucket["gpu_max"]) == (count, count)
        assert result["unknown_gpu_samples"] == 0
    if tres == "":
        assert wait_sample({**parsed, "started_at": parsed["ended_at"]}, SOURCE) is None


def test_unknown_gpu_counts_are_deduplicated_scoped_and_expire(store: Store) -> None:
    current = datetime.now(UTC)
    source = {**SOURCE, "enabled": True, "interval_minutes": 10, "name": "Cluster A"}
    twin = {**source, "id": "twin"}
    bob = {**source, "id": "bob", "username": "bob"}
    other = {**source, "id": "other", "cluster_id": "cluster-b"}
    for login in (source, twin, bob, other):
        store.save_source(login)
    unknown = job(current=current, gpu_count=None)
    store.record_job_waits(source, [unknown, unknown, {**unknown, "user": "bob"}])
    store.record_job_waits(twin, [unknown])
    store.record_job_waits(source, [job(1, current=current - timedelta(days=31), gpu_count=None)])
    reopened = Store(store.path)
    try:
        history = reopened.dashboard()["wait_history"]
        assert history[source["id"]] == history["twin"]
        assert history[source["id"]]["unknown_gpu_samples"] == 1
        assert history[source["id"]]["buckets"] == []
        assert history["bob"]["unknown_gpu_samples"] == history["other"]["unknown_gpu_samples"] == 0
        # A twin's known count resolves the uncertainty without counting an attempt twice.
        reopened.record_job_waits(twin, [{**unknown, "gpu_count": 1}])
        result = reopened.dashboard()["wait_history"][source["id"]]
        assert result["unknown_gpu_samples"] == 0
        assert result["buckets"][0]["samples"] == 1
    finally:
        reopened.db.close()
    assert (
        summary(samples(3, gpu_count=None, current=NOW - timedelta(days=31)))["unknown_gpu_samples"]
        == 0
    )


def test_store_retains_only_times_deduplicates_attempts_and_survives_restart(store: Store) -> None:
    current = datetime.now(UTC)
    source = {
        **SOURCE,
        "enabled": True,
        "interval_minutes": 10,
        "driver": "slurm",
        "name": "Cluster A",
    }
    store.save_source(source)
    own = job(current=current, name="must-not-store", stdout_path="/work/example/output")
    store.record_job_waits(source, [own, own, job(current=current, user="bob")])
    # Saving an old source without optional empty connection fields is not a repoint.
    store.save_source(source)
    # Requeued/reused ids with a distinct start count as distinct observed attempts.
    store.record_job_waits(source, [job(current=current - timedelta(days=1))])
    rows = [json.loads(row[0]) for row in store.db.execute("SELECT data FROM job_wait_samples")]
    assert len(rows) == 2
    assert all(
        set(row)
        == {
            "id",
            "cluster_id",
            "user",
            "qos",
            "partition",
            "gpu_count",
            "submitted_at",
            "started_at",
            "ended_at",
        }
        for row in rows
    )
    reopened = Store(store.path)
    try:
        assert reopened.dashboard()["wait_history"][source["id"]]["buckets"][0]["samples"] == 2
    finally:
        reopened.db.close()
    # Expiry applies to query results even before the retention pass runs.
    with store.db:
        expired = {**rows[0], "ended_at": (current - timedelta(days=31)).isoformat()}
        store.db.execute(
            "UPDATE job_wait_samples SET ended_at=?, data=?",
            (expired["ended_at"], json.dumps(expired)),
        )
    assert store.dashboard()["wait_history"][source["id"]]["buckets"] == []
    store.record_job_waits(source, [])
    assert store.db.execute("SELECT COUNT(*) FROM job_wait_samples").fetchone()[0] == 0


def test_source_identity_edits_and_deletion_clear_history_but_pausing_keeps_it(
    store: Store,
) -> None:
    source = {
        **SOURCE,
        "enabled": True,
        "interval_minutes": 10,
        "driver": "slurm",
        "name": "Cluster A",
        "options": {},
    }
    store.save_source(source)
    store.record_job_waits(source, [job(current=datetime.now(UTC))])
    store.save_source({**source, "enabled": False})
    assert store.db.execute("SELECT COUNT(*) FROM job_wait_samples").fetchone()[0] == 1
    store.save_source({**source, "ssh_alias": "new-login"})
    assert store.db.execute("SELECT COUNT(*) FROM job_wait_samples").fetchone()[0] == 0
    store.record_job_waits(source, [job(current=datetime.now(UTC))])
    store.delete_source(source["id"])
    assert store.db.execute("SELECT COUNT(*) FROM job_wait_samples").fetchone()[0] == 0


def test_example_has_range_small_sample_and_unavailable_accounting() -> None:
    data = dashboard()
    history = data["wait_history"]
    [available] = history["example:cluster-a-alice"]["buckets"]
    assert available["samples"] == 12 and available["p25_seconds"] == 2250
    assert available["p75_seconds"] == 5550
    [small] = history["example:cluster-b-alice"]["buckets"]
    assert small["samples"] == 3 and small["p25_seconds"] is None
    assert history["example:cluster-a-bob"]["status"] == "unavailable"
    assert history["example:cluster-a-bob"]["buckets"] == []
    assert history["example:cluster-d-alice"]["unknown_gpu_samples"] == 4
    [cpu] = history["example:cluster-d-alice"]["buckets"]
    assert (cpu["gpu_min"], cpu["gpu_max"], cpu["samples"]) == (0, 0, 8)


@pytest.mark.parametrize(
    ("driver", "status"),
    [
        ("slurm", "available"),
        ("pbs", "available"),
        ("lsf", "unsupported"),
        ("kubernetes", "unsupported"),
        ("unknown-plugin", "unsupported"),
    ],
)
def test_driver_support_is_distinct_from_accounting_availability(driver: str, status: str) -> None:
    result = summary(samples(8), driver=driver)
    assert result["status"] == status
    assert bool(result["buckets"]) == (status == "available")
    if status == "unsupported":
        assert result["observed_at"] is None
    else:
        assert summary([], driver=driver, capabilities=[])["status"] == "unavailable"


@pytest.mark.parametrize("opt_in", [None, False, True, "true", property(lambda self: True)])
def test_plugin_wait_history_requires_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch,
    store: Store,
    opt_in: object,
) -> None:
    from computedeck import drivers

    class PluginDriver:
        name = "example-waits"
        kind = "cluster"

    if opt_in is not None:
        monkeypatch.setattr(PluginDriver, "supports_wait_history", opt_in, raising=False)
    monkeypatch.setitem(drivers._DRIVERS, PluginDriver.name, PluginDriver())
    source = {**SOURCE, "driver": PluginDriver.name}
    assert summary([], driver=PluginDriver.name)["status"] == (
        "available" if opt_in is True else "unsupported"
    )
    store.record_job_waits(source, [job(current=datetime.now(UTC))])
    assert store.db.execute("SELECT COUNT(*) FROM job_wait_samples").fetchone()[0] == int(
        opt_in is True
    )
