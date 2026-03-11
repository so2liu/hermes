# 桌面 AI 智能体应用架构调研

## 调研目标

调研主流开源 AI 智能体的桌面应用架构、本地/云端混合执行模式、工具路由机制，为 Hermes 项目提供架构参考。

---

## 一、各项目架构详解

### 1. OpenHands（原 OpenDevin）

**项目地址**: https://github.com/OpenHands/OpenHands
**定位**: 云端编码智能体平台，64k+ GitHub Stars

#### 核心架构（V1 SDK 重构后）

- **沙箱可选化**: V1 彻底反转了 V0 的设计——沙箱从"强制"变为"可选"。默认情况下，agent 在本地单进程直接执行工具，当需要隔离时透明地切换到容器化环境，代码无需修改。
- **Workspace 抽象层**: 使用工厂模式实现本地/远程透明切换：
  - `Conversation(workspace=path)` → `LocalConversation`（本地执行）
  - `Conversation(workspace=DockerWorkspace(...))` → `RemoteConversation`（容器化执行）
  - `BaseWorkspace` 仅定义三个操作：`execute_command()`、`file_upload()`、`file_download()`
- **事件溯源状态模型**: 所有交互记录为追加式事件日志，`ConversationState` 是唯一可变状态源，支持确定性重放和会话恢复。
- **工具系统**: Action → ToolExecutor → Observation 三分离模式。MCP 工具通过 `MCPToolDefinition` 和 `MCPToolExecutor` 自动转译为原生工具。
- **配置系统**: V0 有 140+ 字段、15 个类、2800 行配置代码。V1 改为不可变 Pydantic 模型，构造时验证。

#### 对 Hermes 的启示

- **Workspace 抽象是关键设计**: 同一份 agent 代码，仅通过切换 workspace 实现即可从本地开发迁移到分布式生产，这正是 Hermes 需要的模式。
- **沙箱可选而非强制**: 本地执行作为默认，需要隔离时再升级到容器——降低了用户上手门槛。
- **事件溯源**: 对于 Hermes 的飞书/桌面多入口场景，事件溯源能确保跨入口的状态一致性。

---

### 2. Goose（Block / AAIF）

**项目地址**: https://github.com/block/goose
**定位**: 本地优先的开源 AI agent 框架，30k+ GitHub Stars，已捐赠给 Linux Foundation AAIF

#### 核心架构

- **Rust 核心 + Tauri 桌面应用**: 核心引擎用 Rust 编写，桌面客户端用 Tauri 构建。安装包 < 10MB，内存占用 30-50MB。同时提供 CLI 入口。
- **MCP 原生**: 所有外部工具通过 MCP 协议集成，工具被打包为独立的 MCP server，通过 JSON-RPC 通信。LLM 动态发现并调用工具。
- **本地优先**: 所有敏感操作在本地处理，代码不离开用户机器。
- **MCP App UI**: 实验性功能——MCP server 可返回 `ui://` 资源 URI，Goose 在沙箱化 iframe 中渲染交互式 UI 组件，通过 postMessage 通信。

#### 对 Hermes 的启示

- **Tauri 是轻量级桌面方案**: 相比 Electron 的体积和内存占用，Tauri + Rust 核心是更现代的选择。Hermes 应考虑 Tauri。
- **MCP 作为唯一工具协议**: Goose 没有自建工具系统，完全依赖 MCP。这简化了架构但也意味着所有工具都必须符合 MCP 标准。
- **Desktop + CLI 双入口**: Goose 同时支持桌面和命令行，类似 Hermes 的桌面 + 飞书双入口模式。

---

### 3. Cursor / Windsurf（AI IDE）

**Cursor 官网**: https://cursor.com
**Windsurf 官网**: https://windsurf.com
**定位**: 基于 VS Code fork 的 AI 增强 IDE

#### Cursor 的 Agent Mode

- **计划-执行-审批循环**: 用户用自然语言描述任务 → Cursor 生成计划 → 编辑文件 → 展示 diff → 用户审批。
- **全仓库感知**: 可同时编辑数十个文件来实现单个功能，超越了早期 Copilot 的单文件建议。
- **Electron 架构**: 基于 VS Code（Electron）fork，继承了完整的编辑器生态。

