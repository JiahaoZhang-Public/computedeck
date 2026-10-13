"""EC2 driver: GPU instances from the AWS CLI, run without a shell; CLI output is stubbed."""

import asyncio
import json
from typing import Any

import pytest

from computedeck.drivers import aws_ec2
from computedeck.drivers.base import SourceError

SOURCE: dict[str, Any] = {
    "id": "aws-ec2-aws-ec2",
    "name": "AWS EC2",
    "driver": "aws-ec2",
    "cluster_id": "aws-ec2",
    "username": "",
    "credential": "",
    "options": {"region": "us-east-1"},
}
GPU_TYPES: list[dict[str, Any]] = [
    {
        "InstanceType": "g5.xlarge",
        "GpuInfo": {
            "Gpus": [
                {"Name": "A10G", "Manufacturer": "NVIDIA", "Count": 1, "MemoryInfo": {}},
            ],
            "TotalGpuMemoryInMiB": 24576,
        },
    },
    {"InstanceType": "c5.large", "VCpuInfo": {"DefaultVCpus": 2}},
    {
        "InstanceType": "p4d.24xlarge",
        "GpuInfo": {"Gpus": [{"Name": "A100", "Manufacturer": "NVIDIA", "Count": 8}]},
    },
]


def ec2(**changes: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "InstanceId": "i-0123456789abcdef0",
        "InstanceType": "g5.xlarge",
        "State": {"Code": 16, "Name": "running"},
        "PublicIpAddress": "203.0.113.30",
        "PrivateIpAddress": "10.0.0.30",
        "KeyName": "example-key",
        "Placement": {"AvailabilityZone": "us-east-1a"},
        "IamInstanceProfile": {"Arn": "arn:aws:iam::000000000000:instance-profile/do-not-return"},
        "Tags": [{"Key": "team", "Value": "do-not-return"}, {"Key": "Name", "Value": "train-1"}],
    }
    result.update(changes)
    return result


def reservations(*instances: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"ReservationId": "r-0123456789abcdef0", "Instances": list(instances)}]


def types() -> dict[str, tuple[int | None, str | None]]:
    return {item["InstanceType"]: aws_ec2.gpu_info(item) for item in GPU_TYPES}


class FakeProcess:
    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", code: int = 0) -> None:
        self.stdout, self.stderr, self.code = stdout, stderr, code
        self.returncode: int | None = None
        self.hang = False
        self.killed = False

    async def communicate(self) -> tuple[bytes, bytes]:
        if self.hang and not self.killed:
            await asyncio.sleep(3600)
        self.returncode = -9 if self.killed else self.code
        return self.stdout, self.stderr

    def kill(self) -> None:
        self.killed = True


class FakeCLI:
    """Answers describe-instances and describe-instance-types like the AWS CLI."""

    def __init__(self, instances: list[dict[str, Any]] | None = None) -> None:
        self.output: dict[str, Any] = {
            "describe-instances": {"Reservations": reservations(*(instances or [ec2()]))},
        }
        self.calls: list[tuple[tuple[str, ...], dict[str, Any]]] = []
        self.process: FakeProcess | None = None

    async def __call__(self, *args: str, **kwargs: Any) -> FakeProcess:
        self.calls.append((args, kwargs))
        if self.process:
            return self.process
        command = args[2]
        if command == "describe-instance-types":
            requested = args[args.index("--instance-types") + 1 : args.index("--region")]
            body: Any = {
                "InstanceTypes": [item for item in GPU_TYPES if item["InstanceType"] in requested]
            }
        else:
            body = self.output[command]
        return FakeProcess(json.dumps(body).encode())


def use_cli(monkeypatch: pytest.MonkeyPatch, cli: Any) -> None:
    monkeypatch.setattr(aws_ec2.asyncio, "create_subprocess_exec", cli)


def test_gpu_instance_with_endpoint_and_no_unrelated_fields() -> None:
    instance = aws_ec2.parse_instances(reservations(ec2()), types(), SOURCE)[0]
    assert instance["id"] == "aws-ec2:i-0123456789abcdef0"
    assert instance["source_id"] == "aws-ec2-aws-ec2"
    assert instance["platform"] == "AWS EC2"
    assert instance["name"] == "train-1"
    assert instance["state"] == "running"
    assert instance["gpu_count"] == 1
    assert instance["gpu_type"] == "NVIDIA A10G"
    assert (instance["host"], instance["port"], instance["username"]) == (
        "203.0.113.30",
        22,
        "ec2-user",
    )
    assert instance["ssh_alias"] == "computedeck-aws-ec2-i-0123456789abcdef0"
    assert instance["region"] == "us-east-1"
    # Prices and utilization are not read; unknown, not zero.
    assert instance["hourly_cost"] is None
    assert instance["currency"] == "USD"
    assert instance["gpu_utilization"] is None
    assert instance["cpu_utilization"] is None
    assert instance["memory_utilization"] is None
    assert instance["ssh_status"] == "unverified"
    assert "do-not-return" not in json.dumps(instance)


