"""Connection diagnostics shared by the CLI and the source connection-check page."""

import asyncio
import json
import shlex
import shutil
import socket
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from . import auth, credentials, drivers, nodes, plugins
from .drivers import ssh
from .errors import SourceError
from .ssh_config import validate_alias, validate_username
from .store import Store

Text = dict[str, str]


def check(
    key: str,
    ok: bool,
    en: str,
    zh: str,
    fix_en: str = "",
    fix_zh: str = "",
    *,
    optional: bool = False,
) -> dict[str, Any]:
    return {
        "id": key,
        "state": "ok" if ok else "missing" if optional else "failed",
        "label": {"en": en, "zh-CN": zh},
        "detail": {} if ok else {"en": fix_en, "zh-CN": fix_zh},
    }


async def ssh_config(alias: str, options: list[str]) -> dict[str, str]:
    process = await asyncio.create_subprocess_exec(
        "ssh",
        "-G",
        "-o",
        "PermitLocalCommand=no",
        *options,
        "--",
        alias,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=10)
    except (TimeoutError, asyncio.CancelledError):
        ssh._kill(process)
        with suppress(TimeoutError):
            await asyncio.wait_for(process.communicate(), ssh.REAP_SECONDS)
        raise
    if process.returncode:
        raise ValueError("Invalid SSH configuration")
    return dict(line.split(None, 1) for line in stdout.decode().splitlines() if " " in line)