#### Windsurf 的 Cascade 系统

- **图式推理引擎**: 使用基于图的推理系统映射整个代码库的逻辑和依赖。
- **Flow 状态**: 维持持久上下文，理解的不仅是当前文件，还有整个项目的架构意图。
- **Memories 功能**: 跨会话记忆项目规则（如自定义样式指南、技术债务约束）。
- **Turbo Mode**: 允许 Cascade 自主执行终端命令。
- **深度集成**: 可以拉取 commit 历史、查询数据库、动态生成文档。

#### 对 Hermes 的启示

- **IDE 方案过重**: Cursor/Windsurf 本质是 IDE fork，对 Hermes 来说过度设计。但它们的"上下文感知"和"持久记忆"机制值得借鉴。
- **Electron 作为桌面框架的代价**: Cursor/Windsurf 依赖 Electron 的完整 VS Code 基础设施，包袱很重。Hermes 应避免这条路。
- **Cascade 的图式推理**: 如果 Hermes 需要代码理解能力，可以考虑类似的项目结构索引方案。

---

### 4. Claude Code（Anthropic CLI Agent）

**项目地址**: https://github.com/anthropics/claude-code
**定位**: 终端原生编码智能体

#### 核心架构

- **本地优先**: 在用户终端运行，直接访问本地文件系统和工具链。
- **内置工具集**: Read、Write、Edit、Bash、Glob、Grep、WebSearch、WebFetch、AskUserQuestion。
- **三层权限系统**: 规则匹配（allow/ask/deny 通配符）→ 决策逻辑 → 执行选项（自动允许/询问用户/自动拒绝）。层级优先级：managed > user > project > local。
- **沙箱机制**: 仅对 Bash 工具生效。使用 OS 级原语（Linux bubblewrap / macOS seatbelt）实现文件系统和网络隔离。沙箱内权限提示减少 84%。
- **Hook 系统**: PreToolUse / PostToolUse / Stop / SessionStart / SessionEnd 等生命周期钩子，支持验证、日志、拦截、转换。

#### Claude Agent SDK（核心可复用组件）

Claude Code 的基础架构已抽取为独立 SDK，这是 Hermes 最应关注的组件：

- **命名演进**: Claude Code SDK → Claude Agent SDK（2025 年底更名，反映其从编码助手运行时进化为通用 agent 运行时）。
- **SDK 提供的能力**:
  - 内置工具执行（Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch）
  - Agent 循环（自动处理 tool call → result → 继续推理）
  - Hook 系统（PreToolUse/PostToolUse/Stop/SessionStart 等）
  - 子 Agent 机制（定义专门化 agent，主 agent 委派任务）
  - MCP 集成（连接外部系统：数据库、浏览器、API）
  - 会话管理（session resume/fork）
  - 权限控制（allowedTools 白名单）
  - Skills / Slash Commands / Memory（文件系统配置）
- **双语言支持**: Python (`claude-agent-sdk`) 和 TypeScript (`@anthropic-ai/claude-agent-sdk`)
- **与 Client SDK 的区别**: Client SDK 需要你自己实现 tool loop；Agent SDK 的 `query()` 函数封装了完整的自主执行循环。

#### 对 Hermes 的启示

- **Claude Agent SDK 是首选基础**: 它提供了完整的 agent 运行时，包含工具执行、权限、MCP、子 agent、会话管理。Hermes 不需要从零构建 agent 引擎。
- **`query()` 作为核心入口**: 一个函数调用即可启动自主 agent 循环，通过 async iterator 流式获取结果——完美适配桌面应用的 UI 更新需求。
- **Hook 系统实现路由控制**: Hermes 可以通过 PreToolUse hook 拦截工具调用，决定路由到本地还是云端执行。
- **子 Agent 支持多角色**: Hermes 可定义专门化子 agent（如"本地文件管理 agent"、"云端代码执行 agent"），由主 agent 按需委派。
- **会话管理支持多入口**: session resume 能力可以让飞书和桌面应用共享同一个会话上下文。

---

### 5. Cline（VS Code 扩展）

**项目地址**: https://github.com/cline/cline
**定位**: VS Code 内自主编码 agent

#### 核心架构

