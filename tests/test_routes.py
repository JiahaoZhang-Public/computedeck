"""Routes: sources reached through an SSH jump host, collected by this machine."""

import asyncio
import shlex
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any, ClassVar, Literal

import pytest
from fastapi.testclient import TestClient

from computedeck import app as api
from computedeck import cli, config, demo, doctor, drivers, routes
from computedeck.collector import Collector
from computedeck.drivers import ssh
from computedeck.drivers.base import Batch, SourceError
from computedeck.plugins import Runtime
from computedeck.records import SourceInput, source_record
from computedeck.ssh_config import validate_alias
from computedeck.store import Store
from computedeck.tools import notify

HEADERS = {"Origin": "http://127.0.0.1:8710", "X-ComputeDeck": "1"}
BASTION = {
    "id": "campus-bastion",
    "name": "Campus bastion",
    "ssh_alias": "campus-bastion",
    "command": "computedeck",
    "mode": "jump",
    "status": "unchecked",
    "version": None,
    "drivers": [],
    "checked_at": None,
    "error": None,
}
HOP = ["ssh", *ssh.STRICT, "-W", "[%h]:%p", "--", "campus-bastion"]


class Finished:
    """A finished ssh process: what ``create_subprocess_exec`` returns in these tests."""

    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0) -> None:
        self.stdin = None
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stderr.feed_data(stderr)
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.returncode = returncode
        self.pid = 0

    async def wait(self) -> int:
        return self.returncode


@pytest.fixture
def argv(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, ...]]:
    """The argument vectors of the ssh processes started."""
    calls: list[tuple[str, ...]] = []

    async def create(*args: str, **kwargs: Any) -> Finished:
        calls.append(args)
        return Finished(b"ok\n")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    return calls


def proxy(args: tuple[str, ...]) -> list[str] | None:
    """The ProxyCommand an argument vector sets, split as the shell would."""
    values = [value for value in args if value.startswith("ProxyCommand=")]
    return shlex.split(values[0].removeprefix("ProxyCommand=")) if values else None


# ---- The SSH argument vector ----


async def test_a_routed_command_goes_through_a_strict_jump_hop(
    argv: list[tuple[str, ...]],
) -> None:
    with ssh.through("campus-bastion"):
        await ssh.ssh_command("cluster-a", "squeue --me", ["-l", "alice"])
    [args] = argv
    assert args == (
        "ssh",
        "-T",
        *ssh.STRICT,
        "-o",
        f"ProxyCommand={shlex.join(HOP)}",
        "-l",
        "alice",
        "--",
        "cluster-a",
        "squeue --me",
    )
    # The hop is as strict as the connection: no prompt, verified keys, a bounded wait.
    hop = proxy(args)
    assert hop == HOP
    assert {"BatchMode=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=10"} <= set(hop)
    # %h and %p are left for OpenSSH; the shell sees them single-quoted.
    assert "'[%h]:%p'" in args[args.index("-o", len(ssh.STRICT) + 2) + 1]


async def test_the_route_ends_with_its_context_and_reaches_started_tasks(
    argv: list[tuple[str, ...]],
) -> None:
    with ssh.through("campus-bastion"):
        # Drivers may run commands in parallel tasks; those inherit the route.
        await asyncio.gather(ssh.run("cluster-a", "true"), ssh.run("cluster-b", "true"))
        task = asyncio.ensure_future(ssh.run("cluster-c", "true"))
        with ssh.through(None):
            await ssh.run("campus-bastion", "true")
    await task
    await ssh.run("cluster-a", "true")
    routed = {args[-2]: proxy(args) for args in argv}
    assert routed == {
        "cluster-a": None,  # the last command, after the context ended
        "cluster-b": HOP,
        "cluster-c": HOP,
        "campus-bastion": None,
    }
    assert proxy(argv[0]) == HOP


@pytest.mark.parametrize(
    "alias",
    [
        "-oProxyCommand=touch /tmp/x",
        "bastion;id",
        "bastion id",
        "bastion'",
        "$(id)",
        "%h",
        "bastion\n",
        "",
    ],
)
def test_a_jump_alias_cannot_become_an_option_or_shell_text(alias: str) -> None:
    if not alias:
        # Empty means no route at all.
        with ssh.through(alias):
            assert ssh.route_options() == []
        return
    with pytest.raises(ValueError):
        ssh.through(alias)


async def test_destination_user_and_command_stay_single_arguments(
    argv: list[tuple[str, ...]],
) -> None:
    command = "squeue --me; echo '$(id)' -oProxyCommand=x"
    with ssh.through("campus-bastion"):
        await ssh.ssh_command("cluster-a", command, ["-l", "alice"])
    [args] = argv
    # The destination follows "--", and the remote command is one argument after it.
    assert args[-3:] == ("--", "cluster-a", command)
    # Nothing of the command or the user reaches the hop's shell command.
    assert "alice" not in " ".join(proxy(args) or []) and "squeue" not in str(proxy(args))
    assert [value for value in args if value.startswith("ProxyCommand=")] == [
        f"ProxyCommand={shlex.join(HOP)}"
    ]


