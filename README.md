<p align="center"><img src="docs/assets/computedeck-mark.svg" width="72" alt=""></p>

# ComputeDeck

A dashboard for Slurm jobs, cloud GPUs and SSH machines. See what is running, why jobs are queued, and which resources could fit your next run.

ComputeDeck uses your existing SSH aliases and provider APIs. It runs on your own machine and does not require cluster administrator access.

[中文](README.zh-CN.md) · [Configuration](docs/configuration.md) · [Plugins](docs/plugins.md)

## Features

- Running, queued and recently failed jobs across cluster accounts.
- GPU capacity and QoS limits, compared by GPU model, count and run time.
- Cloud instances, known hourly prices and GPU usage on SSH hosts.
- Collection history and connection diagnostics with repair suggestions.

The core only reads resources; it does not submit jobs or stop instances. Missing data stays marked as unknown. Planner results are estimates, not scheduler guarantees. See [how the numbers are calculated](docs/metrics.md).

## Supported sources

| Clusters | Cloud GPUs | Other machines |
|---|---|---|
| Slurm, Kubernetes, PBS, LSF | RunPod, Lambda, AWS EC2, Vast.ai | NVIDIA and AMD GPU hosts over SSH; manual entries |

Kubernetes, PBS, LSF and Vast.ai are beta integrations. The interface supports English and Chinese.

## Run from source

ComputeDeck is available as a source preview. No PyPI package has been released yet.

You need macOS or Linux, Python 3.12 or 3.13, [uv](https://docs.astral.sh/uv/), Node.js 22 and OpenSSH. Node is needed to build the web interface.

```sh
git clone https://github.com/JiahaoZhang-Public/computedeck.git
cd computedeck
uv sync --frozen
npm --prefix web ci
npm --prefix web run build
uv run computedeck serve --open
```

Open **Example data** at the bottom left to try the interface without connecting a resource. The service listens on `http://127.0.0.1:8710`.

To connect a cluster, choose **Sources → Add source** and enter the SSH alias and username you already use. SSH must work without prompts. For cloud providers, enter a credential reference such as `env:RUNPOD_API_KEY`, not the key itself. See [configuration](docs/configuration.md) and the [Slurm setup guide](docs/drivers/slurm.md).

Use **Test connection** or `uv run computedeck doctor` to check a source. The [diagnostics guide](docs/doctor.md) explains the results.

## Run on a server

```sh
# On the server, from its ComputeDeck checkout:
uv run computedeck service install

# On your laptop, from its ComputeDeck checkout:
uv run computedeck connect my-server
```

The server keeps collecting while your laptop is closed; the client connects through SSH. Use `COMPUTEDECK_AUTH=token` on a shared host. See [deployment, authentication and backups](docs/deployment.md).

Data is stored on the service machine in `~/Library/Application Support/ComputeDeck` on macOS or `~/.local/share/ComputeDeck` on Linux. Set `COMPUTEDECK_DATA_DIR` to use another directory.

## Plugins and contributions

Plugins add tools, source drivers, notification channels and pages. They run inside the service with its user's permissions. Install them on the service machine and enable tools in **Toolbox**.

- [Official plugins](https://github.com/JiahaoZhang-Public/computedeck-plugins): network diagnostics and Shell credential references. Their first release is in preparation.
- [Write a plugin](docs/plugins.md): scaffold, Python API and web API.
- [Contribute a plugin or submit a PR](https://github.com/JiahaoZhang-Public/computedeck-plugins/blob/main/CONTRIBUTING.md): local setup, tests and review requirements.

For core changes, open a focused PR with the behavior changed and the checks you ran. Use fictional data in tests and screenshots.

```sh
bash scripts/check.sh    # lint, formatting, types, tests and web build
bash scripts/build.sh    # local wheel and sdist, including the web interface
```

The Python service is in `src/computedeck`, the React interface in `web`, and Python tests in `tests`.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for bundled dependencies.