- **VS Code 原生**: 作为 VS Code 扩展运行，利用 VS Code shell integration（v1.93+）直接在终端执行命令并获取输出。
- **人在回路中**: 用户描述目标 → Cline 提出计划 → 执行步骤需显式 tool call → 用户审批。
- **模型无关**: 支持 OpenRouter、Anthropic、OpenAI、Gemini、Bedrock、Azure、Vertex、本地模型（LM Studio/Ollama）。
- **MCP Marketplace**: v3.4 引入 MCP 市场，类似"AI 能力应用商店"。MCP server 作为独立进程运行，与 IDE 进程分离。
- **自生成工具**: Cline 可以自己创建和安装 MCP server——用户只需说"添加一个工具"，Cline 处理从创建 MCP server 到安装的全过程。
- **浏览器自动化**: 利用 Claude Computer Use 能力，在无头浏览器中操作本地运行的应用。

#### 对 Hermes 的启示

- **MCP Marketplace 模式**: Hermes 可以提供类似的工具市场，让用户发现和安装扩展能力。
- **Agent 自建工具**: Cline 允许 agent 自己创建 MCP server 是一个强大但危险的模式，Hermes 应谨慎评估。
- **VS Code 扩展 vs 独立桌面应用**: Cline 受限于 VS Code 生态，Hermes 作为独立桌面应用有更大的自由度。

---

### 6. aider（终端编码 Agent）

**项目地址**: https://github.com/Aider-AI/aider
**定位**: 终端内 AI pair programming

#### 核心架构

- **Git 原生**: 每次编辑都是一个 commit，每个会话都是一个可审查、可回滚、可 cherry-pick 的分支。
- **全仓库映射**: 理解整个代码库结构，支持 100+ 语言。
- **纯本地执行**: 没有云端沙箱概念，所有操作直接在用户机器上执行。

#### 相关架构研究：OpenDev 的终端 Agent 架构模式

来自 2026 年 3 月的学术论文《Building Effective AI Coding Agents for the Terminal》，总结了关键模式：

- **双 Agent 架构**: 规划 Agent（只读工具）+ 执行 Agent（读写工具），通过 schema 级别隔离而非状态机模式切换。
- **工作负载专项模型路由**: 5 种独立模型角色（正常执行 / 思考批判 / 视觉 / 规划 / 压缩），各自独立配置 provider。
- **渐进式上下文压缩**: token 预算耗尽时，渐进减少旧观察记录。
- **双记忆架构**: 情景记忆（完整对话）与工作记忆（近期上下文）分离。
- **事件驱动提醒**: 在决策点注入行为指导，对抗指令淡化效应。
- **五层纵深防御**: 提示级守护 → Schema 级工具限制 → 运行时审批 → 工具级验证 → 用户自定义生命周期钩子。

#### 对 Hermes 的启示

- **双 Agent 架构值得借鉴**: 规划 Agent 只有读权限，执行 Agent 有写权限——在 schema 层面隔离，比运行时检查更安全。
- **模型路由**: 不同工作负载用不同模型，可以优化成本和延迟。
- **上下文管理是长会话的关键**: 渐进式压缩 + 双记忆架构对 Hermes 的长对话场景至关重要。

---

## 二、关键架构模式总结

### 模式 1：Agent 决定执行环境（vs 静态路由器）

| 方案 | 谁决定路由？ | 机制 |
|------|-------------|------|
| OpenHands V1 | 开发者配置 | Workspace 抽象层，启动时选择 Local/Docker |
| Goose | Agent 隐式决定 | 所有工具通过 MCP 暴露，agent 选择调用哪个工具 |
| Claude Code | 权限系统 + 沙箱配置 | PreToolUse hook 可拦截并路由 |
| Cline | Agent 隐式决定 | MCP server 作为独立进程，agent 根据上下文选择 |
| Cursor/Windsurf | IDE 内部 | 全部本地执行，无云端选项 |
| aider | N/A | 纯本地 |

**关键发现**: 目前没有项目实现了真正的"agent 动态决定在哪里执行"。最接近的是 Goose/Cline 的 MCP 模式——agent 选择调用哪个 MCP tool，而不同 MCP server 可能运行在不同环境中。Hermes 可以在此基础上更进一步：**在工具描述中嵌入执行环境信息，让 LLM 基于任务需求选择合适的工具变体**。

