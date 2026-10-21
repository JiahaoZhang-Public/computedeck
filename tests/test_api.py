"""Loopback HTTP API: local-only writes, sources, manual instances, probes and settings."""

import asyncio
import json
import sqlite3
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import collector as collector_module
from computedeck.drivers import ssh, ssh_host
from computedeck.drivers.base import Batch, SourceError
from computedeck.drivers.slurm import SlurmDriver
from computedeck.store import DatabaseVersionError, Store

HEADERS = {
    "Origin": "http://127.0.0.1:8710",
    "X-ComputeDeck": "1",
    "Content-Type": "application/json",
}
CLUSTER = {"name": "Cluster A", "driver": "slurm", "username": "alice", "ssh_alias": "cluster-a"}
INSTANCE = {
    "platform": "Lab box",
    "name": "Training box",
    "external_id": "box1",
    "host": "192.0.2.1",
    "port": 2222,
    "username": "root",
    "identity_file": "~/.ssh/id_ed25519",
    "gpu_count": 1,
}


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    return tmp_path / "data"


@pytest.fixture
def client(data_dir: Path) -> Iterator[TestClient]:
    with TestClient(api.create_app(data_dir, polling=False, plugins=[])) as value:
        yield value


def post(client: TestClient, path: str, body: Any = None) -> Any:
    return client.post(path, json={} if body is None else body, headers=HEADERS)


def wait_until_idle(client: TestClient) -> dict[str, Any]:
    for _ in range(200):
        data: dict[str, Any] = client.get("/api/dashboard").json()
        if not data["refreshing"]:
            return data
        time.sleep(0.02)
    pytest.fail("Refresh did not finish")


def test_live_starts_empty_and_demo_is_isolated(client: TestClient) -> None:
    live = client.get("/api/dashboard").json()
    assert live["mode"] == "live"
    assert live["sources"] == []
    assert live["jobs"] == []
    assert live["instances"] == []
    assert live["history"] == []
    assert live["refreshing"] is False
    demo = client.get("/api/dashboard?demo=true").json()
    assert demo["mode"] == "demo"
    assert demo["jobs"] and demo["sources"] and demo["recent_failures"]
    assert all("known_allocated_gpus" in point for point in demo["history"])
    after = client.get("/api/dashboard").json()
    assert after["sources"] == [] and after["jobs"] == []


def test_cross_origin_writes_and_dns_rebinding_are_rejected(client: TestClient) -> None:
    denied = {"detail": {"code": "local_app_required"}}
    response = client.post("/api/backup", json={})
    assert response.status_code == 403
    assert response.json() == denied
    for headers in (
        {**HEADERS, "Origin": "https://evil.example"},
        {**HEADERS, "Origin": "http://127.0.0.1:9999"},
        {key: value for key, value in HEADERS.items() if key != "X-ComputeDeck"},
        {key: value for key, value in HEADERS.items() if key != "Origin"},
        {**HEADERS, "Content-Type": "text/plain"},
        {**HEADERS, "Content-Type": "application/x-www-form-urlencoded"},
    ):
        assert client.post("/api/backup", content="{}", headers=headers).status_code == 403
    assert client.delete("/api/sources/cluster-a-alice").status_code == 403
    assert client.put("/api/settings", json={"language": "en"}).status_code == 403
    assert client.get("/api/dashboard", headers={"Host": "evil.example"}).status_code == 400
    assert (
        client.post(
            "/api/backup", json={}, headers={**HEADERS, "Origin": "http://localhost:5173"}
        ).status_code
        == 200
    )


def test_loopback_tunnel_origin_matches_forwarded_host(client: TestClient) -> None:
    headers = {**HEADERS, "Host": "127.0.0.1:8711", "Origin": "http://127.0.0.1:8711"}
    assert client.post("/api/backup", json={}, headers=headers).status_code == 200
    mismatched = {**headers, "Origin": "http://localhost:9999"}
    assert client.post("/api/backup", json={}, headers=mismatched).status_code == 403


def test_security_headers(client: TestClient) -> None:
    response = client.get("/api/dashboard")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Cache-Control"] == "no-store"


def test_web_app_shell_is_revalidated_and_hashed_assets_are_cached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>t</title>")
    (web / "assets" / "index-abc123.js").write_text("console.log(1)")
    monkeypatch.setenv("COMPUTEDECK_WEB_DIR", str(web))
    with TestClient(api.create_app(tmp_path / "data", polling=False, plugins=[])) as client:
        assert client.get("/").headers["Cache-Control"] == "no-cache"
        asset = client.get("/assets/index-abc123.js")
        assert asset.status_code == 200
        assert "immutable" in asset.headers["Cache-Control"]


def test_drivers_are_listed_with_their_kind(client: TestClient) -> None:
    listed = {row["name"]: row for row in client.get("/api/drivers").json()}
    assert {name: row["kind"] for name, row in listed.items()} == {
        "aws-ec2": "cloud",
        "gpuhub": "cloud",
        "kubernetes": "cluster",
        "lambda": "cloud",
        "lsf": "cluster",
        "pbs": "cluster",
        "runpod": "cloud",
        "slurm": "cluster",
        "ssh": "cloud",
        "vastai": "cloud",
    }
    slurm = listed["slurm"]
    assert slurm["label"] == {"en": "Slurm cluster", "zh-CN": "Slurm 集群"}
    assert [field["key"] for field in slurm["fields"]] == ["username", "ssh_alias"]
    assert slurm["fields"][0]["identity"] is True
    assert [check["command"] for check in slurm["checks"]] == [
        "squeue",
        "scontrol",
        "assoc_mgr",
        "association QOS",
        "sacct",
    ]
    assert listed["runpod"]["fields"][0]["default"] == "env:RUNPOD_API_KEY"


