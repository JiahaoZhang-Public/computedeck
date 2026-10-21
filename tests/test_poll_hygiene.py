"""Content tokens follow the response, including changes without a database write."""

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import demo, store, summary
from computedeck.collector import Collector
from computedeck.records import SourceInput, source_record


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[datetime]:
    current = [datetime(2026, 10, 13, 12, tzinfo=UTC)]

    class Clock(datetime):
        @classmethod
        def __get_pydantic_core_schema__(cls, source: Any, handler: Any) -> Any:
            # API query annotations still describe ordinary datetimes while time is frozen.
            return handler(datetime)

        @classmethod
        def now(cls, tz: Any = None) -> datetime:
            return current[0].astimezone(tz) if tz else current[0].replace(tzinfo=None)

    for module in (api, demo, store, summary):
        monkeypatch.setattr(module, "datetime", Clock)
    return current


@pytest.fixture
def client(tmp_path: Path, clock: list[datetime]) -> Iterator[TestClient]:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        yield client


def test_dashboard_token_preserves_the_full_contract_and_skips_unchanged_history(
    client: TestClient, tmp_path: Path
) -> None:
    db = store.Store(tmp_path / "computedeck.sqlite")
    try:
        db.record_history()
        response = client.get("/api/dashboard")
        data = response.json()
        assert data["history"]
        assert len(data["token"]) == 16
        unchanged = client.get("/api/dashboard", params={"since": data["token"]})
        assert unchanged.status_code == 200
        assert unchanged.json() == {"unchanged": True, "token": data["token"]}
        assert unchanged.headers["Cache-Control"] == "no-store"
        assert len(unchanged.content) < len(response.content)
        assert client.get("/api/dashboard").json() == data
        # A write by another connection is visible, with no revision bookkeeping.
        db.save_source(source_record(SourceInput(name="Cluster A", driver="slurm", enabled=False)))
        changed = client.get("/api/dashboard", params={"since": data["token"]}).json()
        assert changed["token"] != data["token"]
        assert changed["sources"]
        assert changed["history"] == data["history"]
    finally:
        db.db.close()


@pytest.mark.parametrize("point_count", [700, 900, 1440])
def test_thinned_history_token_is_stable_between_polls(
    client: TestClient, tmp_path: Path, clock: list[datetime], point_count: int
) -> None:
    db = store.Store(tmp_path / "computedeck.sqlite")
    try:
        # Leave room at both ends so no point enters or leaves during these polls.
        start = clock[0] - timedelta(hours=23, minutes=55)
        with db.db:
            for index in range(point_count):
                point = {
                    "at": (start + timedelta(seconds=index * 86000 / point_count)).isoformat(),
                    "allocated_gpus": index,
                }
                db.db.execute("INSERT INTO history VALUES (?, ?)", (point["at"], json.dumps(point)))
        before = client.get("/api/dashboard").json()
        assert 0 < len(before["history"]) <= 600 < point_count
        for _ in range(6):
            clock[0] += timedelta(seconds=10)
            response = client.get("/api/dashboard", params={"since": before["token"]})
            assert response.status_code == 200
            assert response.json() == {"unchanged": True, "token": before["token"]}
    finally:
        db.db.close()


def test_token_tracks_time_only_staleness_summary_and_attention(
    client: TestClient, tmp_path: Path, clock: list[datetime]
) -> None:
    db = store.Store(tmp_path / "computedeck.sqlite")
    try:
        source = source_record(SourceInput(name="Cluster A", driver="slurm", ssh_alias="cluster-a"))
        source.update(last_success=clock[0].isoformat(), capabilities=["jobs"], status="ready")
        db.save_source(source)
        before = client.get("/api/dashboard").json()
        assert before["behind"] == []
        assert before["summary"]["jobs"]["total"] == 0
        clock[0] += timedelta(seconds=source["interval_minutes"] * 66 + 121)
        after = client.get("/api/dashboard", params={"since": before["token"]}).json()
        assert after["token"] != before["token"]
        assert after["sources"][0]["stale"]
        assert after["behind"] == [source["id"]]
        assert after["summary"]["jobs"]["total"] is None
        assert after["attention"][0]["severity"] == "warn"
        clock[0] += timedelta(minutes=20)
        escalated = client.get("/api/dashboard", params={"since": after["token"]}).json()
        assert escalated["token"] != after["token"]
        assert escalated["attention"][0]["severity"] == "error"
    finally:
        db.db.close()


