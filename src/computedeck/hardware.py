"""On-demand hardware snapshot of an SSH host. Reads only; deploys nothing.

The snapshot runs the SSH machine driver's read-only probe and reads it the same way, so a
machine added by hand and an SSH machine source agree on what "GPUs in use" means: GPUs with
compute processes.
"""

import asyncio
import os
from typing import Any

from .drivers import ssh, ssh_host
from .drivers.base import now
from .ssh_config import validate_alias, validate_endpoint


def parse_probe(output: str) -> dict[str, Any]:
    readings, _, warnings = ssh_host.measure(ssh_host.read_output(output))
    # Per-GPU processes and their users stay on the machine; the row keeps the counts.
    readings.pop("gpus")
    return {
        **readings,
        "metrics_scope": "host_visible",
        "observed_at": now(),
        "ssh_status": "reachable",
        # Why a reading is unknown, e.g. gpu_processes_unavailable on an AMD host.
        "probe_warnings": warnings,
    }


async def probe_instance(instance: dict[str, Any]) -> dict[str, Any]:
    if instance.get("existing_alias"):
        # The host field names an alias already defined in the user's SSH config.
        destination, options = validate_alias(instance["host"]), []
    else:
        validate_endpoint(instance)
        destination = instance["host"]
        options = ["-p", str(instance["port"]), "-l", instance["username"]]
        if instance.get("identity_file"):
            identity = await asyncio.to_thread(os.path.expanduser, instance["identity_file"])
            options.extend(["-i", identity])
    result = parse_probe(await ssh.run(destination, ssh_host.probe_command(), options))
    # An absent GPU utility says nothing about inventory obtained from the provider.
    for key in ("gpu_count", "gpu_type"):
        if result[key] is None:
            result.pop(key)
    return result
