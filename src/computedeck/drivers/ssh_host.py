"""One GPU machine reached through an existing SSH Host alias, collected on schedule. Read-only.

A short Python script runs on the machine with ``python3 -I -c``. It reads /proc, nvidia-smi
(or rocm-smi) and ps, prints one JSON object and writes nothing. Parsing happens here.
"""

import csv
import io
import json
import shlex
import textwrap
from typing import Any, ClassVar, Literal

from ..host_identity import ssh_endpoint
from ..ssh_config import validate_alias, validate_username
from . import ssh
from .base import (
    EMPTY,
    Batch,
    DriverCheck,
    DriverInfo,
    SourceError,
    integer,
    message,
    now,
    number,
    ssh_alias_field,
)

_GPU_QUERY = "index,uuid,name,utilization.gpu,memory.used,memory.total"
_APPS_QUERY = "gpu_uuid,pid,used_memory"

# Shell start-up files may print a banner first; the result is the line after this mark.
MARKER = "computedeck-probe:"
# Runs on the remote machine. Every command is an argument list (no shell); the only value
# taken from a command's output and passed to another one is a digit-only pid.
_PROBE = textwrap.dedent(f"""\
    import json, os, pwd, shutil, subprocess, time
    from pathlib import Path

    def cpu():
        values = [int(v) for v in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
        return sum(values), values[3] + values[4]

    def run(args, timeout, check=True):
        try:
            done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  universal_newlines=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            return None, type(error).__name__
        if check and done.returncode:
            lines = (done.stderr.strip() or done.stdout.strip()).splitlines()
            return None, (lines[0] if lines else 'exit status %d' % done.returncode)[:180]
        return done.stdout, None

    result = {{'ssh_connection': os.environ.get('SSH_CONNECTION'),
              'cpu_utilization': None, 'memory_utilization': None, 'user': None,
              'gpu_tool': None, 'gpu': None, 'gpu_error': None, 'amd_memory': None,
              'apps': None, 'apps_error': None, 'owners': None}}
    try:
        first = cpu()
        time.sleep(0.3)
        second = cpu()
        total = second[0] - first[0]
        if total > 0:
            result['cpu_utilization'] = 100 * (1 - (second[1] - first[1]) / total)
        memory = {{line.split(':')[0]: int(line.split()[1])
                  for line in Path('/proc/meminfo').read_text().splitlines()}}
        if memory.get('MemTotal') and 'MemAvailable' in memory:
            result['memory_utilization'] = 100 * (1 - memory['MemAvailable'] / memory['MemTotal'])
    except (OSError, ValueError, KeyError, IndexError):
        pass
    try:
        result['user'] = pwd.getpwuid(os.getuid()).pw_name
    except (KeyError, OSError):
        pass
    if shutil.which('nvidia-smi'):
        result['gpu_tool'] = 'nvidia-smi'
        result['gpu'], result['gpu_error'] = run(
            ['nvidia-smi', '--query-gpu={_GPU_QUERY}', '--format=csv,noheader,nounits'], 6)
        if result['gpu'] is not None:
            result['apps'], result['apps_error'] = run(
                ['nvidia-smi', '--query-compute-apps={_APPS_QUERY}',
                 '--format=csv,noheader,nounits'], 5)
        pids = set()
        for line in (result['apps'] or '').splitlines():
            parts = [part.strip() for part in line.split(',')]
            if len(parts) == 3 and parts[1].isdigit():
                pids.add(int(parts[1]))
        if pids:
            # ps exits non-zero when a process has already exited; keep what it printed.
            result['owners'], _ = run(
                ['ps', '-o', 'pid=,user=', '-p', ','.join(str(pid) for pid in sorted(pids))],
                3, check=False)
    elif shutil.which('rocm-smi'):
        result['gpu_tool'] = 'rocm-smi'
        result['gpu'], result['gpu_error'] = run(
            ['rocm-smi', '--showproductname', '--showuse', '--json'], 6)
        if result['gpu'] is not None:
            result['amd_memory'], _ = run(['rocm-smi', '--showmeminfo', 'vram', '--json'], 5)
    print({MARKER!r} + json.dumps(result))
""")

