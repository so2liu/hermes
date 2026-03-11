# Hermes 功能清单

> 完整的功能备忘录，包含 MVP 和未来规划。标注 `[MVP]` 的是最小可行产品范围。

## 核心能力

### Agent 运行时
- [MVP] 云端运行 PiCodeAgent，通过 WebSocket 提供服务
- [MVP] 单用户 Agent 实例
- [ ] 多用户隔离，每用户独立 Agent 实例
- [ ] 多 LLM 提供商支持（Anthropic、OpenAI、Doubao 等）
- [ ] 模型动态切换（对话中途换模型）
- [ ] Thinking level 可配置
- [ ] Context overflow 自动 compaction

### 工具系统
- [MVP] `cloud_bash` — 云端执行 shell 命令
- [MVP] `local_bash` — 回调桌面端执行 shell 命令
- [ ] `cloud_read_file` / `local_read_file` — 文件读取
- [ ] `cloud_write_file` / `local_write_file` — 文件写入
- [ ] `cloud_edit_file` / `local_edit_file` — 文件编辑
- [ ] `local_browser` — 操作用户本地浏览器（使用登录态）
- [ ] `cloud_sandbox` — 隔离沙盒执行不可信代码
- [ ] `web_search` / `web_fetch` — 网络搜索和抓取
- [ ] 工具执行超时和取消
- [ ] 工具执行结果截断（大输出处理）

### 智能体自主路由
- [MVP] Agent 根据工具描述自主选择本地/云端执行环境
- [MVP] 桌面端离线时自动移除本地工具，agent 只看到云端工具
- [ ] 桌面端上线时自动注册本地工具
- [ ] 安全策略：敏感操作需用户确认

## 客户端

### 桌面端（主入口）
- [MVP] 终端 CLI 客户端（MVP 阶段）
- [ ] Electron 桌面应用（基于 MA Agent 演化）
- [ ] React UI：对话界面、工具调用可视化
- [ ] Artifact 面板（代码预览、文件预览）
- [ ] 会话历史和分支管理
- [ ] 工作空间文件浏览器
- [ ] 拖拽文件/图片发送
- [ ] 多模态输入（文本、图片、文件）
- [ ] 系统托盘常驻 + 全局快捷键
- [ ] 自动更新
- [ ] macOS / Windows / Linux 支持

### 飞书端（辅助入口）
- [ ] 飞书 bot 接入（基于 Factorio World 演化）
- [ ] 与桌面端共享同一 agent session
- [ ] 群聊主动回复
- [ ] 飞书卡片消息展示工具调用
- [ ] 飞书文件直接传递给 agent

## 会话管理

### 多客户端同步
- [MVP] 单 Session + 事件广播模型
- [MVP] 消息队列（FIFO），顺序执行
- [ ] 所有在线客户端实时同步 agent 输出
- [ ] 会话历史持久化（JSONL）
- [ ] 跨客户端会话恢复（断线重连后同步历史）

### 会话功能
- [ ] 会话分支（fork）
- [ ] 会话压缩（compaction）
- [ ] 会话导出（HTML/Markdown）
- [ ] 会话搜索

## 记忆系统
- [ ] 三层记忆（SOUL.md / MEMORY.md / diary）
- [ ] 每日日记自动生成
- [ ] 用户偏好自动学习
- [ ] 跨会话记忆持久化

## 技能系统
- [ ] PiCodeAgent Skills 标准兼容
- [ ] 内置技能（文档生成、Web App、数据分析）
- [ ] 自定义技能安装
- [ ] LAN 技能发现（局域网共享）
- [ ] 技能市场

## Extension 系统
- [ ] PiCodeAgent Extension API 兼容
- [ ] 生命周期事件订阅（agent_start/end, tool_call 等）
- [ ] 自定义工具注册
- [ ] 权限控制（危险操作确认）
- [ ] UI 自定义（桌面端）

## 安全
- [ ] 用户认证（桌面端 ↔ 云端绑定）
- [ ] WebSocket 连接加密（WSS）
- [ ] 本地工具执行权限管控
- [ ] 云端沙盒隔离
- [ ] API Key 安全存储
- [ ] 敏感文件过滤（不上传 .env 等）

## 可观测性
- [ ] Langfuse 集成（agent 追踪）
- [ ] Token 用量和成本统计
- [ ] 工具调用日志
- [ ] 错误监控和告警

## 部署
- [MVP] 本地开发（云端 + 桌面端都在本机）
- [ ] Docker 部署（云端）
- [ ] CI/CD 自动构建和发布
- [ ] 桌面端自动更新（GitHub Releases）

## 定时任务
- [ ] 定时触发 agent 执行任务
- [ ] 每用户独立 cron 管理
- [ ] 任务执行结果通知（飞书/桌面端）