def test_source_options_are_validated_and_reset_collection(
    client: TestClient, data_dir: Path
) -> None:
    bad = {**CLUSTER, "options": {"Bad-Key": "x"}}
    assert post(client, "/api/sources", bad).status_code == 422
    control = {**CLUSTER, "options": {"partition": "gpu\n"}}
    assert post(client, "/api/sources", control).status_code == 422
    body = {**CLUSTER, "options": {"partition": " gpu ", "empty": " "}}
    source = post(client, "/api/sources", body).json()
    # Values are trimmed and empty values are dropped.
    assert source["options"] == {"partition": "gpu"}
    store = Store(data_dir / "computedeck.sqlite")
    stored = store.source(source["id"])
    assert stored
    store.save_source({**stored, "last_success": "2026-01-01T00:00:00+00:00"})
    changed = client.put(
        f"/api/sources/{source['id']}", json={"options": {"partition": "a100"}}, headers=HEADERS
    ).json()
    assert changed["options"] == {"partition": "a100"}
    # Different options are a different connection; old results no longer apply.
    assert changed["last_success"] is None
    # A source saved before options existed keeps its results when saved with none.
    legacy = {key: value for key, value in store.source(source["id"]).items() if key != "options"}  # type: ignore[union-attr]
    store.save_source({**legacy, "last_success": "2026-01-01T00:00:00+00:00"})
    kept = client.put(f"/api/sources/{source['id']}", json={"options": {}}, headers=HEADERS)
    assert kept.json()["last_success"] == "2026-01-01T00:00:00+00:00"


def test_source_lifecycle(client: TestClient) -> None:
    response = post(client, "/api/sources", CLUSTER)
    assert response.status_code == 201, response.text
    source = response.json()
    assert source["id"] == "cluster-a-alice"
    assert source["cluster_id"] == "cluster-a"
    assert source["name"] == "Cluster A"
    assert source["kind"] == "cluster"
    assert source["status"] == "ready"
    assert source["enabled"] is True
    assert source["next_due_at"]
    assert post(client, "/api/sources", CLUSTER).status_code == 409
    bob = post(client, "/api/sources", {**CLUSTER, "username": "bob"}).json()
    assert bob["id"] == "cluster-a-bob" and bob["cluster_id"] == "cluster-a"
    sources = client.get("/api/dashboard").json()["sources"]
    assert [row["id"] for row in sources] == ["cluster-a-alice", "cluster-a-bob"]

    updated = client.put(
        "/api/sources/cluster-a-alice", json={"interval_minutes": 30}, headers=HEADERS
    )
    assert updated.status_code == 200
    assert updated.json()["interval_minutes"] == 30
    assert (
        client.put(
            "/api/sources/cluster-a-nobody", json={"enabled": False}, headers=HEADERS
        ).status_code
        == 404
    )
    assert (
        client.put(
            "/api/sources/cluster-a-alice", json={"driver": "runpod"}, headers=HEADERS
        ).status_code
        == 422
    )

    deleted = client.delete("/api/sources/cluster-a-alice", headers=HEADERS)
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    missing = client.delete("/api/sources/cluster-a-alice", headers=HEADERS)
    assert missing.status_code == 404
    assert missing.json() == {"detail": {"code": "source_not_found"}}
    assert [row["id"] for row in client.get("/api/dashboard").json()["sources"]] == [
        "cluster-a-bob"
    ]


@pytest.mark.parametrize(
    ("username", "alias", "source_id"),
    [
        ("alice", "cluster-a", "cluster-a-alice"),
        ("alice@example.org", "login.cluster-a", "cluster-a-alice-example-org"),
        ("alice.smith", "cluster_a", "cluster-a-alice-smith"),
    ],
)
def test_cluster_source_uses_ssh_configuration(
    client: TestClient, username: str, alias: str, source_id: str
) -> None:
    body = {**CLUSTER, "username": username, "ssh_alias": alias}
    response = post(client, "/api/sources", body)
    assert response.status_code == 201, response.text
    source = response.json()
    assert source["id"] == source_id
    assert source["ssh_alias"] == alias
    assert source["username"] == username
    assert source["driver"] == "slurm"


@pytest.mark.parametrize(
    "changes",
    [
        {"username": "alice\nProxyCommand true"},
        {"username": "-oProxyCommand=true"},
        {"username": "alice;id"},
        {"ssh_alias": "cluster-a;id"},
        {"ssh_alias": "cluster-a\nHost *"},
        {"ssh_alias": "-oProxyCommand"},
        {"ssh_alias": ""},
        {"username": ""},
        {"interval_minutes": 1},
        {"provider": "slurm"},
        {"name": "!!!"},
        {"cluster_id": "Cluster A"},
        {"driver": "no-such-scheduler"},
    ],
)
def test_invalid_sources_are_rejected(client: TestClient, changes: dict[str, Any]) -> None:
    response = post(client, "/api/sources", {**CLUSTER, **changes})
    assert response.status_code == 422, response.text
    assert client.get("/api/dashboard").json()["sources"] == []


def test_rejections_use_message_codes(client: TestClient) -> None:
    missing = post(client, "/api/sources", {**CLUSTER, "ssh_alias": ""})
    assert missing.json() == {"detail": {"code": "cluster_connection_required"}}
    driver = post(client, "/api/sources", {**CLUSTER, "driver": "no-such-scheduler"})
    assert driver.json() == {"detail": {"code": "unknown_driver", "driver": "no-such-scheduler"}}
    name = post(client, "/api/sources", {**CLUSTER, "name": "!!!"})
    assert name.json() == {"detail": {"code": "name_required"}}


def test_connection_is_required_only_when_enabled(client: TestClient) -> None:
    body = {"name": "Cluster A", "driver": "slurm", "enabled": False}
    response = post(client, "/api/sources", body)
    assert response.status_code == 201, response.text
    source = response.json()
    assert source["status"] == "unconfigured"
    assert source["id"] == "cluster-a-slurm"
    assert "next_due_at" not in source
    enable = client.put(f"/api/sources/{source['id']}", json={"enabled": True}, headers=HEADERS)
    assert enable.status_code == 422
    assert enable.json() == {"detail": {"code": "cluster_connection_required"}}
    enable = client.put(
        f"/api/sources/{source['id']}",
        json={"enabled": True, "username": "alice", "ssh_alias": "cluster-a"},
        headers=HEADERS,
    )
    assert enable.status_code == 200
    assert enable.json()["status"] == "ready"


