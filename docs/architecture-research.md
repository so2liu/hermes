# 推理与执行分离：智能体架构调研

## 背景

在构建 AI 智能体时，存在两种主要的运行模式：

1. **云端运行**（如 Factorio World）— 用户无需配置环境，有沙箱隔离，安全可靠
2. **本地运行**（如 MA Agent / 小马快跑）— 可访问用户本地文件、浏览器登录态等

这两种模式各有优势，但也各有局限。核心问题是：**能否将智能体的推理（Reasoning）与工具执行（Tool Execution）解耦，同时支持本地和云端执行环境？**

## 业界现有方案

### 主要项目对比

| 项目 | 架构模式 | 执行环境 | 关键特点 |
|------|----------|----------|----------|
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | Agent SDK 在本地，执行在 Docker sandbox | 云端容器 | 事件驱动架构，Action/Observation 分离，SWE-Bench 72% |
| [Manus](https://manus.im) | 推理在云端，执行在 E2B 微虚拟机 | 云端 VM | 每个任务独立 Ubuntu VM，文件系统即记忆 |
| [Goose](https://github.com/block/goose) (Block/AAIF) | 本地 agent + MCP 暴露工具 | 本地/远程 | MCP 做工具抽象层，本地远程统一协议 |
| [E2B](https://github.com/e2b-dev/E2B) | 纯执行层基础设施 | 云端 Firecracker 微虚拟机 | 被 Manus 生产使用，开源 |
| [Daytona](https://www.daytona.io) | 纯执行层基础设施 | 云端 Docker 容器 | 90ms 启动，适合持久开发环境 |
| [MA Agent](https://github.com/pheuter/claude-agent-desktop) (小马快跑) | Electron 桌面应用 + Claude Agent SDK | 纯本地 | 面向非技术用户，本地全权限执行 |

### 两种 Sandbox 连接模式（来自 LangChain）

LangChain 的 Harrison Chase 总结了两种模式：

#### 模式 A：Agent Inside Sandbox

Agent 和工具在同一个容器/虚拟机内运行。

```
┌─────────────────────────┐
│       Sandbox           │
│  ┌───────┐  ┌────────┐  │
│  │ Agent │→ │ Tools  │  │
│  └───────┘  └────────┘  │
└─────────────────────────┘
```

- **优点**：简单、低延迟、工具和 agent 共享文件系统
- **缺点**：API key 暴露在 sandbox 内、更新 agent 需重建镜像、sandbox 崩溃导致 agent 状态丢失

#### 模式 B：Sandbox as a Tool（推荐）

Agent 在外部运行，sandbox 作为可调用的工具。

```
┌───────┐      ┌─────────────┐
│ Agent │─API→ │  Sandbox    │
│ (推理) │      │  (执行工具)  │
└───────┘      └─────────────┘
```

- **优点**：agent 更新无需重建镜像、API key 不暴露、sandbox 故障不影响 agent 状态、可随时切换执行环境
- **缺点**：网络延迟、需维护 API 层

**模式 B 正是"推理与执行分离"的核心思路。**

### 关键协议

| 协议 | 维护方 | 用途 | 传输层 |
|------|--------|------|--------|
| **MCP** (Model Context Protocol) | Anthropic → AAIF | 工具/资源/提示词暴露 | STDIO（本地）/ HTTP+SSE（远程） |
| **A2A** (Agent2Agent) | Google → Linux Foundation | Agent 间通信 | HTTP/SSE/JSON-RPC |
| **AGENTS.md** | OpenAI → AAIF | 项目级 Agent 指导 | 文件约定 |

## MCP 作为统一工具抽象层

MCP 是实现"推理与执行分离"的天然粘合剂：

- 将工具定义为标准化的 JSON-RPC 接口
- **本地工具** → STDIO transport（快速，同机器，无网络开销）
- **远程工具** → HTTP+SSE transport（跨网络，支持云端 sandbox）
- Agent 不关心工具运行在哪里，只管调用统一的 MCP 接口

```
                        ┌─── STDIO ──→ 本地 MCP Server (文件/浏览器/系统信息)
                        │
Agent (推理) → MCP ─────┤
                        │
                        └─── HTTP ───→ 远程 MCP Server (shell sandbox/代码执行)
```

### 三种 MCP 原语

| 原语 | 说明 | 示例 |
|------|------|------|
| **Tools** | 可执行的函数 | `shell_exec`, `read_file`, `browser_navigate` |
| **Resources** | 数据源 | 文件内容、数据库查询结果 |
| **Prompts** | 提示词模板 | 技能描述、角色设定 |

## 架构演进方案

### 现状（以 Factorio World 为例）

```
用户 (飞书) → 云端 Agent (推理+执行一体) → shell / file tools
                                            ↑ 全在同一个 Docker 容器内
```

优点：简单可靠。缺点：无法访问用户本地资源。

### 目标架构

```
                                    ┌─ 本地 MCP Server ─→ 用户文件系统
                                    │                   → 浏览器登录态
用户 (飞书/桌面) → Agent (推理) → Tool Router ─┤
                                    │                   → Shell 沙箱
                                    └─ 云端 MCP Server ─→ 代码执行环境
                                                        → 持久化存储
```

### 关键设计决策

#### 1. Tool Router 的路由策略

| 路由依据 | 说明 |
|----------|------|
| 工具类型 | 文件操作 → 本地；代码沙箱 → 云端 |
| 安全级别 | 涉及用户隐私数据 → 本地；不可信代码 → 云端 |
| 用户偏好 | 用户可选择"全部本地"或"全部云端" |
| 可用性 | 本地 client 离线时 fallback 到云端 |

#### 2. 本地执行器

在用户机器上运行的轻量 MCP server，可能的形态：
- **桌面应用内嵌**（类似 MA Agent 的 Electron 方式）
- **浏览器扩展**（类似 Factorio World 的 Chrome Extension + Electron Bridge 方式）
- **CLI 守护进程**（后台运行，STDIO/HTTP 暴露 MCP 接口）

#### 3. 云端执行器

现有 Docker 容器改造为 MCP server，对外暴露 HTTP 接口：
- Shell 命令执行
- 文件读写（容器内工作目录）
- 代码编译运行

## 实施路径建议

### 第一步：现有工具 MCP 化

将 Factorio World 的 `shell`、`read_file`、`write_file`、`edit_file` 封装为 MCP tool 定义。改造量极小，本质上只是加一层标准化接口。

### 第二步：引入 Tool Router

Agent 发出 tool call 后，Router 根据工具元数据（`execution: "local" | "cloud"`）决定路由目标。初期可以简单硬编码，后续支持动态配置。

### 第三步：实现本地 MCP Server

基于现有的 Electron Bridge + Chrome Extension 架构扩展，支持：
- 本地文件读写
- 浏览器 Cookie / 登录态读取
- 本地命令执行

### 第四步：支持混合模式

用户通过飞书消息或配置选择执行环境偏好。Agent 在推理时可以同时调用本地和云端工具。

## 参考资料

- [OpenHands Runtime Architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime)
- [OpenHands Agent SDK Paper](https://arxiv.org/html/2511.03690v1)
- [Manus Sandbox Architecture](https://manus.im/blog/manus-sandbox)
- [Context Engineering for AI Agents - Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [How Manus Uses E2B](https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)
- [The Two Patterns by Which Agents Connect Sandboxes - LangChain](https://blog.langchain.com/the-two-patterns-by-which-agents-connect-sandboxes/)
- [MCP Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [Google A2A Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [AAIF (Agentic AI Foundation)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [Goose (Block)](https://github.com/block/goose)
- [E2B GitHub](https://github.com/e2b-dev/E2B)
- [AI Agent Sandboxes Compared](https://rywalker.com/research/ai-agent-sandboxes)
