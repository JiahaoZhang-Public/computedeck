<p align="center"><img src="docs/assets/computedeck-mark.svg" width="88" alt=""></p>

# ComputeDeck

[English](README.md)

ComputeDeck 运行在你自己的电脑上，以只读方式收集你在集群、云 GPU 和自己机器上的情况：你的作业和排队原因、你占用的 GPU、各集群对你可见的容量、你的上限、最近一天失败的作业，以及云实例的小时单价。

它面向用普通账号（没有管理员权限）使用一个或多个集群、另外租用 GPU 的人。它通过你已经在用的 SSH 配置访问集群，跳板机和密钥照常工作，不在集群上安装任何东西。

支持的来源：**Slurm**、**Kubernetes**、**PBS**、**LSF** 集群；**RunPod**、**Vast.ai**、**Lambda**、**AWS EC2**；以及任何能通过 SSH 访问的 **GPU 机器**。插件可以增加更多类型。

## 能看到什么

- **作业**：每个登录身份正在运行和排队的作业，含 GPU 数、节点和排队原因。两个身份看到的同一作业只算一次。
- **集群**：可见节点、已分配和未分配的 GPU，以及调度器对你的登录身份显示的 QoS 上限。
- **失败记录**：最近 24 小时内以失败、超时、内存不足、节点故障或被抢占结束的作业（`sacct`）。
- **云实例与机器**：云平台 API 列出的实例；通过 SSH 定时采集的 GPU 机器（GPU、GPU 上的进程及其用户、CPU 和内存；NVIDIA 用 `nvidia-smi`，AMD 用 `rocm-smi`）；以及手动添加的任何机器。
- **去哪跑**：填写需要几张卡、什么型号、跑多久，按每个集群登录身份和 QoS 列出该型号的空闲 GPU、你剩余的 QoS 额度、你的排队作业和 QoS 时长限制，并按启动的可能性排序。这是根据上次采集的估计，不是调度器的承诺。
- **来源**：集中添加、检查和修改来源的页面。每个登录身份显示上次采集能执行 `squeue`、`scontrol`、`assoc_mgr`、`sacct` 中的哪几项，并可以立即采集。
- **历史**：过去 24 小时、3 天或 7 天的在用 GPU 和观测到的利用率。
- **最近动态**：开始运行、离开队列或失败的作业，以及采集出错或恢复的来源。
- **工具箱**：可选工具，开启前都处于关闭状态：**任务提醒**（作业失败、开始或结束时发邮件或 Webhook，可由 AI 模型撰写内容）和**团队留言**（给使用同一个 ComputeDeck 的人留言和传小文件）。从插件市场安装的插件也显示在这里。

## 不做什么

- 不提交、取消或修改作业，不启动或停止实例。核心只读；会写入的工具（任务提醒、团队留言）在你开启前都是关闭的，并写明会做什么。
- 不测量整个集群的 GPU 利用率。分配量（调度器分出去的）和利用率（GPU 有多忙）分开显示。
- 不会把未知值当成 0。某个来源没采集到时，总数会标为不完整。

## 环境要求