def test_cloud_source_takes_only_a_credential_reference(client: TestClient, data_dir: Path) -> None:
    body = {"name": "RunPod", "driver": "runpod", "credential": "env:RUNPOD_API_KEY"}
    response = post(client, "/api/sources", body)
    assert response.status_code == 201, response.text
    source = response.json()
    assert source["id"] == "runpod-runpod"
    assert source["kind"] == "cloud"
    assert source["credential"] == "env:RUNPOD_API_KEY"
    no_credential = post(client, "/api/sources", {"name": "RunPod B", "driver": "runpod"})
    assert no_credential.status_code == 422
    assert no_credential.json() == {"detail": {"code": "credential_required"}}
    # A pasted API key is not a reference and is never stored.
    pasted = "rp_PASTEDSECRET0123456789"
    response = post(
        client, "/api/sources", {"name": "RunPod B", "driver": "runpod", "credential": pasted}
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_credential_reference"
    disabled = {"name": "RunPod C", "driver": "runpod", "credential": pasted, "enabled": False}
    assert post(client, "/api/sources", disabled).status_code == 422
    update = client.put("/api/sources/runpod-runpod", json={"credential": pasted}, headers=HEADERS)
    assert update.status_code == 422
    assert client.get("/api/dashboard").json()["sources"][0]["credential"] == ("env:RUNPOD_API_KEY")
    with sqlite3.connect(data_dir / "computedeck.sqlite") as db:
        rows = [row[0] for row in db.execute("SELECT data FROM sources")]
    db.close()
    assert len(rows) == 1 and pasted not in rows[0]


def test_cluster_cannot_mix_drivers(client: TestClient) -> None:
    assert post(client, "/api/sources", CLUSTER).status_code == 201
    response = post(
        client,
        "/api/sources",
        {
            "name": "Cluster A cloud",
            "driver": "runpod",
            "cluster_id": "cluster-a",
            "credential": "env:RUNPOD_API_KEY",
        },
    )
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "cluster_driver_mismatch"}}
    shared = post(
        client, "/api/sources", {**CLUSTER, "name": "Shared login", "cluster_id": "cluster-a"}
    )
    assert shared.status_code == 409  # Same identity on the same cluster already exists.
    other = post(client, "/api/sources", {**CLUSTER, "username": "bob", "cluster_id": "cluster-a"})
    assert other.status_code == 201


def test_refresh_coalesces_and_failure_preserves_previous_snapshot(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []
    fail = False

    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        calls.append(source["id"])
        await asyncio.sleep(0.2)
        if fail:
            raise RuntimeError("network unavailable")
        job = {
            "id": "cluster-a:1",
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
            "state": "RUNNING",
            "gpu_count": 4,
        }
        return Batch(jobs=[job], capabilities=["jobs"])

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    assert post(client, "/api/refresh").json() == {"status": "idle"}
    assert post(client, "/api/sources", CLUSTER).status_code == 201

    def refresh_and_wait() -> dict[str, Any]:
        statuses = [post(client, "/api/refresh").json()["status"] for _ in range(2)]
        assert statuses == ["queued", "running"]
        return wait_until_idle(client)

    data = refresh_and_wait()
    assert calls == ["cluster-a-alice"]
    assert len(data["jobs"]) == 1
    success = data["sources"][0]["last_success"]
    assert success
    assert data["history"][-1]["allocated_gpus"] == 4
    fail = True
    data = refresh_and_wait()
    assert len(calls) == 2
    assert len(data["jobs"]) == 1
    source = data["sources"][0]
    assert source["last_success"] == success
    assert source["status"] == "error"
    assert source["error"] == {
        "code": "collection_failed",
        "detail": "RuntimeError: network unavailable",
    }
    one = post(client, "/api/refresh", {"source_id": "cluster-a-alice"})
    assert one.json() == {"status": "queued"}
    wait_until_idle(client)
    unknown = post(client, "/api/refresh", {"source_id": "cluster-z-nobody"})
    assert unknown.status_code == 404


def test_deleting_a_source_removes_its_data(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        job = {"id": "cluster-a:1", "source_id": source["id"], "state": "RUNNING"}
        return Batch(jobs=[job], capabilities=["jobs"])

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    post(client, "/api/sources", CLUSTER)
    post(client, "/api/refresh")
    assert len(wait_until_idle(client)["jobs"]) == 1
    assert client.delete("/api/sources/cluster-a-alice", headers=HEADERS).status_code == 200
    data = client.get("/api/dashboard").json()
    assert data["sources"] == [] and data["jobs"] == []


def test_manual_endpoint_persists_and_updates_stable_alias(
    client: TestClient, data_dir: Path
) -> None:
    response = post(client, "/api/instances", INSTANCE)
    assert response.status_code == 201, response.text
    instance = response.json()
    assert instance["id"] == "manual:lab-box-box1"
    assert instance["ssh_alias"] == "cd-lab-box-box1"
    assert instance["source_id"] == "manual"
    assert instance["state"] == "unknown"
    assert instance["ssh_status"] == "unverified"
    assert instance["gpu_utilization"] is None
    assert instance["existing_alias"] is False
    duplicate = post(client, "/api/instances", INSTANCE)
    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": {"code": "instance_exists"}}
    config = client.get("/api/ssh/config").json()
    assert config["installed"] is False
    assert "Host cd-lab-box-box1" in config["config"]
    assert "HostName 192.0.2.1" in config["config"]
    response = client.put(
        f"/api/instances/{instance['id']}", json={**INSTANCE, "port": 3333}, headers=HEADERS
    )
    assert response.status_code == 200
    assert response.json()["ssh_alias"] == instance["ssh_alias"]
    assert "Port 3333" in client.get("/api/ssh/config").json()["config"]
    assert "Port 3333" in (data_dir / "computedeck.conf").read_text()
    moved = client.put(
        f"/api/instances/{instance['id']}",
        json={**INSTANCE, "external_id": "box2"},
        headers=HEADERS,
    )
    assert moved.status_code == 400
    assert moved.json() == {"detail": {"code": "instance_identity_fixed"}}
    absent = client.put("/api/instances/manual:lab-box-none", json=INSTANCE, headers=HEADERS)
    assert absent.status_code == 404
    assert post(client, "/api/ssh/install", {"confirm": False}).status_code == 400


def test_delete_instance_removes_it_from_ssh_config(client: TestClient, data_dir: Path) -> None:
    instance = post(client, "/api/instances", INSTANCE).json()
    assert client.delete(f"/api/instances/{instance['id']}", headers=HEADERS).json() == {
        "deleted": True
    }
    assert client.get("/api/dashboard").json()["instances"] == []
    assert "192.0.2.1" not in (data_dir / "computedeck.conf").read_text()
    assert client.delete(f"/api/instances/{instance['id']}", headers=HEADERS).status_code == 404


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("host", "example.com\nProxyCommand touch /tmp/oops"),
        ("host", "-oProxyCommand=evil"),
        ("host", "example.com extra"),
        ("username", "root\nHost *"),
        ("username", "-oProxyCommand=x"),
        ("external_id", "a\nHost *"),
        ("external_id", "-a"),
        ("port", 0),
        ("port", 70000),
        ("identity_file", "/keys/id\nProxyCommand x"),
        ("identity_file", "relative/key"),
        ("identity_file", "/keys/${HOME}"),
        ("platform", "!!!"),
        ("currency", "usd"),
        ("hourly_cost", -1),
    ],
)
def test_bad_ssh_fields_are_rejected(client: TestClient, field: str, value: Any) -> None:
    response = post(client, "/api/instances", {**INSTANCE, field: value})
    assert response.status_code == 422, response.text
    assert client.get("/api/dashboard").json()["instances"] == []