@pytest.mark.skipif(shutil.which("ssh") is None, reason="needs the OpenSSH client")
def test_openssh_lets_the_route_replace_the_hosts_own_proxy(tmp_path: Path) -> None:
    """``ssh -G`` resolves the configuration without connecting."""
    settings = tmp_path / "ssh_config"
    settings.write_text(
        "Host cluster-a\n    HostName 192.0.2.10\n    ProxyJump other-gateway\n"
        "Host cluster-b\n    HostName 192.0.2.11\n    ProxyCommand nc %h %p\n"
    )
    for alias in ("cluster-a", "cluster-b"):
        with ssh.through("campus-bastion"):
            options = ssh.route_options()
        result = subprocess.run(
            ["ssh", "-G", "-F", str(settings), *options, "--", alias],
            capture_output=True,
            text=True,
            check=True,
            stdin=subprocess.DEVNULL,
        )
        resolved = dict(line.split(" ", 1) for line in result.stdout.splitlines() if " " in line)
        assert shlex.split(resolved["proxycommand"]) == HOP
        assert "proxyjump" not in resolved


# ---- Which sources a jump host can carry ----


@pytest.mark.parametrize(
    ("driver", "alias", "expected"),
    [
        ("slurm", "cluster-a", True),
        ("pbs", "cluster-c", True),
        ("ssh", "gpu-box", True),
        ("kubernetes", "kube-login", True),
        ("kubernetes", "", False),
        ("runpod", "", False),
        ("aws-ec2", "", False),
        ("slurm", "", False),
        ("no-such-driver", "cluster-a", False),
    ],
)
def test_only_sources_that_connect_over_ssh_can_use_a_jump_host(
    driver: str, alias: str, expected: bool
) -> None:
    assert routes.applies({"driver": driver, "ssh_alias": alias}) is expected


def test_nodes_stored_without_a_mode_collect() -> None:
    assert routes.mode({"id": "old"}) == "collect"
    assert routes.mode(None) == "collect"
    assert routes.mode({"mode": "jump"}) == "jump"
    assert routes.jump_alias(BASTION) == "campus-bastion"
    assert routes.jump_alias({**BASTION, "mode": "collect"}) is None


# ---- Telling the hops apart ----


