"""SSH host driver: one GPU machine through an existing SSH alias, collected read-only.

All sample outputs are hand-written from the documented nvidia-smi, rocm-smi and ps formats
and use fictional data.
"""

import json
import shlex
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from computedeck.drivers import ssh, ssh_host
from computedeck.drivers.base import SourceError
from computedeck.ssh_config import render_config

SOURCE: dict[str, Any] = {
    "id": "gpu-box-ssh",
    "name": "GPU box",
    "driver": "ssh",
    "cluster_id": "gpu-box",
    "username": "",
    "ssh_alias": "gpu-box",
    "credential": "",
    "options": {},
}
GPUS = (
    "0, GPU-0000aaaa, NVIDIA A100 80GB, 80, 40000, 81920\n"
    "1, GPU-1111bbbb, NVIDIA A100 80GB, 20, 1000, 81920\n"
)
APPS = "GPU-0000aaaa, 4242, 39000\nGPU-0000aaaa, 4343, [N/A]\n"
OWNERS = " 4242 alice\n 4343 bob\n"
AMD = {
    "card0": {"GPU use (%)": "35", "Card Series": "AMD Instinct MI210"},
    "card1": {"GPU use (%)": "N/A", "Card series": "AMD Instinct MI210"},
    "system": {"Driver version": "1.0.0"},
}
AMD_MEMORY = {
    "card0": {"VRAM Total Memory (B)": "68702699520", "VRAM Total Used Memory (B)": "10485760"},
    "card1": {"VRAM Total Memory (B)": "68702699520"},
}


def probe_output(**changes: Any) -> str:
    result: dict[str, Any] = {
        "cpu_utilization": 25.0,
        "memory_utilization": 40.0,
        "user": "alice",
        "gpu_tool": "nvidia-smi",
        "gpu": GPUS,
        "gpu_error": None,
        "amd_memory": None,
        "apps": APPS,
        "apps_error": None,
        "owners": OWNERS,
    }
    result.update(changes)
    return json.dumps(result)


def parse(**changes: Any) -> tuple[dict[str, Any], Any]:
    batch = ssh_host.parse_machine(probe_output(**changes), SOURCE, "gpu-box")
    assert batch.instances is not None and len(batch.instances) == 1
    return batch.instances[0], batch


def test_one_running_instance_with_gpus_and_processes() -> None:
    instance, batch = parse()
    assert batch.capabilities == ["instances", "gpu_processes"]
    assert batch.warnings == []
    assert batch.jobs is None and batch.nodes is None and batch.failures is None
    assert set(batch.snapshot()) == {"instances"}
    assert instance["id"] == "gpu-box:gpu-box"
    assert instance["source_id"] == "gpu-box-ssh"
    assert instance["platform"] == "GPU box"
    assert instance["name"] == "gpu-box"
    assert instance["state"] == "running"
    assert instance["ssh_status"] == "reachable"
    assert instance["last_probe_attempt"] == instance["observed_at"]
    assert instance["observed_at"]
    assert instance["gpu_count"] == 2
    assert instance["gpu_type"] == "NVIDIA A100 80GB"
    assert instance["gpu_utilization"] == 50
    assert instance["gpu_observed_count"] == 2
    assert instance["cpu_utilization"] == 25
    assert instance["memory_utilization"] == 40
    assert instance["metrics_scope"] == "host_visible"
    # The user's own alias, used as is; there is no endpoint or price to report.
    assert instance["ssh_alias"] == "gpu-box"
    assert instance["existing_alias"] is True
    assert instance["host"] == "gpu-box"
    assert instance["port"] is None
    assert instance["identity_file"] is None
    assert instance["username"] == "alice"
    assert instance["hourly_cost"] is None
    assert instance["currency"] == "USD"
    assert instance["gpus"] == [
        {
            "index": 0,
            "name": "NVIDIA A100 80GB",
            "utilization": 80,
            "memory_used_mb": 40000,
            "memory_total_mb": 81920,
            "processes": [
                {"pid": 4242, "user": "alice", "memory_mb": 39000},
                {"pid": 4343, "user": "bob", "memory_mb": None},
            ],
        },
        {
            "index": 1,
            "name": "NVIDIA A100 80GB",
            "utilization": 20,
            "memory_used_mb": 1000,
            "memory_total_mb": 81920,
            "processes": [],
        },
    ]


def test_existing_alias_adds_no_managed_host_block() -> None:
    instance, _ = parse()
    config = render_config([instance])
    assert "Host gpu-box" not in config
    assert "HostName" not in config


