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

### 智能体自主选择执行环境

不使用 MCP，不使用静态 Tool Router。注册两套同类工具，名称区分环境，让 agent 根据任务语义自主选择：

- `local_bash` / `cloud_bash`
- `local_read_file` / `cloud_read_file`

Agent 通过工具描述理解场景，自主决定在哪执行。当桌面端离线时，本地工具不注册，agent 只能使用云端工具。

## 技术可行性分析

### PiCodeAgent 支持回调模式

PiCodeAgent 的设计天然适配"云端 agent 回调桌面端执行本地工具"：

- **工具执行是 async 的** — `tool.execute()` 返回 `Promise`，agent loop 用 `await` 等待，execute 内部可以发 WebSocket 请求给桌面端等待结果
- **`BashOperations` 接口为远程执行设计** — 源码注释："Override these to delegate command execution to remote systems (e.g., SSH)"
- **Extension 注册的工具也是 async** — `pi.registerTool()` 注册的工具和内置工具走同一个执行流
- **事件流天然可转发** — RPC 模式已将所有 agent 事件序列化为 JSON Lines，改成 WebSocket 推送很直接

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
- 桌面端上线时注册本地工具到 agent 工具列表，下线时移除。agent 自然只看到当前可用的工具

## 关键技术依赖

- **PiCodeAgent** (`~/github/pi-mono`): 云端 agent 运行时，提供 SDK、Extension 系统、多 LLM 提供商支持
- **MA Agent** (`~/playground/ma-agent`): 已有的 Electron 桌面端，可作为 Hermes Desktop 的起点
- **Factorio World** (`~/playground/factorio-world`): 已有的飞书 bot + 云端执行环境，可演化为飞书辅助入口 + 云端沙盒服务
