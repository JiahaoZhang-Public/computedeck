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

from . import auth, credentials, drivers, nodes, plugins, routes
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
        # Through a jump host, as the connection itself would go.
        *ssh.route_options(),
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


def beyond(name: str) -> dict[str, tuple[str, str]]:
    """Guidance when this machine reached the jump host ``name`` but not the target."""
    return {
        "authentication": (
            f"The connection went through {name}, and the target rejected the login. "
            "This computer logs in with its own keys: check the login name and key access here.",
            f"连接已经过 {name}，但目标主机拒绝了登录。"
            "本机用自己的密钥登录：请在本机检查登录用户名和密钥权限。",
        ),
        "host_key": (
            f"The connection went through {name}, but the target's host key could not be "
            "verified. Verify it with its administrator before updating known_hosts on this "
            "computer; do not disable verification.",
            f"连接已经过 {name}，但无法验证目标主机的密钥。先向管理员核实，再更新本机的 "
            "known_hosts；不要关闭验证。",
        ),
        "network": (
            f"{name} was reached, but it could not reach the target. Check the target's "
            f"HostName as {name} resolves it, and that {name} may connect to its SSH port.",
            f"已连上 {name}，但它无法到达目标主机。"
            f"检查 {name} 能否解析目标的 HostName 并连接其 SSH 端口。",
        ),
        "refused": (
            f"The target refused the connection from {name}. Check its SSH port and whether "
            "its SSH service is running.",
            f"目标主机拒绝了来自 {name} 的连接。检查 SSH 端口及远端 SSH 服务是否运行。",
        ),
        "closed": (
            f"The connection from {name} to the target was closed. Check that {name} may "
            "forward SSH connections (AllowTcpForwarding) and that the target accepts them.",
            f"从 {name} 到目标主机的连接被关闭。检查 {name} 是否允许转发 SSH 连接"
            "（AllowTcpForwarding），以及目标主机是否接受连接。",
        ),
        "unknown": (
            f"The connection goes from {name} to the target. Check the target's HostName as "
            f"{name} sees it, and the username, key and known_hosts on this computer; test "
            "the command below.",
            f"连接从 {name} 到目标主机。检查 {name} 所见的目标 HostName，以及本机的用户名、"
            "密钥和 known_hosts；可运行下面的命令测试。",
        ),
    }


def reach_hints(name: str, alias: str) -> dict[str, tuple[str, str]]:
    """Guidance when this machine cannot reach the jump host ``name``."""
    return {
        "timeout": (
            f"{name} did not answer in time. Check this computer's network and any VPN it "
            "needs, then retry.",
            f"{name} 未能及时响应。检查本机网络和所需的 VPN 后重试。",
        ),
        "authentication": (
            f"{name} rejected this computer's login. Check the user and key of Host {alias} "
            "in this computer's ~/.ssh/config, and that the key is loaded without a prompt.",
            f"{name} 拒绝了本机的登录。检查本机 ~/.ssh/config 中 Host {alias} 的用户和密钥，"
            "并确认无需交互即可使用该密钥。",
        ),
        "host_key": (
            f"The host key of {name} could not be verified. Verify it with its administrator "
            "before updating known_hosts on this computer; do not disable verification.",
            f"无法验证 {name} 的主机密钥。先向管理员核实，再更新本机的 known_hosts；不要关闭验证。",
        ),
        "network": (
            f"{name} is unreachable from this computer. Check the network, any VPN and the "
            f"HostName of Host {alias} in ~/.ssh/config.",
            f"本机无法到达 {name}。检查网络、VPN 以及 ~/.ssh/config 中 Host {alias} 的 HostName。",
        ),
        "refused": (
            f"{name} refused the connection. Check the SSH port of Host {alias} and whether "
            "its SSH service is running.",
            f"{name} 拒绝了连接。检查 Host {alias} 的 SSH 端口及其 SSH 服务是否运行。",
        ),
        "unknown": (
            f"Check that this computer logs in to {name} without a prompt: run the command "
            "below once in a terminal and accept the host key after verifying it.",
            f"确认本机无需交互即可登录 {name}：在终端运行一次下面的命令，核实后接受主机密钥。",
        ),
    }