def test_only_gpu_types_are_listed_and_undescribed_types_stay_unknown() -> None:
    rows = reservations(
        ec2(),
        ec2(InstanceId="i-0000000000000000c", InstanceType="c5.large"),
        ec2(InstanceId="i-0000000000000000d", InstanceType="p4d.24xlarge", Tags=None),
        ec2(InstanceId="i-0000000000000000e", InstanceType="x9.example"),
    )
    parsed = {item["id"]: item for item in aws_ec2.parse_instances(rows, types(), SOURCE)}
    assert set(parsed) == {
        "aws-ec2:i-0123456789abcdef0",
        "aws-ec2:i-0000000000000000d",
        "aws-ec2:i-0000000000000000e",
    }
    assert parsed["aws-ec2:i-0000000000000000d"]["gpu_count"] == 8
    assert parsed["aws-ec2:i-0000000000000000d"]["name"] == "i-0000000000000000d"
    unknown = parsed["aws-ec2:i-0000000000000000e"]
    assert unknown["gpu_count"] is None and unknown["gpu_type"] is None


@pytest.mark.parametrize(
    ("name", "state"),
    [
        ("running", "running"),
        ("stopped", "stopped"),
        ("terminated", "terminated"),
        ("pending", "desired_running"),
        ("stopping", "desired_stopped"),
        ("shutting-down", "desired_terminated"),
        ("rebooting", "unknown"),
        (None, "unknown"),
        ("not-a-dict", "unknown"),
    ],
)
def test_state_mapping(name: str | None, state: str) -> None:
    row = ec2(State="running" if name == "not-a-dict" else {"Code": 0, "Name": name})
    assert aws_ec2.parse_instances(reservations(row), types(), SOURCE)[0]["state"] == state


def test_stopped_instance_keeps_a_stable_alias_without_an_endpoint() -> None:
    alias = aws_ec2.parse_instances(reservations(ec2()), types(), SOURCE)[0]["ssh_alias"]
    row = ec2(State={"Code": 80, "Name": "stopped"})
    row.pop("PublicIpAddress")
    stopped = aws_ec2.parse_instances(reservations(row), types(), SOURCE)[0]
    assert stopped["host"] is None and stopped["port"] is None
    assert stopped["ssh_alias"] == alias


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        ({"InstanceType": "c5.large"}, (0, None)),
        ({"GpuInfo": {"Gpus": []}}, (0, None)),
        (GPU_TYPES[2], (8, "NVIDIA A100")),
        (
            {"GpuInfo": {"Gpus": [{"Name": "L4", "Manufacturer": "NVIDIA", "Count": 1}] * 2}},
            (2, "NVIDIA L4"),
        ),
        (
            {
                "GpuInfo": {
                    "Gpus": [
                        {
                            "Name": "L4",
                            "Manufacturer": "NVIDIA",
                            "Count": 1,
                            "GpuPartitionSize": 0.125,
                        }
                    ]
                }
            },
            (1, "NVIDIA L4 (0.125 GPU)"),
        ),
        (
            {"GpuInfo": {"Gpus": [{"Name": "A10G", "Manufacturer": "NVIDIA"}]}},
            (None, "NVIDIA A10G"),
        ),
        ({"GpuInfo": {"Gpus": [{"Name": "T4", "Count": "one"}]}}, (None, "T4")),
        ({"GpuInfo": {"TotalGpuMemoryInMiB": 1}}, (None, None)),
        ({"GpuInfo": ["unexpected"]}, (None, None)),
        ({"GpuInfo": {"Gpus": ["unexpected"]}}, (None, None)),
    ],
)
def test_gpu_info(item: dict[str, Any], expected: tuple[int | None, str | None]) -> None:
    assert aws_ec2.gpu_info(item) == expected


