# Kubernetes driver

The `kubernetes` driver (beta) shows the GPU work of one Kubernetes namespace: pods that request GPUs, the GPU nodes of the cluster, GPU quotas and pods that failed in the last 24 hours. It only runs `kubectl get … -o json`, so it never changes the cluster.

One source is one namespace. Two namespaces of one cluster are two sources of the same cluster, just as two Slurm logins are.

## Requirements

- `kubectl` and a working kubeconfig, either on the machine that runs ComputeDeck or on an SSH host (see `ssh_alias` below).
- Credentials that work without a person present. Collection runs in the background with no terminal and no browser, so a kubeconfig whose exec plugin asks for a password or opens a login page will time out. Use a token, a client certificate, or a cloud CLI that refreshes its own tokens.
- GPUs advertised by a device plugin as `nvidia.com/gpu` or `amd.com/gpu`.
- Optional: GPU model labels on the nodes, written by NVIDIA GPU Feature Discovery (`nvidia.com/gpu.product`) or the AMD node labeller (`amd.com/gpu.product-name`, or the legacy `beta.amd.com/gpu.product-name`). Without them the GPU model is shown as unknown.

Over SSH, the command runs in a non-login shell. If `kubectl` lives in a directory that only your login profile adds to `PATH` (for example `~/.local/bin`), the collection reports that kubectl was not found. Put kubectl in a standard directory, or set `PATH` in a file that non-interactive shells read.

## Access it needs (RBAC)

| Request | Scope | Needed for | Without it |
|---|---|---|---|
| `list pods` | the namespace | GPU pods and failed pods | The collection fails. |
| `list resourcequotas` | the namespace | GPU quotas | Warning `qos_unavailable`; quotas are not shown. |
| `list nodes` | cluster | GPU nodes, GPU models, node pools | Warning `nodes_unavailable`; nodes are not shown. |
| `list pods` | all namespaces | GPUs allocated on each node | Warning `nodes_unavailable`; nodes are not shown. |

