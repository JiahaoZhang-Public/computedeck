<p align="center"><img src="docs/assets/computedeck-mark.svg" width="72" alt=""></p>

# ComputeDeck

用于查看 Slurm 作业、云 GPU 和 SSH 机器的仪表盘。查看哪些作业在运行、为什么排队，以及下一项任务适合使用哪些资源。

ComputeDeck 沿用已有的 SSH 别名和云平台 API，在你自己的机器上运行，无需集群管理员权限。

[English](README.md) · [演示](https://jiahaozhang-public.github.io/computedeck/#demo) · [配置说明](docs/configuration.md) · [插件开发](docs/plugins.md)

[![示例总览：两个集群、云实例、GPU 占用和历史曲线](https://jiahaozhang-public.github.io/computedeck/assets/overview.jpg)](https://jiahaozhang-public.github.io/computedeck/#demo)

*以下截图均为应用内的示例数据。点击总览可观看 20 秒演示。*

## 功能

- 汇总不同集群账号的运行中、排队和最近失败的作业。
- 按 GPU 型号、数量和运行时长比较可见容量与 QoS 上限。
- 查看云实例、已知小时单价，以及 SSH 主机上的 GPU 使用情况。
- 保留采集历史，检查连接问题并给出修复建议。

核心只读取资源，不提交作业或停止实例。缺失数据会标为未知，规划结果是估计，不能保证调度成功。详见[数字的计算方式](docs/metrics.md)。

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
| Slurm、Kubernetes、PBS、LSF | RunPod、Lambda、AWS EC2、Vast.ai | 通过 SSH 访问的 NVIDIA / AMD GPU 主机；手动添加的实例 |

Kubernetes、PBS、LSF 和 Vast.ai 集成处于测试阶段。界面支持中文和英文。

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

在左下角打开**示例数据**，无需接入资源即可浏览界面。服务监听 `http://127.0.0.1:8710`。

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

## 许可证

采用 [Apache-2.0](LICENSE)。第三方依赖声明见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
