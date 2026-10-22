"""SQLite store: schema versioning, settings, snapshots, deduplication and failures."""

import json
import sqlite3
import stat
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from computedeck import store as store_module
from computedeck.store import SCHEMA_VERSION, DatabaseVersionError, Store, now

AddSource = Callable[..., dict[str, Any]]


def test_dashboard_does_not_validate_collector_lifecycle_rows(
    monkeypatch: pytest.MonkeyPatch, store: Store, add_source: AddSource
) -> None:
    source = add_source()
    ended = {"id": "cluster-a:1", "end": now(), "observed_at": now()}
    store.save_snapshot(
        source["id"], {"jobs": [], "lifecycle_pending": [], "lifecycle_ended": [ended]}
    )
    # Partial inventory updates must retain the collector's reconciliation state.
    store.save_snapshot(source["id"], {"nodes": []})
    validated = []
    validate = store_module.validate_row

    def track(row: dict[str, Any]) -> None:
        validated.append(row)
        validate(row)

    monkeypatch.setattr(store_module, "validate_row", track)
    assert store.dashboard()["jobs"] == []
    assert ended not in validated
    assert store.snapshot(source["id"])["lifecycle_ended"] == [ended]
    assert ended in validated


def test_fresh_store_has_no_sources_and_default_settings(tmp_path: Path) -> None:
    path = tmp_path / "data" / "computedeck.sqlite"
    store = Store(path)
    assert store.sources() == []
    assert store.settings() == {"language": "en", "server_name": None}
    data = store.dashboard()
    assert data["mode"] == "live"
    assert data["sources"] == data["jobs"] == data["nodes"] == data["instances"] == []
    assert data["history"] == []
    assert data["recent_failures"] == []
    assert data["updated_at"] is None
    row = store.db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert row == (str(SCHEMA_VERSION),)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    store.db.close()


def test_settings_persist_and_reject_unknown_keys(tmp_path: Path) -> None:
    store = Store(tmp_path / "computedeck.sqlite")
    assert store.save_settings({"language": "zh-CN"}) == {"language": "zh-CN", "server_name": None}
    store.save_settings({"server_name": "Lab server"})
    with pytest.raises(ValueError, match="Unknown setting"):
        store.save_settings({"theme": "dark"})
    store.db.close()
    reopened = Store(tmp_path / "computedeck.sqlite")
    assert reopened.settings() == {"language": "zh-CN", "server_name": "Lab server"}
    reopened.db.close()


def legacy_database(path: Path, sources: list[dict[str, object]]) -> None:
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE sources (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        for source in sources:
            db.execute("INSERT INTO sources VALUES (?, ?)", (source["id"], json.dumps(source)))
    db.close()


def test_legacy_database_without_driver_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "computedeck.sqlite"
    legacy_database(path, [{"id": "cluster-a-alice", "provider": "cluster-a", "enabled": True}])
    with pytest.raises(DatabaseVersionError, match="pre-release"):
        Store(path)
    # Refusing must not stamp the database as current.
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() is None
    db.close()


def test_unversioned_database_with_current_records_is_adopted(tmp_path: Path) -> None:
    path = tmp_path / "computedeck.sqlite"
    legacy_database(path, [{"id": "cluster-a-alice", "driver": "slurm"}])
    store = Store(path)
    row = store.db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    assert row == (str(SCHEMA_VERSION),)
    store.db.close()


def test_newer_schema_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "computedeck.sqlite"
    Store(path).db.close()
    with sqlite3.connect(path) as db:
        db.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(SCHEMA_VERSION + 1),))
    db.close()
    with pytest.raises(DatabaseVersionError, match="newer"):
        Store(path)


def test_source_kind_is_derived_and_not_stored(store: Store, add_source: AddSource) -> None:
    cluster = add_source()
    cloud = add_source("RunPod", driver="runpod")
    assert cluster["kind"] == "cluster"
    assert cloud["kind"] == "cloud"
    store.save_source({**cluster, "stale": True})
    stored = [json.loads(row[0]) for row in store.db.execute("SELECT data FROM sources")]
    assert all("kind" not in row and "stale" not in row for row in stored)
    # A driver that is no longer installed still lists as a cluster instead of failing.
    store.save_source({**cluster, "id": "cluster-x-alice", "driver": "removed-driver"})
    assert store.source("cluster-x-alice")["kind"] == "cluster"