async def source_checks(
    source: dict[str, Any],
    node: dict[str, Any] | None = None,
    *,
    report: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def add(row: dict[str, Any]) -> None:
        rows.append(row)
        if report:
            report(row)

    def starting(key: str, en: str, zh: str) -> None:
        if report:
            row = check(key, True, en, zh)
            row["state"] = "checking"
            report(row)

    try:
        driver = drivers.get(source["driver"])
        driver.validate(source)
    except (SourceError, ValueError):
        return [
            check(
                "configuration",
                False,
                "Source configuration",
                "来源配置",
                "Check the required source fields.",
                "检查来源的必填字段。",
            )
        ]
    if source.get("node"):
        if node is None:
            return [
                check(
                    "node",
                    False,
                    "Collection node",
                    "采集节点",
                    "Select an existing collection node.",
                    "选择已存在的采集节点。",
                )
            ]
        starting("node", "Collection on the configured node", "在指定节点采集")
        try:
            async with asyncio.timeout(120):
                batch = await nodes.collect(node, source)
        except (SourceError, OSError, TimeoutError):
            return [
                check(
                    "node",
                    False,
                    "Collection on the configured node",
                    "在指定节点采集",
                    "Check the node connection and run doctor on that node.",
                    "检查节点连接，并在该节点运行 doctor。",
                )
            ]
        add(check("node", True, "Collection on the configured node", "在指定节点采集"))
        for item in driver.info.checks:
            row = check(
                item.capability,
                item.capability in batch.capabilities,
                item.label["en"],
                item.label.get("zh-CN", item.label["en"]),
                "Check command availability and permissions on the collection node.",
                "检查采集节点上的命令和权限。",
                optional=True,
            )
            add(row)
        return rows
    alias = source.get("ssh_alias") or ""
    options = []
    if source["driver"] in {"slurm", "pbs", "lsf"} and source.get("username"):
        options = ["-l", validate_username(source["username"])]
    if alias:
        installed = shutil.which("ssh") is not None
        add(
            check(
                "ssh",
                installed,
                "OpenSSH is installed",
                "已安装 OpenSSH",
                "Install the OpenSSH client on the collecting machine.",
                "在采集机器安装 OpenSSH 客户端。",
            )
        )
        if not installed:
            return rows
        starting("ssh_alias", "SSH alias resolves", "SSH 别名可解析")
        try:
            validate_alias(alias)
            config = await ssh_config(alias, options)
            hostname = config.get("hostname", "")
            if not hostname:
                raise ValueError("No SSH host")
            # ProxyJump/ProxyCommand may resolve a private hostname on the jump host.
            proxied = any(
                config.get(key, "none") != "none" for key in ("proxyjump", "proxycommand")
            )
            if not proxied:
                async with asyncio.timeout(5):
                    await asyncio.get_running_loop().getaddrinfo(
                        hostname, int(config.get("port", "22")), type=socket.SOCK_STREAM
                    )
            resolved = True
        except (OSError, ValueError, TimeoutError):
            resolved = False
        add(
            check(
                "ssh_alias",
                resolved,
                "SSH alias resolves",
                "SSH 别名可解析",
                "Check the Host alias and HostName in the collecting machine's SSH config.",
                "检查采集机器 SSH 配置中的 Host 别名和 HostName。",
            )
        )
        if not resolved:
            return rows
        starting("ssh_login", "SSH BatchMode login", "SSH BatchMode 登录")
        failure = "unknown"
        try:
            await ssh.run(alias, "true", options)
            connected = True
        except (ssh.SSHError, OSError, TimeoutError) as error:
            connected = False
            failure = ssh.failure_cause(error)
            # A process timeout may include time queued behind a collection.
            if failure == "timeout" and not isinstance(error, TimeoutError):
                failure = "network"
        add(
            check(
                "ssh_login",
                connected,
                "SSH BatchMode login",
                "SSH BatchMode 登录",
                "Check the username, key and known_hosts; "
                "test ssh -o BatchMode=yes with this alias.",
                "检查用户名、密钥和 known_hosts，并用此别名测试 ssh -o BatchMode=yes。",
            )
        )
        if not connected:
            hints = {
                "timeout": (
                    "The check timed out before completion. Wait for any active collection "
                    "and retry; this alone does not identify a network or authentication failure.",
                    "检查未能在时限内完成。请等待当前采集结束后重试；仅凭超时无法确定网络或认证故障。",
                ),
                "authentication": (
                    "Authentication was rejected. Check the login name, key access and "
                    "any required credential update on the collecting machine.",
                    "认证被拒绝。检查登录用户名、密钥权限，并在采集机器更新所需凭据。",
                ),
                "host_key": (
                    "Host identity verification failed. Verify the host key with its administrator "
                    "before updating known_hosts; do not disable verification.",
                    "主机身份验证失败。先向管理员核实主机密钥，再更新 known_hosts；不要关闭验证。",
                ),
                "network": (
                    "The host is unreachable. Check the network, required VPN and jump-host route "
                    "before retrying.",
                    "无法到达主机。重试前检查网络、所需 VPN 和跳板路由。",
                ),
                "refused": (
                    "The host refused the connection. Check the SSH port and whether "
                    "its SSH service is running.",
                    "主机拒绝了连接。检查 SSH 端口及远端 SSH 服务是否运行。",
                ),
            }
            if failure in hints:
                en, zh = hints[failure]
                rows[-1]["detail"] = {"en": en, "zh-CN": zh}
            rows[-1]["command"] = shlex.join(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    *options,
                    "--",
                    alias,
                    "true",
                ]
            )
            if report:
                report(rows[-1])
            return rows
    commands = {
        "slurm": ("squeue", "scontrol", "sacctmgr", "sacct"),
        "pbs": ("qselect", "qstat", "pbsnodes"),
        "lsf": ("bjobs", "bhosts", "bqueues", "lshosts"),
        "kubernetes": ("kubectl",),
        "ssh": ("python3",),
        "aws-ec2": ("aws",),
    }.get(source["driver"], ())
    for command in commands:
        starting(f"command:{command}", f"Command: {command}", f"命令：{command}")
        try:
            found = (
                bool(await ssh.run(alias, f"command -v {command}", options))
                if alias
                else shutil.which(command) is not None
            )
        except (ssh.SSHError, OSError, TimeoutError):
            found = False
        add(
            check(
                f"command:{command}",
                found,
                f"Command: {command}",
                f"命令：{command}",
                f"Install {command} or add it to the non-interactive PATH on the collecting host.",
                f"在采集主机安装 {command} 或将它加入非交互会话的 PATH。",
                optional=command in {"sacct", "sacctmgr", "pbsnodes", "lshosts"},
            )
        )
    if source.get("credential"):
        starting("credential", "Credential reference resolves", "凭据引用可解析")
        try:
            available = bool(await asyncio.to_thread(credentials.resolve, source["credential"]))
        except Exception:
            # Resolver failures may quote secrets. Never include exception text or the value.
            available = False
        add(
            check(
                "credential",
                available,
                "Credential reference resolves",
                "凭据引用可解析",
                "Check the configured reference and the service's credential access. "
                "Values are never displayed.",
                "检查凭据引用及服务进程的访问权限。不会显示凭据内容。",
            )
        )
    if not rows:
        add(
            check(
                "connection",
                False,
                "Connection diagnostics",
                "连接诊断",
                "This driver has no connection checks. Refresh the source to verify collection.",
                "此驱动没有连接检查。请刷新来源以验证采集。",
                optional=True,
            )
        )
    return rows