def test_pending_collection_changes_token_before_any_store_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pending: set[str] = set()
    original = Collector.__init__

    def capture(self: Collector, *args: Any, **kwargs: Any) -> None:
        original(self, *args, **kwargs)
        self.pending = pending

    monkeypatch.setattr(Collector, "__init__", capture)
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        before = client.get("/api/dashboard").json()
        pending.add("cluster-a")
        after = client.get("/api/dashboard", params={"since": before["token"]}).json()
        assert after["token"] != before["token"]
        assert after["refreshing"] is True
        assert after["collecting"] == ["cluster-a"]
        pending.add("cluster-b")
        more = client.get("/api/dashboard", params={"since": after["token"]}).json()
        assert more["refreshing"] is True
        assert more["collecting"] == ["cluster-a", "cluster-b"]
        pending.clear()
        assert client.get("/api/dashboard", params={"since": before["token"]}).json() == {
            "unchanged": True,
            "token": before["token"],
        }


def test_token_tracks_sliding_history_without_writes(
    client: TestClient, tmp_path: Path, clock: list[datetime]
) -> None:
    db = store.Store(tmp_path / "computedeck.sqlite")
    try:
        clock[0] -= timedelta(hours=24)
        db.record_history()
        clock[0] += timedelta(hours=24)
        before = client.get("/api/dashboard").json()
        assert len(before["history"]) == 1
        clock[0] += timedelta(seconds=1)
        after = client.get("/api/dashboard", params={"since": before["token"]}).json()
        assert after["history"] == []
        assert after["token"] != before["token"]
    finally:
        db.db.close()


def test_example_mode_has_its_own_token_and_stable_minute_samples(
    client: TestClient, clock: list[datetime]
) -> None:
    live = client.get("/api/dashboard").json()
    example = client.get("/api/dashboard", params={"demo": True, "since": live["token"]}).json()
    assert example["mode"] == "demo"
    assert example["token"] != live["token"]
    clock[0] += timedelta(seconds=10)
    assert client.get(
        "/api/dashboard", params={"demo": True, "since": example["token"]}
    ).json() == {"unchanged": True, "token": example["token"]}
    assert client.get("/api/dashboard", params={"since": example["token"]}).json() == live
    clock[0] += timedelta(minutes=1)
    assert client.get("/api/dashboard?demo=true").json()["token"] != example["token"]


def test_health_never_builds_dashboard_or_renders_ssh_config(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def forbidden(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("health must not build the dashboard or render its SSH endpoints")

    monkeypatch.setattr(store.Store, "dashboard", forbidden)
    monkeypatch.setattr(api, "render_config", forbidden)
    assert client.get("/api/health").status_code == 200


def test_event_since_validates_datetimes_with_frozen_clock(
    client: TestClient, clock: list[datetime]
) -> None:
    assert client.get("/api/events", params={"since": clock[0].isoformat()}).json() == []
    assert client.get("/api/events?since=not-a-date").status_code == 422


def test_attention_snooze_expiry_changes_content_token_without_writes(
    client: TestClient, tmp_path: Path, clock: list[datetime]
) -> None:
    db = store.Store(tmp_path / "computedeck.sqlite")
    try:
        source = source_record(SourceInput(name="Cluster A", driver="slurm"))
        source.update(error={"code": "ssh_timeout"}, failures=2, status="error")
        db.save_source(source)
        item = client.get("/api/dashboard").json()["attention"][0]
        db.set_attention_state(
            item["key"],
            {
                "fingerprint": item["fingerprint"],
                "acknowledged_at": clock[0].isoformat(),
                "snooze_until": (clock[0] + timedelta(hours=1)).isoformat(),
            },
        )
        before = client.get("/api/dashboard").json()
        assert before["attention_count"] == 0
        clock[0] += timedelta(hours=1)
        after = client.get("/api/dashboard", params={"since": before["token"]}).json()
        assert after["token"] != before["token"]
        assert after["attention_count"] == 1
        assert after["attention"][0]["muted"] is None
        assert item["key"] in db.attention_state()
    finally:
        db.db.close()
