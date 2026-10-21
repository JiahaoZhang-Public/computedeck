"""Collection nodes: the hub collects a source on another machine over SSH."""

import json
import os
from pathlib import Path
from typing import Any, ClassVar, Literal

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import drivers, nodes
from computedeck.collector import Collector
from computedeck.drivers import ssh
from computedeck.drivers.base import Batch, SourceError
from computedeck.plugins import Runtime
from computedeck.store import Store

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}
NODE = {
    "id": "lab-gateway",
    "name": "Lab gateway",
    "ssh_alias": "lab-gateway",
    "command": "~/.local/bin/computedeck",
}


class NodeOnlyDriver:
    """Stands in for a driver that works only on the node (its VPN, its keys)."""

    name: ClassVar[str] = "slurm"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"

    def validate(self, source: dict[str, Any]) -> None:
        if not source.get("ssh_alias"):
            raise SourceError("cluster_connection_required")

    async def collect(self, source: dict[str, Any]) -> Batch:
        if source["ssh_alias"] == "down":
            raise SourceError("ssh_failed", "Connection refused")
        job = {
            "id": f"{source['cluster_id']}:7",
            "state": "RUNNING",
            "gpu_count": 2,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
        }
        return Batch(jobs=[job], capabilities=["jobs"], history_window_seconds=86400)