def test_freshest_identity_observation_deduplicates_jobs_and_nodes(store: Store) -> None:
    older = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    job = {"id": "cluster-a:12", "source_id": "cluster-a-alice", "gpu_count": 4}
    store.save_snapshot(
        "cluster-a-alice",
        {"jobs": [{**job, "observed_at": older}], "nodes": [{"id": "cluster-a:node-01"}]},
    )
    store.save_snapshot(
        "cluster-a-bob",
        {
            "jobs": [{**job, "source_id": "cluster-a-bob", "gpu_count": 2, "observed_at": now()}],
            "nodes": [{"id": "cluster-a:node-01"}],
        },
    )
    store.save_snapshot(
        "cluster-b-alice",
        {
            "jobs": [{**job, "id": "cluster-b:12", "observed_at": older}],
            "nodes": [{"id": "cluster-b:node-01"}],
        },
    )
    data = store.dashboard()
    jobs = {row["id"]: row for row in data["jobs"]}
    assert set(jobs) == {"cluster-a:12", "cluster-b:12"}
    assert jobs["cluster-a:12"]["gpu_count"] == 2
    assert jobs["cluster-a:12"]["source_id"] == "cluster-a-bob"
    assert sorted(row["id"] for row in data["nodes"]) == ["cluster-a:node-01", "cluster-b:node-01"]


def test_partial_success_preserves_unsupported_inventory(store: Store) -> None:
    store.save_snapshot(
        "cluster-a-alice",
        {
            "jobs": [{"id": "cluster-a:1"}],
            "nodes": [{"id": "cluster-a:node-01"}],
            "failures": [{"id": "cluster-a:2", "end": "2026-01-01T00:00:00"}],
        },
    )
    store.save_snapshot("cluster-a-alice", {"jobs": []})
    snapshot = json.loads(
        store.db.execute("SELECT data FROM snapshots WHERE source_id='cluster-a-alice'").fetchone()[
            0
        ]
    )
    assert snapshot["jobs"] == []
    assert snapshot["nodes"] == [{"id": "cluster-a:node-01"}]
    assert len(snapshot["failures"]) == 1
    data = store.dashboard()
    assert data["jobs"] == []
    assert len(data["nodes"]) == 1


def test_missing_pod_preserves_connection_and_marks_missing(store: Store) -> None:
    pod = {"id": "runpod:a", "state": "desired_running", "host": "192.0.2.1", "port": 22001}
    store.save_snapshot("runpod-runpod", {"instances": [pod]})
    store.save_snapshot("runpod-runpod", {"instances": []})
    [instance] = store.dashboard()["instances"]
    assert instance["state"] == "missing"
    assert instance["host"] == "192.0.2.1"
    assert instance["port"] == 22001
    # A second complete listing removes the missing row; reappearance is normal.
    store.save_snapshot("runpod-runpod", {"instances": []})
    assert store.dashboard()["instances"] == []
    store.save_snapshot("runpod-runpod", {"instances": [{**pod, "state": "desired_stopped"}]})
    assert store.dashboard()["instances"][0]["state"] == "desired_stopped"


def test_manual_instance_overrides_and_deletes(store: Store) -> None:
    store.save_instance({"id": "manual:lab-box1", "source_id": "manual", "state": "unknown"})
    assert [row["id"] for row in store.dashboard()["instances"]] == ["manual:lab-box1"]
    assert store.delete_instance("manual:lab-box1") is True
    assert store.delete_instance("manual:lab-box1") is False
    assert store.dashboard()["instances"] == []


