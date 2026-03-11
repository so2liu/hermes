/**
 * End-to-end test: starts the cloud server with real LLM,
 * connects as desktop client (registers desktop skill),
 * sends a message that should trigger desktop_exec,
 * executes locally, and verifies the full round trip.
 *
 * REQUIRES: OPENROUTER_API_KEY or ANTHROPIC_API_KEY env var.
 */

import { spawn } from "node:child_process";

const PORT = 28765;

// --- Start server as subprocess ---
console.log("[e2e] Starting cloud server on port", PORT);

const serverProc = spawn("bun", ["run", "server.ts"], {
  cwd: import.meta.dir,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
serverProc.stdout.on("data", (d) => {
  const s = d.toString();
  serverOutput += s;
  process.stdout.write(`[server] ${s}`);
});
serverProc.stderr.on("data", (d) => {
  process.stderr.write(`[server:err] ${d.toString()}`);
});

// Wait for server to be ready (with 30s timeout)
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => {
    clearInterval(check);
    reject(new Error("Server failed to start within 30s"));
  }, 30000);
  const check = setInterval(() => {
    if (serverOutput.includes("running on ws://")) {
      clearInterval(check);
      clearTimeout(timeout);
      resolve();
    }
  }, 200);
});

console.log("[e2e] Server ready, connecting desktop client...");

// --- Desktop SKILL.md ---
const DESKTOP_SKILL_MD = `---
name: desktop
description: "操作用户本地电脑。访问本地文件、使用本地应用、操作浏览器登录状态等。"
---

# Desktop 本地执行环境

通过 \`desktop_exec\` 工具在用户本地电脑上执行 bash 命令。

## 使用方法
\`\`\`
desktop_exec({ command: "ls ~/Desktop" })
\`\`\`
`;

// --- Connect as desktop client ---
const ws = new WebSocket(`ws://localhost:${PORT}`);
const events: any[] = [];
let testDone = false;

ws.addEventListener("open", () => {
  console.log("[e2e] Desktop client connected");

  // Register desktop skill
  ws.send(
    JSON.stringify({
      type: "register_skill",
      skill: { name: "desktop", skillMd: DESKTOP_SKILL_MD },
    }),
  );
  console.log("[e2e] Registered desktop skill");
});

ws.addEventListener("message", async (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : "");

  if (msg.type === "agent_event") {
    const ae = msg.event;
    events.push(ae);

    if (ae.type !== "message_update") {
      console.log(
        `\n[e2e] Event: ${ae.type}`,
        JSON.stringify(ae).slice(0, 200),
      );
    }

    if (
      ae.type === "message_update" &&
      ae.assistantMessageEvent?.type === "text_delta"
    ) {
      process.stdout.write(ae.assistantMessageEvent.delta);
    }
    if (
      ae.type === "message_update" &&
      ae.assistantMessageEvent?.type !== "text_delta"
    ) {
      console.log(
        `\n[e2e] message_update subtype: ${ae.assistantMessageEvent?.type}`,
      );
    }

    if (ae.type === "tool_execution_start") {
      console.log(
        `\n[e2e] Tool call: ${ae.toolName ?? ae.tool?.name ?? "unknown"}`,
      );
    }
  }

  if (msg.type === "skill_exec_request") {
    console.log(`\n[e2e] SKILL EXEC REQUEST: ${msg.command}`);

    const result = await new Promise<{
      result: string;
      exitCode: number | null;
    }>((resolve) => {
      const chunks: Buffer[] = [];
      const child = spawn("bash", ["-c", msg.command], {
        cwd: process.env.HOME,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      child.on("close", (code) => {
        resolve({ result: Buffer.concat(chunks).toString(), exitCode: code });
      });
    });

    console.log(
      `[e2e] Local execution result: "${result.result.trim()}" (exit=${result.exitCode})`,
    );

    ws.send(
      JSON.stringify({
        type: "skill_exec_response",
        id: msg.id,
        result: result.result,
        exitCode: result.exitCode,
      }),
    );
  }

  if (
    msg.type === "status" &&
    msg.agent === "idle" &&
    events.length > 0 &&
    !testDone
  ) {
    testDone = true;
    console.log("\n\n[e2e] === Test Complete ===");

    const toolCalls = events.filter((e) => e.type === "tool_execution_start");
    const desktopCalls = toolCalls.filter(
      (e) => (e.toolName ?? e.tool?.name) === "desktop_exec",
    );
    const cloudCalls = toolCalls.filter(
      (e) => (e.toolName ?? e.tool?.name) === "cloud_bash",
    );

    console.log(`[e2e] Total tool calls: ${toolCalls.length}`);
    console.log(`[e2e] - desktop_exec: ${desktopCalls.length}`);
    console.log(`[e2e] - cloud_bash: ${cloudCalls.length}`);

    if (desktopCalls.length > 0) {
      console.log("[e2e] ✅ PASS: Agent used desktop_exec as expected");
    } else {
      console.log("[e2e] ❌ FAIL: Agent did not use desktop_exec");
    }

    ws.close();
    serverProc.kill("SIGTERM");
    setTimeout(() => process.exit(desktopCalls.length > 0 ? 0 : 1), 500);
  }

  if (msg.type === "error") {
    console.error(`[e2e] Error: ${msg.message}`);
  }
});

ws.addEventListener("error", (err) => {
  console.error("[e2e] WS error:", err);
  serverProc.kill();
  process.exit(1);
});

// Wait for connection + registration, then send test message
await new Promise((r) => setTimeout(r, 2000));
console.log('[e2e] Sending test message: "list files on my Desktop"');
ws.send(
  JSON.stringify({
    type: "message",
    content:
      "List the files on my Desktop directory. Use desktop_exec since you need to access my local machine.",
  }),
);

// Timeout after 60s
setTimeout(() => {
  if (!testDone) {
    console.log("[e2e] ❌ TIMEOUT after 60s");
    serverProc.kill();
    process.exit(1);
  }
}, 60000);