@pytest.mark.parametrize(
    "changes",
    [
        {"InstanceId": "-oProxyCommand=touch"},
        {"InstanceId": "i-1\nHost *"},
        {"PublicIpAddress": "203.0.113.30\nProxyCommand touch /tmp/x"},
        {"PublicIpAddress": "-oProxyCommand=touch"},
    ],
)
def test_unsafe_provider_values_are_rejected(changes: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        aws_ec2.parse_instances(reservations(ec2(**changes)), types(), SOURCE)


@pytest.mark.parametrize("bad", [None, "text", {"InstanceType": "g5.xlarge"}])
def test_rows_without_an_id_are_unexpected(bad: Any) -> None:
    with pytest.raises(SourceError, match="unexpected_output"):
        aws_ec2.parse_instances([{"Instances": [bad]}], types(), SOURCE)


@pytest.mark.parametrize(
    ("options", "code", "option"),
    [
        ({}, "option_required", "region"),
        ({"region": "US East"}, "invalid_option", "region"),
        ({"region": "--region"}, "invalid_option", "region"),
        ({"region": "us-east-1", "profile": "-x"}, "invalid_option", "profile"),
        ({"region": "us-east-1", "profile": "two words"}, "invalid_option", "profile"),
        ({"region": "us-east-1", "ssh_user": "-oProxyCommand"}, "invalid_option", "ssh_user"),
    ],
)
def test_validate_rejects_missing_or_unsafe_options(
    options: dict[str, str], code: str, option: str
) -> None:
    with pytest.raises(SourceError) as error:
        aws_ec2.AWSEC2Driver().validate({**SOURCE, "options": options})
    assert error.value.message() == {"code": code, "option": option}


def test_validate_accepts_region_profile_and_user() -> None:
    driver = aws_ec2.AWSEC2Driver()
    driver.validate(SOURCE)
    source = {
        **SOURCE,
        "options": {"region": "ap-southeast-2", "profile": "team.gpu-ro", "ssh_user": "ubuntu"},
    }
    driver.validate(source)
    assert aws_ec2.settings(source) == ("ap-southeast-2", "team.gpu-ro", "ubuntu")
    instance = aws_ec2.parse_instances(reservations(ec2()), types(), source)[0]
    assert instance["username"] == "ubuntu"


def test_driver_description() -> None:
    info = aws_ec2.AWSEC2Driver.info
    assert aws_ec2.AWSEC2Driver.name == "aws-ec2"
    assert aws_ec2.AWSEC2Driver.kind == "cloud"
    assert [field.key for field in info.fields] == ["region", "profile", "ssh_user"]
    assert [field.required for field in info.fields] == [True, False, False]
    assert [check.command for check in info.checks] == [
        "describe-instances",
        "describe-instance-types",
    ]
    assert all(text.get("zh-CN") for text in (info.label, info.description, info.details))


async def test_collect_runs_the_cli_without_a_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = FakeCLI(
        [
            ec2(),
            ec2(InstanceId="i-0000000000000000c", InstanceType="c5.large"),
            ec2(InstanceId="i-0000000000000000d", InstanceType="p4d.24xlarge"),
        ]
    )
    use_cli(monkeypatch, cli)
    source = {**SOURCE, "options": {"region": "eu-west-1", "profile": "readonly"}}
    batch = await aws_ec2.AWSEC2Driver().collect(source)
    assert batch.capabilities == ["instances", "gpu_types", "ssh_discovery", "ssh_probe"]
    assert batch.instances is not None
    assert sorted(item["id"] for item in batch.instances) == [
        "aws-ec2:i-0000000000000000d",
        "aws-ec2:i-0123456789abcdef0",
    ]
    assert set(batch.snapshot()) == {"instances"}
    common = ("--region", "eu-west-1", "--output", "json", "--profile", "readonly")
    assert [args for args, _ in cli.calls] == [
        ("aws", "ec2", "describe-instances", *common),
        (
            "aws",
            "ec2",
            "describe-instance-types",
            "--instance-types",
            "c5.large",
            "g5.xlarge",
            "p4d.24xlarge",
            *common,
        ),
    ]
    for _, kwargs in cli.calls:
        assert kwargs["stdin"] == asyncio.subprocess.DEVNULL
        assert kwargs["env"]["AWS_PAGER"] == ""
        assert kwargs["env"]["AWS_CLI_AUTO_PROMPT"] == "off"
        assert "shell" not in kwargs


async def test_instance_types_are_described_in_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aws_ec2, "TYPES_PER_CALL", 2)
    cli = FakeCLI(
        [
            ec2(),
            ec2(InstanceId="i-0000000000000000c", InstanceType="c5.large"),
            ec2(InstanceId="i-0000000000000000d", InstanceType="p4d.24xlarge"),
            # Not a valid type name: never passed to the CLI, listed as unknown.
            ec2(InstanceId="i-0000000000000000e", InstanceType="--debug"),
        ]
    )
    use_cli(monkeypatch, cli)
    batch = await aws_ec2.AWSEC2Driver().collect(SOURCE)
    described = [args[4 : args.index("--region")] for args, _ in cli.calls[1:]]
    assert described == [("c5.large", "g5.xlarge"), ("p4d.24xlarge",)]
    assert batch.instances is not None
    unknown = next(item for item in batch.instances if item["id"].endswith("0e"))
    assert unknown["gpu_count"] is None
    assert all("--profile" not in args for args, _ in cli.calls)