The first two are part of the built-in `view` ClusterRole, so a RoleBinding of `view` in the namespace is enough for jobs, failures and quotas. The node view needs a ClusterRole such as this one (fictional names):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: computedeck-gpu-reader
rules:
  - apiGroups: [""]
    resources: ["nodes", "pods"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: computedeck-gpu-reader-alice
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: computedeck-gpu-reader
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: User
    name: alice
```

Listing pods in every namespace shows their names and specs to the reader. If that is not acceptable, leave this access out: jobs, quotas and failures still work, and nodes are reported as unavailable, never as empty or idle.

## Fields

| Field | Key | Meaning |
|---|---|---|
| Namespace | `username` | The namespace to read, for example `ml-team`. Lowercase letters, digits and hyphens, at most 63 characters. It identifies the source. |
| SSH host alias | `ssh_alias` | Optional. A `Host` from `~/.ssh/config` on the machine running the service. kubectl then runs on that host with its kubeconfig. Empty means kubectl runs on the service machine. |
| Kube context | `options.context` | Optional. A context of the kubeconfig. Empty means its current context. |

In a configuration file:

```toml
[[cluster]]
id = "cluster-a"
label = "Cluster A"
driver = "kubernetes"

  [[cluster.identity]]
  username = "ml-team"
  options = { context = "alice@cluster-a" }

  [[cluster.identity]]
  username = "vision-team"
  ssh_alias = "cluster-a-gateway"
```

## What is read

Each collection runs at most four commands, one after another:

```sh
kubectl [--context=…] get pods --namespace=<namespace> -o json
kubectl [--context=…] get nodes -o json
kubectl [--context=…] get pods --all-namespaces --field-selector=status.phase!=Succeeded,status.phase!=Failed -o json
kubectl [--context=…] get resourcequotas --namespace=<namespace> -o json
```

Every command has `--request-timeout=20s` and a 25-second limit. Values are validated before use; locally kubectl runs without a shell, and over SSH every argument is quoted.

### Jobs

A job is a pod in the namespace that requests GPUs and has not finished (phase `Succeeded` or `Failed`).

| Job field | From |
|---|---|
| `id` | `<cluster id>:<namespace>/<pod>` |
| `name` | The controlling owner, such as the Job or the Deployment (the ReplicaSet name without its pod-template hash); otherwise the pod name. |
| `user` | The pod label `owner` or `user` when present. Kubernetes does not record who created a pod. |
| `account` | The namespace. |
| `partition` | The node pool label of the node (`cloud.google.com/gke-nodepool`, `eks.amazonaws.com/nodegroup`, `kubernetes.azure.com/agentpool` or `karpenter.sh/nodepool`), or of the pod's node selector before it is scheduled. |
| `qos` | `spec.priorityClassName`. |
| `state` | `RUNNING`, `PENDING`, `COMPLETING` (being deleted; still holds its GPUs) or `UNKNOWN` (phase `Unknown`). |
| `reason` | For a pod the scheduler cannot place: the `PodScheduled` condition, e.g. `Unschedulable: 0/4 nodes are available: 4 Insufficient nvidia.com/gpu.` Otherwise the first waiting container reason, such as `ImagePullBackOff` or `CrashLoopBackOff`. |
| `gpu_count` | The pod's effective request of `nvidia.com/gpu` plus `amd.com/gpu`: the larger of all app and sidecar containers together and the largest init container, plus pod overhead. A container limit without a request counts as the request. An unreadable quantity makes the count unknown. |
| `gpu_type` | The node's GPU model label, or the model named in the pod's node selector. |
| `cpu_count` | The effective CPU request in cores; may be a fraction such as `0.5`. |
| `node`, `elapsed` | `spec.nodeName`; time since `status.startTime` (`0:00` while pending). |

A pod that is scheduled but still pulling its image is `PENDING` with a reason such as `ContainerCreating`, although the node already counts its GPUs as allocated.

### Nodes

Only nodes with GPUs are shown: nodes whose capacity or allocatable resources list a GPU resource, or that carry a GPU model label.

- `gpu_count` is the allocatable GPUs. A node whose device plugin is not running reports `0`.
- `gpu_allocated` is the sum of effective GPU requests of unfinished pods bound to the node, across all namespaces. One unreadable request makes it unknown.
- `cpu_count` and `cpu_allocated` are allocatable cores and the requested cores.
- `state` joins the Kubernetes words with the word the dashboard colours by: `ready`, `ready+idle` (no GPU allocated), `ready+cordoned+drain` (`spec.unschedulable`), `not_ready+down` (`Ready` is `False`) and `unknown` (`Ready` is `Unknown` or missing).
- `partitions` holds the node pool label, if any.

Node rows retain `status.addresses` entries of type InternalIP or ExternalIP as
`host_addresses`. These can identify an SSH machine that is also a scheduler node;
Hostname labels alone never establish a match. No extra API call is made. See
[machine/node accounting](../metrics.md#machines-that-are-also-scheduler-nodes).

### GPU quotas

Each ResourceQuota of the namespace with a GPU entry becomes one limit, named after the quota:

```json
{
  "name": "gpu-quota",
  "limits": {
    "MaxTRESPU": "gres/gpu=8",
    "UsedTRESPU": "gres/gpu=3",
    "requests.nvidia.com/gpu": "8"
  },
  "origin": "kubernetes_resource_quota"
}
```

`MaxTRESPU` uses the Slurm form the dashboard already reads. A namespace quota is shared by everyone in the namespace, and the namespace is this source's identity, so it is the limit of this source. `UsedTRESPU` is the quota's own usage (`status.used`), which also counts admitted pods that have not started. Kubernetes only accepts `requests.` entries for GPUs; a `limits.` entry is read too, and the smaller value applies. Several GPU vendors add up. A quota with scopes, for example one PriorityClass, lists them under `Scopes`. An unreadable value leaves the limit unknown.

### Failures in the last 24 hours

A GPU pod of the namespace counts as a failure when it finished within the last 24 hours and either its phase is `Failed`, or a container (current or previous run) exited with a non-zero code. Each pod appears once, with its latest failure.

| Field | From |
|---|---|
| `state` | `OUT_OF_MEMORY` (a container was `OOMKilled`), `TIMEOUT` (`DeadlineExceeded`, from `activeDeadlineSeconds`), `PREEMPTED` (`DisruptionTarget` reason `PreemptionByScheduler`), `NODE_FAIL` (`DeletionByPodGC` or `NodeLost`), otherwise `FAILED`. |
| `end` | The latest container `finishedAt`; for a pod without terminated containers, such as an evicted pod, the latest condition change. |
| `exit_code` | The exit code of the latest non-zero termination, such as `137`. |
| `exit_status`, `exit_signal` | The nonnegative container exit status and explicit termination signal, when present. A signal is never inferred from status 137. |
| `ended_at` | The same offset-bearing time as `end`. |
| `time_limit` | `spec.activeDeadlineSeconds`, formatted as `[D-][H:]MM:SS`; null when absent. No log path is collected. |
| `reason` | The pod reason (e.g. `Evicted`), the disruption reason, or the container reason (e.g. `Error`). Termination messages are never read. |

## Errors

When the namespace's pods cannot be listed, the collection fails and keeps the previous data. kubectl and API server messages are not shown, since they can contain user names and server addresses; the error is one of these codes:

| Code | Meaning |
|---|---|
| `namespace_required`, `invalid_namespace`, `invalid_kube_context`, `invalid_ssh_alias` | A setting is missing or not allowed. |
| `kubectl_not_found` | kubectl is not installed, or not on `PATH`, where it runs. |
| `kube_context_not_found` | The context is not in the kubeconfig. |
| `kubectl_unauthorized` | The API server rejected the credentials. |
| `kubectl_forbidden` | The credentials may not list the resource (`resource` names it). |
| `kubectl_unreachable` | The API server could not be reached. |
| `kubectl_timeout`, `kubectl_failed` | kubectl timed out, or failed in another way. |
| `ssh_failed`, `ssh_timeout` | The SSH connection failed (with ssh's own message) or timed out. |
| `unexpected_output` | kubectl did not return a JSON list. |

## Limitations

- GPU slices are not counted: MIG devices in the mixed strategy (`nvidia.com/mig-…`) and renamed shared GPUs (`nvidia.com/gpu.shared`). With the MIG single strategy or time-slicing that keeps the `nvidia.com/gpu` name, a count is a number of slices, not of physical GPUs.
- Utilization is not read; it needs a metrics source such as DCGM.
- Pod-level resources (`spec.resources`) are not read; requests come from the containers.
- Failed pods that were already deleted, for example by a Job's `ttlSecondsAfterFinished`, are not seen.
- Only the namespace's own pods are jobs. Node allocation counts every namespace but does not say whose pods they are.
