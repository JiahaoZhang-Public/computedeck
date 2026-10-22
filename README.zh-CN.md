<p align="center"><img src="docs/assets/computedeck-mark.svg" width="72" alt=""></p>

# ComputeDeck

用于查看 Slurm 作业、云 GPU 和 SSH 机器的仪表盘。查看哪些作业在运行、为什么排队，以及下一项任务适合使用哪些资源。

ComputeDeck 沿用已有的 SSH 别名和云平台 API，在你自己的机器上运行，无需集群管理员权限。

[English](README.md) · [演示](https://jiahaozhang-public.github.io/computedeck/#demo) · [配置说明](docs/configuration.md) · [插件开发](docs/plugins.md)

[![示例总览：两个集群、云实例、GPU 占用和历史曲线](https://jiahaozhang-public.github.io/computedeck/assets/overview.jpg)](https://jiahaozhang-public.github.io/computedeck/#demo)

*以下截图均使用较早预览版的内置示例数据；0.7.0 的布局和数字已有变化。点击总览可观看 20 秒演示。*

## 功能

- 汇总不同集群账号的运行中、排队和最近失败的作业。
- 按 GPU 型号、数量和运行时长比较可用容量与 QoS 上限，估计时计入你自己的排队需求。
- 查看云实例、已知小时单价，以及 SSH 主机上的 GPU 使用情况。
- 统一待处理列表，在每个页面显示采集时间和服务健康状态，并提供连接诊断与修复建议。

核心只读取资源，不提交作业或停止实例。缺失数据会标为未知，规划结果是估计，不能保证调度成功。详见[数字的计算方式](docs/metrics.md)。

**值得信赖的数字：** 不完整的合计显示 `≥`，并列出未能测量的机器或登录身份。
总览、用量和历史使用同一套数字。运行中的云实例按服务商报告的 GPU 分配计数；
SSH 机器按有可见计算进程或显存用量达到阈值的 GPU 计数；进程不可读，或没有可见进程且显存缺失时，使用量保持未知。关闭监控的手动机器不计入。
服务商更新实例列表后，SSH 检查结果仍保留自己的检查时间。

顶部栏的**数据时效与服务状态**指示器显示已启用来源中最早的成功采集时间；
只要有一个已启用的来源从未成功，就显示**尚未采集**。
点击可查看错误和重试时间。总览突出显示待处理和当前作业；趋势图集中在「用量与费用」。
隐藏标签页会暂停浏览器请求，服务端仍继续采集。
升级说明见 [0.4.0 变更记录](CHANGELOG.md)，其中包括历史曲线可能出现跳变的原因。

**0.5.0 — 看懂问题，完成修复**新增分步连接检查、作业原因和时间、窄屏表格，以及可保留的页面链接状态。详见[变更记录](CHANGELOG.md)。

**0.6.0 — 及时知道发生了什么**新增可搜索的动态、作业结果记录与数组摘要、合并通知及发送状态、可见的观测空档，以及待处理项的确认与暂缓。详见[变更记录](CHANGELOG.md)。

**0.7.0 — 有依据地选择资源**说明资源估计及其依据，列出 SSH 机器的空闲 GPU，并根据采集到的事实复制 Slurm 提交参数。「用量与费用」新增按日观测用量和费用估算；持续低利用率提示、Slurm 队列位置和有历史支持的等待区间，帮助你决定在哪里运行。详见[变更记录](CHANGELOG.md)。

## 版本预览

以下包含已完成的里程碑与后续计划；未来范围与优先级可能调整。

- [x] **v0.5 — 看懂问题，完成修复：** 分步连接诊断与凭据更新、清晰的作业原因和时间、自适应表格，以及保存在网址中的筛选条件和规划输入。
- [x] **v0.6 — 及时知道发生了什么：** 可搜索的动态页、每个作业一条结果记录及失败说明、合并的作业与数组通知及发送状态、待处理项的确认与暂缓，以及可见的观测空档。
- [x] **v0.7 — 有依据地选择资源：** 可解释的资源比较、SSH 空闲 GPU 与仅复制的 Slurm 参数、观测用量与费用估算、持续低利用率提示、Slurm 队列位置、有历史支持的等待区间，以及同主机 GPU 去重计数。
- [ ] **v1.0 — 全新的界面与交互：** 重做的视觉体系、按问题组织的导航、命令面板、带底部标签栏的手机布局，以及集中添加和修复连接的入口。

## 界面术语

| 术语 | 含义 |
|---|---|
| 来源 | 用于采集数据的一条连接：集群登录身份、云 API 账号或 SSH 主机。多个来源可以对应同一个集群或平台。 |
| 集群或平台 | **集群与云平台**面板和分组筛选器中的资源分组。 |
| 实例 / 机器 | 一台租用或自有的机器。**云平台与机器**包括云实例、SSH 来源和手动添加的机器。 |
| 采集机器 | 为当前服务采集来源的另一台电脑，标为**经由 {name}**，不是计算节点。 |
| 节点 | 集群调度器报告的计算节点。可用容量不包含不可用节点。 |
| 在用 GPU | 你的运行中作业和持有的云实例所分配的 GPU，或 SSH 机器上有可见计算进程或显存用量达到阈值的 GPU。进程不可读，或没有可见进程且显存缺失时，使用量保持未知；不等同于 GPU 利用率。 |
| 容量读数中的“可用 GPU” | 可用节点上面向所有用户的容量，不保证当前登录身份能够分配这些资源。 |
| 待处理 | 当前故障和警告的统一列表；导航徽标、统计卡片和面板统一统计尚未确认、也未暂缓的项目。 |

作业详情使用对应调度器的术语：Slurm 为账户 / 分区 / QoS，PBS 为账户 / 队列，
LSF 为项目 / 队列，Kubernetes 为命名空间 / 节点池 / 优先级类。
其他驱动使用通用的账户 / 分区 / QoS 标签。

## 使用案例

<details>
<summary><strong>查看作业为什么排队</strong></summary>

这个作业申请了 4 张 A100。详情同时显示账户、QoS 和 Slurm 返回的 `QOSMaxGRESPerUser` 排队原因，便于定位是哪项限制在影响作业。

[![示例作业详情：4 张 A100 的申请与 QoS 排队原因](https://jiahaozhang-public.github.io/computedeck/assets/job-detail.jpg)](https://jiahaozhang-public.github.io/computedeck/assets/job-detail.jpg)

</details>

<details>
<summary><strong>为 4 张 H100、24 小时的任务选择资源</strong></summary>

输入型号、数量和时长后，规划器会标出不匹配的选项：debug QoS 最多运行 2 小时，Cluster A 没有 H100。可行选项仍是基于最近采集的估计。

[![示例资源比较：4 张 H100、24 小时，显示时长限制与型号不匹配](https://jiahaozhang-public.github.io/computedeck/assets/planner.jpg)](https://jiahaozhang-public.github.io/computedeck/assets/planner.jpg)

</details>

## 支持的来源

| 集群 | 云 GPU | 其他机器 |
|---|---|---|
| Slurm、Kubernetes、PBS、LSF | RunPod、Lambda、AWS EC2、Vast.ai、GPUhub | 通过 SSH 访问的 NVIDIA / AMD GPU 主机；手动添加的实例 |

Kubernetes、PBS、LSF、Vast.ai 和 GPUhub 集成处于测试阶段。界面支持中文和英文。

## 从源码运行

ComputeDeck 目前提供源码预览，尚未发布 PyPI 包。

需要 macOS 或 Linux、Python 3.12 或 3.13、[uv](https://docs.astral.sh/uv/)、Node.js 22 和 OpenSSH。Node 用于构建网页。

```sh
git clone https://github.com/JiahaoZhang-Public/computedeck.git
cd computedeck
uv sync --frozen
npm --prefix web ci
npm --prefix web run build
uv run computedeck serve --open
```

开启**示例数据**，无需接入资源即可浏览界面，其中包含采集失败、数据过期、云账号限流和作业超时的场景。
刷新页面后仍保留该模式，网页中的修改请求会被阻止，包括通知、聊天和插件请求；仍可通过访问令牌登录。
工具和设置页面依然显示你自己的数据，已有的后台采集也会继续。
使用横幅中的**关闭示例数据**恢复修改。服务监听 `http://127.0.0.1:8710`。

接入集群时，在**来源 → 添加来源**中填写已有的 SSH 别名和用户名。SSH 必须能够无需交互地登录。云平台凭据填写 `env:RUNPOD_API_KEY` 这样的引用，而不是密钥本身。详见[配置说明](docs/configuration.md)和 [Slurm 接入指南](docs/drivers/slurm.md)。

使用**测试连接**或 `uv run computedeck doctor --language zh-CN` 检查来源，结果说明见[诊断指南](docs/doctor.md)。

## 在服务器上运行

```sh
# 在服务器的 ComputeDeck 源码目录中：
uv run computedeck service install

# 在笔记本的 ComputeDeck 源码目录中：
uv run computedeck connect my-server
```

笔记本关闭后，服务器仍可持续采集；客户端通过 SSH 连接。共用的服务器应设置 `COMPUTEDECK_AUTH=token`。详见[部署、认证与备份](docs/deployment.md)。

数据保存在服务所在机器上：macOS 为 `~/Library/Application Support/ComputeDeck`，Linux 为 `~/.local/share/ComputeDeck`。可用 `COMPUTEDECK_DATA_DIR` 指定其他目录。

## 插件与贡献

插件可以添加工具、来源驱动、通知渠道和页面。插件在服务进程内运行，拥有运行用户的权限。请在服务所在机器上安装，并在**工具箱**中启用。

- [官方插件](https://github.com/JiahaoZhang-Public/computedeck-plugins)：网络诊断和 Shell 凭据引用，首次发布仍在准备中。
- [开发插件](docs/plugins.md)：项目模板、Python API 和网页 API。
- [贡献插件与提交 PR](https://github.com/JiahaoZhang-Public/computedeck-plugins/blob/main/CONTRIBUTING.md)：本地环境、测试和审查要求。

修改核心时，请让每个 PR 解决一个具体问题，写明行为变化和执行过的检查。测试和截图使用虚构数据。

```sh
bash scripts/check.sh    # lint、格式、类型、测试和网页构建
bash scripts/build.sh    # 本地构建 wheel 和 sdist，包含网页
```

Python 服务位于 `src/computedeck`，React 界面位于 `web`，Python 测试位于 `tests`。

网页类型检查使用 TypeScript 7，ESLint 同时使用官方 TypeScript 6 API 包。运行 `npm --prefix web run typecheck` 会明确调用 TypeScript 7 编译器。

## 许可证

采用 [Apache-2.0](LICENSE)。第三方依赖声明见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
