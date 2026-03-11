/**
 * Integration test: verifies WebSocket communication and local tool callback.
 * Does NOT require an LLM API key.
 *
 * Tests:
 * 1. Desktop client connects via WebSocket
 * 2. Client sends a message (simulating user input)
 * 3. Server forwards local_tool_request to client
 * 4. Client executes locally and sends result back
 * 5. Server receives the result
 */

// --- Shared types (same as server.ts) ---
type ServerMessage =
  | { type: "agent_event"; event: Record<string, unknown> }
  | { type: "local_tool_request"; id: string; tool: string; params: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "status"; agent: "idle" | "busy"; localToolsAvailable: boolean };

// --- Test server: minimal WS server that simulates the local tool callback flow ---

const PORT = 18765;
const results: string[] = [];

function log(msg: string) {
  console.log(`[test] ${msg}`);
  results.push(msg);
}

// Store pending callbacks (same pattern as server.ts)
const pendingCalls = new Map<string, { resolve: (v: any) => void }>();

let clientWs: any = null;

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("test server");
  },
  websocket: {
    open(ws) {
      log("server: client connected");
      clientWs = ws;

      // Simulate: send a local_tool_request after client connects
      setTimeout(async () => {
        const requestId = crypto.randomUUID();
        log(`server: sending local_tool_request (id=${requestId.slice(0, 8)})`);

        ws.send(JSON.stringify({
          type: "local_tool_request",
          id: requestId,
          tool: "local_bash",
          params: { command: "echo hello-from-local" },
        } satisfies ServerMessage));

        // Wait for response
        const response = await new Promise<any>((resolve) => {
          pendingCalls.set(requestId, { resolve });
          setTimeout(() => {
            if (pendingCalls.has(requestId)) {
              pendingCalls.delete(requestId);
              resolve({ result: "TIMEOUT", exitCode: null });
            }
          }, 5000);
        });

        log(`server: received tool response: "${response.result.trim()}" (exit=${response.exitCode})`);

        // Verify
        if (response.result.trim() === "hello-from-local" && response.exitCode === 0) {
          log("PASS: local tool callback works correctly");
        } else {
          log(`FAIL: unexpected result`);
        }

        // Cleanup
        ws.close();
        server.stop();
      }, 100);
    },

    message(ws, raw) {
      const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));

      if (msg.type === "local_tool_response") {
        log(`server: got local_tool_response (id=${msg.id.slice(0, 8)})`);
        const pending = pendingCalls.get(msg.id);
        if (pending) {
          pending.resolve({ result: msg.result, exitCode: msg.exitCode });
          pendingCalls.delete(msg.id);
        }
      }
    },

    close() {
      log("server: client disconnected");
    },
  },
});

log(`server: listening on port ${PORT}`);

// --- Test client: same as desktop/client.ts but simplified ---

import { spawn } from "node:child_process";

const ws = new WebSocket(`ws://localhost:${PORT}`);

ws.addEventListener("open", () => {
  log("client: connected to server");
});

ws.addEventListener("message", async (event) => {
  const msg: ServerMessage = JSON.parse(
    typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
  );

  if (msg.type === "local_tool_request") {
    log(`client: received local_tool_request for: ${(msg.params as any).command}`);

    // Execute locally
    const result = await new Promise<{ result: string; exitCode: number | null }>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const child = spawn("bash", ["-c", (msg.params as any).command], {
        cwd: process.env.HOME,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => chunks.push(data));
      child.stderr.on("data", (data) => chunks.push(data));
      child.on("close", (code) => {
        resolve({ result: Buffer.concat(chunks).toString(), exitCode: code });
      });
    });

    log(`client: executed locally, result="${result.result.trim()}"`);

    // Send result back
    ws.send(JSON.stringify({
      type: "local_tool_response",
      id: msg.id,
      result: result.result,
      exitCode: result.exitCode,
    }));
  }
});

ws.addEventListener("close", () => {
  log("client: disconnected");
  console.log("\n--- Test Summary ---");
  results.forEach((r) => console.log(`  ${r}`));
  const passed = results.some((r) => r.includes("PASS"));
  console.log(passed ? "\n✅ All tests passed" : "\n❌ Tests failed");
  process.exit(passed ? 0 : 1);
});
