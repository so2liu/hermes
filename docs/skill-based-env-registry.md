# 基于 Skill 的环境注册机制

## 核心思想

每个执行环境（容器、桌面端等）是一个 **Skill**。环境上线时注册 Skill，下线时移除。Agent 通过 Skill 机制按需发现和使用环境能力。

**设计理念**：不使用 MCP，不静态注册工具列表。借鉴当前 agent 生态的 Skill 模式——Agent 启动时只看到 Skill 名字和描述（~100 tokens），需要时用自带的 Read 工具读取 SKILL.md 获取完整指令和工具用法。每个 Skill 对应一个专属 exec 工具，路由到对应环境执行。

## 场景驱动

| 场景 | Skill | 环境形态 |
|------|-------|---------|
| 用户让 agent 画原型图 | `excalidraw` | Docker 容器 |
| 用户让 agent 写代码/做 PPT | `coding` | Docker 容器 |
| 用户让 agent 到网站下载文件 | `desktop` | 用户本地电脑 |

## 环境模型

**所有环境统一支持随时上下线**。不区分"插件环境"和"客户端环境"——无论是云端容器还是桌面端，注册和注销协议完全一致。云端容器也可能 crash、重启、扩缩容，必须按"随时可能下线"来设计。

**环境是共享资源，不绑定 session**。多个 session（不同用户）可以连接同一个环境实例（如同一个 excalidraw 容器）。Session 隔离由环境自身负责——exec 请求中携带 sessionId，环境根据 sessionId 隔离数据和状态。

## 架构

```
┌──────────────────────────────────────────────────────┐
│  Hermes Cloud                                        │
│                                                      │
│  Session A (User A)    Session B (User B)            │
│  ├── Agent A           ├── Agent B                   │
│  └── Skill Registry A  └── Skill Registry B          │
│                                                      │
│  环境池（共享，随时上下线）                             │
│  ├── excalidraw container ←── WebSocket              │
│  ├── coding container     ←── WebSocket              │
│  └── desktop client       ←── WebSocket              │
│       (每个环境可同时服务多个 session)                  │
└──────────────────────────────────────────────────────┘
```

## 注册协议

### 环境 → Cloud：注册

环境通过 WebSocket 连接后，发送注册消息：

```typescript
interface RegisterSkill {
  type: "register_skill";
  sessionId: string;
  skill: {
    name: string;         // "excalidraw"，必须匹配 /^[a-z][a-z0-9-]*$/
    skillMd: string;      // SKILL.md 的完整内容
  };
}
```

Cloud 收到后：
1. 校验 `skill.name` 格式（`/^[a-z][a-z0-9-]*$/`，防路径穿越和工具名冲突）
2. 将 `skillMd` 写入 `.hermes/skills/{name}/SKILL.md`
3. 创建对应的 exec 工具（如 `excalidraw_exec`），execute 实现为转发到该环境的 WebSocket
4. 将 exec 工具 push 到 `dynamicTools` 数组
5. 将 skill 信息 push 到 `registeredSkills` 数组
6. 等待 agent idle → 调用 `session.reload()` 触发系统提示词和工具列表重建

### 环境 → Cloud：注销

WebSocket 断开时，Cloud 自动：
1. 如果 agent 正在使用该环境的工具（有 pending call）→ 标记为 `draining`，等调用完成
2. 从 `dynamicTools` 数组移除对应 exec 工具
3. 从 `registeredSkills` 数组移除对应 skill
4. 删除 `.hermes/skills/{name}/`
5. 等待 agent idle → 调用 `session.reload()`

### 工具执行路由

Agent 调用 `excalidraw_exec({ command: "..." })` 时：

```
Agent 调用 excalidraw_exec
       ↓
exec 工具的 execute 函数内部：
  查找 excalidraw 环境的 WebSocket 连接
       ↓
  如果在线 → 转发执行请求 → 容器执行 → 返回结果
  如果 draining/offline → 返回错误提示
```

## PiCodeAgent 动态能力验证

经源码验证（`~/github/pi-mono`），PiCodeAgent 的关键行为：

### 确认可行的能力

| 能力 | 支持 | 机制 |
|------|------|------|
| `_customTools` 引用传递 | ✅ | 构造时直接赋值 `this._customTools = config.customTools`，不拷贝 |
| `session.reload()` 重建工具 | ✅ | 调用 `_buildRuntime()` → 重新读取 `_customTools` 数组 |
| `session.reload()` 重建 skills | ✅ | 调用 `resourceLoader.reload()` → `_rebuildSystemPrompt()` → `getSkills()` |
| `session.reload()` 重建系统提示词 | ✅ | 重新调用 `getSystemPrompt()` + `getSkills()` 拼接 |
| `resourceLoader` 可动态返回 | ✅ | 接口方法每次调用可返回不同值 |

### 不支持的能力

