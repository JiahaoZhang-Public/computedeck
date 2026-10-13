"""Team messages: channels, files, limits and housekeeping."""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck.tools import chat

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}
UPLOAD = {**HEADERS, "Content-Type": "application/octet-stream"}


@pytest.fixture
def client(tmp_path: Path) -> Any:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[chat.plugin])) as value:
        value.put("/api/toolbox/chat", json={"enabled": True}, headers=HEADERS)
        yield value


def post(client: TestClient, body: dict[str, Any]) -> Any:
    return client.post("/api/plugins/chat/messages", json=body, headers=HEADERS)


def test_messages_are_kept_per_channel_and_read_incrementally(client: TestClient) -> None:
    first = post(client, {"author": "alice", "body": "checkpoint copied to /data"}).json()
    post(client, {"author": "bob", "body": "thanks", "channel": "general"})
    post(client, {"author": "bob", "body": "queue is long", "channel": "cluster-a"})
    rows = client.get("/api/plugins/chat/messages?channel=general").json()
    assert [row["body"] for row in rows] == ["checkpoint copied to /data", "thanks"]
    later = client.get(f"/api/plugins/chat/messages?channel=general&after={first['id']}").json()
    assert [row["author"] for row in later] == ["bob"]
    assert (
        post(client, {"author": "alice", "body": "  "}).json()["detail"]["code"] == "message_empty"
    )
    assert post(client, {"author": "\n", "body": "x"}).status_code == 422
    assert (
        post(client, {"author": "alice", "body": "x", "channel": "Bad Channel"}).status_code == 422
    )


def test_files_are_uploaded_attached_and_removed_with_their_message(
    client: TestClient, tmp_path: Path
) -> None:
    uploaded = client.post(
        "/api/plugins/chat/attachments?name=results.csv", content=b"a,b\n1,2\n", headers=UPLOAD
    ).json()
    assert uploaded["name"] == "results.csv" and uploaded["size"] == 8
    note = post(client, {"author": "alice", "attachment": uploaded["id"]}).json()
    assert note["attachment"]["name"] == "results.csv"
    saved = client.get(f"/api/plugins/chat/attachments/{uploaded['id']}")
    assert saved.content == b"a,b\n1,2\n"
    assert "results.csv" in saved.headers["content-disposition"]
    deleted = client.request(
        "DELETE", f"/api/plugins/chat/messages/{note['id']}", json={}, headers=HEADERS
    )
    assert deleted.json() == {"deleted": True}
    assert client.get(f"/api/plugins/chat/attachments/{uploaded['id']}").status_code == 404
    assert not (tmp_path / "chat-files" / uploaded["id"]).exists()


def test_uploads_are_limited_and_checked(client: TestClient) -> None:
    client.put("/api/toolbox/chat", json={"settings": {"max_file_mb": 1}}, headers=HEADERS)
    big = client.post(
        "/api/plugins/chat/attachments?name=big.bin",
        content=b"x" * (1024 * 1024 + 1),
        headers=UPLOAD,
    )
    assert big.status_code == 413
    bad = client.post("/api/plugins/chat/attachments?name=../etc", content=b"x", headers=UPLOAD)
    assert bad.status_code == 422
    # Without the app's headers an upload is refused like any other write.
    plain = client.post(
        "/api/plugins/chat/attachments?name=x.txt",
        content=b"x",
        headers={"Content-Type": "text/plain", **HEADERS},
    )
    assert plain.status_code == 403
    assert post(client, {"author": "a", "attachment": "0" * 32}).status_code == 404


def test_channels_follow_sources_and_machines(client: TestClient, tmp_path: Path) -> None:
    from computedeck.store import Store

    store = Store(tmp_path / "computedeck.sqlite")
    store.save_source(
        {
            "id": "cluster-a-alice",
            "name": "Cluster A",
            "driver": "slurm",
            "cluster_id": "cluster-a",
            "enabled": True,
            "interval_minutes": 10,
        }
    )
    store.save_node({"id": "lab-gateway", "name": "Lab gateway"})
    listed = client.get("/api/plugins/chat").json()["channels"]
    assert [(row["id"], row["kind"]) for row in listed] == [
        ("general", "general"),
        ("cluster-a", "group"),
        ("node-lab-gateway", "node"),
    ]