def test_delete_source_removes_its_snapshot(store: Store, add_source: AddSource) -> None:
    alice = add_source()
    bob = add_source(username="bob")
    store.save_snapshot(alice["id"], {"jobs": [{"id": "cluster-a:1", "source_id": alice["id"]}]})
    store.save_snapshot(bob["id"], {"jobs": [{"id": "cluster-a:2", "source_id": bob["id"]}]})
    assert store.delete_source(alice["id"]) is True
    assert store.delete_source(alice["id"]) is False
    assert [source["id"] for source in store.sources()] == [bob["id"]]
    assert [job["id"] for job in store.dashboard()["jobs"]] == ["cluster-a:2"]


def test_cloud_metrics_update_only_the_probed_endpoint(store: Store) -> None:
    pod = {"id": "runpod:a", "host": "192.0.2.1", "port": 22001, "username": "root"}
    store.save_snapshot("runpod-runpod", {"instances": [pod, {**pod, "id": "runpod:b"}]})
    endpoint = {"host": "192.0.2.1", "port": 22001, "username": "root", "identity_file": None}
    store.update_cloud_metrics("runpod:a", endpoint, {"gpu_utilization": 50})
    store.update_cloud_metrics("runpod:b", {**endpoint, "port": 22002}, {"gpu_utilization": 99})
    rows = {row["id"]: row for row in store.dashboard()["instances"]}
    assert rows["runpod:a"]["gpu_utilization"] == 50
    assert "gpu_utilization" not in rows["runpod:b"]


def test_a_listing_keeps_the_last_check_of_an_unchanged_endpoint(store: Store) -> None:
    pod = {
        "id": "runpod:a",
        "source_id": "runpod-runpod",
        "state": "desired_running",
        "host": "192.0.2.1",
        "port": 22001,
        "username": "root",
        "cpu_utilization": None,
        "ssh_status": "unverified",
    }
    other = {**pod, "id": "runpod:b"}
    store.save_snapshot("runpod-runpod", {"instances": [pod, other]})
    endpoint = {"host": "192.0.2.1", "port": 22001, "username": "root"}
    failed = {
        "ssh_status": "error",
        "ssh_error": {"code": "ssh_failed", "detail": "Connection refused"},
        "last_probe_attempt": now(),
    }
    store.update_cloud_metrics("runpod:a", endpoint, failed)
    reached = {"ssh_status": "reachable", "ssh_error": None, "last_probe_attempt": now()}
    store.update_cloud_metrics("runpod:b", endpoint, {**reached, "cpu_utilization": 20.0})
    # A listing cannot check SSH: a failed connection stays failed until checked again.
    store.save_snapshot("runpod-runpod", {"instances": [pod, other]})
    rows = {row["id"]: row for row in store.dashboard()["instances"]}
    assert {key: rows["runpod:a"][key] for key in failed} == failed
    assert {key: rows["runpod:b"][key] for key in reached} == reached
    # What the check measured belongs to that moment, not to this listing.
    assert rows["runpod:b"]["cpu_utilization"] is None
    # A pod that comes back on another port has not been checked there.
    store.save_snapshot("runpod-runpod", {"instances": [{**pod, "port": 22002}, other]})
    rows = {row["id"]: row for row in store.dashboard()["instances"]}
    assert rows["runpod:a"]["ssh_status"] == "unverified"
    assert "ssh_error" not in rows["runpod:a"]
    assert "last_probe_attempt" not in rows["runpod:a"]
    assert rows["runpod:b"]["ssh_status"] == "reachable"


def test_a_source_that_reaches_the_machine_itself_is_not_overruled(store: Store) -> None:
    machine = {"id": "gpu-box:gpu-box", "host": "gpu-box", "port": None, "username": "alice"}
    failed = {"ssh_status": "error", "ssh_error": "timeout", "last_probe_attempt": now()}
    store.save_snapshot("gpu-box-ssh", {"instances": [{**machine, **failed}]})
    store.save_snapshot("gpu-box-ssh", {"instances": [{**machine, "ssh_status": "reachable"}]})
    [row] = store.dashboard()["instances"]
    assert row["ssh_status"] == "reachable"
    assert "ssh_error" not in row


