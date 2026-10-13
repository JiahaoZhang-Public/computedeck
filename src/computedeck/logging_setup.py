"""Bounded, owner-only service logs, shared by the application and uvicorn."""

import logging.config
import os
from io import TextIOWrapper
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .paths import secure_data_dir

MAX_BYTES = 5 * 1024 * 1024
BACKUPS = 4  # service.log plus four older files: five files in total.


class ServiceLogHandler(RotatingFileHandler):
    def _open(self) -> TextIOWrapper:
        stream = super()._open()
        os.fchmod(stream.fileno(), 0o600)
        return stream


def configure(data_dir: Path) -> None:
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "service": {"format": "%(asctime)s %(levelname)s %(name)s: %(message)s"}
            },
            "handlers": {
                "service": {
                    "()": ServiceLogHandler,
                    "filename": str(data_dir / "service.log"),
                    "maxBytes": MAX_BYTES,
                    "backupCount": BACKUPS,
                    "formatter": "service",
                    "delay": True,
                }
            },
            "loggers": {
                name: {
                    "handlers": ["service"],
                    "level": os.environ.get("COMPUTEDECK_LOG_LEVEL", "INFO").upper(),
                    "propagate": False,
                }
                for name in ("computedeck", "uvicorn", "uvicorn.error", "uvicorn.access")
            },
        }
    )
    secure_data_dir(data_dir)
