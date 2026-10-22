# Lambda Cloud driver (`lambda`)

Lists the instances of one Lambda Cloud account: lifecycle, instance type with GPU model and count, price per hour, region and the SSH endpoint. One source is one API key.

The driver class is `computedeck.drivers.lambda_cloud.LambdaCloudDriver` (driver name `lambda`, kind `cloud`). The module is called `lambda_cloud` because `lambda` is a Python keyword.

## Requirements

- A Lambda Cloud API key (created in the Lambda Cloud console under API keys). The driver only lists instances; it never launches, restarts or terminates anything.
- The key must be readable by the ComputeDeck service, for example as the environment variable `LAMBDA_API_KEY` of the service process, or in the system keychain (`keyring set computedeck lambda`, reference `keychain:computedeck/lambda`).
- HTTPS access from the service to `cloud.lambda.ai`.

## What is read

`GET https://cloud.lambda.ai/api/v1/instances` with `Authorization: Bearer <key>` ([API reference](https://docs.lambda.ai/api/cloud#listInstances)). Without paging parameters the response holds every instance in one list, `{"data": [...], "page_token": null}`.

| Instance field | Lambda field |
| --- | --- |
| `name` | `name`, or the instance id |
| `state` | `status` (below) |
| `gpu_count` | `instance_type.specs.gpus` (0 for CPU-only types) |
| `gpu_type` | `instance_type.gpu_description` |
| `hourly_cost` (USD) | `instance_type.price_cents_per_hour` / 100, for the whole instance |
| `started_at` | `null`; no documented current-run start is collected |
| `region` | `region.name` |
| `host`, `port`, `username` | `ip` (public IPv4), port 22, user `ubuntu`, as in Lambda's [connection guide](https://docs.lambda.ai/public-cloud/on-demand/connecting-instance/) |

State, from `status`:

| `status` | State |
| --- | --- |
| `active` | `running` |
| `booting` | `desired_running` |
| `terminating` | `desired_terminated` |
| `terminated` | `terminated` |
| `unhealthy`, `preempted`, anything else | `unknown` |

Not read or not returned: Jupyter tokens and URLs, SSH key names, file systems, tags, firewall rules, private IP. The API reports no utilization, so GPU, CPU and memory use stay empty until an SSH check reads them. Provider error bodies are never shown; a failed request reports only its HTTP status.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `credential` | yes | Where the API key is read, default `env:LAMBDA_API_KEY`. `env:NAME` or `keychain:service/account`; never the key itself. |

The driver has no options. A source-level `username` replaces `ubuntu` for SSH.

## Limitations

- The API does not describe `unhealthy` or `preempted` beyond their names, so both are shown as unknown lifecycle.
- The SSH user `ubuntu` is Lambda's default image login. A custom image with another user needs a source `username`.
- If the API ever returns a `page_token` without being asked, the collection fails rather than showing an incomplete list.

## Running cost and low-use coverage

Running-cost estimates use the labelled `seen_running_since` observation window
because no provider start is collected. Gaps or lifecycle changes reset the window;
stale estimates stop at the last successful collection. Current-price estimates
are not bills. See [running cost estimates](../metrics.md#running-cost-estimates).

The listing provides no utilization. On-demand hardware checks contribute actual
readings, but one check cannot establish sustained low use and no periodic provider
SSH checks are added. See [low-use coverage](../metrics.md#sustained-low-gpu-use).