def test_existing_alias_instance_probes_alias_without_cluster_source(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, list[str] | None]] = []

    async def run(destination: str, command: str, options: list[str] | None = None) -> str:
        calls.append((destination, options))
        gpus = "".join(f"{index}, GPU-{index}, NVIDIA L4, 24, 0, 1\n" for index in range(8))
        output = {
            "cpu_utilization": 10,
            "gpu_tool": "nvidia-smi",
            "gpu": gpus,
            "apps": "GPU-3, 4242, 90\n",
        }
        return ssh_host.MARKER + json.dumps(output)

    monkeypatch.setattr(ssh, "run", run)
    body = {
        "platform": "Lab box",
        "name": "gpu-box",
        "external_id": "node1",
        "host": "gpu-box",
        "existing_alias": True,
        "monitoring": True,
    }
    response = post(client, "/api/instances", body)
    assert response.status_code == 201, response.text
    instance = response.json()
    assert instance["ssh_alias"] == "gpu-box"
    result = post(client, f"/api/instances/{instance['id']}/probe")
    assert result.status_code == 200, result.text
    assert calls == [("gpu-box", [])]
    assert result.json()["gpu_count"] == 8
    assert result.json()["gpu_allocated"] == 1
    assert result.json()["gpu_utilization"] == 24
    # It answered just now; there is no provider lifecycle behind a machine added by hand.
    assert result.json()["state"] == "running"
    dashboard = client.get("/api/dashboard").json()
    assert dashboard["sources"] == []
    assert dashboard["instances"][0]["state"] == "running"
    config = client.get("/api/ssh/config").json()["config"]
    assert "Host gpu-box" not in config
    assert "HostName gpu-box" not in config


