# Hermes

## 核心定位

Hermes 是一个桌面优先的 AI Agent 应用，复用 PiCodeAgent 作为云端 agent 运行时，让智能体能同时操作用户本地环境和云端沙盒，实现"智能无处不在"。

## 架构

```
┌─────────────────────────────────────────┐
│  Cloud (PiCodeAgent 运行时)              │
│                                         │
│  Agent 推理 + 工具调度                    │
│  ├── 云端工具 → 直接在云端执行            │
│  └── 本地工具 → 回调桌面端执行            │
└──────────┬──────────────┬───────────────┘
           │              │
     WebSocket/API   WebSocket/API
           │              │
   ┌───────┴───────┐  ┌──┴──────────┐
   │ Hermes Desktop │  │ 飞书 Bot    │
   │ (主入口)       │  │ (辅助入口)  │
   │ - React UI    │  │             │
   │ - 本地工具执行 │  │             │
   └───────────────┘  └─────────────┘
```

### 设计原则

- **Desktop 不嵌入 agent 运行时**，它只是一个 UI 客户端 + 本地工具的执行器
- **PiCodeAgent 跑在云端**，推理和工具调度都在云端完成
- 当 agent 需要操作用户本地资源时，**回调桌面端**让桌面端执行
- 飞书和桌面端是**对等的客户端**，区别只是桌面端能额外提供本地工具能力

### 优势

1. **Agent 永远在线** — 不依赖用户开着电脑
2. **桌面端变轻** — 不需要跑 agent 循环，只做 UI + 本地工具代理
3. **飞书体验一致** — 同一个 agent 实例，只是没有本地工具可用
4. **本地工具是增强而非必须** — 桌面端在线时 agent 能力更强，离线也不影响基本使用

### 基于 Skill 的环境插件化

不使用 MCP，不静态注册工具列表。每个执行环境是一个 **Skill**：

- 环境上线 → 注册 Skill（写入 SKILL.md + 创建专属 exec 工具）→ `session.reload()`
- 环境下线 → 移除 Skill → `session.reload()`
- Agent 启动时只看到 Skill 名字和描述，需要时用 Read 工具读取 SKILL.md 获取完整指令

所有环境统一支持随时上下线（包括云端容器 crash/重启）。环境是共享资源，多个 session 可连接同一个环境实例，session 隔离由环境自身负责（通过 exec 请求中的 sessionId）。

详细设计见 `docs/skill-based-env-registry.md`。

### PiCodeAgent 动态工具实现方案

经源码验证，PiCodeAgent 不提供运行时增删工具的公开 API，但 `_customTools` 是引用赋值。利用这一点：

- `customTools` 传入可变数组 → 直接 push/splice 修改
- `resourceLoader.getSkills()` 返回动态列表 → 每次 reload 时重新读取
- `session.reload()` 触发 `_buildRuntime()` → 重建工具列表 + 系统提示词
- **约束**：`reload()` 必须在 agent idle 时调用；`tools` 配置必须包含 `["read"]`

### 云端部署形态

单 Bun 进程，包装成 WebSocket 服务。不同用户的 agent 在同一个进程内管理。

### 多客户端会话同步

PiCodeAgent 的 SessionManager 没有并发锁（append-only JSONL），不是为多客户端并发写设计的。

采用 **单 Session + 事件广播 + 消息排队** 模型：

```
┌──────────────┐     ┌──────────────┐
│ Hermes Desktop│     │  飞书 Bot    │
└──────┬───────┘     └──────┬───────┘
       │ ws                  │ ws
       ▼                     ▼
┌─────────────────────────────────────┐
│  Hermes Cloud (per-user Agent)       │
│                                     │
│  Session State (内存中, 单写者)       │
│  ├── message queue (FIFO)           │
│  ├── event broadcast → all clients  │
│  └── JSONL 持久化 (追加写)           │
└─────────────────────────────────────┘
```

规则：
- 每个用户一个 Agent 实例 + 一个 Session，所有客户端共享
- 任何客户端发的消息进入同一个队列，顺序执行（PiCodeAgent 本身是单线程 turn-based）
- Agent 事件广播给所有在线客户端，实时同步输出和工具调用
- 环境上线时注册 Skill + exec 工具，下线时移除。reload 后 agent 自然只看到当前可用的 Skill

## 关键技术依赖

- **PiCodeAgent** (`~/github/pi-mono`): 云端 agent 运行时，提供 SDK、Extension 系统、多 LLM 提供商支持
- **MA Agent** (`~/playground/ma-agent`): 已有的 Electron 桌面端，可作为 Hermes Desktop 的起点
- **Factorio World** (`~/playground/factorio-world`): 已有的飞书 bot + 云端执行环境，可演化为飞书辅助入口 + 云端沙盒服务