def local_checks(directory: Path, port: int) -> list[dict[str, Any]]:
    private = not directory.exists() or (
        directory.is_dir() and directory.stat().st_mode & 0o077 == 0
    )
    rows = [
        check(
            "data_permissions",
            private,
            "Private data directory",
            "私有数据目录权限",
            "Use a directory owned by this account with chmod 700.",
            "使用当前账户拥有的目录，并执行 chmod 700。",
        )
    ]
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
            available = True
        except OSError:
            available = auth.service_nonce(port) is not None
    rows.append(
        check(
            "port",
            available,
            f"Service port {port}",
            f"服务端口 {port}",
            "Stop the conflicting listener or choose another --port.",
            "停止冲突的监听进程，或使用其他 --port。",
        )
    )
    return rows


async def diagnose(
    directory: Path, port: int, source_id: str | None = None
) -> list[dict[str, Any]]:
    rows = local_checks(directory, port)
    runtime = plugins.Runtime(directory)
    database = directory / "computedeck.sqlite"
    store = Store(database, readonly=True) if database.exists() else None
    if store is not None:
        runtime.store = store
    try:
        contexts = plugins.load(plugins.discover(directory), runtime)
        for context in contexts:
            rows.append(
                check(
                    f"plugin:{context.id}",
                    context.rejected is None,
                    f"Plugin compatibility: {context.id}",
                    f"插件兼容性：{context.id}",
                    "Install a compatible plugin version or disable it in policy.",
                    "安装兼容的插件版本，或在策略中禁用它。",
                )
            )
        sources = store.sources() if store is not None else []
        if source_id is not None:
            sources = [source for source in sources if source["id"] == source_id]
            if not sources:
                rows.append(
                    check(
                        "source",
                        False,
                        "Configured source",
                        "已配置来源",
                        "Use an existing source id.",
                        "使用已存在的来源 ID。",
                    )
                )
        else:
            sources = [source for source in sources if source["enabled"]]
        for source in sources:
            node = store.node(source.get("node", "")) if store is not None else None
            for row in await source_checks(source, node):
                row["source_id"] = source["id"]
                rows.append(row)
        return rows
    finally:
        if store is not None:
            store.db.close()


def run(directory: Path, port: int, source_id: str | None, as_json: bool, language: str) -> int:
    rows = asyncio.run(diagnose(directory, port, source_id))
    if as_json:
        print(json.dumps(rows, ensure_ascii=False))
    else:
        for row in rows:
            prefix = f"{row['source_id']}: " if row.get("source_id") else ""
            labels = (
                {"ok": "通过", "failed": "失败", "missing": "缺失"}
                if language == "zh-CN"
                else {"ok": "PASS", "failed": "FAIL", "missing": "MISSING"}
            )
            print(f"{labels[row['state']]}: {prefix}{row['label'][language]}")
            if row["detail"]:
                print(f"  {row['detail'][language]}")
    return int(any(row["state"] == "failed" for row in rows))