async def test_no_instances_skips_the_type_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = FakeCLI()
    cli.output["describe-instances"] = {"Reservations": []}
    use_cli(monkeypatch, cli)
    batch = await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert batch.instances == []
    assert len(cli.calls) == 1


async def test_missing_cli_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    async def missing(*args: str, **kwargs: Any) -> FakeProcess:
        raise FileNotFoundError(2, "No such file or directory", "aws")

    use_cli(monkeypatch, missing)
    with pytest.raises(SourceError) as error:
        await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert error.value.message() == {"code": "aws_cli_unavailable", "detail": "FileNotFoundError"}


async def test_cli_error_reports_only_the_error_code(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = FakeCLI()
    cli.process = FakeProcess(
        stderr=b"\nAn error occurred (UnauthorizedOperation) when calling the DescribeInstances "
        b"operation: You are not authorized. User: arn:aws:iam::000000000000:user/do-not-return",
        code=254,
    )
    use_cli(monkeypatch, cli)
    with pytest.raises(SourceError) as error:
        await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert error.value.message() == {
        "code": "aws_cli_failed",
        "command": "describe-instances",
        "detail": "UnauthorizedOperation",
    }
    assert "do-not-return" not in str(error.value)


@pytest.mark.parametrize(
    ("code", "detail"),
    [
        (253, "exit status 253: AWS CLI configuration or credentials missing"),
        (255, "exit status 255"),
    ],
)
async def test_cli_failure_without_a_code_reports_the_exit_status(
    monkeypatch: pytest.MonkeyPatch, code: int, detail: str
) -> None:
    cli = FakeCLI()
    cli.process = FakeProcess(
        stderr=b"The config profile (do-not-return) could not be found", code=code
    )
    use_cli(monkeypatch, cli)
    with pytest.raises(SourceError) as error:
        await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert error.value.message()["detail"] == detail
    assert "do-not-return" not in json.dumps(error.value.message())


@pytest.mark.parametrize("stdout", [b"not json", b"[]", b'{"Reservations": {}}'])
async def test_unexpected_output_is_an_error(
    monkeypatch: pytest.MonkeyPatch, stdout: bytes
) -> None:
    cli = FakeCLI()
    cli.process = FakeProcess(stdout)
    use_cli(monkeypatch, cli)
    with pytest.raises(SourceError) as error:
        await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert error.value.message() == {"code": "unexpected_output", "command": "describe-instances"}


async def test_type_lookup_shape_is_checked(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = FakeCLI()
    real = cli.__call__

    async def call(*args: str, **kwargs: Any) -> FakeProcess:
        if args[2] == "describe-instance-types":
            return FakeProcess(b'{"Types": []}')
        return await real(*args, **kwargs)

    use_cli(monkeypatch, call)
    with pytest.raises(SourceError) as error:
        await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert error.value.message() == {
        "code": "unexpected_output",
        "command": "describe-instance-types",
    }


async def test_hanging_cli_is_killed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(aws_ec2, "TIMEOUT", 0.01)
    cli = FakeCLI()
    cli.process = FakeProcess()
    cli.process.hang = True
    use_cli(monkeypatch, cli)
    with pytest.raises(TimeoutError):
        await aws_ec2.AWSEC2Driver().collect(SOURCE)
    assert cli.process.killed


async def test_invalid_options_never_start_the_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = FakeCLI()
    use_cli(monkeypatch, cli)
    with pytest.raises(SourceError, match="invalid_option"):
        await aws_ec2.AWSEC2Driver().collect({**SOURCE, "options": {"region": "-x"}})
    assert cli.calls == []