### 模式 2：复用现有 SDK vs 自建

| 项目 | 策略 | 基础 SDK |
|------|------|---------|
| OpenHands | 自建 SDK（已开源） | 自研事件溯源引擎 |
| Goose | 自建（Rust） | 自研 + MCP 标准 |
| Cursor/Windsurf | 自建 | VS Code 扩展 API |
| Claude Code | 自建 → 开源为 SDK | Claude Agent SDK |
| Cline | 自建 | VS Code 扩展 API + 多 provider |
| aider | 自建 | LiteLLM 多模型适配 |

**关键发现**: 所有主流项目都是自建 agent 引擎。但 Claude Agent SDK 的出现改变了格局——它是第一个提供**完整 agent 运行时**（不仅是 API wrapper）的官方 SDK，包含工具执行、权限、MCP、子 agent。Hermes 复用 Claude Agent SDK 是合理的技术选择。

### 模式 3：桌面应用技术选型

| 项目 | 技术栈 | 包体积 | 内存 |
|------|--------|--------|------|
| Goose | Tauri (Rust + WebView) | < 10MB | 30-50MB |
| Cursor | Electron (VS Code fork) | ~300MB | 300MB+ |
| Windsurf | Electron (VS Code fork) | ~300MB | 300MB+ |
| MA Agent | Electron | ~150MB | 200MB+ |

**关键发现**: Tauri 是新一代桌面应用的首选框架，特别适合 AI agent 场景——轻量、安全（Rust 后端）、原生 WebView。

### 模式 4：MCP 作为统一工具层

所有调研项目都在拥抱 MCP（截至 2026 年 1 月，MCP 月下载量已达 1 亿，索引 3000+ server）：

- **Goose**: MCP 是唯一工具协议
- **Claude Code/Agent SDK**: 内置 MCP 支持，可通过配置添加 MCP server
- **Cline**: MCP Marketplace，agent 可自建 MCP server
- **OpenHands V1**: MCP 工具自动转译为原生工具

---

## 三、Hermes 架构建议

### 推荐技术栈

```
┌─────────────────────────────────────────────────┐
│              Hermes 桌面应用 (Tauri)               │
│  ┌──────────────────────────────────────────┐    │
│  │            前端 UI (React/Vue)            │    │
│  │  - 对话界面                               │    │
│  │  - 工具执行可视化                          │    │
│  │  - 权限审批面板                            │    │
│  └──────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────┐    │
│  │         Rust 后端 (Tauri Commands)        │    │
│  │  - 本地 MCP Server 管理                    │    │
│  │  - 系统级操作（文件/进程/网络）              │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
           │                          │
           │ Claude Agent SDK         │ MCP (STDIO)
           │ (TypeScript)             │
           ▼                          ▼
┌─────────────────────┐    ┌──────────────────────┐
│   Agent 运行时        │    │  本地 MCP Servers     │
│  - query() 循环      │    │  - 文件系统访问        │
│  - Hook 路由         │    │  - 浏览器登录态        │
│  - 子 Agent 委派     │    │  - 本地命令执行        │
│  - 会话管理          │    └──────────────────────┘
└─────────────────────┘
           │
           │ MCP (HTTP+SSE)
           ▼
┌──────────────────────┐    ┌──────────────────────┐
│   云端 MCP Servers    │    │   飞书 Bot 入口       │
│  - Shell 沙箱         │    │  - 消息接收/发送      │
│  - 代码执行环境       │    │  - session resume    │
│  - 持久化存储         │    │  - 与桌面共享会话     │
└──────────────────────┘    └──────────────────────┘
```

### 核心设计决策

#### 1. Agent 运行时：复用 Claude Agent SDK

- 使用 `query()` 作为 agent 循环的核心入口
- 通过 `allowedTools` 控制工具可见性
- 通过 `hooks.PreToolUse` 实现动态路由逻辑
- 通过 `agents` 定义子 agent（本地操作 agent / 云端执行 agent）
- 通过 `mcpServers` 连接本地和云端 MCP server
- 通过 `resume` 实现飞书 ↔ 桌面的会话共享