@pytest.mark.parametrize(
    "state", ["stopped", "terminated", "deleted", "desired_stopped", "desired_terminated"]
)
@pytest.mark.parametrize("ssh_status", ["reachable", "error"])
def test_a_released_instance_drops_its_old_check_even_with_the_same_endpoint(
    store: Store, state: str, ssh_status: str
) -> None:
    pod = {
        "id": "runpod:a",
        "state": "reported_running",
        "host": "192.0.2.1",
        "port": 22001,
        "username": "root",
        "ssh_status": "unverified",
    }
    store.save_snapshot("runpod-runpod", {"instances": [pod]})
    store.update_cloud_metrics(
        pod["id"],
        {"host": pod["host"], "port": pod["port"], "username": pod["username"]},
        {"ssh_status": ssh_status, "ssh_error": None, "last_probe_attempt": now()},
    )
    store.save_snapshot("runpod-runpod", {"instances": [{**pod, "state": state}]})
    [stopped] = store.dashboard()["instances"]
    assert stopped["ssh_status"] == "unverified"
    assert "last_probe_attempt" not in stopped
    assert "ssh_error" not in stopped
    store.save_snapshot("runpod-runpod", {"instances": [pod]})
    [restarted] = store.dashboard()["instances"]
    assert restarted["ssh_status"] == "unverified"
    assert "last_probe_attempt" not in restarted


@pytest.mark.parametrize(
    ("ssh_status", "minutes", "state"),
    [
        ("reachable", 1, "running"),
        ("reachable", 19, "running"),
        ("reachable", 21, "unknown"),
        ("error", 1, "unknown"),
        ("unverified", None, "unknown"),
    ],
)
def test_a_machine_added_by_hand_runs_only_while_a_recent_check_reached_it(
    store: Store, ssh_status: str, minutes: int | None, state: str
) -> None:
    observed = None if minutes is None else datetime.now(UTC) - timedelta(minutes=minutes)
    store.save_instance(
        {
            "id": "manual:lab-box1",
            "source_id": "manual",
            "manual": True,
            # Stored by an earlier check; what counts is when that check was.
            "state": "running",
            "ssh_status": ssh_status,
            "observed_at": observed and observed.isoformat(),
        }
    )
    [row] = store.dashboard()["instances"]
    assert row["state"] == state


def test_stale_sources_are_flagged(store: Store, add_source: AddSource) -> None:
    hour_ago = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    add_source(last_success=hour_ago)
    add_source("Cluster B")
    add_source("Cluster C", last_success=hour_ago, enabled=False)
    stale = {source["id"]: source["stale"] for source in store.dashboard()["sources"]}
    assert stale == {"cluster-a-alice": True, "cluster-b-alice": False, "cluster-c-alice": False}


def failure(identifier: str, end: str, **changes: object) -> dict[str, object]:
    result: dict[str, object] = {
        "id": identifier,
        "name": "train",
        "user": "alice",
        "state": "FAILED",
        "end": end,
        "exit_code": "1:0",
        "gpu_count": None,
    }
    result.update(changes)
    return result


def test_recent_failures_come_from_enabled_source_snapshots(
    store: Store, add_source: AddSource
) -> None:
    alice = add_source(capabilities=["jobs", "history"])
    bob = add_source(username="bob", capabilities=["jobs", "history"])
    disabled = add_source("Cluster B", enabled=False)
    store.save_snapshot(
        alice["id"],
        {
            "failures": [
                failure("cluster-a:1", "2026-01-05T10:00:00"),
                failure("cluster-a:3", "2026-01-05T12:00:00", state="OUT_OF_MEMORY"),
            ]
        },
    )
    store.save_snapshot(bob["id"], {"failures": [failure("cluster-a:3", "2026-01-05T12:00:00")]})
    store.save_snapshot(
        disabled["id"], {"failures": [failure("cluster-b:9", "2026-01-05T13:00:00")]}
    )
    data = store.dashboard()
    assert [row["id"] for row in data["recent_failures"]] == ["cluster-a:3", "cluster-a:1"]
    assert data["recent_failures"][0]["state"] == "OUT_OF_MEMORY"
    assert sorted(data["failure_history_sources"]) == sorted([alice["id"], bob["id"]])
    assert data["failure_history_observed_at"] == min(alice["last_success"], bob["last_success"])


