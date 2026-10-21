"""SSH hardware probe: the SSH machine driver's probe, unknown is not zero, strict endpoints.

Parsing of nvidia-smi, rocm-smi and ps output is covered in test_ssh_host.py; these tests
cover what a check of one machine stores.
"""

import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from computedeck import hardware
from computedeck.drivers import ssh, ssh_host
from computedeck.drivers.base import SourceError

GPUS = (
    "0, GPU-0000aaaa, NVIDIA A100 80GB, 80, 40000, 81920\n"
    "1, GPU-1111bbbb, NVIDIA A100 80GB, [N/A], 1000, 81920\n"
)
AMD = {
    "card0": {"GPU use (%)": "35", "Card Series": "AMD Instinct MI250X"},
    "card1": {"GPU use (%)": "N/A", "Card Series": "AMD Instinct MI250X"},
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
        "apps": "GPU-0000aaaa, 4242, 39000\n",
        "apps_error": None,
        "owners": " 4242 alice\n",
    }
    result.update(changes)
    return ssh_host.MARKER + json.dumps(result)


def test_nvidia_reading_counts_gpus_with_processes_and_scope_is_explicit() -> None:
    result = hardware.parse_probe(probe_output())
    assert result["gpu_count"] == 2
    assert result["gpu_type"] == "NVIDIA A100 80GB"
    # The same convention as an SSH machine source: GPUs with compute processes.
    assert result["gpu_allocated"] == 1
    assert result["gpu_utilization"] == 80
    assert result["gpu_observed_count"] == 1
    assert result["cpu_utilization"] == 25
    assert result["memory_utilization"] == 40
    assert result["metrics_scope"] == "host_visible"
    assert result["ssh_status"] == "reachable"
    assert result["observed_at"]
    assert result["probe_warnings"] == []
    # A probe measures a host; it never claims a provider lifecycle state.
    assert "state" not in result
    # Process ids and their users are not kept.
    assert "gpus" not in result


def test_idle_gpus_are_zero_in_use_but_unreadable_processes_stay_unknown() -> None:
    assert hardware.parse_probe(probe_output(apps=""))["gpu_allocated"] == 0
    result = hardware.parse_probe(probe_output(apps=None, apps_error="Insufficient Permissions"))
    assert result["gpu_allocated"] is None
    assert result["gpu_count"] == 2
    assert result["probe_warnings"] == [
        {"code": "gpu_processes_unavailable", "detail": "Insufficient Permissions"}
    ]


def test_amd_gpus_in_use_are_unknown_with_a_reason() -> None:
    result = hardware.parse_probe(
        probe_output(gpu_tool="rocm-smi", gpu=json.dumps(AMD), apps=None, owners=None)
    )
    assert result["gpu_count"] == 2
    assert result["gpu_type"] == "AMD Instinct MI250X"
    assert result["gpu_utilization"] == 35
    assert result["gpu_allocated"] is None
    assert result["probe_warnings"] == [{"code": "gpu_processes_unavailable", "detail": "rocm-smi"}]


def test_no_gpu_tool_leaves_everything_unknown() -> None:
    missing = hardware.parse_probe(
        probe_output(
            gpu_tool=None, gpu=None, apps=None, cpu_utilization=None, memory_utilization=None
        )
    )
    assert missing["gpu_count"] is None
    assert missing["gpu_allocated"] is None
    assert missing["gpu_type"] is None
    assert missing["gpu_utilization"] is None
    assert missing["gpu_observed_count"] == 0
    assert missing["cpu_utilization"] is None
    assert missing["memory_utilization"] is None
    assert [warning["code"] for warning in missing["probe_warnings"]] == ["gpus_unavailable"]


@pytest.mark.parametrize("output", ["not json", "[]", probe_output(gpu="NVIDIA A100, 80\n")])
def test_unexpected_output_is_rejected(output: str) -> None:
    with pytest.raises(SourceError):
        hardware.parse_probe(output)