def test_unknown_gpu_values_are_not_zero() -> None:
    gpus = (
        "0, GPU-0000aaaa, NVIDIA L4, [N/A], [N/A], 23034\n1, GPU-1111bbbb, NVIDIA L4, 150, 0, 1\n"
    )
    instance, _ = parse(gpu=gpus, apps="")
    assert instance["gpu_count"] == 2
    assert instance["gpu_utilization"] is None
    assert instance["gpu_observed_count"] == 0
    first, second = instance["gpus"]
    assert first["utilization"] is None
    assert first["memory_used_mb"] is None
    assert first["memory_total_mb"] == 23034
    # Out-of-range utilization is not a measurement.
    assert second["utilization"] is None
    assert second["memory_used_mb"] == 0


def test_no_processes_is_an_empty_list_and_runs_no_ps() -> None:
    instance, batch = parse(apps="", owners=None)
    assert batch.capabilities == ["instances", "gpu_processes"]
    assert [gpu["processes"] for gpu in instance["gpus"]] == [[], []]


@pytest.mark.parametrize(
    "owners",
    [None, "", " 4343 bob\n", " 4242 averylongusern+\n 4343 bob\n", "garbage\n 4343 bob\n"],
)
def test_owner_ps_did_not_list_is_unknown(owners: str | None) -> None:
    instance, batch = parse(owners=owners)
    assert "gpu_processes" in batch.capabilities
    processes = instance["gpus"][0]["processes"]
    assert processes[0] == {"pid": 4242, "user": None, "memory_mb": 39000}
    assert processes[1]["user"] == ("bob" if owners and "bob" in owners else None)


def test_unreadable_processes_are_not_collected() -> None:
    instance, batch = parse(apps=None, apps_error="Insufficient Permissions", owners=None)
    assert batch.capabilities == ["instances"]
    assert batch.warnings == [
        {"code": "gpu_processes_unavailable", "detail": "Insufficient Permissions"}
    ]
    assert [gpu["processes"] for gpu in instance["gpus"]] == [None, None]
    # GPU metrics are still reported.
    assert instance["gpu_count"] == 2


@pytest.mark.parametrize(
    "apps",
    ["GPU-0000aaaa, 4242\n", "GPU-0000aaaa, pid, 10\n", "GPU-9999ffff, 4242, 10\n"],
)
def test_malformed_process_output_becomes_a_warning(apps: str) -> None:
    instance, batch = parse(apps=apps)
    assert batch.capabilities == ["instances"]
    assert [warning["code"] for warning in batch.warnings] == ["gpu_processes_unavailable"]
    assert [gpu["processes"] for gpu in instance["gpus"]] == [None, None]
    assert instance["gpu_utilization"] == 50


@pytest.mark.parametrize(
    "gpus",
    [
        "NVIDIA A100, 80\n",
        "0, GPU-0000aaaa, 80, 1, 2\n",
        "x, GPU-a, A100, 1, 1, 1\n",
    ],
)
def test_malformed_gpu_output_is_an_error(gpus: str) -> None:
    with pytest.raises(SourceError) as error:
        parse(gpu=gpus)
    assert error.value.message() == {"code": "unexpected_output", "command": "nvidia-smi"}


@pytest.mark.parametrize("output", ["not json", "[]", ""])
def test_malformed_probe_output_is_an_error(output: str) -> None:
    with pytest.raises(SourceError) as error:
        ssh_host.parse_machine(output, SOURCE, "gpu-box")
    assert error.value.message() == {"code": "unexpected_output", "command": "python3"}


def test_no_gpu_tool_leaves_gpus_unknown_and_keeps_host_metrics() -> None:
    instance, batch = parse(gpu_tool=None, gpu=None, apps=None, owners=None)
    assert batch.capabilities == ["instances"]
    assert batch.warnings == [{"code": "gpus_unavailable", "detail": "no nvidia-smi or rocm-smi"}]
    assert instance["gpus"] is None
    assert instance["gpu_count"] is None
    assert instance["gpu_type"] is None
    assert instance["gpu_utilization"] is None
    assert instance["gpu_observed_count"] == 0
    assert instance["cpu_utilization"] == 25
    assert instance["state"] == "running"


def test_failed_gpu_tool_reports_its_error() -> None:
    failure = "Failed to initialize NVML: Driver/library version mismatch"
    instance, batch = parse(gpu=None, gpu_error=failure, apps=None, owners=None)
    assert batch.warnings == [{"code": "gpus_unavailable", "detail": failure}]
    assert instance["gpu_count"] is None
    assert instance["gpus"] is None


def test_unknown_host_metrics_and_user_stay_unknown() -> None:
    instance, _ = parse(cpu_utilization=None, memory_utilization="n/a", user="bad user\n")
    assert instance["cpu_utilization"] is None
    assert instance["memory_utilization"] is None
    assert instance["username"] == ""