async def route_check(
    node: dict[str, Any],
    add: Callable[[dict[str, Any]], None],
    starting: Callable[[str, str, str], None],
) -> bool:
    """The ``route`` row: whether this machine reaches the jump host ``node`` over SSH."""
    name = node["name"]
    en, zh = f"Reach {name} from this computer", f"从本机连接 {name}"
    starting("route", en, zh)
    alias = node["ssh_alias"]
    if shutil.which("ssh") is None:
        add(
            check(
                "route",
                False,
                en,
                zh,
                "Install the OpenSSH client on this computer.",
                "在本机安装 OpenSSH 客户端。",
            )
        )
        return False
    try:
        validate_alias(alias)
    except ValueError:
        add(
            check(
                "route",
                False,
                en,
                zh,
                "Edit the jump host: its SSH alias may use only letters, digits, dots, "
                "dashes and underscores.",
                "编辑跳板机：SSH 别名只能包含字母、数字、点、短横线和下划线。",
            )
        )
        return False
    failure = "unknown"
    try:
        # The jump host itself is reached directly.
        with ssh.through(None):
            await ssh.run(alias, "true")
        reached = True
    except (ssh.SSHError, OSError, TimeoutError) as error:
        reached = False
        failure = ssh.failure_cause(error)
    row = check("route", reached, en, zh)
    if not reached:
        hints = reach_hints(name, alias)
        fix_en, fix_zh = hints.get(failure, hints["unknown"])
        row["detail"] = {"en": fix_en, "zh-CN": fix_zh}
        row["command"] = shlex.join(
            ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "--", alias, "true"]
        )
    add(row)
    return reached


async def source_checks(
    source: dict[str, Any],
    node: dict[str, Any] | None = None,
    *,
    report: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    """Connection checks of a source, streamed through ``report`` as they run.

    For a source routed through a jump host, the ``route`` row checks that host first, and
    every SSH check after it goes through the jump host, as collection does.
    """
    try:
        route = ssh.through(routes.jump_alias(node) if source.get("node") else None)
    except ValueError:
        # An unusable jump alias: the route row reports it before anything connects.
        route = ssh.through(None)
    with route:
        return await _source_checks(source, node, report=report)


async def _source_checks(
    source: dict[str, Any],
    node: dict[str, Any] | None,
    *,
    report: Callable[[dict[str, Any]], None] | None,
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
    if source.get("node") and node is None:
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
    # A jump host this machine connects through, after checking that it reaches it.
    route = node if source.get("node") and routes.mode(node) == "jump" else None
    if route is not None and not await route_check(route, add, starting):
        return rows
    if node is not None and source.get("node") and route is None:
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
        fix = (
            (
                "Check the Host alias in this computer's SSH config. "
                f"Its HostName is resolved by {route['name']}, which connects to it.",
                f"检查本机 SSH 配置中的 Host 别名。其 HostName 由 {route['name']} 解析并连接。",
            )
            if route is not None
            else (
                "Check the Host alias and HostName in the collecting machine's SSH config.",
                "检查采集机器 SSH 配置中的 Host 别名和 HostName。",
            )
        )
        add(check("ssh_alias", resolved, "SSH alias resolves", "SSH 别名可解析", *fix))
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
            if route is not None:
                # The jump host answered: what failed lies between it and the target.
                hints.update(beyond(route["name"]))
                failure = failure if failure in hints else "unknown"
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
                    *(["-J", route["ssh_alias"]] if route is not None else []),
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
                f"Install {command} or add it to the non-interactive PATH on the collecting host"
                + (f", reached through {route['name']}." if route is not None else "."),
                f"在采集主机安装 {command} 或将它加入非交互会话的 PATH"
                + (f"（经由 {route['name']} 连接）。" if route is not None else "。"),
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