async def test_an_unreachable_jump_host_is_named(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_ssh(monkeypatch, bastion=False)
    error = await routes.blame(BASTION, SourceError("ssh_failed", "Connection closed"))
    assert isinstance(error, SourceError)
    assert error.message() == {
        "code": "route_unreachable",
        "node": "Campus bastion",
        "detail": "ssh: connect to host 192.0.2.1 port 22: Connection refused",
    }
    # The jump host is reached on its own, not through itself.
    assert calls == [("campus-bastion", "true", [])]


async def test_a_failure_beyond_the_jump_host_keeps_its_code_and_names_the_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_ssh(monkeypatch)
    error = await routes.blame(BASTION, SourceError("ssh_failed", "Permission denied", host="x"))
    assert isinstance(error, SourceError)
    assert error.message() == {
        "code": "ssh_failed",
        "host": "x",
        "via": "Campus bastion",
        "detail": "Permission denied",
    }
    raw = await routes.blame(BASTION, ssh.SSHError("Permission denied (publickey).", 255))
    assert isinstance(raw, SourceError)
    assert (raw.code, raw.params) == ("ssh_authentication", {"via": "Campus bastion"})
    # Not an SSH failure: reported as it is.
    other = SourceError("scheduler_unavailable")
    assert await routes.blame(BASTION, other) is other


# ---- Collection ----


class SSHDriver:
    """A driver that runs one command over the source's alias, like the built-in ones."""

    name: ClassVar[str] = "slurm"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cluster"
    info = drivers.get("slurm").info
    fail = False

    def validate(self, source: dict[str, Any]) -> None:
        pass

    async def collect(self, source: dict[str, Any]) -> Batch:
        try:
            await ssh.run(source["ssh_alias"], "squeue --me")
        except ssh.SSHError as error:
            raise SourceError("ssh_failed", str(error)) from None
        job = {
            "id": f"{source['cluster_id']}:7",
            "state": "RUNNING",
            "gpu_count": 1,
            "source_id": source["id"],
            "cluster_id": source["cluster_id"],
        }
        return Batch(jobs=[job], capabilities=["jobs"])


def routed_source(**changes: Any) -> dict[str, Any]:
    source = source_record(
        SourceInput(
            name="Cluster B",
            driver="slurm",
            username="alice",
            ssh_alias="cluster-b",
            node="campus-bastion",
        )
    )
    source.update(status="ready", **changes)
    return source


@pytest.fixture
def collector(store: Store, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Collector:
    monkeypatch.setattr(drivers, "get", lambda name: SSHDriver())
    runtime = Runtime(tmp_path)
    runtime.store = store
    store.save_node(BASTION)
    store.save_source(routed_source())
    return Collector(runtime)


def fake_ssh(
    monkeypatch: pytest.MonkeyPatch, *, bastion: bool = True, target: str | None = None
) -> list[tuple[str, str, list[str]]]:
    """ssh_command that fails for an unreachable bastion or target, recording each call."""
    calls: list[tuple[str, str, list[str]]] = []

    async def ssh_command(destination: str, command: str, *args: Any, **kwargs: Any) -> str:
        route = ssh.route_options()
        calls.append((destination, command, route))
        if not bastion and (destination == "campus-bastion" or route):
            raise ssh.SSHError("ssh: connect to host 192.0.2.1 port 22: Connection refused", 255)
        if target and destination != "campus-bastion":
            raise ssh.SSHError(target, 255)
        return ""

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    return calls


async def test_a_routed_source_is_collected_here_through_the_jump_host(
    collector: Collector, store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_ssh(monkeypatch)
    source_id = routed_source()["id"]
    await collector.collect(source_id)
    source = store.source(source_id)
    assert source is not None and source["status"] == "ready", source
    assert [job["id"] for job in store.dashboard()["jobs"]] == ["cluster-b:7"]
    # One routed command; the jump host is not contacted separately on success.
    assert [(destination, proxy(tuple(route))) for destination, _, route in calls] == [
        ("cluster-b", HOP)
    ]
    node = store.node("campus-bastion")
    assert node is not None
    assert node["status"] == "ok" and node["error"] is None
    assert node["checked_at"] and node["last_collected_at"] == node["checked_at"]
    assert node["version"] is None and node["drivers"] == []


async def test_an_unreachable_jump_host_fails_the_source_and_the_node(
    collector: Collector, store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_ssh(monkeypatch, bastion=False)
    source_id = routed_source()["id"]
    await collector.collect(source_id)
    source = store.source(source_id)
    assert source is not None and source["status"] == "error"
    assert source["error"] == {
        "code": "route_unreachable",
        "node": "Campus bastion",
        "detail": "ssh: connect to host 192.0.2.1 port 22: Connection refused",
    }
    # The routed command, then the jump host alone, once.
    assert [destination for destination, _, _ in calls] == ["cluster-b", "campus-bastion"]
    node = store.node("campus-bastion")
    assert node is not None and node["status"] == "error"
    assert node["error"]["code"] == "route_unreachable" and node["checked_at"]


async def test_a_failure_beyond_the_jump_host_is_not_blamed_on_it(
    collector: Collector, store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_ssh(monkeypatch, target="Permission denied (publickey).")
    source_id = routed_source()["id"]
    await collector.collect(source_id)
    source = store.source(source_id)
    assert source is not None
    assert source["error"] == {
        "code": "ssh_failed",
        "via": "Campus bastion",
        "detail": "Permission denied (publickey).",
    }
    node = store.node("campus-bastion")
    assert node is not None and node["status"] == "ok" and node["error"] is None
    assert "last_collected_at" not in node


async def test_a_jump_host_edited_during_collection_discards_the_result(
    collector: Collector, store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def ssh_command(destination: str, command: str, *args: Any, **kwargs: Any) -> str:
        store.save_node({**BASTION, "ssh_alias": "other-bastion"})
        return ""

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    source_id = routed_source()["id"]
    await collector.collect(source_id)
    source = store.source(source_id)
    assert source is not None and source["status"] == "ready" and not source.get("last_success")
    assert store.dashboard()["jobs"] == []


async def test_an_instance_of_a_routed_source_is_checked_through_the_jump_host(
    collector: Collector, store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[list[str]] = []

    async def probe(instance: dict[str, Any]) -> dict[str, Any]:
        seen.append(ssh.route_options())
        return {"ssh_status": "reachable"}

    monkeypatch.setattr("computedeck.collector.probe_instance", probe)
    source_id = routed_source()["id"]
    await collector._probe({"source_id": source_id, "host": "cluster-b"})
    await collector._probe({"source_id": "manual", "host": "192.0.2.20"})
    assert [proxy(tuple(route)) for route in seen] == [HOP, None]

    async def refused(instance: dict[str, Any]) -> dict[str, Any]:
        raise SourceError("ssh_refused", "Connection refused")

    monkeypatch.setattr("computedeck.collector.probe_instance", refused)
    fake_ssh(monkeypatch)
    with pytest.raises(SourceError) as error:
        await collector._probe({"source_id": source_id, "host": "cluster-b"})
    assert error.value.params == {"via": "Campus bastion"}


async def test_job_logs_of_a_routed_source_are_read_through_the_jump_host(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.save_node(BASTION)
    source = routed_source(id="cluster-b-alice")
    store.save_source(source)
    routed: list[list[str]] = []

    async def run(alias: str, command: str) -> str:
        routed.append(ssh.route_options())
        return "   StdOut=/home/alice/logs/eval.out" if command.startswith("scontrol") else "done\n"

    monkeypatch.setattr(notify.ssh, "run", run)
    event = {"source_id": source["id"], "data": {"job": {"id": "cluster-b:41"}}}
    assert await notify.job_log(store, event) == "done\n"
    assert [proxy(tuple(route)) for route in routed] == [HOP, HOP]


# ---- The API ----


@pytest.fixture
def client(tmp_path: Path) -> Any:
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as value:
        yield value


def call(client: TestClient, method: str, path: str, body: Any = None) -> Any:
    return client.request(method, path, json={} if body is None else body, headers=HEADERS)


JUMP = {"name": "Campus bastion", "ssh_alias": "campus-bastion", "mode": "jump"}
CLUSTER = {
    "name": "Cluster B",
    "driver": "slurm",
    "username": "alice",
    "ssh_alias": "cluster-b",
    "node": "campus-bastion",
}


def test_nodes_have_a_mode_and_jump_hosts_report_no_version(
    client: TestClient, tmp_path: Path
) -> None:
    created = call(client, "POST", "/api/nodes", JUMP).json()
    assert (created["mode"], created["version"], created["drivers"]) == ("jump", None, [])
    assert created["command"] == "computedeck"
    plain = call(client, "POST", "/api/nodes", {"name": "Lab gateway", "ssh_alias": "gw"}).json()
    assert plain["mode"] == "collect"
    bad = call(client, "POST", "/api/nodes", {**JUMP, "name": "Other", "mode": "relay"})
    assert bad.status_code == 422
    # A node stored before modes existed is a collection machine.
    store = Store(tmp_path / "computedeck.sqlite")
    legacy = {key: value for key, value in BASTION.items() if key != "mode"}
    store.save_node({**legacy, "id": "legacy", "name": "Legacy"})
    store.db.close()
    rows = {row["id"]: row["mode"] for row in client.get("/api/nodes").json()}
    assert rows == {"campus-bastion": "jump", "lab-gateway": "collect", "legacy": "collect"}


@pytest.mark.parametrize(
    "source",
    [
        {"name": "RunPod", "driver": "runpod", "credential": "env:RUNPOD_API_KEY"},
        {"name": "Kube", "driver": "kubernetes", "username": "ml-team"},
        {"name": "EC2", "driver": "aws-ec2", "options": {"region": "us-east-1"}},
        {"name": "Off", "driver": "slurm", "username": "alice", "enabled": False},
    ],
)
def test_a_source_without_ssh_cannot_use_a_jump_host(
    client: TestClient, source: dict[str, Any]
) -> None:
    assert call(client, "POST", "/api/nodes", JUMP).status_code == 201
    reply = call(client, "POST", "/api/sources", {**source, "node": "campus-bastion"})
    assert reply.status_code == 422
    assert reply.json()["detail"] == {"code": "route_not_applicable", "node": "Campus bastion"}
    # Directly, or on a collection machine, the same source is fine.
    assert call(client, "POST", "/api/sources", source).status_code == 201


def test_a_routed_source_is_saved_and_cannot_lose_its_ssh_connection(
    client: TestClient,
) -> None:
    assert call(client, "POST", "/api/nodes", JUMP).status_code == 201
    created = call(client, "POST", "/api/sources", CLUSTER)
    assert created.status_code == 201, created.text
    source_id = created.json()["id"]
    kube = call(
        client,
        "POST",
        "/api/sources",
        {"name": "Kube", "driver": "kubernetes", "username": "ml-team", "ssh_alias": "kube-login"},
    ).json()
    edited = call(client, "PUT", f"/api/sources/{kube['id']}", {"node": "campus-bastion"})
    assert edited.status_code == 200, edited.text
    emptied = call(client, "PUT", f"/api/sources/{kube['id']}", {"ssh_alias": ""})
    assert emptied.json()["detail"]["code"] == "route_not_applicable"
    assert call(client, "PUT", f"/api/sources/{source_id}", {"node": ""}).status_code == 200


def test_credentials_of_a_routed_source_resolve_on_this_machine(client: TestClient) -> None:
    assert call(client, "POST", "/api/nodes", JUMP).status_code == 201
    gateway = {"name": "Lab gateway", "ssh_alias": "lab-gateway"}
    assert call(client, "POST", "/api/nodes", gateway).status_code == 201
    # A scheme only a collection machine has is accepted there, not through a jump host.
    on_node = {**CLUSTER, "node": "lab-gateway", "credential": "shell:CLUSTER_KEY"}
    assert call(client, "POST", "/api/sources", on_node).status_code == 201
    routed = {**CLUSTER, "username": "bob", "credential": "shell:CLUSTER_KEY"}
    reply = call(client, "POST", "/api/sources", routed)
    assert reply.status_code == 422
    assert reply.json()["detail"]["code"] == "invalid_credential_reference"


def test_the_mode_of_a_node_in_use_cannot_change(client: TestClient) -> None:
    assert call(client, "POST", "/api/nodes", JUMP).status_code == 201
    assert call(client, "POST", "/api/sources", CLUSTER).status_code == 201
    changed = call(client, "PUT", "/api/nodes/campus-bastion", {**JUMP, "mode": "collect"})
    assert changed.status_code == 409
    assert changed.json()["detail"] == {"code": "node_mode_in_use"}
    # An edit that does not name the mode keeps it.
    renamed = call(
        client, "PUT", "/api/nodes/campus-bastion", {**JUMP, "name": "Bastion", "mode": None}
    )
    assert renamed.status_code == 200 and renamed.json()["mode"] == "jump"
    unnamed = {key: value for key, value in JUMP.items() if key != "mode"}
    assert call(client, "PUT", "/api/nodes/campus-bastion", unnamed).json()["mode"] == "jump"
    # Not in use: the kind can change.
    spare = {"name": "Spare", "ssh_alias": "spare"}
    assert call(client, "POST", "/api/nodes", spare).status_code == 201
    switched = call(client, "PUT", "/api/nodes/spare", {**spare, "mode": "jump"}).json()
    assert (switched["mode"], switched["version"], switched["drivers"]) == ("jump", None, [])


def test_checking_a_jump_host_reaches_it_from_this_machine(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert call(client, "POST", "/api/nodes", JUMP).status_code == 201
    calls = fake_ssh(monkeypatch)
    checked = call(client, "POST", "/api/nodes/campus-bastion/check").json()
    assert (checked["status"], checked["error"], checked["mode"]) == ("ok", None, "jump")
    assert checked["checked_at"] and checked["version"] is None
    assert calls == [("campus-bastion", "true", [])]
    fake_ssh(monkeypatch, bastion=False)
    failed = call(client, "POST", "/api/nodes/campus-bastion/check").json()
    assert failed["status"] == "error"
    assert failed["error"] == {
        "code": "route_unreachable",
        "node": "Campus bastion",
        "detail": "ssh: connect to host 192.0.2.1 port 22: Connection refused",
    }


def test_a_jump_host_check_is_discarded_when_its_mode_changes(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert call(client, "POST", "/api/nodes", JUMP).status_code == 201

    async def reach(node: dict[str, Any]) -> None:
        other = Store(tmp_path / "computedeck.sqlite")
        other.save_node({**other.node("campus-bastion"), "mode": "collect"})  # type: ignore[dict-item]
        other.db.close()

    monkeypatch.setattr(routes, "reach", reach)
    response = call(client, "POST", "/api/nodes/campus-bastion/check")
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "node_changed", "node": "Campus bastion"}


def test_ssh_hosts_are_listed_from_the_service_users_config(
    client: TestClient, isolated: Path
) -> None:
    assert client.get("/api/ssh/hosts").json() == {"hosts": [], "readable": False}
    ssh_dir = isolated / ".ssh"
    ssh_dir.mkdir()
    (ssh_dir / "config").write_text(
        "Host cluster-a\n  HostName login.cluster-a.example.org\n  User alice\n"
        "  IdentityFile ~/.ssh/id_cluster\n"
    )
    assert client.get("/api/ssh/hosts").json() == {
        "hosts": [
            {
                "alias": "cluster-a",
                "hostname": "login.cluster-a.example.org",
                "user": "alice",
                "proxy_jump": None,
            }
        ],
        "readable": True,
    }
    # Example data never reads the disk.
    assert client.get("/api/ssh/hosts?demo=true").json() == {
        "hosts": demo.ssh_hosts(),
        "readable": True,
    }


def test_ssh_hosts_need_the_token_like_the_rest_of_the_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COMPUTEDECK_AUTH", "token")
    with TestClient(api.create_app(tmp_path, polling=False, plugins=[])) as secured:
        assert secured.get("/api/ssh/hosts").status_code == 401
        assert secured.get("/api/ssh/hosts?demo=true").status_code == 401


# ---- Connection checks ----


@pytest.fixture
def routed_checks(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str, list[str]]]:
    calls: list[tuple[str, str, list[str]]] = []

    async def config(alias: str, options: list[str]) -> dict[str, str]:
        calls.append((alias, "ssh -G", ssh.route_options()))
        # As OpenSSH resolves it with the route's ProxyCommand.
        return {"hostname": "10.1.0.5", "port": "22", "proxycommand": "ssh -W ..."}

    async def run(alias: str, command: str, options: list[str] | None = None) -> str:
        calls.append((alias, command, ssh.route_options()))
        return "" if command == "true" else "/usr/bin/command\n"

    monkeypatch.setattr(doctor, "ssh_config", config)
    monkeypatch.setattr(doctor.shutil, "which", lambda _: "/usr/bin/ssh")
    monkeypatch.setattr(ssh, "run", run)
    return calls


def checks_source() -> dict[str, Any]:
    return {**routed_source(), "id": "cluster-b-alice"}


async def test_a_routed_source_checks_the_jump_host_first_then_goes_through_it(
    routed_checks: list[Any],
) -> None:
    rows = await doctor.source_checks(checks_source(), BASTION)
    assert [row["id"] for row in rows] == [
        "route",
        "ssh",
        "ssh_alias",
        "ssh_login",
        "command:squeue",
        "command:scontrol",
        "command:sacctmgr",
        "command:sacct",
    ]
    assert all(row["state"] == "ok" for row in rows)
    assert rows[0]["label"] == {
        "en": "Reach Campus bastion from this computer",
        "zh-CN": "从本机连接 Campus bastion",
    }
    # The jump host alone, then everything else through it.
    assert routed_checks[0] == ("campus-bastion", "true", [])
    assert all(proxy(tuple(route)) == HOP for _, _, route in routed_checks[1:])
    assert routed_checks[1][:2] == ("cluster-b", "ssh -G")


@pytest.mark.parametrize(
    ("error", "hint"),
    [
        ("Permission denied (publickey).", "rejected this computer's login"),
        ("Host key verification failed.", "host key of Campus bastion"),
        ("ssh: connect to host 192.0.2.1 port 22: No route to host", "unreachable from this"),
        ("ssh: connect to host 192.0.2.1 port 22: Connection refused", "refused the connection"),
        ("Connection timed out during banner exchange", "did not answer in time"),
        ("Something unexpected", "without a prompt"),
    ],
)
async def test_an_unreachable_jump_host_stops_with_guidance(
    routed_checks: list[Any], monkeypatch: pytest.MonkeyPatch, error: str, hint: str
) -> None:
    async def run(alias: str, command: str, options: list[str] | None = None) -> str:
        raise ssh.SSHError(error, 255)

    monkeypatch.setattr(ssh, "run", run)
    rows = await doctor.source_checks(checks_source(), BASTION)
    [row] = rows
    assert (row["id"], row["state"]) == ("route", "failed")
    assert hint in row["detail"]["en"] and row["detail"]["zh-CN"]
    assert row["command"] == (
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -- campus-bastion true"
    )


@pytest.mark.parametrize(
    ("error", "hint"),
    [
        ("Permission denied (publickey).", "the target rejected the login"),
        ("channel 0: open failed: connect failed: No route to host", "could not reach the target"),
        ("ssh: connect to host 10.1.0.5 port 22: Connection refused", "from Campus bastion"),
        ("kex_exchange_identification: Connection closed by remote host", "AllowTcpForwarding"),
        ("stdio forwarding failed", "goes from Campus bastion to the target"),
    ],
)
async def test_a_failure_beyond_the_jump_host_says_so(
    routed_checks: list[Any], monkeypatch: pytest.MonkeyPatch, error: str, hint: str
) -> None:
    async def run(alias: str, command: str, options: list[str] | None = None) -> str:
        if alias == "campus-bastion":
            return ""
        raise ssh.SSHError(error, 255)

    monkeypatch.setattr(ssh, "run", run)
    rows = await doctor.source_checks(checks_source(), BASTION)
    assert [(row["id"], row["state"]) for row in rows] == [
        ("route", "ok"),
        ("ssh", "ok"),
        ("ssh_alias", "ok"),
        ("ssh_login", "failed"),
    ]
    assert hint in rows[-1]["detail"]["en"] and rows[-1]["detail"]["zh-CN"]
    assert rows[-1]["command"] == (
        "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -J campus-bastion "
        "-l alice -- cluster-b true"
    )


async def test_a_missing_command_beyond_the_jump_host_names_it(
    routed_checks: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def run(alias: str, command: str, options: list[str] | None = None) -> str:
        # Logins work; `command -v` prints nothing, so no command is found.
        return ""

    monkeypatch.setattr(ssh, "run", run)
    rows = await doctor.source_checks(checks_source(), BASTION)
    squeue = next(row for row in rows if row["id"] == "command:squeue")
    assert squeue["state"] == "failed"
    assert squeue["detail"]["en"].endswith("collecting host, reached through Campus bastion.")
    direct = await doctor.source_checks({**checks_source(), "node": ""})
    plain = next(row for row in direct if row["id"] == "command:squeue")
    assert plain["detail"]["en"].endswith("on the collecting host.")


async def test_an_unusable_jump_alias_is_reported_before_connecting(
    routed_checks: list[Any],
) -> None:
    rows = await doctor.source_checks(checks_source(), {**BASTION, "ssh_alias": "-oX=y"})
    assert [(row["id"], row["state"]) for row in rows] == [("route", "failed")]
    assert routed_checks == []


async def test_a_collection_machine_keeps_its_node_row(
    routed_checks: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def collect(node: dict[str, Any], source: dict[str, Any]) -> Batch:
        return Batch(capabilities=["jobs"])

    monkeypatch.setattr(doctor.nodes, "collect", collect)
    rows = await doctor.source_checks(checks_source(), {**BASTION, "mode": "collect"})
    assert rows[0]["id"] == "node" and "route" not in [row["id"] for row in rows]
    assert routed_checks == []


def test_doctor_prints_the_route_row(
    tmp_path: Path, routed_checks: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    data = tmp_path / "data"
    store = Store(data / "computedeck.sqlite")
    store.save_node(BASTION)
    store.save_source(checks_source())
    store.db.close()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    arguments = ["--data-dir", str(data), "doctor", "--source", "cluster-b-alice"]
    assert cli.main([*arguments, "--port", str(port)]) == 0
    assert "PASS: cluster-b-alice: Reach Campus bastion from this computer" in (
        capsys.readouterr().out
    )


# ---- The configuration file ----

ROUTED_CONFIG = """
[[node]]
id = "campus-bastion"
name = "Campus bastion"
ssh_alias = "campus-bastion"
mode = "jump"

[[node]]
id = "lab-gateway"
name = "Lab gateway"
ssh_alias = "lab-gateway"

[[cluster]]
id = "cluster-b"
label = "Cluster B"
driver = "slurm"
username = "alice"
ssh_alias = "cluster-b"
node = "campus-bastion"
"""


def test_jump_hosts_round_trip_through_the_configuration_file(store: Store, tmp_path: Path) -> None:
    assert config.apply(store, ROUTED_CONFIG) == {"sources": 1, "instances": 0, "nodes": 2}
    assert {node["id"]: node["mode"] for node in store.nodes()} == {
        "campus-bastion": "jump",
        "lab-gateway": "collect",
    }
    exported = config.export(store)
    # Only a mode other than the default is written, so older versions read the file.
    assert exported.count("mode = ") == 1 and 'mode = "jump"' in exported
    copy = Store(tmp_path / "copy.sqlite")
    config.apply(copy, exported)
    assert config.export(copy) == exported
    assert copy.node("campus-bastion")["mode"] == "jump"  # type: ignore[index]
    copy.db.close()


def test_the_configuration_file_cannot_route_a_source_without_ssh(store: Store) -> None:
    text = ROUTED_CONFIG + (
        '\n[[cloud]]\nid = "runpod"\nlabel = "RunPod"\ndriver = "runpod"\n'
        'credential = "env:RUNPOD_API_KEY"\nnode = "campus-bastion"\n'
    )
    with pytest.raises(config.ConfigError, match="SSH jump host"):
        config.apply(store, text)
    assert store.sources() == [] and store.nodes() == []
    with pytest.raises(config.ConfigError, match="mode"):
        config.apply(store, ROUTED_CONFIG.replace('mode = "jump"', 'mode = "relay"'))


def test_the_configuration_file_cannot_change_the_mode_of_a_node_in_use(store: Store) -> None:
    config.apply(store, ROUTED_CONFIG)
    store.save_node({**store.node("campus-bastion"), "status": "ok"})  # type: ignore[dict-item]
    with pytest.raises(config.ConfigError, match="cannot change mode"):
        config.apply(store, ROUTED_CONFIG.replace('mode = "jump"\n', ""))
    # Unused, a node changes kind and forgets what it reported as the other kind.
    unused = ROUTED_CONFIG.split("[[cluster]]")[0]
    gateway = unused.replace(
        'ssh_alias = "lab-gateway"', 'ssh_alias = "lab-gateway"\nmode = "jump"'
    )
    store.save_node({**store.node("lab-gateway"), "version": "0.7.0", "drivers": ["slurm"]})  # type: ignore[dict-item]
    config.apply(store, gateway)
    node = store.node("lab-gateway")
    assert node is not None
    assert (node["mode"], node["version"], node["drivers"]) == ("jump", None, [])
    assert store.node("campus-bastion")["status"] == "ok"  # type: ignore[index]


# ---- Example data and the command line ----


def test_the_example_data_routes_one_ssh_source_through_a_bastion() -> None:
    gateway, bastion = demo.nodes()
    assert gateway["mode"] == "collect" and gateway["version"]
    assert {key: bastion[key] for key in ("id", "name", "ssh_alias", "mode", "status")} == {
        "id": "example:campus-bastion",
        "name": "Campus bastion",
        "ssh_alias": "campus-bastion",
        "mode": "jump",
        "status": "ok",
    }
    assert (bastion["version"], bastion["drivers"], bastion["error"]) == (None, [], None)
    [routed] = [s for s in demo.dashboard()["sources"] if s["node"] == bastion["id"]]
    assert routed["id"] == "example:lab-server" and routed["status"] == "ready"
    assert routes.applies(routed)
    for host in demo.ssh_hosts():
        assert set(host) == {"alias", "hostname", "user", "proxy_jump"}
        assert validate_alias(host["alias"]) == host["alias"]


def test_version_flag(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit:
        cli.main(["--version"])
    assert exit.value.code == 0
    assert capsys.readouterr().out.startswith("computedeck ")


# ---- Moving another server's sources here: import --from ----

OLD_SERVER = """
language = "zh-CN"
server_name = "old-server"

[[cluster]]
id = "cluster-a"
label = "Cluster A"
driver = "slurm"
username = "alice"
ssh_alias = "cluster-a"

[[cloud]]
id = "runpod"
label = "RunPod"
driver = "runpod"
credential = "env:RUNPOD_API_KEY"

[[cloud]]
id = "lab-server"
label = "Lab server"
driver = "ssh"
ssh_alias = "lab-server"

[[instance]]
platform = "Lab workstation"
id = "devbox"
name = "dev-box"
host = "192.0.2.20"
port = 22
username = "alice"
"""


@pytest.fixture
def old_server(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[tuple[str, str, list[str]]]:
    """``computedeck export`` on the old server, answered from a store holding OLD_SERVER."""
    store = Store(tmp_path / "old.sqlite")
    config.apply(store, OLD_SERVER)
    exported = config.export(store)
    store.db.close()
    calls: list[tuple[str, str, list[str]]] = []

    async def ssh_command(destination: str, command: str, *args: Any, **kwargs: Any) -> str:
        calls.append((destination, command, ssh.route_options()))
        return "Welcome to the old server\n" + exported

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    return calls


def imported(tmp_path: Path, *arguments: str) -> tuple[int, Store]:
    code = cli.main(["--data-dir", str(tmp_path / "data"), "import", *arguments])
    return code, Store(tmp_path / "data" / "computedeck.sqlite")


@pytest.mark.parametrize(
    ("route", "routed"),
    [
        ("collect", {"cluster-a-alice", "runpod-runpod", "lab-server-ssh"}),
        ("jump", {"cluster-a-alice", "lab-server-ssh"}),
        ("direct", set()),
    ],
)
def test_another_servers_sources_are_reached_through_it(
    tmp_path: Path,
    old_server: list[Any],
    capsys: pytest.CaptureFixture[str],
    route: str,
    routed: set[str],
) -> None:
    code, store = imported(tmp_path, "--from", "old-server", "--route", route)
    assert code == 0, capsys.readouterr().err
    assert old_server == [("old-server", "computedeck export", [])]
    sources = {source["id"]: source["node"] for source in store.sources()}
    assert set(sources) == {"cluster-a-alice", "runpod-runpod", "lab-server-ssh"}
    assert {key for key, node in sources.items() if node} == routed
    nodes = store.nodes()
    if route == "direct":
        assert nodes == []
    else:
        [node] = nodes
        assert (node["id"], node["ssh_alias"], node["mode"]) == ("old-server", "old-server", route)
        assert all(node_id in ("", "old-server") for node_id in sources.values())
    # The old server's own settings and machines stay there.
    assert store.settings()["server_name"] != "old-server"
    assert store.manual_instances() == []
    assert "Imported 3 sources from old-server." in capsys.readouterr().out
    store.db.close()


def test_moving_again_updates_and_a_different_route_is_refused(
    tmp_path: Path, old_server: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    assert imported(tmp_path, "--from", "old-server")[0] == 0
    code, store = imported(tmp_path, "--from", "old-server")
    assert code == 0 and len(store.sources()) == 3
    store.db.close()
    code, store = imported(tmp_path, "--from", "old-server", "--route", "jump")
    assert code == 1
    assert "cannot change mode" in capsys.readouterr().err
    assert store.node("old-server")["mode"] == "collect"  # type: ignore[index]
    store.db.close()


def test_the_remote_command_and_alias_cannot_inject(
    tmp_path: Path, old_server: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    command = ["--command", "~/.local/bin/computedeck --data-dir /srv/computedeck"]
    code, store = imported(tmp_path, "--from", "old-server", *command)
    assert code == 0
    assert old_server[-1][1] == "~/.local/bin/computedeck --data-dir /srv/computedeck export"
    assert store.node("old-server")["command"] == command[1]  # type: ignore[index]
    store.db.close()
    for arguments in (
        ["--from", "-oProxyCommand=touch /tmp/x"],
        ["--from", "old-server", "--command", "computedeck; reboot"],
    ):
        code, store = imported(tmp_path, *arguments)
        store.db.close()
        assert code == 1 and "not plain text" in capsys.readouterr().err
    assert len(old_server) == 1


def test_a_server_that_routes_sources_itself_is_not_chained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def ssh_command(destination: str, command: str, *args: Any, **kwargs: Any) -> str:
        return ROUTED_CONFIG

    monkeypatch.setattr(ssh, "ssh_command", ssh_command)
    code, store = imported(tmp_path, "--from", "old-server")
    assert code == 1 and "routes through two machines" in capsys.readouterr().err
    assert store.sources() == [] and store.nodes() == []
    store.db.close()


def test_import_needs_a_file_or_a_server_and_reports_ssh_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    config_file = tmp_path / "config.toml"
    config_file.write_text(OLD_SERVER)
    data = ["--data-dir", str(tmp_path / "data"), "import"]
    assert cli.main(data) == 2
    assert cli.main([*data, str(config_file), "--from", "old-server"]) == 2

    async def unreachable(*args: Any, **kwargs: Any) -> str:
        raise ssh.SSHError("ssh: Could not resolve hostname old-server", 255)

    monkeypatch.setattr(ssh, "ssh_command", unreachable)
    assert cli.main([*data, "--from", "old-server"]) == 1
    assert "Could not run export on old-server: ssh: Could not resolve" in (capsys.readouterr().err)