def test_editing_endpoint_during_probe_does_not_restore_old_connection(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = Event()
    release = Event()

    async def slow_probe(instance: dict[str, Any]) -> dict[str, Any]:
        started.set()
        await asyncio.to_thread(release.wait, 2)
        return {"ssh_status": "reachable", "gpu_utilization": 80}

    monkeypatch.setattr(collector_module, "probe_instance", slow_probe)
    body = {"platform": "Lab box", "name": "box", "external_id": "box1", "host": "192.0.2.1"}
    instance = post(client, "/api/instances", body).json()
    with ThreadPoolExecutor() as executor:
        future = executor.submit(post, client, f"/api/instances/{instance['id']}/probe")
        assert started.wait(2)
        busy = post(client, f"/api/instances/{instance['id']}/probe")
        assert busy.status_code == 409
        assert busy.json() == {"detail": {"code": "probe_in_progress"}}
        update = client.put(
            f"/api/instances/{instance['id']}", json={**body, "host": "192.0.2.2"}, headers=HEADERS
        )
        assert update.status_code == 200
        release.set()
        result = future.result(timeout=3)
        assert result.status_code == 409
        assert result.json() == {"detail": {"code": "endpoint_changed"}}
    [saved] = client.get("/api/dashboard").json()["instances"]
    assert saved["host"] == "192.0.2.2"
    assert saved["ssh_status"] == "unverified"
    assert saved["gpu_utilization"] is None


@pytest.mark.parametrize(
    ("failure", "response", "recorded"),
    [
        (
            SourceError("ssh_failed", "Connection refused"),
            {"code": "ssh_failed", "detail": "Connection refused"},
            {"code": "ssh_failed", "detail": "Connection refused"},
        ),
        (
            ssh.SSHError("Host key verification failed."),
            {"code": "probe_failed", "detail": "Host key verification failed."},
            {"code": "collection_failed", "detail": "SSHError: Host key verification failed."},
        ),
    ],
)
def test_probe_failure_is_reported_and_recorded(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    failure: Exception,
    response: dict[str, str],
    recorded: dict[str, str],
) -> None:
    async def probe(instance: dict[str, Any]) -> dict[str, Any]:
        raise failure

    monkeypatch.setattr(collector_module, "probe_instance", probe)
    instance = post(client, "/api/instances", INSTANCE).json()
    result = post(client, f"/api/instances/{instance['id']}/probe")
    assert result.status_code == 502
    assert result.json() == {"detail": response}
    [saved] = client.get("/api/dashboard").json()["instances"]
    assert saved["ssh_status"] == "error"
    assert saved["ssh_error"] == recorded
    assert saved["last_probe_attempt"]
    absent = post(client, "/api/instances/manual:lab-box-none/probe")
    assert absent.status_code == 404
    assert absent.json() == {"detail": {"code": "instance_not_found"}}


def test_settings_api(client: TestClient) -> None:
    assert client.get("/api/settings").json() == {"language": "en", "server_name": None}
    response = client.put(
        "/api/settings", json={"language": "zh-CN", "server_name": "Lab server"}, headers=HEADERS
    )
    assert response.status_code == 200
    assert response.json() == {"language": "zh-CN", "server_name": "Lab server"}
    partial = client.put("/api/settings", json={"server_name": "GPU box"}, headers=HEADERS)
    assert partial.json() == {"language": "zh-CN", "server_name": "GPU box"}
    for invalid in ({"language": "xx"}, {"theme": "dark"}, {"server_name": "x" * 81}):
        assert client.put("/api/settings", json=invalid, headers=HEADERS).status_code == 422
    assert client.get("/api/settings").json() == {"language": "zh-CN", "server_name": "GPU box"}
    assert client.get("/api/health").json()["server_name"] == "GPU box"


def test_health(client: TestClient, data_dir: Path) -> None:
    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    assert health["application"] == "ComputeDeck"
    assert health["polling"] is False
    assert health["plugins"] == {}
    assert health["source_count"] == 0
    assert health["ssh_installed"] is False
    assert health["database_path"] == str(data_dir / "computedeck.sqlite")
    post(client, "/api/sources", CLUSTER)
    assert client.get("/api/health").json()["source_count"] == 1


def test_ssh_install_requires_confirmation_and_prepends_include(
    client: TestClient, isolated: Path, data_dir: Path
) -> None:
    post(client, "/api/instances", INSTANCE)
    user_config = isolated / ".ssh" / "config"
    user_config.parent.mkdir()
    user_config.write_text("Host example\n  HostName example.org\n")
    assert post(client, "/api/ssh/install", {"confirm": False}).status_code == 400
    assert user_config.read_text() == "Host example\n  HostName example.org\n"
    response = post(client, "/api/ssh/install", {"confirm": True})
    assert response.status_code == 200, response.text
    assert response.json()["installed"] is True
    content = user_config.read_text()
    assert content.startswith("# ComputeDeck managed endpoints\nInclude ")
    assert str((data_dir / "computedeck.conf").resolve()) in content
    assert content.endswith("Host example\n  HostName example.org\n")
    assert client.get("/api/health").json()["ssh_installed"] is True


def test_backup_endpoint(client: TestClient, data_dir: Path) -> None:
    response = post(client, "/api/backup")
    assert response.status_code == 200
    path = Path(response.json()["path"])
    assert path.parent == data_dir / "backups"
    assert path.suffix == ".sqlite"
    assert path.is_file()


def test_backups_beyond_the_configured_number_are_removed(
    client: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COMPUTEDECK_BACKUPS", "2")
    paths = [post(client, "/api/backup").json()["path"] for _ in range(4)]
    assert sorted((data_dir / "backups").iterdir()) == [Path(path) for path in paths[-2:]]
    monkeypatch.setenv("COMPUTEDECK_BACKUPS", "many")
    for _ in range(11):
        post(client, "/api/backup")
    assert len(list((data_dir / "backups").iterdir())) == 10


def test_one_service_per_data_directory(client: TestClient, data_dir: Path) -> None:
    with (
        pytest.raises(RuntimeError, match="Another ComputeDeck service"),
        TestClient(api.create_app(data_dir, polling=False, plugins=[])),
    ):
        pass


def test_legacy_database_is_refused_at_startup(data_dir: Path) -> None:
    data_dir.mkdir()
    with sqlite3.connect(data_dir / "computedeck.sqlite") as db:
        db.execute("CREATE TABLE sources (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute(
            "INSERT INTO sources VALUES (?, ?)",
            ("cluster-a-alice", json.dumps({"id": "cluster-a-alice", "provider": "cluster-a"})),
        )
    db.close()
    with (
        pytest.raises(DatabaseVersionError),
        TestClient(api.create_app(data_dir, polling=False, plugins=[])),
    ):
        pass


def test_a_bad_stored_endpoint_does_not_stop_the_service(tmp_path: Path) -> None:
    store = Store(tmp_path / "computedeck.sqlite")
    store.save_instance(
        {
            "id": "manual:lab-box",
            "source_id": "manual",
            "platform": "Lab",
            "name": "box",
            "state": "unknown",
            "host": "192.0.2.9",
            "port": 22,
            "username": "alice",
            "identity_file": "keys/relative",
            "ssh_alias": "cd-lab-box",
            "ssh_status": "unverified",
            "manual": True,
        }
    )
    store.db.close()
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        assert client.get("/api/health").status_code == 200
        assert "cd-lab-box" not in client.get("/api/ssh/config").json()["config"]


def test_unreadable_rows_do_not_stop_the_service_or_any_page(data_dir: Path) -> None:
    store = Store(data_dir / "computedeck.sqlite")
    with store.db:
        for statement in (
            "INSERT INTO sources VALUES ('a', 'not json')",
            """INSERT INTO sources VALUES ('b', '{"id": "b"}')""",
            "INSERT INTO snapshots VALUES ('a', 'garbage')",
            "INSERT INTO history VALUES ('2099-01-01T00:00:00+00:00', 'zz')",
            "INSERT INTO meta VALUES ('setting:language', '{bad')",
            """INSERT INTO nodes VALUES ('n', '{"id": "n"}')""",
            "INSERT INTO events (key, type, at, source_id, silent, data) "
            "VALUES ('k', 'job.failed', '2099-01-01T00:00:00+00:00', NULL, 0, 'nope')",
        ):
            store.db.execute(statement)
    store.db.close()
    with TestClient(api.create_app(data_dir, polling=False, plugins=[])) as client:
        for path in (
            "/api/dashboard",
            "/api/history",
            "/api/events",
            "/api/nodes",
            "/api/settings",
            "/api/toolbox",
            "/api/ssh/config",
        ):
            assert client.get(path).status_code == 200, path
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["unreadable_rows"] == {
            "events": 1,
            "history": 1,
            "meta": 1,
            "nodes": 1,
            "snapshots": 1,
            "sources": 2,
        }
        assert post(client, "/api/sources", CLUSTER).status_code == 201


def test_history_endpoint_bounds_and_demo(client: TestClient) -> None:
    assert client.get("/api/history?hours=0").status_code == 422
    assert client.get("/api/history?hours=169").status_code == 422
    assert client.get("/api/history").json() == {"hours": 24, "points": []}
    week = client.get("/api/history?hours=168&demo=true").json()
    assert week["hours"] == 168
    assert len(week["points"]) == 337
    data = client.get("/api/dashboard?demo=true").json()
    summary = data["summary"]
    early = week["points"][0]
    assert early["unknown_allocation_sources"] == 0
    assert early["allocated_gpus"] == early["known_allocated_gpus"]
    for source in data["sources"]:
        if source["stale"] or source["error"]:
            assert all(
                point["unknown_allocation_sources"] > 0 and point["allocated_gpus"] is None
                for point in week["points"]
                if point["at"] >= source["last_success"]
            )
    latest = week["points"][-1]
    assert latest["allocated_gpus"] == summary["allocated"]
    assert latest["known_allocated_gpus"] == summary["known_allocated"]
    assert latest["unknown_allocation_sources"] == len(summary["unmeasured"])
    assert all(
        point["allocated_gpus"] is None
        for point in week["points"]
        if point["unknown_allocation_sources"]
    )


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("POST", "/api/sources", '{"name": "Lab", "driver": "slurm", "options": {"k": "\\ud800"}}'),
        ("POST", "/api/sources", '{"name": "x\\udfff", "driver": "slurm"}'),
        ("PUT", "/api/sources/cluster-a-alice", '{"options": {"partition": "\\ud83d"}}'),
        ("POST", "/api/nodes", '{"name": "n\\ud800", "ssh_alias": "gateway"}'),
        ("PUT", "/api/settings", '{"server_name": "box\\ud800"}'),
        ("POST", "/api/instances", '{"platform": "Lab", "name": "\\ud800", "external_id": "b"}'),
        ("POST", "/api/refresh", '{"source_id": "\\ud800"}'),
        ("POST", "/api/sources", b'{"name": "raw \xed\xa0\x80", "driver": "slurm"}'),
    ],
)
def test_text_utf8_cannot_encode_is_rejected_before_anything_is_saved(
    client: TestClient, method: str, path: str, body: str | bytes
) -> None:
    post(client, "/api/sources", CLUSTER)
    before = client.get("/api/dashboard").json()["sources"]
    response = client.request(method, path, content=body, headers=HEADERS)
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": {"code": "text_invalid"}}
    assert client.get("/api/dashboard").json()["sources"] == before
    assert client.get("/api/settings").json()["server_name"] is None
    assert client.get("/api/nodes").json() == []