def test_failure_coverage_requires_fresh_history_capability(
    store: Store, add_source: AddSource
) -> None:
    add_source()
    add_source("Cluster B", capabilities=["jobs", "history"], status="error")
    add_source(
        "Cluster C",
        capabilities=["jobs", "history"],
        last_success=(datetime.now(UTC) - timedelta(hours=2)).isoformat(),
    )
    data = store.dashboard()
    assert data["failure_history_sources"] == []
    assert data["failure_history_observed_at"] is None
    assert data["recent_failures"] == []


def test_updated_at_is_latest_observation(store: Store, add_source: AddSource) -> None:
    older = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    add_source(last_success=older)
    assert store.dashboard()["updated_at"] == older
    probed = now()
    store.save_instance({"id": "manual:lab-box1", "state": "unknown", "observed_at": probed})
    assert store.dashboard()["updated_at"] == probed


def test_backup_can_be_opened_independently(
    store: Store, add_source: AddSource, tmp_path: Path
) -> None:
    add_source()
    add_source("RunPod", driver="runpod")
    path = store.backup(tmp_path / "backups")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    with sqlite3.connect(path) as backup:
        assert backup.execute("SELECT count(*) FROM sources").fetchone()[0] == 2
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    backup.close()
    assert path != store.backup(tmp_path / "backups")


def test_only_the_newest_backups_are_kept(store: Store, tmp_path: Path) -> None:
    folder = tmp_path / "backups"
    folder.mkdir()
    (folder / "mine.sqlite").write_text("a copy the user made")
    written = [store.backup(folder, keep=3) for _ in range(5)]
    assert sorted(folder.iterdir()) == sorted([folder / "mine.sqlite", *written[-3:]])
    assert store.backup(folder, keep=0).exists()
    assert len(list(folder.glob("computedeck-*.sqlite"))) == 1


def test_failures_of_a_stale_source_are_not_shown_as_recent(
    store: Store, add_source: AddSource
) -> None:
    stale = add_source(
        capabilities=["jobs", "history"],
        last_success=(datetime.now(UTC) - timedelta(days=3)).isoformat(),
    )
    store.save_snapshot(stale["id"], {"failures": [failure("cluster-a:1", "2026-01-05T10:00")]})
    assert store.dashboard()["recent_failures"] == []


def test_terminal_instance_disappearance_does_not_become_unknown(
    store: Store,
    add_source: AddSource,
) -> None:
    source = add_source("Cloud", driver="runpod", capabilities=["instances"])
    store.save_snapshot(
        source["id"],
        {"instances": [{"id": "cloud:a", "source_id": source["id"], "state": "terminated"}]},
    )
    store.save_snapshot(source["id"], {"instances": []})
    store.record_history()
    assert store.dashboard()["instances"] == []
    assert store.history(24)[-1]["allocated_gpus"] == 0


def test_syncing_failed_source_is_not_fresh(store: Store, add_source: AddSource) -> None:
    source = add_source(status="syncing", error={"code": "ssh_failed"})
    assert not store.fresh(source, "jobs")


def test_existing_malformed_row_cannot_break_dashboard(store: Store) -> None:
    store.db.execute(
        "INSERT INTO snapshots VALUES (?, ?)",
        ("source", json.dumps({"instances": [{"name": "bad"}]})),
    )
    assert store.dashboard()["instances"] == []
    # Stored before text fields were checked: an object would blank the web app.
    job = {"id": "c:1", "source_id": "source", "state": "RUNNING", "user": {"x": 1}}
    store.db.execute(
        "INSERT OR REPLACE INTO snapshots VALUES (?, ?)", ("source", json.dumps({"jobs": [job]}))
    )
    assert store.dashboard()["jobs"] == []