def test_amd_gpus_without_process_data() -> None:
    instance, batch = parse(
        gpu_tool="rocm-smi",
        gpu=json.dumps(AMD),
        amd_memory=json.dumps(AMD_MEMORY),
        apps=None,
        owners=None,
    )
    assert batch.capabilities == ["instances"]
    assert batch.warnings == [{"code": "gpu_processes_unavailable", "detail": "rocm-smi"}]
    assert instance["gpu_count"] == 2
    assert instance["gpu_type"] == "AMD Instinct MI210"
    assert instance["gpu_utilization"] == 35
    assert instance["gpu_observed_count"] == 1
    assert instance["gpus"] == [
        {
            "index": 0,
            "name": "AMD Instinct MI210",
            "utilization": 35,
            "memory_used_mb": 10,
            "memory_total_mb": 65520,
            "processes": None,
        },
        {
            "index": 1,
            "name": "AMD Instinct MI210",
            "utilization": None,
            "memory_used_mb": None,
            "memory_total_mb": 65520,
            "processes": None,
        },
    ]


@pytest.mark.parametrize("memory", [None, "not json"])
def test_amd_memory_unknown_without_meminfo(memory: str | None) -> None:
    instance, _ = parse(gpu_tool="rocm-smi", gpu=json.dumps(AMD), amd_memory=memory, apps=None)
    assert instance["gpu_count"] == 2
    assert {gpu["memory_total_mb"] for gpu in instance["gpus"]} == {None}


@pytest.mark.parametrize("text", ["[]", '"card0"', "not json"])
def test_malformed_amd_output_is_an_error(text: str) -> None:
    with pytest.raises(SourceError) as error:
        parse(gpu_tool="rocm-smi", gpu=text, apps=None)
    assert error.value.message() == {"code": "unexpected_output", "command": "rocm-smi"}


def test_validate_requires_a_safe_alias() -> None:
    driver = ssh_host.SSHHostDriver()
    driver.validate(SOURCE)
    with pytest.raises(SourceError, match="ssh_alias_required"):
        driver.validate({**SOURCE, "ssh_alias": ""})
    with pytest.raises(SourceError, match="invalid_ssh_alias"):
        driver.validate({**SOURCE, "ssh_alias": "-oProxyCommand=touch"})
    with pytest.raises(SourceError) as error:
        driver.validate({**SOURCE, "ssh_alias": "_hidden"})
    assert error.value.code == "invalid_endpoint"


def test_driver_description() -> None:
    driver = ssh_host.SSHHostDriver()
    assert driver.name == "ssh"
    assert driver.kind == "cloud"
    info = driver.info
    assert info.label["en"] and info.label["zh-CN"]
    assert info.description["en"] and info.description["zh-CN"]
    assert info.details["en"] and info.details["zh-CN"]
    [field] = info.fields
    assert field.key == "ssh_alias" and field.required
    assert field.placeholder == "gpu-box"
    assert {check.capability: check.warning for check in info.checks} == {
        "instances": None,
        "gpu_processes": "gpu_processes_unavailable",
    }


class RecordingSSH:
    def __init__(self, result: str | Exception) -> None:
        self.result = result
        self.calls: list[tuple[str, str, list[str] | None]] = []

    async def __call__(
        self, destination: str, command: str, options: list[str] | None = None
    ) -> str:
        self.calls.append((destination, command, options))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


async def test_collect_runs_one_read_only_probe_through_the_alias(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder = RecordingSSH(probe_output())
    monkeypatch.setattr(ssh, "run", recorder)
    batch = await ssh_host.SSHHostDriver().collect(SOURCE)
    assert batch.capabilities == ["instances", "gpu_processes"]
    assert batch.instances is not None and batch.instances[0]["id"] == "gpu-box:gpu-box"
    [(destination, command, options)] = recorder.calls
    # User, port, keys and ProxyJump all come from the user's own Host block.
    assert destination == "gpu-box"
    assert not options
    assert shlex.split(command) == ["python3", "-I", "-c", ssh_host._PROBE]


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (
            ssh.SSHError("Permission denied (publickey)."),
            {
                "code": "ssh_failed",
                "detail": "Permission denied (publickey).",
            },
        ),
        (TimeoutError(), {"code": "ssh_timeout"}),
    ],
)
async def test_unreachable_machine_is_an_error(
    monkeypatch: pytest.MonkeyPatch, failure: Exception, expected: dict[str, Any]
) -> None:
    monkeypatch.setattr(ssh, "run", RecordingSSH(failure))
    with pytest.raises(SourceError) as error:
        await ssh_host.SSHHostDriver().collect(SOURCE)
    assert error.value.message() == expected


@pytest.mark.parametrize("alias", ["-oProxyCommand=touch", "gpu-box -v", "gpu-box\nHost *", ""])
async def test_unsafe_alias_is_rejected_before_ssh(
    monkeypatch: pytest.MonkeyPatch, alias: str
) -> None:
    async def run(*args: Any) -> str:
        raise AssertionError("SSH must not run")

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(SourceError):
        await ssh_host.SSHHostDriver().collect({**SOURCE, "ssh_alias": alias})


