import os
import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest

from computedeck.ssh_config import install_config, quote_path, render_config, write_config


def instance(**changes: Any) -> dict[str, Any]:
    result = {
        "id": "pod-1",
        "host": "203.0.113.10",
        "port": 2201,
        "username": "root",
        "ssh_alias": "cd-runpod-pod-1",
        "state": "unknown",
        "identity_file": "/Users/researcher/My Keys/id_ed25519",
    }
    result.update(changes)
    return result


def test_render_is_stable_strict_and_supports_spaces(tmp_path: Path) -> None:
    config = write_config([instance()], tmp_path)
    result = subprocess.run(
        ["ssh", "-G", "-F", str(config), "cd-runpod-pod-1"],
        text=True,
        capture_output=True,
        check=True,
    )
    assert "hostname 203.0.113.10\n" in result.stdout
    assert "port 2201\n" in result.stdout
    assert "identityfile /Users/researcher/My Keys/id_ed25519\n" in result.stdout
    assert "stricthostkeychecking true\n" in result.stdout
    assert "batchmode yes\n" in result.stdout
    assert config.read_text() == render_config([instance()])
    assert stat.S_IMODE(config.stat().st_mode) == 0o600


@pytest.mark.parametrize(
    "changes",
    [
        {"host": "example.com\nProxyCommand touch /tmp/injected"},
        {"host": "example.com; touch /tmp/injected"},
        {"username": "root\nLocalCommand touch /tmp/injected"},
        {"ssh_alias": "*"},
        {"ssh_alias": "-oProxyCommand=touch"},
        {"port": 65536},
        {"port": "22\nProxyCommand true"},
        {"identity_file": "/tmp/key\nProxyCommand true"},
        {"identity_file": "/tmp/${DANGEROUS}"},
        {"identity_file": "/tmp/*"},
    ],
)
def test_generated_config_rejects_injection(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        render_config([instance(**changes)])


def test_no_endpoint_terminated_and_alias_collisions() -> None:
    content = render_config([instance(host=None), instance(state="terminated")])
    assert "HostName" not in content
    assert "HostName" in render_config([instance(state="desired_terminated")])
    with pytest.raises(ValueError, match="Duplicate"):
        render_config([instance(), instance(host="203.0.113.20")])


def test_existing_alias_is_never_shadowed_by_a_managed_host_block(tmp_path: Path) -> None:
    existing = instance(
        id="manual:lab-box-gpu1",
        host="gpu-box",
        ssh_alias="gpu-box",
        port=22,
        username="root",
        existing_alias=True,
        identity_file=None,
    )
    content = render_config([existing, instance()])
    assert "Host gpu-box" not in content
    assert "HostName gpu-box" not in content
    assert "# Uses existing SSH configuration: gpu-box" in content
    assert "Host cd-runpod-pod-1" in content
    # The user's own block still decides how the alias connects.
    data = tmp_path / "data"
    config = write_config([existing], data)
    ssh_dir = tmp_path / ".ssh"
    ssh_dir.mkdir()
    (ssh_dir / "config").write_text(
        "Host gpu-box\n  HostName gpu-box.example.org\n  User alice\n  Port 2200\n"
    )
    install_config(config, ssh_dir)
    resolved = subprocess.run(
        ["ssh", "-G", "-F", str(ssh_dir / "config"), "gpu-box"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    assert "hostname gpu-box.example.org\n" in resolved
    assert "user alice\n" in resolved
    assert "port 2200\n" in resolved


def test_existing_alias_must_still_be_a_plain_alias() -> None:
    for alias in ("-oProxyCommand=touch", "gpu box", "gpu-box\nHost *"):
        with pytest.raises(ValueError):
            render_config([instance(host=alias, ssh_alias=alias, existing_alias=True)])


def test_paths_are_quoted_literally() -> None:
    assert quote_path("~/.ssh/id 100%") == '"~/.ssh/id 100%%"'
    assert quote_path('/keys/a"b') == '"/keys/a\\"b"'
    for unsafe in ("relative/key", "/keys/\x00", "/keys/[ab]", "/keys/?", "/keys/${HOME}"):
        with pytest.raises(ValueError):
            quote_path(unsafe)


def test_install_preserves_bytes_backup_and_existing_host_settings(tmp_path: Path) -> None:
    data = tmp_path / "App Data"
    config = write_config([instance()], data)
    ssh_dir = tmp_path / ".ssh"
    ssh_dir.mkdir()
    target = ssh_dir / "config"
    existing = b"User global-user\r\nHost existing\r\n  HostName old.example.com\r\n  Port 2209\r\n"
    target.write_bytes(existing)
    install_config(config, ssh_dir)
    first_install = target.read_bytes()
    assert first_install.endswith(existing)
    backup = list(ssh_dir.glob("config.computedeck-backup-*"))
    assert len(backup) == 1
    assert backup[0].read_bytes() == existing
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    managed = subprocess.run(
        ["ssh", "-G", "-F", str(target), "cd-runpod-pod-1"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    old_host = subprocess.run(
        ["ssh", "-G", "-F", str(target), "existing"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    assert "user root\n" in managed
    assert "hostname old.example.com\n" in old_host
    assert "user global-user\n" in old_host
    assert "port 2209\n" in old_host
    install_config(config, ssh_dir)
    assert target.read_bytes() == first_install
    assert len(list(ssh_dir.glob("config.computedeck-backup-*"))) == 1


def test_config_generation_does_not_install_include(tmp_path: Path) -> None:
    write_config([instance()], tmp_path / "data")
    assert not (tmp_path / ".ssh").exists()


def test_failed_atomic_replacement_keeps_previous_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = write_config([instance()], tmp_path)
    original = path.read_bytes()

    def fail_replace(src: str, dst: Path) -> None:
        raise OSError("disk unavailable")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(OSError, match="disk unavailable"):
        write_config([instance(host="203.0.113.20")], tmp_path)
    assert path.read_bytes() == original
    assert not list(tmp_path.glob(".computedeck.conf.*"))


def test_install_does_not_replace_existing_symlink(tmp_path: Path) -> None:
    config = write_config([], tmp_path / "data")
    ssh_dir = tmp_path / ".ssh"
    ssh_dir.mkdir()
    shared = tmp_path / "shared-config"
    shared.write_text("Host shared\n")
    (ssh_dir / "config").symlink_to(shared)
    with pytest.raises(ValueError, match="symlink"):
        install_config(config, ssh_dir)
    assert shared.read_text() == "Host shared\n"


def test_service_rendering_skips_invalid_rows_instead_of_failing(tmp_path: Path) -> None:
    good = {
        "id": "manual:lab-a",
        "ssh_alias": "cd-lab-a",
        "host": "192.0.2.5",
        "port": 22,
        "username": "alice",
    }
    relative_key = {
        **good,
        "id": "manual:lab-b",
        "ssh_alias": "cd-lab-b",
        "identity_file": "keys/id",
    }
    duplicate = {**good, "id": "manual:lab-c"}
    with pytest.raises(ValueError):
        render_config([good, relative_key])
    path = write_config([good, relative_key, duplicate], tmp_path)
    content = path.read_text()
    assert content.count("Host cd-lab-a") == 1
    assert "cd-lab-b" not in content