def test_sqlite_sidecars_are_private_on_first_open(tmp_path: Path) -> None:
    path = tmp_path / "private.sqlite"
    store = Store(path)
    for file in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        assert stat.S_IMODE(file.stat().st_mode) == 0o600
    store.db.close()


def test_snapshot_write_rejects_bad_rows_atomically(store: Store) -> None:
    original = {"jobs": [{"id": "cluster:a", "gpu_count": 2}]}
    store.save_snapshot("source", original)
    with pytest.raises(ValueError):
        store.save_snapshot("source", {"jobs": [{"id": "cluster:b"}, {"gpu_count": "oops"}]})
    assert store.snapshot("source") == original


def test_reopening_bad_snapshot_preserves_good_rows(tmp_path: Path) -> None:
    path = tmp_path / "reopen.sqlite"
    store = Store(path)
    good = {"id": "cluster:good", "source_id": "source", "state": "running", "gpu_count": 2}
    with store.db:
        store.db.execute(
            "INSERT INTO snapshots VALUES (?, ?)",
            (
                "source",
                json.dumps(
                    {
                        "instances": [
                            {"id": "cluster:bad", "gpu_count": "oops"},
                            {"name": "no id"},
                            good,
                        ]
                    }
                ),
            ),
        )
    store.db.close()
    reopened = Store(path)
    assert reopened.dashboard()["instances"] == [good]
    reopened.record_history()
    reopened.save_snapshot("source", {"instances": [good]})
    assert reopened.snapshot("source") == {"instances": [good]}
    reopened.db.close()


@pytest.mark.parametrize("bad", [{"vendor_metric": float("nan")}, {"state": "bad\ud800"}])
def test_old_non_json_safe_snapshot_is_hidden_and_source_is_not_fresh(
    store: Store,
    add_source: AddSource,
    bad: dict[str, Any],
) -> None:
    source = add_source("Cloud", driver="runpod", capabilities=["instances"])
    row = {"id": "cloud:bad", "source_id": source["id"], "state": "running", **bad}
    with store.db:
        store.db.execute(
            "INSERT INTO snapshots VALUES (?, ?)", (source["id"], json.dumps({"instances": [row]}))
        )
    dashboard = store.dashboard()
    assert dashboard["instances"] == []
    assert dashboard["sources"][0]["status"] == "error"
    json.dumps(dashboard, allow_nan=False, ensure_ascii=False).encode("utf-8")
    store.record_history()
    assert store.history(24)[-1]["allocated_gpus"] is None


def test_old_non_json_safe_account_does_not_break_dashboard(
    store: Store, add_source: AddSource
) -> None:
    add_source("Cloud", driver="runpod", account={"balance": float("nan")})
    dashboard = store.dashboard()
    assert dashboard["sources"][0]["account"] is None
    assert dashboard["sources"][0]["status"] == "error"
    json.dumps(dashboard, allow_nan=False, ensure_ascii=False).encode("utf-8")


UNREADABLE = [
    ("sources", "INSERT INTO sources VALUES ('bad', 'not json')"),
    ("sources", "INSERT INTO sources VALUES ('bad', '[1, 2]')"),
    ("sources", """INSERT INTO sources VALUES ('bad', '{"id": "bad"}')"""),
    ("snapshots", "INSERT INTO snapshots VALUES ('no-source', 'garbage')"),
    ("history", "INSERT INTO history VALUES ('2099-01-01T00:00:00+00:00', 'zz')"),
    ("history", """INSERT INTO history VALUES ('2099-01-01T00:00:00+00:00', '{"at": "x"}')"""),
    ("nodes", """INSERT INTO nodes VALUES ('n', '{"id": "n"}')"""),
    ("instances", """INSERT INTO instances VALUES ('i', '{"name": "i"}')"""),
    ("meta", "INSERT INTO meta VALUES ('setting:language', '{bad')"),
    ("meta", """INSERT INTO meta VALUES ('setting:language', '"xx"')"""),
    ("meta", "INSERT INTO meta VALUES ('plugin:chat:settings', 'nope')"),
    (
        "events",
        "INSERT INTO events (key, type, at, source_id, silent, data) "
        "VALUES ('k', 'job.failed', '2099-01-01T00:00:00+00:00', NULL, 0, 'nope')",
    ),
]


