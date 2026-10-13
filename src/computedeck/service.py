"""Per-user login service: launchd on macOS, systemd --user on Linux."""

import os
import platform
import plistlib
import shlex
import subprocess
import sys
from pathlib import Path

LABEL = "local.computedeck.service"
# Seconds the service manager waits after asking the service to stop: enough for the
# service's own 10-second limit on requests in flight and background work.
STOP_SECONDS = 30


class ServiceError(RuntimeError):
    pass


def _command(port: int) -> list[str]:
    return [sys.executable, "-m", "computedeck", "serve", "--port", str(port)]


def _launchd_path() -> Path:
    return Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"


def _systemd_path() -> Path:
    return Path.home() / ".config/systemd/user/computedeck.service"


def _run(args: list[str], check: bool = True) -> None:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if check and result.returncode:
        raise ServiceError(result.stderr.strip() or f"{args[0]} failed")


def install(port: int, data_dir: Path) -> str:
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = {
        "COMPUTEDECK_DATA_DIR": str(data_dir),
        "COMPUTEDECK_PORT": str(port),
        "PYTHONUNBUFFERED": "1",
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(Path.home()),
    }
    if platform.system() == "Darwin":
        path = _launchd_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as stream:
            plistlib.dump(
                {
                    "Label": LABEL,
                    "ProgramArguments": _command(port),
                    "EnvironmentVariables": environment,
                    "RunAtLoad": True,
                    "KeepAlive": True,
                    "ThrottleInterval": 10,
                    "ExitTimeOut": STOP_SECONDS,
                    "StandardOutPath": str(data_dir / "service.log"),
                    "StandardErrorPath": str(data_dir / "service.log"),
                },
                stream,
            )
        domain = f"gui/{os.getuid()}"
        _run(["launchctl", "bootout", f"{domain}/{LABEL}"], check=False)
        _run(["launchctl", "bootstrap", domain, str(path)])
        return f"Installed {path}. The service runs while you are logged in."
    if platform.system() == "Linux":
        path = _systemd_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "[Unit]",
            "Description=ComputeDeck",
            "",
            "[Service]",
            f"ExecStart={shlex.join(_command(port))}",
            *(f'Environment="{key}={value}"' for key, value in environment.items()),
            "Restart=on-failure",
            "RestartSec=10",
            f"TimeoutStopSec={STOP_SECONDS}",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
        path.write_text("\n".join(lines), encoding="utf-8")
        _run(["systemctl", "--user", "daemon-reload"])
        _run(["systemctl", "--user", "enable", "--now", "computedeck.service"])
        return f"Installed {path}. To keep it running after logout: loginctl enable-linger $USER"
    raise ServiceError("Login services are supported on macOS and Linux.")


def uninstall() -> str:
    if platform.system() == "Darwin":
        path = _launchd_path()
        _run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], check=False)
        path.unlink(missing_ok=True)
        return f"Removed {path}."
    if platform.system() == "Linux":
        path = _systemd_path()
        _run(["systemctl", "--user", "disable", "--now", "computedeck.service"], check=False)
        path.unlink(missing_ok=True)
        _run(["systemctl", "--user", "daemon-reload"], check=False)
        return f"Removed {path}."
    raise ServiceError("Login services are supported on macOS and Linux.")
