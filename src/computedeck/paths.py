"""Default locations. Every path can be overridden with an environment variable."""

import logging
import os
from pathlib import Path

from platformdirs import user_data_dir

APP_NAME = "ComputeDeck"
DEFAULT_PORT = 8710
DEFAULT_BACKUPS = 10


def secure_data_dir(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.stat().st_mode & 0o077:
        directory.chmod(0o700)
        logging.getLogger("computedeck").info("Restricted data directory permissions to 0700")
    for path in [directory / "startup.log", *directory.glob("service.log*")]:
        if path.is_file() and path.stat().st_mode & 0o077:
            path.chmod(0o600)
            logging.getLogger("computedeck").info("Restricted log file permissions to 0600")


def data_dir() -> Path:
    configured = os.environ.get("COMPUTEDECK_DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    # macOS: ~/Library/Application Support/ComputeDeck; Linux: ~/.local/share/ComputeDeck
    return Path(user_data_dir(APP_NAME, appauthor=False))


def port() -> int:
    return int(os.environ.get("COMPUTEDECK_PORT", str(DEFAULT_PORT)))


def backups_kept() -> int:
    """How many backups to keep; writing one removes the oldest beyond that."""
    try:
        return max(1, int(os.environ.get("COMPUTEDECK_BACKUPS", str(DEFAULT_BACKUPS))))
    except ValueError:
        return DEFAULT_BACKUPS


def web_dir() -> Path | None:
    configured = os.environ.get("COMPUTEDECK_WEB_DIR")
    package = Path(__file__).parent
    checkout = package.parent.parent
    candidates = [package / "static"]
    if package.parent.name == "src" and (checkout / "pyproject.toml").is_file():
        # A source build is newer than static assets left by an earlier wheel build.
        candidates.insert(0, checkout / "web" / "dist")
    if configured:
        candidates = [Path(configured)]
    return next((path for path in candidates if (path / "index.html").is_file()), None)