- Python 3.12 和 [uv](https://docs.astral.sh/uv/)
- Node.js 22（仅从源码构建网页时需要）
- macOS 或 Linux，以及 OpenSSH 客户端
- 集群需要一个**无需交互**即可登录的 SSH Host 别名（密钥或 agent，主机密钥已确认）。ComputeDeck 使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`。

## 从源码运行

ComputeDeck 还没有发布到 PyPI。

```sh
git clone <本仓库地址> computedeck
cd computedeck
uv sync
npm --prefix web ci
npm --prefix web run build
uv run computedeck serve --open
```

服务只监听 `http://127.0.0.1:8710`。`--open` 会打开页面；除非你打开访问令牌，否则无需登录（见“数据与安全”）。左下角打开**示例数据**，可以不接入任何资源先看看界面。

## 接入资源

在首页或**来源**页点**添加来源**，或者写一个配置文件后导入（见 [docs/configuration.md](docs/configuration.md)）。

**Slurm 集群**：填写集群名称、登录用户名和 SSH Host 别名。ComputeDeck 执行以下只读命令：

| 命令 | 用途 |
|---|---|
| `squeue --user=<你>` | 你正在运行和排队的作业 |
| `scontrol -d show nodes -o` | 可见节点及其 GPU 分配 |
| `scontrol show partition -o` | 分区允许的 QoS 名称 |
| `scontrol show assoc_mgr flags=qos` | QoS 上限 |
| `sacct --user=<你> --state=FAILED,…` | 最近 24 小时的失败 |

只有 `squeue` 是必需的。集群不允许其他命令时，来源会标为“部分数据”，其余功能照常。添加来源后，应用会立即做一次采集并显示哪些项成功。同一集群的第二个登录身份，填写相同的集群名称即可。

**其他集群**：Kubernetes（用你的 kubeconfig 执行 kubectl，可在本机或经 SSH；命名空间即登录身份）、PBS 和 LSF（与 Slurm 一样经 SSH）。见 [docs/drivers](docs/drivers/)。PBS、LSF、Kubernetes 和 Vast.ai 标为测试版：按官方文档的格式实现，但没有在所有版本上运行过。

**云 GPU**：RunPod、Vast.ai、Lambda 通过各自的 API；AWS EC2 通过 AWS CLI 及其自身配置。填写 API Key 的引用，而不是 Key 本身：`env:RUNPOD_API_KEY` 读取服务进程的环境变量，`keychain:computedeck/runpod` 读取系统钥匙串（服务 `computedeck`，账户 `runpod`），`file:~/.config/computedeck/runpod` 读取只有你能读的文件。

**GPU 机器**：用能连到它的 SSH 别名添加为来源，按周期采集。远端需要有 `python3`，不会安装任何东西。

**其他机器**：在**云实例 → 添加实例**中填写主机、端口和用户名，或者填写你已有的 SSH 别名。ComputeDeck 把固定别名写在自己的 `computedeck.conf` 里；预览后可以在应用中把一行 `Include` 加到 `~/.ssh/config`。

默认每 10 分钟采集一次，每个来源可设为 5 到 1440 分钟。

## 在服务器上运行

想在笔记本休眠时继续采集，可以把 ComputeDeck 放在一台常开的机器上，通过 SSH 打开：

```sh
# 在服务器上
uv run computedeck service install      # macOS 用 launchd，Linux 用 systemd --user

# 在笔记本上
uv run computedeck connect my-server     # 建立到服务器的 SSH 隧道并打开浏览器
```

HTTP API 不会暴露到 `127.0.0.1` 以外。详见 [docs/deployment.md](docs/deployment.md)。

## 多台机器

某个集群只能从另一台机器访问时（那台机器上的 VPN、密钥），在**来源 → 采集机器**中用 SSH 别名添加那台机器，并在来源的**由哪台机器采集**中选择它。ComputeDeck 会通过 SSH 在那台机器上运行 `computedeck collect`：那台机器需要安装 ComputeDeck，但不需要运行服务、开放端口或配置令牌，用的是它自己的 SSH 配置、凭据和网络。结果、历史和提醒都留在你打开的这台机器上。

## 工具与插件

插件是 Python 包，登记在插件市场中；市场是一份目录，可以放在 git 仓库、https 地址或文件夹里。安装在服务所在的机器上进行：

```sh
computedeck plugin marketplace add example-lab/computedeck-plugins
computedeck plugin search alerts
computedeck plugin install lab-alerts@example-lab     # 然后重启，并在工具箱中开启
```

工具箱显示每个插件的来源与层级、版本，以及它声明会做的事。数据目录中的 `policy.toml` 可以限制插件市场、禁止插件。编写插件可以从 `computedeck plugin new my-tool --web` 开始，并阅读 [docs/plugins.md](docs/plugins.md)。

## 语言

界面默认英文。在**设置 → 语言**中可以切换为中文，选择保存在浏览器里。服务器可以在配置文件中用 `language = "zh-CN"` 设置默认语言。

## 数据与安全

- 数据保存在 `~/Library/Application Support/ComputeDeck`（macOS）或 `~/.local/share/ComputeDeck`（Linux）；可用 `COMPUTEDECK_DATA_DIR` 修改。ComputeDeck 在其中写入的所有内容只有你能读取（目录 0700，文件 0600）。
- API Key、密码和私钥不会写入数据库、备份或日志。来源只保存 `env:NAME` 这样的引用。
- ComputeDeck 面向你自己的电脑。服务只监听 `127.0.0.1`，只接受 `127.0.0.1` 和 `localhost` 这两个主机名（网页无法通过 DNS 重绑定访问它），浏览器也不允许其他网站读取它的应答。但这挡不住同一台机器上的其他用户账号：如果运行服务的机器上还有别人的账号（例如共用的服务器），请设置 `COMPUTEDECK_AUTH=token`。此后每个 API 请求都需要数据目录中的访问令牌（`api-token`，只有你能读取）；`serve --open` 和 `connect` 会先确认监听端口的确实是你的服务再自动登录，`computedeck token` 输出令牌，供手动登录。令牌如何交给页面，见 [docs/deployment.md](docs/deployment.md#access-token)。
- 写操作还必须来自 ComputeDeck 页面本身（检查 Origin 和请求头），其他网站无法修改你的配置。
- 在**设置 → 备份**中可以生成一致的 SQLite 备份；只保留最新的 10 份（可用 `COMPUTEDECK_BACKUPS` 修改）。

## 数字的含义

- **在用 GPU** 是分配给你运行中作业和运行中云实例的 GPU。有来源最近没采集到时，这个数是小计，并会标出。
- 集群的**未分配** GPU 是节点容量减去分配量。维护、预留或 QoS 限制仍可能让你用不上。
- **QoS 上限**是调度器对你的登录身份显示的值，不能证明你有权使用该 QoS，不同 QoS 的上限也不能相加。
- 云实例的**利用率**是整台主机的瞬时值，在容器中可能反映宿主机。
- **历史**只来自成功的采集，没有数据的时段留空。
- **单价**是按已知小时价格的估算，不是账单。不同币种不会相加。

## 开发

```sh
bash scripts/check.sh    # ruff、mypy、pytest、eslint、prettier、tsc、vitest、vite build
bash scripts/build.sh    # 打包 wheel 和 sdist，网页一并打入
```

目录：`src/computedeck` 是服务（FastAPI、SQLite），`web` 是 React 应用，`tests` 是 Python 测试。如何增加调度器或云平台、增加页面，见 [docs/plugins.md](docs/plugins.md)。

## 许可证

尚未确定，首次发布前补充。

### 诊断来源

运行 `computedeck doctor --language zh-CN`，检查连接、命令、权限和插件兼容性；也可以在
“来源”页点击“测试连接”。两处使用相同的修复提示。使用 `--source <来源 ID>` 只检查一个
来源。详见[诊断说明](docs/doctor.md)、[Slurm 权限](docs/drivers/slurm.md)与
[日志轮转](docs/deployment.md#logs-and-startup-permissions)。