def run_probe(tmp_path: Path, tools: dict[str, str]) -> tuple[str, list[str]]:
    """Run the embedded probe with fake GPU tools and ps first on PATH."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.log"
    for name, body in tools.items():
        tool = bin_dir / name
        tool.write_text(f'#!/bin/sh\necho "{name} $*" >> "$CALLS"\n{body}\n')
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    done = subprocess.run(
        [sys.executable, "-I", "-c", ssh_host._PROBE],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
        env={"PATH": str(bin_dir), "CALLS": str(log)},
    )
    return done.stdout, log.read_text().splitlines() if log.exists() else []


def test_embedded_probe_reads_nvidia_processes_and_owners(tmp_path: Path) -> None:
    nvidia = (
        'case "$1" in\n'
        "  --query-gpu=*) printf '0, GPU-0000aaaa, NVIDIA L4, 5, 100, 23034\\n' ;;\n"
        "  --query-compute-apps=*) printf 'GPU-0000aaaa, 4242, 90\\n' ;;\n"
        "esac"
    )
    output, calls = run_probe(
        tmp_path, {"nvidia-smi": nvidia, "ps": "printf ' 4242 alice\\n'", "rocm-smi": "exit 1"}
    )
    assert calls == [
        "nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total "
        "--format=csv,noheader,nounits",
        "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits",
        "ps -o pid=,user= -p 4242",
    ]
    batch = ssh_host.parse_machine(output, SOURCE, "gpu-box")
    assert batch.instances is not None
    [gpu] = batch.instances[0]["gpus"]
    assert gpu["processes"] == [{"pid": 4242, "user": "alice", "memory_mb": 90}]
    assert batch.capabilities == ["instances", "gpu_processes"]


def test_embedded_probe_reads_amd_without_ps(tmp_path: Path) -> None:
    rocm = (
        'case "$*" in\n'
        f"  *--showuse*) printf '%s' '{json.dumps(AMD)}' ;;\n"
        f"  *--showmeminfo*) printf '%s' '{json.dumps(AMD_MEMORY)}' ;;\n"
        "esac"
    )
    output, calls = run_probe(tmp_path, {"rocm-smi": rocm, "ps": "exit 1"})
    assert calls == [
        "rocm-smi --showproductname --showuse --json",
        "rocm-smi --showmeminfo vram --json",
    ]
    batch = ssh_host.parse_machine(output, SOURCE, "gpu-box")
    assert batch.instances is not None and batch.instances[0]["gpu_count"] == 2
    assert batch.instances[0]["gpus"][0]["memory_used_mb"] == 10


def test_embedded_probe_reports_a_failing_gpu_tool(tmp_path: Path) -> None:
    output, calls = run_probe(
        tmp_path, {"nvidia-smi": "echo 'NVIDIA-SMI has failed' >&2\nexit 9", "ps": "exit 1"}
    )
    assert len(calls) == 1
    batch = ssh_host.parse_machine(output, SOURCE, "gpu-box")
    assert batch.warnings == [{"code": "gpus_unavailable", "detail": "NVIDIA-SMI has failed"}]


def test_embedded_probe_runs_on_this_machine() -> None:
    done = subprocess.run(
        [sys.executable, "-I", "-c", ssh_host._PROBE],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    batch = ssh_host.parse_machine(done.stdout, SOURCE, "gpu-box")
    assert batch.instances is not None
    assert batch.instances[0]["ssh_status"] == "reachable"


def test_a_login_banner_before_the_result_is_ignored() -> None:
    output = "Welcome to gpu-box!\n{not json}\n" + ssh_host.MARKER + probe_output() + "\n"
    batch = ssh_host.parse_machine(output, SOURCE, "gpu-box")
    assert batch.instances is not None and batch.instances[0]["gpu_count"] == 2


def test_a_comma_in_a_gpu_name_keeps_the_gpu() -> None:
    gpus = GPUS.replace("NVIDIA A100 80GB", "NVIDIA A100, PCIe")
    instance, _ = parse(gpu=gpus)
    assert instance["gpu_count"] == 2
    assert instance["gpu_type"] and "NVIDIA A100, PCIe" in instance["gpu_type"]


@pytest.mark.parametrize(("apps", "expected"), [(APPS, 1), ("", 0), (None, None)])
def test_in_use_means_compute_processes_not_utilization(apps, expected):
    instance, _ = parse(apps=apps)
    assert instance["gpu_allocated"] == expected
    assert instance["gpu_count"] == 2
    # A high utilization sample without a listed process does not redefine this count.
    assert instance["gpu_utilization"] == 50
