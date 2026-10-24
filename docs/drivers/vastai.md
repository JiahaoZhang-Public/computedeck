# Vast.ai driver (`vastai`)

Lists the instances of one Vast.ai account: lifecycle, GPU model and count, price per hour, the SSH endpoint and the GPU utilization Vast.ai reports. One source is one API key.

The driver class is `computedeck.drivers.vastai.VastAIDriver` (driver name `vastai`, kind `cloud`). It is marked beta: several response fields are not described by Vast.ai (see Limitations).

## Requirements

- A Vast.ai API key (https://cloud.vast.ai/manage-keys/). A key that can read instances is enough; the driver never creates, starts, stops or destroys anything.
- The key must be readable by the ComputeDeck service, for example as the environment variable `VAST_API_KEY` of the service process, or in the system keychain (`keyring set computedeck vastai`, reference `keychain:computedeck/vastai`).
- HTTPS access from the service to `console.vast.ai`.

## What is read

`GET https://console.vast.ai/api/v1/instances/` with `Authorization: Bearer <key>` ([API reference](https://docs.vast.ai/api-reference/instances/show-instances)). The list is paged, 25 instances per page, ordered by id, following `next_token` until it is `null`, as the official `vastai` CLI does. The driver waits one second between pages, because the endpoint rate-limits faster requests. At most 40 pages (1000 instances) are read; a longer list fails the collection rather than hiding the rest.

| Instance field | Vast.ai field |
| --- | --- |
| `name` | `label`, or the instance id |
| `state` | `actual_status`, then `intended_status` (below) |
| `gpu_count`, `gpu_type` | `num_gpus`, `gpu_name` |
| `gpu_utilization` | `gpu_util`, only for running instances and only when between 0 and 100 |
| `hourly_cost` (USD) | `dph_total`, the CLI's `$/hr` column |
| `started_at` | `null`; `start_date` is not used because reset-on-restart semantics are unconfirmed |
| `host`, `port` | `public_ipaddr` and the host port mapped to `22/tcp` when present; otherwise the Vast SSH proxy `ssh_host` and `ssh_port` |
| `username` | `root`, the login Vast.ai documents |

State, from `actual_status` ([status values](https://docs.vast.ai/api-reference/hello-world)):

| `actual_status` | State |
| --- | --- |
| `running` | `running` |
| `exited` | `stopped` (the container is not running) |
| `unknown` (no heartbeat), `offline` (host disconnected) | `unknown` |
| `null` (provisioning), `loading` (image download), anything else | `desired_running` or `desired_stopped` from `intended_status`, otherwise `unknown` |

Destroyed instances disappear from the list; ComputeDeck then shows them as missing.

Not read or not returned: environment variables, on-start scripts, Jupyter tokens, template data, credit balance, CPU and memory use. Provider error bodies are never shown; a failed request reports only its HTTP status.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `credential` | yes | Where the API key is read, default `env:VAST_API_KEY`. `env:NAME` or `keychain:service/account`; never the key itself. |

The driver has no options.

## Limitations

- `gpu_util` is not documented by Vast.ai. The official CLI prints it as a percentage next to the GPU model, so the driver reads it as a percentage; how it is sampled and how several GPUs are combined is unknown. For exact per-GPU figures, check the instance over SSH.
- `cpu_util` and `mem_usage` have undocumented units and are not used.
- The SSH endpoint follows the official CLI's `ssh-url` logic, including its rule that the proxy port is one higher for Jupyter launch modes. Neither is documented in the API reference. The proxy hosts are shared, so accept the host key with a normal `ssh` login first.
- `dph_total` is the instance's listed total price per hour. Whether it changes to the storage-only charge while an instance is stopped is not documented.
- Pages are fetched one second apart, so a large account takes several seconds per collection.

## Running cost

Without a documented start of the current run, cost-so-far uses the store's
`seen_running_since` observation window, labelled as such. It multiplies the
observed duration by the current whole-instance price; it does not reconstruct
past prices or billing. Gaps and lifecycle changes reset that window, and stale
estimates stop at the last successful collection. See
[running cost estimates](../metrics.md#running-cost-estimates).

## Sustained low GPU use

Each actual `gpu_util` reading contributes to the low-use observation window. At least
three readings must cover the configured window without gaps longer than twice the
source interval, and every reading must stay below the threshold. The UI labels these
as **provider readings** because the API does not document their sampling window or
multi-GPU aggregation. It does not claim that every individual GPU was idle. Missing
readings or lifecycle changes break coverage. Known `dph_total` prices can produce a
labelled estimate over the covered span at the current price, not a bill.

The drawer links to the [Vast.ai Instances console](https://cloud.vast.ai/instances),
as described in the [provider's instance guide](https://github.com/vast-ai/docs/blob/main/guides/instances/manage-instances.mdx).
No stop operation is performed by ComputeDeck.