_MIB = 1024 * 1024


def _percent(value: Any) -> float | None:
    result = number(value)
    return result if result is not None and 0 <= result <= 100 else None


def _gpu_rows(text: str) -> list[list[str]]:
    """nvidia-smi does not quote CSV, so a comma inside a GPU name splits it; rejoin it."""
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        if len(row) < 6:
            raise SourceError("unexpected_output", command="nvidia-smi")
        rows.append([cell.strip() for cell in [*row[:2], ",".join(row[2:-3]), *row[-3:]]])
    return rows


def _nvidia(text: str) -> list[tuple[str, dict[str, Any]]]:
    """``--query-gpu`` rows as (uuid, GPU row). Units are MiB and percent."""
    gpus = []
    for index, uuid, name, utilization, used, total in _gpu_rows(text):
        position = integer(index)
        if position is None or uuid in EMPTY:
            raise SourceError("unexpected_output", command="nvidia-smi")
        gpus.append(
            (
                uuid,
                {
                    "index": position,
                    "name": None if name in EMPTY else name,
                    "utilization": _percent(utilization),
                    "memory_used_mb": integer(used),
                    "memory_total_mb": integer(total),
                    "processes": None,
                },
            )
        )
    return gpus


def _owners(text: str | None) -> dict[int, str]:
    """``ps -o pid=,user=`` lines. A pid ps did not list keeps an unknown owner."""
    owners: dict[int, str] = {}
    for line in (text or "").splitlines():
        parts = line.split()
        pid = integer(parts[0]) if len(parts) == 2 else None
        # procps marks a name cut to the column width with "+"; that is not the owner.
        if pid is not None and not parts[1].endswith("+"):
            owners[pid] = parts[1]
    return owners


def _processes(text: str, uuids: set[str], owners: dict[int, str]) -> dict[str, list[Any]]:
    """``--query-compute-apps`` rows grouped by GPU uuid. Raises ValueError when malformed."""
    result: dict[str, list[Any]] = {uuid: [] for uuid in uuids}
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = [part.strip() for part in line.split(",")]
        pid = integer(parts[1]) if len(parts) == 3 else None
        if pid is None or parts[0] not in result:
            raise ValueError("Unexpected nvidia-smi --query-compute-apps output")
        result[parts[0]].append(
            {"pid": pid, "user": owners.get(pid), "memory_mb": integer(parts[2])}
        )
    return result


def _amd_cards(text: str) -> dict[str, dict[str, Any]]:
    """rocm-smi JSON: one object per card. Key spelling varies between ROCm releases."""
    try:
        data = json.loads(text)
    except ValueError:
        raise SourceError("unexpected_output", command="rocm-smi") from None
    if not isinstance(data, dict):
        raise SourceError("unexpected_output", command="rocm-smi")
    return {
        key.lower(): {str(name).lower(): value for name, value in card.items()}
        for key, card in data.items()
        if key.lower().startswith("card") and isinstance(card, dict)
    }


def _mib(value: Any) -> int | None:
    result = integer(value)
    return round(result / _MIB) if result is not None else None


def _amd(text: str, memory_text: str | None) -> list[dict[str, Any]]:
    try:
        memory = _amd_cards(memory_text) if memory_text else {}
    except SourceError:
        # VRAM comes from a second, optional query; unreadable output leaves memory unknown.
        memory = {}
    gpus = []
    for key, fields in _amd_cards(text).items():
        vram = memory.get(key, {})
        gpus.append(
            {
                "index": integer(key.removeprefix("card")),
                "name": next(
                    (
                        str(fields[label])
                        for label in ("card series", "card model", "card sku")
                        if fields.get(label) and str(fields[label]) not in EMPTY
                    ),
                    "AMD GPU",
                ),
                "utilization": _percent(fields.get("gpu use (%)")),
                "memory_used_mb": _mib(vram.get("vram total used memory (b)")),
                "memory_total_mb": _mib(vram.get("vram total memory (b)")),
                # rocm-smi has no stable per-GPU process listing to read here.
                "processes": None,
            }
        )
    return gpus


