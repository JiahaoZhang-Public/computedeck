"""Amazon EC2 GPU instance discovery through the AWS CLI. Read-only.

The AWS CLI on the service machine supplies credentials (profiles, SSO, environment,
instance roles); ComputeDeck stores no AWS secret. Two read-only calls are made:
``ec2 describe-instances`` and ``ec2 describe-instance-types`` for the types seen.
"""

import asyncio
import json
import os
import re
from typing import Any, ClassVar, Literal

from ..ssh_config import validate_alias, validate_endpoint, validate_username
from .base import (
    Batch,
    DriverCheck,
    DriverField,
    DriverInfo,
    SourceError,
    integer,
    job_time,
    now,
    number,
    options,
)

REGION = r"[a-z]{2}(-[a-z]+)+-[0-9]{1,2}"
# A profile name is a config section name; no leading dash, so it is never an option.
PROFILE = r"[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,63}"
INSTANCE_TYPE = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}")
DEFAULT_USER = "ec2-user"
# DescribeInstanceTypes accepts at most 100 instance types per request.
# https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypes.html
TYPES_PER_CALL = 100
TIMEOUT = 60

# InstanceState names: pending | running | shutting-down | terminated | stopping | stopped.
# Transitions keep the lifecycle they are heading for.
# https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceState.html
STATES = {
    "running": "running",
    "stopped": "stopped",
    "terminated": "terminated",
    "pending": "desired_running",
    "stopping": "desired_stopped",
    "shutting-down": "desired_terminated",
}
# "An error occurred (UnauthorizedOperation) when calling ...": keep only the code. The
# message can name the account, user ARN or request details.
_ERROR_CODE = re.compile(r"An error occurred \(([A-Za-z0-9.]{1,64})\)")
# https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-returncodes.html
_EXIT_CODES = {
    252: "invalid command or parameter",
    253: "AWS CLI configuration or credentials missing",
    254: "service returned an error",
}


def settings(source: dict[str, Any]) -> tuple[str, str | None, str]:
    """Validated region, profile and SSH username of a source."""
    values = options(source)
    region = values.get("region", "")
    if not region:
        raise SourceError("option_required", option="region")
    if not re.fullmatch(REGION, region):
        raise SourceError("invalid_option", option="region")
    profile = values.get("profile") or None
    if profile and not re.fullmatch(PROFILE, profile):
        raise SourceError("invalid_option", option="profile")
    username = values.get("ssh_user") or DEFAULT_USER
    try:
        validate_username(username)
    except ValueError:
        raise SourceError("invalid_option", option="ssh_user") from None
    return region, profile, username


def _failure(returncode: int, stderr: bytes) -> str:
    """The AWS error code, or the CLI's exit status; never the error message itself."""
    match = _ERROR_CODE.search(stderr.decode("utf-8", errors="replace"))
    if match:
        return match.group(1)
    meaning = _EXIT_CODES.get(returncode)
    return f"exit status {returncode}" + (f": {meaning}" if meaning else "")


