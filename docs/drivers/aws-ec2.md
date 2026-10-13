# Amazon EC2 driver (`aws-ec2`)

Lists the GPU instances of one AWS Region: lifecycle, GPU model and count, and the SSH endpoint. One source is one Region, optionally with a named AWS CLI profile.

The driver class is `computedeck.drivers.aws_ec2.AWSEC2Driver` (driver name `aws-ec2`, kind `cloud`).

## Requirements

On the computer that runs ComputeDeck:

- The AWS CLI (`aws`, version 2 recommended) on the service's `PATH`. A service started by launchd or systemd may have a shorter `PATH` than your shell.
- AWS credentials the CLI can use non-interactively: a profile in `~/.aws/config` and `~/.aws/credentials`, an SSO session that is already logged in (`aws sso login`), environment variables, or an instance role. ComputeDeck stores no AWS key and has no credential field; it uses whatever the CLI resolves.
- Permission for two read-only actions: `ec2:DescribeInstances` and `ec2:DescribeInstanceTypes`.

## What is read

Two commands, run without a shell (`asyncio.create_subprocess_exec`), with standard input closed, the pager disabled (`AWS_PAGER=""`) and auto-prompt off (`AWS_CLI_AUTO_PROMPT=off`), each limited to 60 seconds:

```sh
aws ec2 describe-instances --region <region> --output json [--profile <profile>]
aws ec2 describe-instance-types --instance-types <types seen> --region <region> --output json [--profile <profile>]
```

The CLI follows pagination itself. Instance types are described at most 100 per call, and only types that actually occur; with no instances the second command is skipped.

Only instances whose type has GPUs (`GpuInfo.Gpus` in [DescribeInstanceTypes](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypes.html)) are listed. CPU-only instances are left out, and so are Inferentia, Trainium and FPGA types, which EC2 does not report as GPUs. An instance whose type could not be described is listed with an unknown GPU count rather than dropped.

| Instance field | EC2 field |
| --- | --- |
| `name` | the `Name` tag, or the instance id |
| `state` | `State.Name` (below) |
| `gpu_count` | sum of `GpuInfo.Gpus[].Count` of the instance type |
| `gpu_type` | `Manufacturer` and `Name` of each GPU, e.g. `NVIDIA A10G`; fractional GPUs add their `GpuPartitionSize`, e.g. `NVIDIA L4 (0.125 GPU)` |
| `host`, `port` | `PublicIpAddress`, port 22 |
| `username` | the `ssh_user` option, default `ec2-user` |
| `region` | the configured Region |
| `hourly_cost` | not read (`null`) |

State, from [`InstanceState`](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceState.html):

| EC2 state | State |
| --- | --- |
| `running` | `running` |
| `stopped` | `stopped` |
| `terminated` | `terminated` |
| `pending` | `desired_running` |
| `stopping` | `desired_stopped` |
| `shutting-down` | `desired_terminated` |
| anything else | `unknown` |

Terminated instances stay in the EC2 list for a while and are shown as terminated; after that ComputeDeck shows them as missing.

Not returned: tags other than `Name`, key pair names, IAM roles, network and storage details. When a command fails, only the AWS error code (such as `UnauthorizedOperation`) or the CLI exit status is reported; the error message can name the account or a user ARN and is never shown.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `region` (option) | yes | The Region to list, e.g. `us-east-1`. Add one source per Region. |
| `profile` (option) | no | A named profile of the AWS CLI. Empty uses the CLI's default credential chain. |
| `ssh_user` (option) | no | SSH login for the listed instances, default `ec2-user`. Use `ubuntu` for Ubuntu AMIs. |

There is no credential field.

## Limitations

- No prices. On-Demand, Spot, Savings Plans and Capacity Blocks price the same instance differently, and the Price List API is out of scope.
- No utilization. EC2 reports configuration and lifecycle; use an SSH check or CloudWatch for usage.
- The SSH user depends on the AMI and cannot be read from EC2, so one `ssh_user` applies to every instance of the source.
- Instances without a public IPv4 address (private subnets, IPv6 only) get no SSH endpoint. Add them by hand with an existing SSH alias, for example one that uses a bastion host.
- A fractional GPU (e.g. G6f) counts as one GPU, the one device the instance sees.
- The `aws` executable must be found on the service's `PATH`; otherwise the collection fails with `aws_cli_unavailable`.
