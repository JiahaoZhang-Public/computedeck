# RunPod

Driver name: `runpod`. Reads pods and SSH endpoints through the
[RunPod REST API](https://docs.runpod.io/api-reference/pods/GET/pods).
No pods are created, started or stopped.

Use a credential reference such as `env:RUNPOD_API_KEY` when adding the source.
`GET /v1/pods` with `includeMachine=true` supplies GPU counts/models, endpoints and
prices. No separate billing request is made. The driver uses `publicIp` and the
external port mapped from `portMappings["22"]`, with SSH user `root` by default.
Without that mapping, the API listing supplies no SSH endpoint; a running report
alone does not establish reachability.

- `desiredStatus=RUNNING` maps to `reported_running`: assigned capacity, not proof
  that the image, SSH or workload is ready. A stop/termination becomes settled when
  the timestamp in `lastStatusChange` is more than ten minutes old; otherwise the
  intended state remains visible.
- `adjustedCostPerHr`, or `costPerHr` if absent, is the whole-pod hourly price in USD,
  not per GPU. Cost estimates use this current price and exclude storage/other charges.
- `lastStartedAt` is documented as the UTC time the pod was last started. It becomes
  `started_at` only for RUNNING pods with a valid timezone-aware timestamp. Missing or
  malformed values use the store's labelled observation window instead.
- HTTP 429 follows the shared provider retry/backoff handling. Old listings remain
  visible, but are excluded from current totals and their cost estimates stop at the
  last successful collection.

RunPod listings provide no GPU utilization. A hardware check contributes one actual
reading to low-use detection; a single reading never establishes a duration. No automatic
provider SSH checks are added. The drawer explains this coverage and offers an
[Open provider console](https://console.runpod.io) link, without any stop operation.

See [running cost estimates](../metrics.md#running-cost-estimates) for observation
windows and currency handling, and [low-use settings](../configuration.md#low-gpu-use-hints)
for the threshold and measurement window.