def test_embedded_probe_script_runs_and_parses() -> None:
    done = subprocess.run(
        [sys.executable, "-I", "-c", ssh_host._PROBE],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    result = hardware.parse_probe(done.stdout)
    assert result["ssh_status"] == "reachable"
    assert result["metrics_scope"] == "host_visible"


class RecordingSSH:
    def __init__(self, output: str) -> None:
        self.output = output
        self.calls: list[tuple[str, str, list[str] | None]] = []

    async def __call__(
        self, destination: str, command: str, options: list[str] | None = None
    ) -> str:
        self.calls.append((destination, command, options))
        return self.output


async def test_endpoint_probe_passes_port_user_and_identity(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    recorder = RecordingSSH(probe_output())
    monkeypatch.setattr(ssh, "run", recorder)
    result = await hardware.probe_instance(
        {
            "host": "192.0.2.10",
            "port": 2222,
            "username": "alice",
            "identity_file": "~/.ssh/id_ed25519",
        }
    )
    assert result["gpu_count"] == 2
    [(destination, command, options)] = recorder.calls
    assert destination == "192.0.2.10"
    assert options == ["-p", "2222", "-l", "alice", "-i", f"{tmp_path}/.ssh/id_ed25519"]
    # The SSH machine driver's read-only probe, run the same way.
    assert shlex.split(command) == ["python3", "-I", "-c", ssh_host._PROBE]


async def test_existing_alias_probe_uses_alias_without_port_or_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorder = RecordingSSH(probe_output())
    monkeypatch.setattr(ssh, "run", recorder)
    await hardware.probe_instance(
        {
            "existing_alias": True,
            "host": "gpu-box.lab",
            "port": 22,
            "username": "root",
            "identity_file": "~/.ssh/ignored",
        }
    )
    [(destination, _, options)] = recorder.calls
    assert destination == "gpu-box.lab"
    assert options == []


async def test_probe_without_gpu_tool_keeps_provider_inventory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ssh, "run", RecordingSSH(probe_output(gpu_tool=None, gpu=None)))
    result = await hardware.probe_instance({"host": "192.0.2.10", "port": 22, "username": "root"})
    # Absent keys leave the provider-reported GPU count and type untouched on merge.
    assert "gpu_count" not in result
    assert "gpu_type" not in result
    assert result["gpu_utilization"] is None
    assert result["gpu_allocated"] is None


@pytest.mark.parametrize(
    "instance",
    [
        {"host": "-oProxyCommand=touch /tmp/test", "port": 22, "username": "root"},
        {"host": "192.0.2.10 -oProxyCommand=x", "port": 22, "username": "root"},
        {"host": "192.0.2.10", "port": 22, "username": "root\nHost *"},
        {"host": "192.0.2.10", "port": 22, "username": "-oProxyCommand=x"},
        {"host": "192.0.2.10", "port": "22", "username": "root"},
        {"host": "192.0.2.10", "port": 0, "username": "root"},
        {"host": "192.0.2.10", "port": 22, "username": "root", "identity_file": "/k/${HOME}"},
        {"host": "192.0.2.10", "port": 22, "username": "root", "identity_file": "relative"},
        {"existing_alias": True, "host": "-oProxyCommand=touch", "port": 22, "username": "x"},
        {"existing_alias": True, "host": "alias with space", "port": 22, "username": "x"},
    ],
)
async def test_probe_rejects_endpoint_injection_before_ssh(
    monkeypatch: pytest.MonkeyPatch, instance: dict[str, Any]
) -> None:
    async def run(*args: Any) -> str:
        raise AssertionError("SSH must not run")

    monkeypatch.setattr(ssh, "run", run)
    with pytest.raises(ValueError):
        await hardware.probe_instance(instance)


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ssh.SSHError("Permission denied (publickey)", returncode=255), "ssh_authentication"),
        (ssh.SSHError("Host key verification failed", returncode=255), "ssh_host_key"),
        (ssh.SSHError("REMOTE HOST IDENTIFICATION HAS CHANGED", returncode=255), "ssh_host_key"),
        (ssh.SSHError("No route to host", returncode=255), "ssh_network"),
        (ssh.SSHError("Could not resolve hostname box.test", returncode=255), "ssh_network"),
        (ssh.SSHError("Connection refused", returncode=255), "ssh_refused"),
        (
            ssh.SSHError("Connection timed out during banner exchange", returncode=255),
            "ssh_timeout",
        ),
        (TimeoutError(), "ssh_timeout"),
        (
            ssh.SSHError("kex_exchange_identification: Connection closed", returncode=255),
            "ssh_closed",
        ),
        (ssh.SSHError("remote command failed", returncode=1), "ssh_failed"),
        (ssh.SSHError("Permission denied: /opt/probe.py", returncode=1), "ssh_failed"),
        (ssh.SSHError("Probe timed out", returncode=1), "ssh_failed"),
        (ssh.SSHError("Connection closed by probe", returncode=1), "ssh_failed"),
        (
            ssh.SSHError(
                "kex_exchange_identification: read: Connection reset by peer", returncode=255
            ),
            "ssh_closed",
        ),
        (ssh.SSHError("Connection reset by peer", returncode=1), "ssh_failed"),
        (ssh.SSHError("Connection reset by peer"), "ssh_failed"),
        (ssh.SSHError("Permission denied"), "ssh_failed"),
    ],
)
async def test_probe_classifies_connection_errors(monkeypatch, error, code) -> None:
    async def fail(*args):
        raise error

    monkeypatch.setattr(ssh, "run", fail)
    with pytest.raises(SourceError) as caught:
        await hardware.probe_instance({"host": "192.0.2.10", "port": 22, "username": "root"})
    assert caught.value.code == code
    assert caught.value.detail == (str(error) or None)