def test_stored_text_utf8_cannot_encode_is_escaped_not_a_failure(
    client: TestClient, data_dir: Path
) -> None:
    source = post(client, "/api/sources", CLUSTER).json()
    store = Store(data_dir / "computedeck.sqlite")
    # Written by an earlier version that did not check request text.
    store.save_source({**source, "options": {"partition": "gpu\ud800"}, "credential": "x\ud800"})
    store.db.close()
    dashboard = client.get("/api/dashboard")
    assert dashboard.status_code == 200
    assert "\\ud800" in dashboard.text
    assert dashboard.json()["sources"][0]["options"] == {"partition": "gpu\ud800"}
    # A rejection that quotes the stored value is sent as well.
    response = client.put("/api/sources/cluster-a-alice", json={"enabled": True}, headers=HEADERS)
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "invalid_credential_reference",
        "reference": "x\ud800",
    }


def test_unreadable_rows_of_the_tools_do_not_break_their_pages(data_dir: Path) -> None:
    from computedeck.tools import chat, notify

    tools = [chat.plugin, notify.plugin]
    with TestClient(api.create_app(data_dir, polling=False, plugins=tools)) as client:
        for name in ("chat", "notify"):
            client.put(f"/api/toolbox/{name}", json={"enabled": True}, headers=HEADERS)
    store = Store(data_dir / "computedeck.sqlite")
    with store.db:
        for statement in (
            "INSERT INTO chat_messages (channel, at, data) VALUES ('general', '2099-01-01', 'x')",
            "INSERT INTO notify_rules VALUES ('r', 'not json')",
            "INSERT INTO notify_channels VALUES ('c', '[]')",
            "INSERT INTO notify_log (at, data) VALUES ('2099-01-01', '{bad')",
            "INSERT INTO notify_queue VALUES ('r', 1, 'c', 0, 0, 0, 'zz')",
        ):
            store.db.execute(statement)
    store.db.close()
    # Startup expires queued deliveries over these rows.
    with TestClient(api.create_app(data_dir, polling=False, plugins=tools)) as client:
        for path in (
            "/api/plugins/chat",
            "/api/plugins/chat/messages?channel=general",
            "/api/plugins/notify",
            "/api/toolbox",
        ):
            assert client.get(path).status_code == 200, path
        unreadable = client.get("/api/health").json()["unreadable_rows"]
        assert {"chat_messages", "notify_rules", "notify_channels", "notify_log"} <= set(unreadable)