def probe_command() -> str:
    """The read-only probe as one remote command."""
    # -I: ignore PYTHON* variables, user site-packages and modules in the remote cwd.
    return shlex.join(["python3", "-I", "-c", _PROBE])


def read_output(output: str) -> dict[str, Any]:
    """The probe's JSON object, after any banner a shell start-up file printed."""
    marked = [line for line in output.splitlines() if line.startswith(MARKER)]
    try:
        snapshot = json.loads(marked[-1][len(MARKER) :] if marked else output)
    except ValueError:
        raise SourceError("unexpected_output", command="python3") from None
    if not isinstance(snapshot, dict):
        raise SourceError("unexpected_output", command="python3")
    return snapshot


def measure(snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[str], list[dict[str, Any]]]:
    """GPU, CPU and memory readings of one machine, the capabilities they cover and warnings
    for what was not read.

    ``gpu_allocated`` counts GPUs with visible compute processes or significant memory use.
    Unreadable processes or memory leave idle-looking GPUs unknown, never free.
    """
    warnings: list[dict[str, Any]] = []
    capabilities = ["instances"]
    tool = snapshot.get("gpu_tool")
    gpu_text = snapshot.get("gpu")
    gpus: list[dict[str, Any]] | None = None
    if tool == "nvidia-smi" and isinstance(gpu_text, str):
        pairs = _nvidia(gpu_text)
        gpus = [row for _, row in pairs]
        apps = snapshot.get("apps")
        if pairs and isinstance(apps, str):
            owner_text = snapshot.get("owners")
            owners = _owners(owner_text if isinstance(owner_text, str) else None)
            try:
                processes = _processes(apps, {uuid for uuid, _ in pairs}, owners)
            except ValueError as error:
                warnings.append(message("gpu_processes_unavailable", detail=str(error)))
            else:
                for uuid, row in pairs:
                    row["processes"] = processes[uuid]
                capabilities.append("gpu_processes")
        elif pairs:
            detail = snapshot.get("apps_error") or "nvidia-smi --query-compute-apps"
            warnings.append(message("gpu_processes_unavailable", detail=str(detail)[:180]))
    elif tool == "rocm-smi" and isinstance(gpu_text, str):
        memory_text = snapshot.get("amd_memory")
        gpus = _amd(gpu_text, memory_text if isinstance(memory_text, str) else None)
        if gpus:
            warnings.append(message("gpu_processes_unavailable", detail="rocm-smi"))
    if not gpus:
        gpus = None
        detail = snapshot.get("gpu_error") or (
            f"{tool} listed no GPUs" if tool else "no nvidia-smi or rocm-smi"
        )
        warnings.append(message("gpus_unavailable", detail=str(detail)[:180]))
    for row in gpus or []:
        processes = row["processes"]
        used, total = row["memory_used_mb"], row["memory_total_mb"]
        if processes:
            row["in_use"] = True
        elif processes is None or used is None or total is None:
            row["in_use"] = None
        else:
            row["in_use"] = used >= max(1024, total * 0.05)
        row["processes_omitted"] = max(0, len(processes) - 16) if processes else 0
        if processes is not None:
            row["processes"] = processes[:16]
    observed = [row["utilization"] for row in gpus or [] if row["utilization"] is not None]
    readings = {
        "gpu_count": len(gpus) if gpus else None,
        "gpu_allocated": (
            sum(row["in_use"] for row in gpus)
            if gpus and all(row["in_use"] is not None for row in gpus)
            else None
        ),
        "gpu_type": ", ".join(dict.fromkeys(row["name"] for row in gpus or [] if row["name"]))
        or None,
        "gpu_utilization": sum(observed) / len(observed) if observed else None,
        "gpu_utilization_max": max(observed)
        if observed and len(observed) == len(gpus or [])
        else None,
        "gpu_observed_count": len(observed),
        "cpu_utilization": _percent(snapshot.get("cpu_utilization")),
        "memory_utilization": _percent(snapshot.get("memory_utilization")),
        "gpus": gpus,
    }
    return readings, capabilities, warnings


