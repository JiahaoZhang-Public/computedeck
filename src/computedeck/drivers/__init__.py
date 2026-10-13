"""Driver registry. Built-in drivers plus any installed under ``computedeck.drivers``."""

import logging
from importlib.metadata import entry_points
from pathlib import Path

from .aws_ec2 import AWSEC2Driver
from .base import Batch, Driver, DriverInfo, SourceError, message
from .gpuhub import GPUHubDriver
from .kubernetes import KubernetesDriver
from .lambda_cloud import LambdaCloudDriver
from .lsf import LsfDriver
from .pbs import PbsDriver
from .runpod import RunPodDriver
from .slurm import SlurmDriver
from .ssh_host import SSHHostDriver
from .vastai import VastAIDriver

__all__ = ["Batch", "Driver", "DriverInfo", "SourceError", "describe", "get", "names", "message"]
logger = logging.getLogger("computedeck")

_BUILT_IN: tuple[Driver, ...] = (
    SlurmDriver(),
    KubernetesDriver(),
    PbsDriver(),
    LsfDriver(),
    SSHHostDriver(),
    RunPodDriver(),
    GPUHubDriver(),
    VastAIDriver(),
    LambdaCloudDriver(),
    AWSEC2Driver(),
)
_DRIVERS: dict[str, Driver] = {driver.name: driver for driver in _BUILT_IN}
_loaded = False
_policy_dir: Path | None = None


def _load_external() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    from .. import paths
    from ..plugins import Plugin, policy_check

    blocked = policy_check(_policy_dir or paths.data_dir())
    for entry in entry_points(group="computedeck.drivers"):
        dist = getattr(entry, "dist", None)
        package = dist.metadata["Name"] if dist is not None else None
        names = [entry.name]
        if dist is not None:
            names.extend(
                item.name for item in dist.entry_points if item.group == "computedeck.plugins"
            )
        if any(blocked(Plugin(name, lambda context: None, package=package)) for name in names):
            logger.error("Driver %s is blocked by plugin policy", entry.name)
            continue
        try:
            driver = entry.load()()
        except Exception:
            logger.exception("Driver %s could not be loaded", entry.name)
            continue
        _DRIVERS.setdefault(driver.name, driver)


def get(name: str) -> Driver:
    _load_external()
    try:
        return _DRIVERS[name]
    except KeyError:
        raise SourceError("unknown_driver", driver=name) from None


def names() -> list[str]:
    _load_external()
    return sorted(_DRIVERS)


def describe(name: str) -> dict[str, object]:
    """Name, kind and form description of a driver, for the web app."""
    driver = get(name)
    info = getattr(driver, "info", None)
    if not isinstance(info, DriverInfo):
        # A third-party driver without a description still gets a usable form.
        info = DriverInfo(label={"en": name})
    return {"name": name, "kind": driver.kind, **info.model_dump()}
