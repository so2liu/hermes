/**
 * End-to-end test: starts the cloud server with real LLM,
 * connects as desktop client, sends a message that should trigger local_bash,
 * executes locally, and verifies the full round trip.
 */

import { spawn } from "node:child_process";

const PORT = 28765; // Use a different port to avoid conflicts

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

// --- Connect as desktop client ---
const ws = new WebSocket(`ws://localhost:${PORT}`);
const events: any[] = [];
let testDone = false;

ws.addEventListener("open", () => {
  console.log("[e2e] Desktop client connected");
});

ws.addEventListener("message", async (event) => {
  const msg = JSON.parse(typeof event.data === "string" ? event.data : "");

  if (msg.type === "agent_event") {
    const ae = msg.event;
    events.push(ae);

    // Log ALL event types for debugging
    if (ae.type !== "message_update") {
      console.log(`\n[e2e] Event: ${ae.type}`, JSON.stringify(ae).slice(0, 200));
    }

    // Print text deltas
    if (ae.type === "message_update" && ae.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(ae.assistantMessageEvent.delta);
    }
    // Log non-text message_update events
    if (ae.type === "message_update" && ae.assistantMessageEvent?.type !== "text_delta") {
      console.log(`\n[e2e] message_update subtype: ${ae.assistantMessageEvent?.type}`);
    }

    // Print tool calls
    if (ae.type === "tool_execution_start") {
      console.log(`\n[e2e] Tool call: ${ae.toolName ?? ae.tool?.name ?? "unknown"}`);
    }
  }

  if (msg.type === "local_tool_request") {
    console.log(`\n[e2e] LOCAL TOOL REQUEST: ${msg.params.command}`);

    // Execute locally
    const result = await new Promise<{ result: string; exitCode: number | null }>((resolve) => {
      const chunks: Buffer[] = [];
      const child = spawn("bash", ["-c", msg.params.command], {
        cwd: process.env.HOME,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      child.on("close", (code) => {
        resolve({ result: Buffer.concat(chunks).toString(), exitCode: code });
      });
    });

    console.log(`[e2e] Local execution result: "${result.result.trim()}" (exit=${result.exitCode})`);

    ws.send(JSON.stringify({
      type: "local_tool_response",
      id: msg.id,
      result: result.result,
      exitCode: result.exitCode,
    }));
  }

  if (msg.type === "status" && msg.agent === "idle" && events.length > 0 && !testDone) {
    testDone = true;
    console.log("\n\n[e2e] === Test Complete ===");

    // Analyze results
    const toolCalls = events.filter((e) => e.type === "tool_execution_start");
    const localCalls = toolCalls.filter((e) => (e.toolName ?? e.tool?.name) === "local_bash");
    const cloudCalls = toolCalls.filter((e) => (e.toolName ?? e.tool?.name) === "cloud_bash");

    console.log(`[e2e] Total tool calls: ${toolCalls.length}`);
    console.log(`[e2e] - local_bash: ${localCalls.length}`);
    console.log(`[e2e] - cloud_bash: ${cloudCalls.length}`);

    if (localCalls.length > 0) {
      console.log("[e2e] ✅ PASS: Agent used local_bash as expected");
    } else {
      console.log("[e2e] ❌ FAIL: Agent did not use local_bash");
    }

    // Cleanup
    ws.close();
    serverProc.kill("SIGTERM");
    setTimeout(() => process.exit(localCalls.length > 0 ? 0 : 1), 500);
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

// Wait for connection, then send test message
await new Promise((r) => setTimeout(r, 1000));
console.log('[e2e] Sending test message: "list files on my Desktop"');
ws.send(JSON.stringify({
  type: "message",
  content: "List the files on my Desktop directory. Use local_bash since you need to access my local machine.",
}));

// Timeout after 60s
setTimeout(() => {
  if (!testDone) {
    console.log("[e2e] ❌ TIMEOUT after 60s");
    serverProc.kill();
    process.exit(1);
  }
}, 60000);