@pytest.mark.parametrize(("table", "statement"), UNREADABLE)
def test_an_unreadable_row_is_skipped_logged_and_counted(
    store: Store,
    add_source: AddSource,
    table: str,
    statement: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    good = add_source()
    store.save_node({"id": "gateway", "name": "Gateway", "ssh_alias": "gw", "command": "cd"})
    store.save_instance({"id": "manual:lab-box", "state": "unknown"})
    store.add_events([{"key": "ok", "type": "job.failed", "data": {"job": {"id": "c:1"}}}])
    with store.db:
        store.db.execute(statement)
    for _ in range(2):
        dashboard = store.dashboard()
        assert [source["id"] for source in dashboard["sources"]] == [good["id"]]
        assert [row["id"] for row in dashboard["instances"]] == ["manual:lab-box"]
        assert [node["id"] for node in store.nodes()] == ["gateway"]
        assert store.settings() == {"language": "en", "server_name": None}
        assert store.plugin_settings("chat") == {}
        assert [event["key"] for event in store.recent_events()] == ["ok"]
        store.history(24)
        store.record_history()
    assert store.unreadable_rows() == {table: 1}
    # Logged once, not on every read.
    assert len([r for r in caplog.records if "Skipped unreadable" in r.getMessage()]) == 1


def test_an_unreadable_event_is_passed_over_not_delivered(store: Store) -> None:
    store.add_events([{"key": "a", "type": "job.failed", "data": {"n": 1}}])
    with store.db:
        store.db.execute(
            "INSERT INTO events (key, type, at, source_id, silent, data) "
            "VALUES ('b', 'job.failed', ?, NULL, 0, 'nope')",
            (now(),),
        )
    store.add_events([{"key": "c", "type": "job.failed", "data": {"n": 3}}])
    events = store.events()
    assert [(event["key"], event["silent"]) for event in events] == [
        ("a", False),
        ("b", True),
        ("c", False),
    ]
    assert events[1]["data"] == {}


def test_bad_stored_times_are_unknown_not_a_failure(store: Store, add_source: AddSource) -> None:
    source = add_source(last_success="yesterday", next_due_at=5)
    assert source["last_success"] is None and source["next_due_at"] is None
    store.save_instance({"id": "manual:lab-box", "state": "running", "observed_at": "soon"})
    assert store.dashboard()["instances"][0]["observed_at"] is None
    store.record_history()


def test_fleet_freshness_uses_oldest_enabled_success(store: Store, add_source: AddSource) -> None:
    current = datetime.now(UTC)
    old = (current - timedelta(hours=3)).isoformat()
    recent = (current - timedelta(minutes=1)).isoformat()
    first = add_source(last_success=old)
    add_source("Cluster B", last_success=recent)
    add_source("Disabled", last_success=None, enabled=False)
    store.save_instance({"id": "manual:box", "observed_at": now()})
    data = store.dashboard()
    assert data["as_of"] == old
    assert data["behind"] == [first["id"]]
    assert data["updated_at"] > recent  # The legacy newest-observation contract is unchanged.
    missing = add_source("New", fresh=False)
    data = store.dashboard()
    assert data["as_of"] is None
    assert data["behind"] == sorted([first["id"], missing["id"]])


def test_fleet_freshness_failure_and_recovery(store: Store, add_source: AddSource) -> None:
    source = add_source(error={"code": "ssh_failed"}, status="syncing")
    data = store.dashboard()
    assert data["as_of"] == source["last_success"]
    assert data["behind"] == [source["id"]]
    store.save_source({**source, "error": None})
    assert store.dashboard()["behind"] == []
    store.save_source({**source, "enabled": False})
    data = store.dashboard()
    assert data["as_of"] is None and data["behind"] == []


def test_retained_nodes_do_not_override_collection_state(
    store: Store, add_source: AddSource
) -> None:
    from computedeck.drivers.base import Batch

    source = add_source(capabilities=["jobs", "nodes"], cluster_state="unavailable")
    node = {
        "id": "cluster-a:g1",
        "source_id": source["id"],
        "cluster_id": "cluster-a",
        "name": "g1",
        "state": "down",
        "gpu_count": 8,
    }
    store.save_snapshot(source["id"], {"nodes": [node], "jobs": []})
    assert store.dashboard()["sources"][0]["cluster_state"] == "unavailable"
    batch = Batch(jobs=[], capabilities=["jobs"])
    store.save_snapshot(source["id"], batch.snapshot())
    store.save_source(
        {**source, "capabilities": batch.capabilities, "cluster_state": batch.cluster_state}
    )
    data = store.dashboard()
    assert data["nodes"]
    assert data["sources"][0]["cluster_state"] == "unknown"
    assert data["summary"]["groups"]["cluster-a"]["nodes"]["nodes"] == 0
    # A driver-defined state is authoritative, even with unfamiliar node states.
    store.save_source({**source, "cluster_state": "available"})
    assert store.dashboard()["sources"][0]["cluster_state"] == "available"
    # Connection edits reset state despite retained inventory.
    store.save_source(
        {**source, "last_success": None, "capabilities": [], "cluster_state": "unknown"}
    )
    assert store.dashboard()["sources"][0]["cluster_state"] == "unknown"


def test_attention_state_upgrades_version_two_idempotently_and_survives_restart(
    tmp_path: Path,
) -> None:
    path = tmp_path / "old.sqlite"
    old = Store(path)
    old.db.execute("DROP TABLE attention_state")
    old.db.close()
    readonly = Store(path, readonly=True)
    assert readonly.attention_state() == {}
    readonly.db.close()
    data = {"fingerprint": "cause", "acknowledged_at": now(), "snooze_until": None}
    upgraded = Store(path)
    upgraded.set_attention_state("source_failed:cluster-a", data)
    upgraded.db.close()
    reopened = Store(path)
    assert reopened.db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() == (
        "2",
    )
    assert reopened.attention_state() == {"source_failed:cluster-a": data}
    readonly = Store(path, readonly=True)
    assert readonly.attention_state() == reopened.attention_state()
    readonly.db.close()
    reopened.delete_attention_state(["source_failed:cluster-a"])
    assert reopened.attention_state() == {}
    reopened.db.close()


def test_unreadable_attention_state_is_skipped(store: Store) -> None:
    with store.db:
        store.db.execute("INSERT INTO attention_state VALUES ('broken', 'not JSON')")
    store.set_attention_state(
        "bad-time", {"fingerprint": "x", "acknowledged_at": now(), "snooze_until": "no time"}
    )
    assert store.attention_state() == {}
    assert store.unreadable_rows()["attention_state"] == 2


def test_probe_preserves_per_gpu_rows_and_sample_time(store: Store) -> None:
    from computedeck.hardware import parse_probe

    sampled = "2026-01-01T00:00:00+00:00"
    endpoint = {"host": "gpu-box", "port": None, "username": "alice"}
    gpu = {"index": 0, "in_use": False, "processes": []}
    store.save_snapshot(
        "gpu-box",
        {
            "instances": [
                {
                    "id": "gpu-box:a",
                    "source_id": "gpu-box",
                    **endpoint,
                    "gpus": [gpu],
                    "gpus_observed_at": sampled,
                    "observed_at": sampled,
                }
            ]
        },
    )
    readings = parse_probe('{"cpu_utilization": 20}')
    assert "gpus" not in readings and "gpus_observed_at" not in readings
    store.update_cloud_metrics("gpu-box:a", endpoint, readings)
    row = next(row for row in store.dashboard()["instances"] if row["id"] == "gpu-box:a")
    assert row["gpus"] == [gpu]
    assert row["gpus_observed_at"] == sampled
    assert row["observed_at"] != sampled
