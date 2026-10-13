"""SSH hardware probe: NVIDIA and AMD parsing, unknown is not zero, strict endpoints."""

import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from computedeck import hardware
from computedeck.drivers import ssh

AMD = {
    "card0": {
        "GPU use (%)": "35",
        "Card Series": "AMD Instinct MI250X",
        "Card Model": "0x7408",
        "Card Vendor": "Advanced Micro Devices, Inc. [AMD/ATI]",
        "Card SKU": "D00000",
    },
    "card1": {"GPU use (%)": "N/A", "Card Series": "AMD Instinct MI250X"},
    "system": {"Driver version": "1.0.0"},
}


def probe_output(**changes: Any) -> str:
    result = {"cpu_utilization": 25.0, "memory_utilization": 40.0, "gpu_csv": "", "amd_json": ""}
    result.update(changes)
    return json.dumps(result)


def test_nvidia_missing_utilization_is_unknown_and_host_scope_explicit() -> None:
    result = hardware.parse_probe(
        probe_output(
            gpu_csv="NVIDIA A100 80GB, 80, 1000, 81920\nNVIDIA A100 80GB, [N/A], 500, 81920\n"
        )
    )
    assert result["gpu_count"] == 2
    assert result["gpu_type"] == "NVIDIA A100 80GB"
    assert result["gpu_utilization"] == 80
    assert result["gpu_observed_count"] == 1
    assert result["cpu_utilization"] == 25
    assert result["memory_utilization"] == 40
    assert result["metrics_scope"] == "host_visible"
    assert result["ssh_status"] == "reachable"
    assert result["observed_at"]
    # A probe measures a host; it never claims a provider lifecycle state.
    assert "state" not in result


def test_no_gpu_tool_leaves_everything_unknown() -> None:
    missing = hardware.parse_probe(probe_output(cpu_utilization=None, memory_utilization=None))
    assert missing["gpu_count"] is None
    assert missing["gpu_type"] is None
    assert missing["gpu_utilization"] is None
    assert missing["gpu_observed_count"] == 0
    assert missing["cpu_utilization"] is None
    assert missing["memory_utilization"] is None


def test_out_of_range_utilization_is_ignored() -> None:
    result = hardware.parse_probe(probe_output(gpu_csv="GPU, 150, 0, 1\nGPU, 50, 0, 1\n"))
    assert result["gpu_count"] == 2
    assert result["gpu_utilization"] == 50
    assert result["gpu_observed_count"] == 1


def test_unexpected_nvidia_output_is_rejected() -> None:
    with pytest.raises(ValueError):
        hardware.parse_probe(probe_output(gpu_csv="NVIDIA A100, 80\n"))


def test_amd_rocm_smi_json() -> None:
    result = hardware.parse_probe(probe_output(amd_json=json.dumps(AMD)))
    assert result["gpu_count"] == 2
    assert result["gpu_type"] == "AMD Instinct MI250X"
    assert result["gpu_utilization"] == 35
    assert result["gpu_observed_count"] == 1
    assert result["metrics_scope"] == "host_visible"


def test_amd_key_spelling_varies_between_releases() -> None:
    data = {
        "card0": {"GPU use (%)": 10, "Card series": "Radeon Example"},
        "card1": {"gpu use (%)": "30", "Card model": "Radeon Example Pro"},
        "card2": {"GPU use (%)": "20"},
        "card3": "not a card",
    }
    result = hardware.parse_probe(probe_output(amd_json=json.dumps(data)))
    assert result["gpu_count"] == 3
    assert result["gpu_type"] == "Radeon Example, Radeon Example Pro, AMD GPU"
    assert result["gpu_utilization"] == 20
    assert result["gpu_observed_count"] == 3


@pytest.mark.parametrize("text", ["[]", '"card0"', "not json"])
def test_unexpected_amd_output_is_rejected(text: str) -> None:
    with pytest.raises(ValueError):
        hardware.parse_probe(probe_output(amd_json=text))


def test_nvidia_output_takes_precedence_over_amd() -> None:
    result = hardware.parse_probe(
        probe_output(gpu_csv="NVIDIA L4, 5, 0, 1\n", amd_json=json.dumps(AMD))
    )
    assert result["gpu_type"] == "NVIDIA L4"
    assert result["gpu_count"] == 1


def test_embedded_probe_script_runs_and_parses() -> None:
    done = subprocess.run(
        [sys.executable, "-I", "-c", hardware._PROBE],
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
    recorder = RecordingSSH(probe_output(gpu_csv="NVIDIA L4, 5, 0, 1\n"))
    monkeypatch.setattr(ssh, "run", recorder)
    result = await hardware.probe_instance(
        {
            "host": "192.0.2.10",
            "port": 2222,
            "username": "alice",
            "identity_file": "~/.ssh/id_ed25519",
        }
    )
    assert result["gpu_count"] == 1
    [(destination, command, options)] = recorder.calls
    assert destination == "192.0.2.10"
    assert options == ["-p", "2222", "-l", "alice", "-i", f"{tmp_path}/.ssh/id_ed25519"]
    assert shlex.split(command) == ["python3", "-c", hardware._PROBE]


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
    monkeypatch.setattr(ssh, "run", RecordingSSH(probe_output()))
    result = await hardware.probe_instance({"host": "192.0.2.10", "port": 22, "username": "root"})
    # Absent keys leave the provider-reported GPU count and type untouched on merge.
    assert "gpu_count" not in result
    assert "gpu_type" not in result
    assert result["gpu_utilization"] is None


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