def test_pending_collections_are_exposed_and_refresh_can_queue_other_sources(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = Event()
    release = Event()

    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        started.set()
        await asyncio.to_thread(release.wait, 5)
        return Batch(jobs=[], capabilities=["jobs"])

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    first = post(client, "/api/sources", CLUSTER).json()
    second = post(client, "/api/sources", {**CLUSTER, "name": "Cluster B"}).json()
    try:
        post(client, "/api/refresh", {"source_id": first["id"]})
        assert started.wait(2)
        data = client.get("/api/dashboard").json()
        assert data["collecting"] == [first["id"]]
        assert data["refreshing"] is True
        assert data["as_of"] is None
        post(client, "/api/refresh")
        assert client.get("/api/dashboard").json()["collecting"] == sorted(
            [first["id"], second["id"]]
        )
    finally:
        release.set()
    assert wait_until_idle(client)["collecting"] == []


@pytest.mark.parametrize("fails", [False, True])
def test_disabling_source_during_collection_resets_run_state(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fails: bool
) -> None:
    started = Event()
    release = Event()

    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        started.set()
        await asyncio.to_thread(release.wait, 5)
        if fails:
            raise SourceError("ssh_timeout")
        return Batch(jobs=[], capabilities=["jobs"])

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    source = post(client, "/api/sources", CLUSTER).json()
    try:
        post(client, "/api/refresh", {"source_id": source["id"]})
        assert started.wait(2)
        assert client.get("/api/dashboard").json()["sources"][0]["status"] == "syncing"
        response = client.put(
            f"/api/sources/{source['id']}", json={"enabled": False}, headers=HEADERS
        )
        assert response.status_code == 200
        assert response.json()["status"] == "unconfigured"
    finally:
        release.set()
    data = wait_until_idle(client)
    [saved] = data["sources"]
    assert saved["enabled"] is False
    assert saved["status"] == "unconfigured"
    assert saved["error"] is None
    assert saved["failures"] == 0
    assert saved["last_success"] is None
    assert data["attention"] == []
    assert data["collecting"] == []


@pytest.mark.parametrize("previous_failure", [False, True])
def test_enabling_configured_source_starts_ready_without_old_failures(
    client: TestClient, data_dir: Path, previous_failure: bool
) -> None:
    source = post(client, "/api/sources", {**CLUSTER, "enabled": False}).json()
    assert source["status"] == "unconfigured"
    if previous_failure:
        store = Store(data_dir / "computedeck.sqlite")
        try:
            store.save_source(
                {**source, "status": "error", "error": {"code": "ssh_timeout"}, "failures": 5}
            )
        finally:
            store.db.close()
    response = client.put(f"/api/sources/{source['id']}", json={"enabled": True}, headers=HEADERS)
    assert response.status_code == 200
    saved = response.json()
    assert saved["status"] == "ready"
    assert saved["error"] is None
    assert saved["failures"] == 0
    assert saved["next_due_at"] is not None
    assert client.get("/api/dashboard").json()["attention"] == []


def test_collector_commit_fault_reaches_health_and_recovers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = post(client, "/api/sources", CLUSTER).json()

    async def fail(self: collector_module.Collector, source_id: str) -> None:
        raise OSError("database write failed")

    monkeypatch.setattr(collector_module.Collector, "_collect", fail)
    post(client, "/api/refresh")
    wait_until_idle(client)
    key = f"collector:commit:{source['id']}"
    assert client.get("/api/health").json()["background_errors"][key]["error"] == (
        "OSError: database write failed"
    )

    items = client.get("/api/dashboard").json()["attention"]
    assert any(
        item["kind"] == "service_loop_failed" and item["subject"]["id"] == key for item in items
    )
    assert not any(
        item["kind"] == "service_loop_failed"
        for item in client.get("/api/dashboard?demo=true").json()["attention"]
    )

    async def succeed(self: collector_module.Collector, source_id: str) -> None:
        pass

    monkeypatch.setattr(collector_module.Collector, "_collect", succeed)
    post(client, "/api/refresh")
    wait_until_idle(client)
    assert key not in client.get("/api/health").json()["background_errors"]
    assert client.get("/api/dashboard").json()["attention"] == []


@pytest.mark.parametrize("action", ["delete", "disable"])
def test_commit_fault_clears_when_source_is_removed_from_collection(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    source = post(client, "/api/sources", CLUSTER).json()
    other = post(client, "/api/sources", {**CLUSTER, "name": "Cluster B"}).json()

    async def fail(self: collector_module.Collector, source_id: str) -> None:
        raise OSError("database write failed")

    monkeypatch.setattr(collector_module.Collector, "_collect", fail)
    post(client, "/api/refresh")
    wait_until_idle(client)
    key = f"collector:commit:{source['id']}"
    other_key = f"collector:commit:{other['id']}"
    assert {key, other_key} <= client.get("/api/health").json()["background_errors"].keys()
    path = f"/api/sources/{source['id']}"
    response = (
        client.delete(path, headers=HEADERS)
        if action == "delete"
        else client.put(path, json={"enabled": False}, headers=HEADERS)
    )
    assert response.status_code == 200
    errors = client.get("/api/health").json()["background_errors"]
    assert key not in errors
    assert other_key in errors


def test_health_filters_inactive_commit_faults_without_mutating_runtime(
    client: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = post(client, "/api/sources", CLUSTER).json()
    other = post(client, "/api/sources", {**CLUSTER, "name": "Cluster B"}).json()
    runtimes = []

    async def fail(self: collector_module.Collector, source_id: str) -> None:
        runtimes.append(self.runtime)
        raise OSError("database write failed")

    monkeypatch.setattr(collector_module.Collector, "_collect", fail)
    post(client, "/api/refresh")
    wait_until_idle(client)
    runtime = runtimes[0]
    recorded = dict(runtime.loop_errors)
    # A CLI edit can disable a source without going through the service's write routes.
    store = Store(data_dir / "computedeck.sqlite")
    try:
        store.save_source({**source, "enabled": False})
    finally:
        store.db.close()
    errors = client.get("/api/health").json()["background_errors"]
    assert f"collector:commit:{source['id']}" not in errors
    assert f"collector:commit:{other['id']}" in errors
    assert runtime.loop_errors == recorded


def test_attention_reads_live_staleness_and_keeps_demo_isolated(
    client: TestClient, data_dir: Path
) -> None:
    from datetime import UTC, datetime, timedelta

    source = post(client, "/api/sources", CLUSTER).json()
    store = Store(data_dir / "computedeck.sqlite")
    try:
        source.update(last_success=(datetime.now(UTC) - timedelta(minutes=31)).isoformat())
        store.save_source(source)
    finally:
        store.db.close()
    data = client.get("/api/dashboard").json()
    assert [(item["kind"], item["severity"]) for item in data["attention"]] == [
        ("source_stale", "error")
    ]
    example = client.get("/api/dashboard?demo=true").json()
    assert [item["kind"] for item in example["attention"]] == [
        "source_stale",
        "source_failed",
        "source_failed",
        "cluster_unavailable",
        "instance_ssh_failed",
    ]
    assert all(item["subject"]["id"].startswith("example:") for item in example["attention"])
    assert source["id"] not in {item["id"] for item in example["sources"]}
    assert client.get("/api/dashboard").json()["attention"] == data["attention"]


@pytest.mark.parametrize(
    "changes",
    [
        {"ssh_alias": "cluster-b"},
        {"interval_minutes": 20},
        {"name": "Renamed cluster"},
        {"enabled": False},
    ],
)
def test_connection_edits_reset_capability_history_but_other_edits_keep_it(
    client: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch, changes: dict[str, Any]
) -> None:
    source = post(client, "/api/sources", CLUSTER).json()
    capabilities = ["jobs", "nodes", "history"]
    store = Store(data_dir / "computedeck.sqlite")
    try:
        store.save_source(
            {
                **source,
                "capabilities": capabilities,
                "capabilities_seen": capabilities,
                "warnings": [{"code": "partitions_unavailable"}],
                "cluster_state": "degraded",
            }
        )
    finally:
        store.db.close()

    response = client.put(f"/api/sources/{source['id']}", json=changes, headers=HEADERS)
    assert response.status_code == 200
    changed_connection = "ssh_alias" in changes
    expected = [] if changed_connection else capabilities
    assert response.json()["capabilities"] == expected
    assert response.json()["capabilities_seen"] == expected
    assert response.json()["warnings"] == (
        [] if changed_connection else [{"code": "partitions_unavailable"}]
    )
    assert response.json()["cluster_state"] == ("unknown" if changed_connection else "degraded")
    if changes.get("enabled") is False:
        assert client.get("/api/dashboard").json()["attention"] == []
        response = client.put(
            f"/api/sources/{source['id']}", json={"enabled": True}, headers=HEADERS
        )
        assert response.status_code == 200
        assert response.json()["capabilities_seen"] == capabilities

    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        return Batch(jobs=[], capabilities=["jobs"], warnings=[{"code": "history_unavailable"}])

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    post(client, "/api/refresh", {"source_id": source["id"]})
    data = wait_until_idle(client)
    assert data["sources"][0]["capabilities_seen"] == (
        ["jobs"] if changed_connection else sorted(capabilities)
    )
    assert [item["kind"] for item in data["attention"]] == (
        [] if changed_connection else ["capability_regressed"]
    )


@pytest.mark.parametrize("outcome", ["jobs_ended", "ongoing_failure"])
def test_reenable_starts_a_silent_event_baseline(
    client: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    stage = "initial"

    async def collect(self: SlurmDriver, source: dict[str, Any]) -> Batch:
        if stage == "failure":
            raise SourceError("ssh_timeout")
        job = {
            "id": "cluster-a:1",
            "source_id": source["id"],
            "cluster_id": "cluster-a",
            "state": "RUNNING",
            "gpu_count": 1,
        }
        if stage == "ended":
            return Batch(
                jobs=[],
                failures=[{**job, "state": "FAILED", "end": "2026-01-01T12:00:00"}],
                capabilities=["jobs", "history"],
            )
        return Batch(jobs=[job], capabilities=["jobs", "history"])

    monkeypatch.setattr(SlurmDriver, "collect", collect)
    source = post(client, "/api/sources", CLUSTER).json()

    def refresh() -> None:
        post(client, "/api/refresh", {"source_id": source["id"]})
        wait_until_idle(client)

    refresh()
    if outcome == "ongoing_failure":
        stage = "failure"
        refresh()
    for enabled in (False, True):
        response = client.put(
            f"/api/sources/{source['id']}", json={"enabled": enabled}, headers=HEADERS
        )
        assert response.status_code == 200
        assert response.json()["last_success"] is None
        assert response.json()["capabilities_seen"] == ["history", "jobs"]
    stage = "ended" if outcome == "jobs_ended" else "failure"
    refresh()
    store = Store(data_dir / "computedeck.sqlite")
    try:
        rows = store.events()
    finally:
        store.db.close()
    if outcome == "jobs_ended":
        assert [(row["type"], row["silent"]) for row in rows] == [
            ("job.started", True),
            ("job.finished", True),
        ]
    else:
        assert [(row["type"], row["silent"]) for row in rows] == [
            ("job.started", True),
            ("source.failed", False),
        ]


def test_event_grouping_is_opt_in_and_limits_groups_not_children(client: TestClient) -> None:
    plain = client.get("/api/events?demo=true&limit=200").json()
    assert all("group" not in row for row in plain)
    grouped = client.get("/api/events?demo=true&group=1&limit=200").json()
    [digest] = [row for row in grouped if "group" in row]
    assert digest["group"]["count"] == 60
    assert digest["group"]["names"] == [{"name": "train-sweep", "count": 60}]
    assert len(digest["group"]["ids"]) == 60
    assert [row["id"] for row in digest["group"]["events"]] == digest["group"]["ids"][:50]
    assert len(grouped) == len(plain) - 59
    assert digest["group"]["first_at"] < digest["group"]["last_at"]
    assert digest["at"] == digest["group"]["last_at"]


def test_live_event_grouping_caps_children_but_retains_totals_and_ids(
    client: TestClient, data_dir: Path
) -> None:
    from computedeck.store import now

    store = Store(data_dir / "computedeck.sqlite")
    at = now()
    rows = [
        {
            "key": str(i),
            "type": "job.finished",
            "at": at,
            "source_id": "cluster-a",
            "data": {
                "observed_at": at,
                "ended_at": at if i else None,
                "since": None if i else "2026-01-01T00:00:00Z",
                "outcome": "completed" if i else "failed",
                "job": {"name": "sweep"},
            },
        }
        for i in range(250)
    ]
    store.add_events(rows)
    store.db.close()
    result = client.get("/api/events?group=1&limit=1").json()
    assert len(result) == 1 and result[0]["group"]["count"] == 250
    group = result[0]["group"]
    assert group["ids"] == list(range(250, 0, -1))
    assert [row["id"] for row in group["events"]] == group["ids"][:50]
    assert group["observed_time"] is True
    assert group["since"] == "2026-01-01T00:00:00Z"
    assert group["outcomes"] == {"completed": 249, "failed": 1}
    assert len(client.get("/api/events?limit=1").json()) == 1


def test_grouped_events_keep_interleaved_sources_types_and_collections(
    client: TestClient, data_dir: Path
) -> None:
    from datetime import UTC, datetime, timedelta

    clock = datetime.now(UTC)
    at = clock.isoformat()
    earlier = (clock - timedelta(minutes=10)).isoformat()
    keys = [
        ("a", "job.finished", earlier),
        ("b", "job.finished", at),
        ("a", "job.started", at),
        ("a", "job.finished", at),
        (None, "source.failed", at),
    ]
    rows = []
    for index in range(3):
        for source, kind, observed in keys:
            rows.append(
                {
                    "key": str(len(rows)),
                    "type": kind,
                    "source_id": source,
                    "at": at,
                    "data": {
                        "observed_at": observed,
                        "outcome": "completed" if index else "failed",
                    },
                }
            )
    store = Store(data_dir / "computedeck.sqlite")
    store.add_events([*rows, {**rows[-1], "key": "silent", "silent": True}])
    statements: list[str] = []
    store.db.set_trace_callback(statements.append)
    assert len(store.recent_event_collections(3)) == 9
    assert len(statements) == 1
    store.db.close()
    result = client.get("/api/events?group=1&limit=3").json()
    assert [(row["source_id"], row["type"], row["data"]["observed_at"]) for row in result] == keys[
        :1:-1
    ]
    assert all(row["group"]["count"] == 3 for row in result)
    assert result[0]["group"]["ids"] == [15, 10, 5]
    assert result[1]["group"]["outcomes"] == {"completed": 2, "failed": 1}
    assert result[2]["group"]["outcomes"] == {}


def test_event_id_lookup_is_exact_and_excludes_silent_rows(
    client: TestClient, data_dir: Path
) -> None:
    from computedeck.store import now

    store = Store(data_dir / "computedeck.sqlite")
    store.add_events(
        [
            {
                "key": str(i),
                "type": "job.failed",
                "at": now(),
                "silent": i == 2,
                "data": {"job": {"id": f"cluster-a:{i}"}},
            }
            for i in range(1, 4)
        ]
    )
    store.db.close()
    [row] = client.get("/api/events?id=1").json()
    assert row["id"] == 1 and row["data"]["job"]["id"] == "cluster-a:1"
    assert client.get("/api/events?id=2").json() == []
    assert client.get("/api/events?id=999").json() == []
    assert client.get("/api/events?id=0").status_code == 422
    assert client.get("/api/events?id=invalid").status_code == 422
    demo = client.get("/api/events?demo=true").json()[0]
    [row] = client.get(f"/api/events?demo=true&id={demo['id']}").json()
    assert row["id"] == demo["id"] and row["type"] == demo["type"]
