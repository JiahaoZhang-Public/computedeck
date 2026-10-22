# GPUhub

Driver name: `gpuhub` (beta). Reads the account balance and the containers of Elastic
Deployments through the [GPUhub API](https://docs.gpuhub.com/api-reference/api-authentication).
Read-only: nothing is created, started or stopped.

## Setup

Create a token in the GPUhub console under **Settings → Tokens** and make it readable by the
service, for example `export GPUHUB_API_KEY=...` in the environment the service starts in.
Add a source of type GPUhub with the reference `env:GPUHUB_API_KEY` (or `keychain:` / `file:`).

## What is read

| Call | Used for |
|---|---|
| `POST /api/v1/dev/wallet/balance` | Balance, shown next to the source |
| `POST /api/v1/dev/deployment/list` | Elastic Deployments |
| `POST /api/v1/dev/deployment/container/list` | Containers: state, GPU model and count, price, region, SSH endpoint |

The token is sent as the bare `Authorization` header. The root password that the container
list includes is never read or stored.

## Limits

- The GPUhub API covers Elastic Deployment only. On-demand instances are not listed. An
  account without Elastic Deployment access can still show its balance; the instance list is
  marked unavailable. Refusals use a generic message because provider error text can echo
  credentials.
- `api.gpuhub.com` is not reachable from every network; the same API is then used through
  `www.gpuhub.com`.
- The [container-list reference](https://docs.gpuhub.com/api-reference/api-elastic-deployment#8-list-containers)
  defines `price` in USD × 1000 per container-hour (1600 means $1.60/hour).
  ComputeDeck divides by 1000 once; it never multiplies by `gpu_num`. This is the base
  price of the whole container, not a per-GPU price or a bill.
- This slice leaves provider `started_at` unset; running-cost estimates use the labelled
  ComputeDeck observation window. No extra billing or lifecycle API calls are made.