async def aws(command: list[str], region: str, profile: str | None) -> Any:
    """Run one AWS CLI command without a shell and return its parsed JSON output."""
    args = ["aws", "ec2", *command, "--region", region, "--output", "json"]
    if profile:
        args.extend(["--profile", profile])
    # No pager or interactive prompt, whatever the user's CLI configuration says.
    # https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-pagination.html
    # https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-prompting.html
    env = {**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"}
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except OSError as error:
        raise SourceError("aws_cli_unavailable", type(error).__name__) from None
    try:
        async with asyncio.timeout(TIMEOUT):
            stdout, stderr = await process.communicate()
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    name = command[0]
    if process.returncode:
        raise SourceError("aws_cli_failed", _failure(process.returncode, stderr), command=name)
    try:
        return json.loads(stdout.decode("utf-8", errors="replace"))
    except ValueError:
        raise SourceError("unexpected_output", command=name) from None


def _list(value: Any, key: str, command: str) -> list[Any]:
    items = value.get(key) if isinstance(value, dict) else None
    if not isinstance(items, list):
        raise SourceError("unexpected_output", command=command)
    return items


def gpu_info(instance_type: dict[str, Any]) -> tuple[int | None, str | None]:
    """GPU count and model of an instance type; ``(0, None)`` when it has no GPU."""
    info = instance_type.get("GpuInfo")
    if info is None:
        return 0, None
    gpus = info.get("Gpus") if isinstance(info, dict) else None
    if not isinstance(gpus, list):
        return None, None
    if not gpus:
        return 0, None
    total: int | None = 0
    names = []
    for gpu in gpus:
        if not isinstance(gpu, dict):
            return None, None
        count = integer(gpu.get("Count"))
        total = total + count if total is not None and count is not None else None
        name = " ".join(
            str(part).strip() for part in (gpu.get("Manufacturer"), gpu.get("Name")) if part
        )
        # Fractional GPUs (e.g. G6f) count as the one device the instance sees.
        size = number(gpu.get("GpuPartitionSize"))
        if name and size is not None and 0 < size < 1:
            name = f"{name} ({size:g} GPU)"
        if name:
            names.append(name)
    return total, ", ".join(dict.fromkeys(names)) or None


def _name(instance: dict[str, Any]) -> str | None:
    for tag in instance.get("Tags") or []:
        if isinstance(tag, dict) and tag.get("Key") == "Name":
            value = str(tag.get("Value") or "").strip()
            return value or None
    return None


def parse_instances(
    reservations: list[Any],
    types: dict[str, tuple[int | None, str | None]],
    source: dict[str, Any],
) -> list[dict[str, Any]]:
    """Instances whose type has GPUs; a type that was not described stays unknown."""
    region, _, username = settings(source)
    result: dict[str, dict[str, Any]] = {}
    observed_at = now()
    for reservation in reservations:
        for instance in _list(reservation, "Instances", "describe-instances"):
            raw_id = instance.get("InstanceId") if isinstance(instance, dict) else None
            if not isinstance(raw_id, str):
                raise SourceError("unexpected_output", command="describe-instances")
            instance_id = validate_alias(raw_id)
            gpu_count, gpu_type = types.get(str(instance.get("InstanceType")), (None, None))
            if gpu_count == 0:
                continue
            lifecycle = instance.get("State")
            name = lifecycle.get("Name") if isinstance(lifecycle, dict) else None
            state = STATES.get(str(name), "unknown")
            host = instance.get("PublicIpAddress")
            host = host.strip() if isinstance(host, str) and host.strip() else None
            endpoint = {"host": host, "port": 22 if host else None, "username": username}
            if host:
                validate_endpoint(endpoint)
            record_id = f"{source['cluster_id']}:{instance_id}"
            result[record_id] = {
                "id": record_id,
                "source_id": source["id"],
                "platform": source["name"],
                "name": _name(instance) or instance_id,
                "state": state,
                "started_at": job_time(instance.get("LaunchTime")) if state == "running" else None,
                "gpu_count": gpu_count,
                "gpu_type": gpu_type,
                # EC2 reports configuration and lifecycle, not utilization.
                "gpu_utilization": None,
                "cpu_utilization": None,
                "memory_utilization": None,
                **endpoint,
                "ssh_alias": f"computedeck-{source['cluster_id']}-{instance_id}",
                "identity_file": None,
                # Prices need the AWS Price List API and depend on purchase option.
                "hourly_cost": None,
                "currency": "USD",
                "region": region,
                "observed_at": observed_at,
                "ssh_status": "unverified",
            }
    return list(result.values())


class AWSEC2Driver:
    name: ClassVar[str] = "aws-ec2"
    kind: ClassVar[Literal["cluster", "cloud"]] = "cloud"
    info: ClassVar[DriverInfo] = DriverInfo(
        label={"en": "Amazon EC2", "zh-CN": "Amazon EC2"},
        description={
            "en": "GPU instances and SSH endpoints of one region, read with the AWS CLI.",
            "zh-CN": "通过 AWS CLI 读取一个区域的 GPU 实例和 SSH 端点。",
        },
        details={
            "en": "Runs aws ec2 describe-instances and describe-instance-types on {where} "
            "with the AWS CLI's own configuration and credentials; ComputeDeck stores no "
            "AWS key. Only instances whose type has GPUs are listed. Prices are not read.",
            "zh-CN": "在{where}上运行 aws ec2 describe-instances 和 describe-instance-types，"
            "使用 AWS CLI 自身的配置和凭据，ComputeDeck 不保存 AWS 密钥。"
            "只列出实例类型带 GPU 的实例，不读取价格。",
        },
        fields=[
            DriverField(
                key="region",
                label={"en": "Region", "zh-CN": "区域"},
                hint={
                    "en": "The AWS Region to list, such as us-east-1. Add one source per Region.",
                    "zh-CN": "要列出的 AWS 区域，例如 us-east-1。每个区域添加一个来源。",
                },
                placeholder="us-east-1",
                required=True,
                pattern=REGION,
            ),
            DriverField(
                key="profile",
                label={"en": "AWS CLI profile", "zh-CN": "AWS CLI profile"},
                hint={
                    "en": "A named profile of the AWS CLI on {where}. Leave empty to use the "
                    "CLI's default credentials.",
                    "zh-CN": "{where} AWS CLI 中的命名 profile。留空则使用 CLI 的默认凭据。",
                },
                placeholder="default",
                pattern=PROFILE,
            ),
            DriverField(
                key="ssh_user",
                label={"en": "SSH username", "zh-CN": "SSH 用户名"},
                hint={
                    "en": "The login of your AMI: ec2-user for Amazon Linux, ubuntu for Ubuntu.",
                    "zh-CN": "AMI 的登录用户：Amazon Linux 为 ec2-user，Ubuntu 为 ubuntu。",
                },
                placeholder=DEFAULT_USER,
                default=DEFAULT_USER,
                pattern="[A-Za-z0-9_][A-Za-z0-9_.@-]*",
            ),
        ],
        checks=[
            DriverCheck(
                capability="instances",
                command="describe-instances",
                label={"en": "GPU instances", "zh-CN": "GPU 实例"},
            ),
            DriverCheck(
                capability="gpu_types",
                command="describe-instance-types",
                label={"en": "GPU models and counts", "zh-CN": "GPU 型号和数量"},
            ),
        ],
        default_name="AWS EC2",
    )

    def validate(self, source: dict[str, Any]) -> None:
        settings(source)

    async def collect(self, source: dict[str, Any]) -> Batch:
        region, profile, _ = settings(source)
        reservations = _list(
            await aws(["describe-instances"], region, profile), "Reservations", "describe-instances"
        )
        names = sorted(
            {
                str(instance.get("InstanceType"))
                for reservation in reservations
                if isinstance(reservation, dict)
                for instance in reservation.get("Instances") or []
                if isinstance(instance, dict)
                and INSTANCE_TYPE.fullmatch(str(instance.get("InstanceType")))
            }
        )
        types: dict[str, tuple[int | None, str | None]] = {}
        for start in range(0, len(names), TYPES_PER_CALL):
            chunk = names[start : start + TYPES_PER_CALL]
            output = await aws(
                ["describe-instance-types", "--instance-types", *chunk], region, profile
            )
            for item in _list(output, "InstanceTypes", "describe-instance-types"):
                if isinstance(item, dict) and item.get("InstanceType") in chunk:
                    types[item["InstanceType"]] = gpu_info(item)
        return Batch(
            instances=parse_instances(reservations, types, source),
            capabilities=["instances", "gpu_types", "ssh_discovery", "ssh_probe"],
        )