#### 2. Agent 动态路由：PreToolUse Hook + MCP 双通道

不使用静态路由器，而是让 agent 自己决定：

```typescript
// 方案 A：同一工具名，通过 Hook 路由到不同后端
const routingHook = async (input) => {
  // agent 在工具调用时可附加 metadata 指示执行偏好
  const env = input.tool_input?.execution_env;
  if (env === "local") return routeToLocalMCP(input);
  if (env === "cloud") return routeToCloudMCP(input);
  // 默认：根据工具类型自动选择
  return autoRoute(input);
};

// 方案 B：暴露两套工具变体，让 agent 选择
// local_shell_exec vs cloud_shell_exec
// local_read_file vs cloud_read_file
// agent 根据任务语义自主选择
```

推荐**方案 B**——更透明，agent 的决策可审计，且更符合 MCP 的设计哲学（不同 server 暴露不同工具）。

#### 3. 桌面框架：Tauri

- Rust 后端处理系统级操作（进程管理、文件监控、MCP server 生命周期）
- WebView 前端负责 UI 渲染
- 跨平台支持（macOS / Windows / Linux）
- 包体积 < 20MB，内存占用 < 100MB

#### 4. 飞书集成：共享会话

- 飞书消息通过 Bot API 接收
- 转发到 Claude Agent SDK 的 `query()` 调用
- 使用 `session_id` + `resume` 在飞书和桌面之间共享上下文
- 桌面应用离线时，云端 agent 继续通过飞书响应

---

## 四、风险与注意事项

1. **Claude Agent SDK 的 vendor lock-in**: SDK 仅支持 Claude 模型。如需多模型支持，需要额外抽象层或备选 SDK（如 OpenHands SDK）。
2. **Tauri 生态成熟度**: Tauri v2 已发布但插件生态不如 Electron 丰富。复杂 UI 交互可能需要更多自定义开发。
3. **MCP 远程传输**: MCP 的 HTTP+SSE transport 标准仍在演进，生产级使用需关注认证、重试、超时等问题。
4. **Agent 路由决策质量**: 让 LLM 决定执行环境依赖于模型理解工具描述的能力——需要精心设计工具名称和描述。
5. **会话状态同步**: 桌面 ↔ 飞书的会话共享需要可靠的状态持久化机制（Claude Agent SDK 的 session 机制是否足够？需验证）。

---

## 参考来源

- [OpenHands GitHub](https://github.com/OpenHands/OpenHands)
- [OpenHands Agent SDK 论文](https://arxiv.org/html/2511.03690v1)
- [Goose GitHub](https://github.com/block/goose)
- [Goose MCP 教程](https://block.github.io/goose/docs/tutorials/building-mcp-apps/)
- [AAIF 成立公告](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [Goose, MCP, and AGENTS.md](https://www.jankowskimichal.pl/en/2026/01/goose-mcp-and-agents-md-the-emerging-foundation-of-agentic-ai/)
- [Cursor vs Windsurf vs Claude Code 2026 对比](https://dev.to/pockit_tools/cursor-vs-windsurf-vs-claude-code-in-2026-the-honest-comparison-after-using-all-three-3gof)
- [Agentic IDE 崛起](https://markets.financialcontent.com/wss/article/tokenring-2026-1-26-the-rise-of-the-agentic-ide-how-cursor-and-windsurf-are-automating-the-art-of-software-engineering)
- [Claude Code 系统架构 (DeepWiki)](https://deepwiki.com/anthropics/claude-code/1.1-system-architecture)
- [Claude Code 沙箱文档](https://code.claude.com/docs/en/sandboxing)
- [Claude Agent SDK 概览](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK (npm)](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Anthropic 沙箱工程博客](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Cline GitHub](https://github.com/cline/cline)
- [Cline MCP 概览](https://docs.cline.bot/mcp/mcp-overview)
- [Cline 2026 评测](https://vibecoding.app/blog/cline-review-2026)
- [aider GitHub](https://github.com/Aider-AI/aider)
- [终端 AI 编码 Agent 架构论文](https://arxiv.org/html/2603.05344v1)
- [2025 终端 AI Agent 全景](https://wal.sh/research/2025-terminal-ai-agents.html)