| 能力 | 不支持 | 影响 |
|------|--------|------|
| 运行时公开 API 增删工具 | ❌ | 无 `addTool()` / `removeTool()`，但可通过引用传递绕过 |
| `getSkills()` 每次 prompt 自动刷新 | ❌ | 仅在 `_buildRuntime` 时调用，需显式 `reload()` |
| `reload()` 并发安全 | ❌ | 无 `isStreaming` 检查，必须在 agent idle 时调用 |

### 实现方案

利用引用传递 + `session.reload()`：

```typescript
// 1. 可变数组，作为 customTools 的后备存储
const dynamicTools: ToolDefinition[] = [];

// 2. 动态 skill 列表
const registeredSkills: Skill[] = [];

// 3. resourceLoader 每次返回当前状态
const resourceLoader: ResourceLoader = {
  getSkills: () => ({ skills: registeredSkills, diagnostics: [] }),
  getSystemPrompt: () => buildSystemPrompt(registeredSkills),
  reload: async () => {},  // 无需从磁盘重读，内存即是真相
  // ...
};

// 4. 创建 session（引用传递）
const { session } = await createAgentSession({
  customTools: dynamicTools,   // 引用，非拷贝
  resourceLoader,
  tools: ["read"],             // 必须启用 Read，供 agent 读取 SKILL.md
  // ...
});

// 5. 环境注册时
function onSkillRegister(name: string, skillMd: string, ws: WebSocket) {
  // 写入文件系统
  writeSkillFile(name, skillMd);
  // 创建 exec 工具
  dynamicTools.push(createExecTool(name, ws));
  // 注册 skill metadata
  registeredSkills.push(parseSkillMetadata(skillMd));
  // 等 agent idle 后 reload
  scheduleReload();
}

// 6. 环境注销时
function onSkillUnregister(name: string) {
  removeSkillFile(name);
  const idx = dynamicTools.findIndex(t => t.name === `${name}_exec`);
  if (idx !== -1) dynamicTools.splice(idx, 1);
  const skillIdx = registeredSkills.findIndex(s => s.name === name);
  if (skillIdx !== -1) registeredSkills.splice(skillIdx, 1);
  scheduleReload();
}

// 7. reload 调度：确保在 agent idle 时执行
let reloadPending = false;
function scheduleReload() {
  reloadPending = true;
  if (!agentBusy) {
    session.reload();
    reloadPending = false;
  }
  // agentBusy 变 false 时检查 reloadPending
}
```

## SKILL.md 格式

每个环境提供的 SKILL.md 遵循标准 frontmatter + markdown 格式：

```markdown
---
name: excalidraw
description: "绘制原型图、架构图、流程图、线框图。当用户需要画图、可视化、设计草图时使用。"
---

# Excalidraw 绘图环境

你可以通过 `excalidraw_exec` 工具在 Excalidraw 画布上操作。

## 可用命令

### 绘制图形
```bash
excalidraw-cli draw --prompt "要绘制的内容描述"
```

### 添加元素
```bash
excalidraw-cli add --type rectangle --x 100 --y 100 --width 200 --height 100 --text "模块名"
```

### 导出图片
```bash
excalidraw-cli export --format png --output /tmp/output.png
```

## 使用指南
- 优先使用手绘风格，更适合原型阶段
- 复杂图形分步绘制，每步用 export 确认效果
- 导出后可通过结果返回给用户查看
```

## Agent 视角的完整流程

```
1. Agent 启动，系统提示词包含：
   "可用 Skills：
    - excalidraw: 绘制原型图、架构图...
    - coding: 编程、构建、运行代码...
    - desktop: 操作用户本地电脑... [在线]"

2. 用户："帮我画一个系统架构图"

3. Agent 判断需要 excalidraw
   → 用 Read 工具读取 .hermes/skills/excalidraw/SKILL.md
   → 获得完整指令，知道如何使用 excalidraw_exec

4. Agent 调用 excalidraw_exec({ command: 'excalidraw-cli draw --prompt "..."' })
   → Cloud 将命令转发到 excalidraw 容器
   → 容器执行，返回结果

5. Agent 继续对话，可能调用 export 导出图片
```

## 已知风险和约束

### MVP 阶段接受的限制

- **信任边界**：环境通过 `skillMd` 可注入 agent 指令。MVP 阶段所有环境都是自己的容器/桌面端，可接受。后续需要做签名校验或 cloud 持有 canonical SKILL.md。
- **无认证**：WebSocket 无 token 认证。MVP 阶段为本地开发，可接受。
- **同名单实例**：每个 skill name 只允许一个环境实例。不支持同能力多实例（如两个 coding 容器）。
- **session 隔离**：环境自身负责按 sessionId 隔离数据。MVP 阶段环境实现可以忽略 sessionId（单用户场景）。

### 必须遵守的约束

- `session.reload()` 只能在 agent idle 时调用 → 注册/注销需排队等当前 turn 结束
- `tools` 配置必须包含 `["read"]`，否则 agent 无法读取 SKILL.md
- `skill.name` 必须校验格式 `/^[a-z][a-z0-9-]*$/`
- 所有环境必须按"随时可能下线"设计，包括云端容器（crash、重启、扩缩容）
- exec 请求携带 sessionId，环境根据 sessionId 隔离状态