def test_old_messages_are_pruned(client: TestClient, tmp_path: Path) -> None:
    from computedeck.plugins import PluginContext, Runtime
    from computedeck.store import Store

    post(client, {"author": "alice", "body": "old"})
    store = Store(tmp_path / "computedeck.sqlite")
    old = (datetime.now(UTC) - timedelta(days=400)).isoformat()
    with store.db:
        store.db.execute("UPDATE chat_messages SET at=?", (old,))
    post(client, {"author": "alice", "body": "new"})
    runtime = Runtime(tmp_path)
    runtime.store = store
    assert chat.Chat(PluginContext(chat.plugin, runtime)).prune() == 1
    assert [row["body"] for row in client.get("/api/plugins/chat/messages").json()] == ["new"]


@pytest.mark.parametrize(
    "setting,value",
    [
        ("keep_days", -1),
        ("keep_days", 1e9),
        ("keep_days", 0),
        ("max_file_mb", -5),
        ("max_file_mb", 1.5),
    ],
)
def test_bad_numeric_settings_do_not_mutate_existing_settings(
    client: TestClient,
    setting: str,
    value: float,
) -> None:
    response = client.put("/api/toolbox/chat", json={"settings": {setting: value}}, headers=HEADERS)
    assert response.status_code == 422
    assert client.get("/api/plugins/chat").json()["max_file_mb"] == 25


def test_shared_attachment_survives_deleting_one_message(client: TestClient) -> None:
    uploaded = client.post(
        "/api/plugins/chat/attachments?name=x.txt", content=b"shared", headers=UPLOAD
    ).json()
    first = post(client, {"author": "a", "attachment": uploaded["id"]}).json()
    second = post(client, {"author": "b", "attachment": uploaded["id"]}).json()
    client.request("DELETE", f"/api/plugins/chat/messages/{first['id']}", json={}, headers=HEADERS)
    assert client.get(f"/api/plugins/chat/attachments/{uploaded['id']}").content == b"shared"
    client.request("DELETE", f"/api/plugins/chat/messages/{second['id']}", json={}, headers=HEADERS)
    assert client.get(f"/api/plugins/chat/attachments/{uploaded['id']}").status_code == 404


@pytest.mark.parametrize("damage", ["meta", "data"])
def test_damaged_upload_is_missing_not_server_error(
    client: TestClient, tmp_path: Path, damage: str
) -> None:
    uploaded = client.post(
        "/api/plugins/chat/attachments?name=x.txt", content=b"x", headers=UPLOAD
    ).json()
    folder = tmp_path / "chat-files" / uploaded["id"]
    if damage == "meta":
        (folder / "meta.json").write_text("{")
    else:
        (folder / "data").unlink()
    assert client.get(f"/api/plugins/chat/attachments/{uploaded['id']}").status_code == 404
    assert post(client, {"author": "a", "attachment": uploaded["id"]}).status_code == 404


def test_unattached_old_upload_is_pruned(client: TestClient, tmp_path: Path) -> None:
    import os
    import time

    from computedeck.plugins import PluginContext, Runtime
    from computedeck.store import Store

    uploaded = client.post(
        "/api/plugins/chat/attachments?name=x.txt", content=b"x", headers=UPLOAD
    ).json()
    folder = tmp_path / "chat-files" / uploaded["id"]
    os.utime(folder, (time.time() - 90000, time.time() - 90000))
    runtime = Runtime(tmp_path)
    runtime.store = Store(tmp_path / "computedeck.sqlite")
    chat.Chat(PluginContext(chat.plugin, runtime)).prune()
    assert not folder.exists()


@pytest.mark.parametrize("keep_days", [-1, 0, float("nan"), "30", 1e9, None])
def test_settings_saved_by_an_older_build_are_checked_when_used(
    client: TestClient, tmp_path: Path, keep_days: Any
) -> None:
    from computedeck.plugins import PluginContext, Runtime
    from computedeck.store import Store

    post(client, {"author": "alice", "body": "recent"})
    store = Store(tmp_path / "computedeck.sqlite")
    # An earlier build accepted these; saving through the Toolbox now refuses them.
    store.save_plugin_settings("chat", {"keep_days": keep_days, "max_file_mb": -5})
    runtime = Runtime(tmp_path)
    runtime.store = store
    context = PluginContext(chat.plugin, runtime)
    chat.setup(context)
    # -1 used to delete every message, and NaN stopped housekeeping with an error.
    assert chat.Chat(context).prune() == 0
    assert [row["body"] for row in client.get("/api/plugins/chat/messages").json()] == ["recent"]
    assert client.get("/api/plugins/chat").json()["max_file_mb"] == 25
    assert context.health is not None
    health = context.health()
    invalid = {"max_file_mb": "-5"}
    if keep_days is not None:
        invalid["keep_days"] = str(keep_days)
    assert health["invalid_settings"] == invalid
    assert "saved “Largest file (MB)” -5 is not valid; using 25" in health["summary"]["en"]