def parse_machine(output: str, source: dict[str, Any], alias: str) -> Batch:
    """The probe's JSON as one running instance, with warnings for what was not read."""
    snapshot = read_output(output)
    readings, capabilities, warnings = measure(snapshot)
    try:
        username = validate_username(str(snapshot.get("user") or ""))
    except ValueError:
        username = ""
    observed = now()
    instance = {
        "id": f"{source['cluster_id']}:{alias}",
        "source_id": source["id"],
        "platform": source["name"],
        "name": alias,
        # The machine answered; there is no provider lifecycle behind it.
        "state": "running",
        **readings,
        "metrics_scope": "host_visible",
        "ssh_endpoint": ssh_endpoint(snapshot.get("ssh_connection")),
        # The user's own Host block is authoritative; no managed Host block is generated.
        "host": alias,
        "port": None,
        "username": username,
        "ssh_alias": alias,
        "existing_alias": True,
        "identity_file": None,
        "started_at": None,
        "hourly_cost": None,
        "currency": "USD",
        "observed_at": observed,
        "gpus_observed_at": observed,
        "last_probe_attempt": observed,
        "ssh_status": "reachable",
    }
    return Batch(instances=[instance], capabilities=capabilities, warnings=warnings)


def _alias(source: dict[str, Any]) -> str:
    alias = source.get("ssh_alias") or ""
    if not alias:
        raise SourceError("ssh_alias_required")
    if alias.startswith("-"):
        raise SourceError("invalid_ssh_alias")
    try:
        return validate_alias(alias)
    except ValueError as error:
        raise SourceError("invalid_endpoint", str(error)) from None


class SSHHostDriver:
    name: ClassVar[str] = "ssh"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cloud"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "GPU machine (SSH)", "zh-CN": "GPU 机器（SSH）"},
        description={
            "en": "GPUs, their processes, CPU and memory of one machine, read through SSH.",
            "zh-CN": "通过 SSH 读取一台机器的 GPU、GPU 进程、CPU 和内存。",
        },
        details={
            "en": "Runs a short read-only python3 script through an SSH host alias on {where}: "
            "/proc, nvidia-smi or rocm-smi, and ps. Nothing is installed or written on the "
            "machine. ProxyJump and keys come from that SSH config.",
            "zh-CN": "通过{where}的 SSH Host 别名运行一段只读的 python3 脚本，读取 /proc、"
            "nvidia-smi 或 rocm-smi 以及 ps。不会在机器上安装或写入任何内容。"
            "ProxyJump 和密钥沿用该 SSH 配置。",
        },
        fields=[
            ssh_alias_field(
                placeholder="gpu-box",
                hint={
                    "en": "A Host in ~/.ssh/config on {where} that reaches this machine. "
                    "Connections are non-interactive; accept the host key with a normal ssh "
                    "login first.",
                    "zh-CN": "{where} ~/.ssh/config 里能连到这台机器的 Host。采集是非交互的，"
                    "首次使用前请先用 ssh 正常登录一次，确认主机密钥。",
                },
            )
        ],
        checks=[
            DriverCheck(
                capability="instances",
                command="nvidia-smi",
                label={
                    "en": "GPUs, CPU and memory (nvidia-smi)",
                    "zh-CN": "GPU、CPU 和内存（nvidia-smi）",
                },
            ),
            DriverCheck(
                capability="gpu_processes",
                command="ps",
                label={
                    "en": "GPU processes and their users (nvidia-smi, ps)",
                    "zh-CN": "GPU 进程及其用户（nvidia-smi、ps）",
                },
                warning="gpu_processes_unavailable",
            ),
        ],
        name_placeholder="GPU box",
    )

    def validate(self, source: dict[str, Any]) -> None:
        _alias(source)

    async def collect(self, source: dict[str, Any]) -> Batch:
        alias = _alias(source)
        try:
            output = await ssh.run(alias, probe_command())
        except ssh.SSHError as error:
            raise SourceError("ssh_failed", str(error)) from None
        except TimeoutError:
            raise SourceError("ssh_timeout") from None
        return parse_machine(output, source, alias)
