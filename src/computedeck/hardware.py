"""On-demand hardware snapshot of an SSH host. Reads only; deploys nothing."""

import asyncio
import csv
import io
import json
import os
import shlex
import textwrap
from typing import Any

from .drivers import ssh
from .drivers.base import now, number
from .ssh_config import validate_alias, validate_endpoint

_PROBE = textwrap.dedent("""\
    import json, shutil, subprocess, time
    from pathlib import Path

    def cpu():
        values = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
        return sum(values), values[3] + values[4]

    def run(args):
        try:
            done = subprocess.run(args, capture_output=True, text=True, timeout=8)
            return done.stdout if done.returncode == 0 else ''
        except (OSError, subprocess.TimeoutExpired):
            return ''

    result = {'cpu_utilization': None, 'memory_utilization': None, 'gpu_csv': '', 'amd_json': ''}
    try:
        first = cpu()
        time.sleep(0.3)
        second = cpu()
        total = second[0] - first[0]
        if total > 0:
            result['cpu_utilization'] = 100 * (1 - (second[1] - first[1]) / total)
        memory = {line.split(':')[0]: int(line.split()[1])
                  for line in Path('/proc/meminfo').read_text().splitlines()}
        if memory.get('MemTotal') and 'MemAvailable' in memory:
            result['memory_utilization'] = 100 * (1 - memory['MemAvailable'] / memory['MemTotal'])
    except (OSError, ValueError, KeyError, IndexError):
        pass
    if shutil.which('nvidia-smi'):
        result['gpu_csv'] = run(['nvidia-smi',
                                 '--query-gpu=name,utilization.gpu,memory.used,memory.total',
                                 '--format=csv,noheader,nounits'])
    elif shutil.which('rocm-smi'):
        result['amd_json'] = run(['rocm-smi', '--showproductname', '--showuse', '--json'])
    print(json.dumps(result))
""")


def _nvidia(text: str) -> list[tuple[str, float | None]]:
    gpus = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) != 4:
            raise ValueError("Unexpected nvidia-smi output")
        gpus.append((row[0].strip(), number(row[1].strip())))
    return gpus


def _amd(text: str) -> list[tuple[str, float | None]]:
    """rocm-smi JSON: one object per card. Key spelling varies between ROCm releases."""
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("Unexpected rocm-smi output")
    gpus = []
    for key, card in data.items():
        if not key.lower().startswith("card") or not isinstance(card, dict):
            continue
        fields = {str(name).lower(): value for name, value in card.items()}
        name = next(
            (
                str(fields[label])
                for label in ("card series", "card model", "card sku")
                if fields.get(label)
            ),
            "AMD GPU",
        )
        gpus.append((name, number(fields.get("gpu use (%)"))))
    return gpus


def parse_probe(output: str) -> dict[str, Any]:
    snapshot = json.loads(output)
    gpus: list[tuple[str, float | None]] = []
    if snapshot.get("gpu_csv"):
        gpus = _nvidia(snapshot["gpu_csv"])
    elif snapshot.get("amd_json"):
        gpus = _amd(snapshot["amd_json"])
    utilization = [value for _, value in gpus if value is not None and 0 <= value <= 100]
    return {
        "gpu_count": len(gpus) if gpus else None,
        "gpu_type": ", ".join(dict.fromkeys(name for name, _ in gpus)) or None,
        "gpu_utilization": sum(utilization) / len(utilization) if utilization else None,
        "gpu_observed_count": len(utilization),
        "cpu_utilization": number(snapshot.get("cpu_utilization")),
        "memory_utilization": number(snapshot.get("memory_utilization")),
        "metrics_scope": "host_visible",
        "observed_at": now(),
        "ssh_status": "reachable",
    }


async def probe_instance(instance: dict[str, Any]) -> dict[str, Any]:
    command = "python3 -c " + shlex.quote(_PROBE)
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
    result = parse_probe(await ssh.run(destination, command, options))
    # An absent GPU utility says nothing about inventory obtained from the provider.
    for key in ("gpu_count", "gpu_type"):
        if result[key] is None:
            result.pop(key)
    return result