@pytest.fixture
def fake_node(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Run the node side in-process instead of over SSH, recording what was sent."""
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(drivers, "get", lambda name: NodeOnlyDriver())

    async def ssh_command(
        destination: str,
        command: str,
        options: Any = None,
        *,
        wait: bool = True,
        input: bytes | None = None,
    ) -> str:
        sent.append(
            {"destination": destination, "command": command, "request": json.loads(input or b"{}")}
        )
        return "log line from the node's shell profile\n" + json.dumps(
            await nodes.handle((input or b"").decode())
        )

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    return sent


SOURCE = {
    "id": "cluster-b-alice",
    "name": "Cluster B",
    "driver": "slurm",
    "cluster_id": "cluster-b",
    "username": "alice",
    "ssh_alias": "login.cluster-b",
    "credential": "",
    "options": {},
    "enabled": True,
    "interval_minutes": 10,
    "node": "lab-gateway",
    "status": "ready",
    "last_success": None,
    "qos": [],
    "capabilities": [],
    "warnings": [],
    "error": None,
}


async def test_a_source_is_collected_on_its_node(fake_node: list[dict[str, Any]]) -> None:
    batch = await nodes.collect(NODE, SOURCE)
    assert batch.history_window_seconds == 86400
    assert batch.jobs and batch.jobs[0]["id"] == "cluster-b:7"
    [call] = fake_node
    assert call["destination"] == "lab-gateway"
    # The ~ is left for the remote shell to expand; the subcommand is fixed.
    assert call["command"] == "~/.local/bin/computedeck collect"
    request = call["request"]
    assert request["action"] == "collect" and request["protocol"] == nodes.PROTOCOL
    # Only connection settings travel; the hub's runtime state stays home.
    assert set(request["source"]) == set(nodes.SOURCE_FIELDS)


async def test_node_errors_come_back_as_source_errors(
    fake_node: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(SourceError) as error:
        await nodes.collect(NODE, {**SOURCE, "ssh_alias": "down"})
    assert error.value.message() == {"code": "ssh_failed", "detail": "Connection refused"}

    async def unreachable(*args: Any, **kwargs: Any) -> str:
        raise ssh.SSHError("ssh: connect to host lab-gateway port 22: Connection refused")

    monkeypatch.setattr(ssh, "ssh_command", unreachable)
    with pytest.raises(SourceError) as error:
        await nodes.collect(NODE, SOURCE)
    assert error.value.code == "node_unreachable"

    async def missing(*args: Any, **kwargs: Any) -> str:
        raise ssh.SSHError("bash: computedeck: command not found")

    monkeypatch.setattr(ssh, "ssh_command", missing)
    with pytest.raises(SourceError) as error:
        await nodes.info(NODE)
    assert error.value.code == "node_command_missing"

    async def garbage(*args: Any, **kwargs: Any) -> str:
        return "Welcome to the lab!\n"

    monkeypatch.setattr(ssh, "ssh_command", garbage)
    with pytest.raises(SourceError) as error:
        await nodes.info(NODE)
    assert error.value.code == "node_bad_response"


async def test_a_different_version_on_the_node_is_noted(
    fake_node: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(nodes, "core_version", lambda: "0.4.0")
    real = nodes.handle

    async def older(text: str) -> dict[str, Any]:
        return {**(await real(text)), "version": "0.3.1"}

    monkeypatch.setattr(nodes, "handle", older)
    batch = await nodes.collect(NODE, SOURCE)
    assert batch.warnings[-1]["code"] == "node_version"


def test_the_node_answers_info_and_rejects_bad_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    info = nodes.answer(json.dumps({"protocol": 1, "action": "info"}))
    assert info["protocol"] == 1 and "slurm" in info["drivers"]
    assert nodes.answer("not json")["error"]["code"] == "node_bad_request"
    assert nodes.answer(json.dumps({"protocol": 99}))["error"]["code"] == "node_protocol"
    unknown = nodes.answer(
        json.dumps({"protocol": 1, "action": "collect", "source": {**SOURCE, "driver": "nope"}})
    )
    assert unknown["error"] == {"code": "unknown_driver", "driver": "nope"}


def test_node_commands_are_restricted() -> None:
    body = nodes.NodeInput(name="Gateway", ssh_alias="gw", command="computedeck; rm -rf ~")
    with pytest.raises(ValueError, match="node_command_invalid"):
        nodes.node_record(body, "gw")
    ok = nodes.node_record(
        nodes.NodeInput(name="Gateway", ssh_alias="gw", command="uv tool run computedeck"), "gw"
    )
    assert nodes._remote(ok) == "uv tool run computedeck collect"


async def test_the_collector_uses_the_node_and_records_its_state(
    fake_node: list[dict[str, Any]], store: Store, tmp_path: Path
) -> None:
    runtime = Runtime(tmp_path)
    runtime.store = store
    store.save_node({**NODE, "status": "unchecked"})
    store.save_source({k: v for k, v in SOURCE.items()})
    collector = Collector(runtime)
    await collector.collect(SOURCE["id"])
    assert store.source(SOURCE["id"])["status"] == "ready"  # type: ignore[index]
    assert [job["id"] for job in store.dashboard()["jobs"]] == ["cluster-b:7"]
    assert store.node("lab-gateway")["status"] == "ok"  # type: ignore[index]
    store.delete_node("lab-gateway")
    await collector.collect(SOURCE["id"])
    assert store.source(SOURCE["id"])["error"] == {
        "code": "node_not_found",  # type: ignore[index]
        "node": "lab-gateway",
    }


def test_api_manages_nodes_and_checks_sources_against_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def info(node: dict[str, Any]) -> dict[str, Any]:
        return {"version": "0.3.0", "drivers": ["slurm"]}

    monkeypatch.setattr(nodes, "info", info)
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:

        def call(method: str, path: str, body: Any = None) -> Any:
            return client.request(method, path, json={} if body is None else body, headers=HEADERS)

        source = {
            "name": "Cluster B",
            "driver": "slurm",
            "username": "alice",
            "ssh_alias": "login.cluster-b",
            "node": "lab-gateway",
        }
        assert call("POST", "/api/sources", source).json()["detail"]["code"] == "node_not_found"
        node = {"name": "Lab gateway", "ssh_alias": "lab-gateway", "command": "computedeck"}
        assert call("POST", "/api/nodes", node).status_code == 201
        assert call("POST", "/api/nodes", node).status_code == 409
        bad = {**node, "name": "Other", "command": "computedeck && reboot"}
        assert call("POST", "/api/nodes", bad).json()["detail"]["code"] == "node_command_invalid"
        # A credential scheme that exists only on the node is accepted for node sources.
        created = call("POST", "/api/sources", {**source, "credential": "shell:CLUSTER_KEY"})
        assert created.status_code == 201, created.text
        checked = call("POST", "/api/nodes/lab-gateway/check").json()
        assert checked["status"] == "ok" and checked["version"] == "0.3.0"
        assert call("DELETE", "/api/nodes/lab-gateway").status_code == 409
        assert [row["id"] for row in client.get("/api/nodes").json()] == ["lab-gateway"]


def test_collect_command_answers_on_stdout(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    import io

    from computedeck import cli

    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"protocol": 1, "action": "info"})))
    monkeypatch.setenv("COMPUTEDECK_DATA_DIR", str(tmp_path / "default"))
    assert cli.main(["--data-dir", str(tmp_path), "collect"]) == 0
    reply = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert reply["protocol"] == 1 and reply["version"]
    # The node reads its own data directory (policy, plugins), not the default one.
    assert os.environ["COMPUTEDECK_DATA_DIR"] == str(tmp_path.resolve())


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "other:pod"},
        {"source_id": "other"},
        {"cluster_id": "other"},
        {"gpu_count": "bad"},
        {"id": None},
    ],
)
@pytest.mark.parametrize("collection", ["instances", "failures", "finished"])
async def test_node_replies_cannot_cross_source_scope(
    monkeypatch: pytest.MonkeyPatch,
    changes: dict[str, Any],
    collection: str,
) -> None:
    source = {"id": "cloud-user", "cluster_id": "cloud", "driver": "runpod"}
    row = {"id": "cloud:pod", "source_id": "cloud-user", "state": "running", **changes}

    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"batch": {collection: [row]}}

    monkeypatch.setattr(nodes, "request", request)
    with pytest.raises(SourceError, match="node_bad_response"):
        await nodes.collect(NODE, source)


@pytest.mark.parametrize(
    "batch",
    [
        {"jobs": [{"user": {"x": 1}}]},
        {"jobs": [{"qos": ["x"]}]},
        {"failures": [{"elapsed": {"h": 1}, "exit_code": [1]}]},
        {"jobs": [{"node": [1]}]},
        {"jobs": [{"gpu_type": True}]},
        {"nodes": [{"partitions": "gpu"}]},
        {"nodes": [{"partitions": [{"name": "gpu"}]}]},
        {"instances": [{"platform": {"x": 1}}]},
        {"qos": [{"name": "normal", "limits": {"MaxTRES": {"gpu": 1}}}]},
        {"qos": [{"name": ["normal"]}]},
        {"warnings": [{"code": "nodes_unavailable", "detail": {"x": 1}}]},
        {"account": {"balance": "12", "currency": "USD"}},
    ],
)
async def test_node_replies_with_non_text_display_fields_are_refused(
    monkeypatch: pytest.MonkeyPatch, batch: dict[str, Any]
) -> None:
    source = {"id": "c-alice", "cluster_id": "c", "driver": "slurm"}
    row = {"id": "c:1", "source_id": "c-alice", "state": "RUNNING"}
    for key in ("jobs", "nodes", "instances", "failures"):
        if key in batch:
            batch = {**batch, key: [{**row, **batch[key][0]}]}

    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"batch": batch}

    monkeypatch.setattr(nodes, "request", request)
    with pytest.raises(SourceError, match="node_bad_response"):
        await nodes.collect(NODE, source)


async def test_numbers_in_text_fields_are_stored_as_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = {"id": "c-alice", "cluster_id": "c", "driver": "slurm"}
    job = {"id": "c:1", "source_id": "c-alice", "state": "RUNNING", "user": 1001, "qos": 2}
    qos = {"name": "normal", "limits": {"MaxJobsPU": 4}, "origin": "scheduler_qos"}

    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"batch": {"jobs": [job], "qos": [qos]}}

    monkeypatch.setattr(nodes, "request", request)
    batch = await nodes.collect(NODE, source)
    assert batch.jobs is not None and batch.qos is not None
    assert (batch.jobs[0]["user"], batch.jobs[0]["qos"]) == ("1001", "2")
    assert batch.qos[0]["limits"] == {"MaxJobsPU": "4"}


async def test_node_reply_cannot_redirect_existing_hub_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = {"id": "cloud-user", "cluster_id": "cloud", "driver": "runpod"}
    row = {
        "id": "cloud:pod",
        "source_id": "cloud-user",
        "state": "running",
        "ssh_alias": "login-c",
        "host": "203.0.113.66",
        "port": 22,
        "username": "root",
        "existing_alias": True,
        "identity_file": "/private/key",
        "manual": True,
    }

    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"batch": {"instances": [row]}}

    monkeypatch.setattr(nodes, "request", request)
    batch = await nodes.collect(NODE, source)
    assert batch.instances is not None
    instance = batch.instances[0]
    assert instance["ssh_alias"] == "computedeck-cloud-pod"
    assert instance["identity_file"] is None
    assert not instance.get("existing_alias") and not instance.get("manual")


@pytest.fixture
def node_client(tmp_path: Path) -> Any:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as client:
        node = {"name": "Lab gateway", "ssh_alias": "lab-gateway", "command": "computedeck"}
        assert client.post("/api/nodes", json=node, headers=HEADERS).status_code == 201
        yield client


def check(client: TestClient) -> Any:
    return client.post("/api/nodes/lab-gateway/check", json={}, headers=HEADERS)


def test_a_check_keeps_deletes_and_edits_made_while_it_ran(
    node_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Another request of the service changes the node while the check waits for SSH.
    other = Store(Path(node_client.get("/api/health").json()["database_path"]))
    during: list[Any] = []

    async def info(node: dict[str, Any]) -> dict[str, Any]:
        during.pop(0)()
        return {"version": "0.3.0", "drivers": ["slurm"]}

    def edit(**changes: Any) -> None:
        other.save_node({**other.node("lab-gateway"), **changes})  # type: ignore[dict-item]

    monkeypatch.setattr(nodes, "info", info)
    # A new name is not a new connection: the result is recorded on the edited node.
    during.append(lambda: edit(name="Renamed"))
    checked = check(node_client).json()
    assert (checked["name"], checked["status"], checked["version"]) == ("Renamed", "ok", "0.3.0")
    # Another machine: the answer described the old one.
    during.append(lambda: edit(ssh_alias="other-gateway", status="unchecked", version=None))
    response = check(node_client)
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "node_changed", "node": "Renamed"}
    [node] = node_client.get("/api/nodes").json()
    assert (node["ssh_alias"], node["status"], node["version"]) == (
        "other-gateway",
        "unchecked",
        None,
    )
    during.append(lambda: other.delete_node("lab-gateway"))
    assert check(node_client).status_code == 404
    assert node_client.get("/api/nodes").json() == []
    other.db.close()


@pytest.mark.parametrize(
    "reply",
    [
        {"version": {"a": 1}, "drivers": ["slurm"]},
        {"version": "x" * 41},
        {"version": "0.3\n0"},
        {"version": "0.3.0", "drivers": "runpod"},
        {"version": "0.3.0", "drivers": [{"name": "slurm"}]},
        {"version": "0.3.0", "drivers": ["Bad Name"]},
    ],
)
def test_a_node_must_report_its_version_and_drivers_as_short_text(
    node_client: TestClient, monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]
) -> None:
    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"protocol": 1, **reply}

    monkeypatch.setattr(nodes, "request", request)
    checked = check(node_client).json()
    assert checked["status"] == "error"
    assert checked["error"] == {"code": "node_bad_response", "node": "Lab gateway"}
    assert checked["version"] is None and checked["drivers"] == []


def test_a_stored_node_report_of_the_wrong_shape_is_not_shown(store: Store) -> None:
    store.save_node(
        {
            **NODE,
            "version": {"a": 1},
            "drivers": "runpod",
            "error": {"code": 5, "detail": {"nested": True}},
        }
    )
    node = store.node("lab-gateway")
    assert node is not None
    assert (node["version"], node["drivers"], node["error"]) == (None, [], None)
    store.save_node({**NODE, "error": {"code": "node_x", "detail": {"x": 1}, "n": [1]}})
    assert store.nodes()[0]["error"] == {"code": "node_x"}


@pytest.mark.parametrize("command", ["", "   ", "\t"])
def test_a_node_needs_a_command(
    node_client: TestClient, command: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = {"name": "Other", "ssh_alias": "other", "command": command}
    response = node_client.post("/api/nodes", json=body, headers=HEADERS)
    assert response.status_code == 422
    assert response.json()["detail"] == {"code": "node_command_invalid"}
    update = {**body, "name": "Lab gateway"}
    response = node_client.put("/api/nodes/lab-gateway", json=update, headers=HEADERS)
    assert response.status_code == 422
    # Saved before commands were checked: the check says so instead of failing.
    sent: list[str] = []

    async def ssh_command(*args: Any, **kwargs: Any) -> str:
        sent.append(args[1])
        return "{}"

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    stored = Store(Path(node_client.get("/api/health").json()["database_path"]))
    stored.save_node({**stored.node("lab-gateway"), "command": command})  # type: ignore[dict-item]
    stored.db.close()
    checked = check(node_client).json()
    assert checked["error"] == {"code": "node_command_invalid", "node": "Lab gateway"}
    assert sent == []


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        ({"code": 5}, {"code": "node_bad_response", "node": "Lab gateway"}),
        ({"code": "Not A Code"}, {"code": "node_bad_response", "node": "Lab gateway"}),
        ({"code": "ssh_failed", "detail": {"nested": True}}, {"code": "ssh_failed"}),
        (
            {"code": "ssh_failed", "detail": "x" * 2_000_000},
            {"code": "ssh_failed", "detail": "x" * 500},
        ),
        (
            {"code": "unknown_driver", "driver": "nope", "extra": {"a": 1}, "Bad Key": "x"},
            {"code": "unknown_driver", "driver": "nope"},
        ),
    ],
)
def test_a_node_error_is_passed_on_only_in_the_expected_shape(
    node_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    error: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    async def ssh_command(*args: Any, **kwargs: Any) -> str:
        return json.dumps({"protocol": 1, "error": error})

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    assert check(node_client).json()["error"] == expected


async def test_node_finished_rows_normalize_cluster(monkeypatch: pytest.MonkeyPatch) -> None:
    source = {"id": "c-alice", "cluster_id": "c", "driver": "slurm"}

    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "batch": {"finished": [{"id": "c:1", "source_id": "c-alice", "state": "COMPLETED"}]}
        }

    monkeypatch.setattr(nodes, "request", request)
    batch = await nodes.collect(NODE, source)
    assert batch.finished and batch.finished[0]["cluster_id"] == "c"
