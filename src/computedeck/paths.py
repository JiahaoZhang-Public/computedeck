"""Default locations. Every path can be overridden with an environment variable."""

import os
from pathlib import Path

from platformdirs import user_data_dir

APP_NAME = "ComputeDeck"
DEFAULT_PORT = 8710
DEFAULT_BACKUPS = 10


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
    candidates = (
        [Path(configured)]
        if configured
        else [
            # Wheel installs ship the built web app inside the package.
            Path(__file__).with_name("static"),
            # Source checkouts: core/web/dist after `npm run build`.
            Path(__file__).parents[2] / "web" / "dist",
        ]
    )
    return next((path for path in candidates if (path / "index.html").is_file()), None)
