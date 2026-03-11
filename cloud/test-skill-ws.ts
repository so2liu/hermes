/**
 * WebSocket integration test: verifies skill registration and exec flow.
 * Does NOT require an LLM API key.
 *
 * Tests:
 * 1. Client connects and registers a skill
 * 2. Server creates the exec tool
 * 3. Server sends skill_exec_request to client (simulating agent tool call)
 * 4. Client executes locally and sends result back
 * 5. Client disconnects → skill is unregistered
 */

import { spawn } from "node:child_process";
import { SkillRegistry } from "./skill-registry";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const PORT = 18766;
const SKILLS_DIR = join(import.meta.dir, ".test-ws-skills");
const results: string[] = [];

function log(msg: string) {
  console.log(`[test] ${msg}`);
  results.push(msg);
}

// --- Setup ---

await rm(SKILLS_DIR, { recursive: true, force: true });

const registry = new SkillRegistry({
  skillsDir: SKILLS_DIR,
  sessionId: "test-ws-session",
  onSkillChange: () => {
    log(`skill change: skills=[${registry.getSkillNames().join(", ")}]`);
  },
});

// --- Test server ---

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("test server");
  },
  websocket: {
    async open(ws) {
      log("server: client connected");
    },

    async close(ws) {
      log("server: client disconnected");
      const before = registry.getSkillNames();
      await registry.unregisterByWs(ws);
      const after = registry.getSkillNames();
      const removed = before.filter((n) => !after.includes(n));
      if (removed.length > 0) {
        log(`server: unregistered skills on disconnect: ${removed.join(", ")}`);
      }
    },

    async message(ws, raw) {
      const msg = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );

      if (msg.type === "register_skill") {
        try {
          await registry.register(msg.skill.name, msg.skill.skillMd, ws);
          log(`server: registered skill "${msg.skill.name}"`);
          log(
            `server: tools=[${registry.tools.map((t) => t.name).join(", ")}]`,
          );

          // After registration, test the exec flow by invoking the tool
          const tool = registry.tools.find(
            (t) => t.name === `${msg.skill.name}_exec`,
          );
          if (tool) {
            log("server: invoking exec tool...");
            const resultPromise = tool.execute(
              "test-call",
              { command: "echo skill-test-ok" },
              undefined,
              undefined,
              {} as any,
            );

            resultPromise
              .then((result) => {
                const text = result.content[0]?.type === "text" ? result.content[0].text : "";
                log(`server: exec result: ${text.trim()}`);

                if (text.includes("skill-test-ok")) {
                  log("PASS: skill exec round-trip works");
                } else {
                  log(`FAIL: unexpected exec result`);
                }

                // Now test disconnect cleanup: close the client
                ws.close();
              })
              .catch((err) => {
                log(`FAIL: exec error: ${err.message}`);
                ws.close();
              });
          }
        } catch (err) {
          log(
            `server: registration failed: ${err instanceof Error ? err.message : err}`,
          );
          ws.close();
        }
        return;
      }

      if (msg.type === "skill_exec_response") {
        registry.handleExecResponse(msg.id, msg.result, msg.exitCode);
        return;
      }
    },
  },
});

log(`server: listening on port ${PORT}`);

// --- Test client ---

const ws = new WebSocket(`ws://localhost:${PORT}`);

ws.addEventListener("open", () => {
  log("client: connected");

  // Register a test skill
  ws.send(
    JSON.stringify({
      type: "register_skill",
      skill: {
        name: "test-local",
        skillMd: `---
name: test-local
description: "Test local execution environment."
---

# Test Local Environment

Execute commands locally via \`test-local_exec\`.
`,
      },
    }),
  );
  log("client: sent register_skill");
});

ws.addEventListener("message", async (event) => {
  const msg = JSON.parse(
    typeof event.data === "string" ? event.data : "",
  );

  if (msg.type === "skill_exec_request") {
    log(`client: received exec request: "${msg.command}"`);

    // Execute locally
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

    log(`client: executed, result="${result.result.trim()}"`);

    ws.send(
      JSON.stringify({
        type: "skill_exec_response",
        id: msg.id,
        result: result.result,
        exitCode: result.exitCode,
      }),
    );
  }
});

ws.addEventListener("close", async () => {
  log("client: disconnected");

  // Wait a tick for server close handler to complete
  await new Promise((r) => setTimeout(r, 100));

  // Verify disconnect cleanup
  if (registry.getSkillNames().length === 0 && registry.tools.length === 0) {
    log("PASS: skills cleaned up after disconnect");
  } else {
    log(
      `FAIL: skills not cleaned up: ${JSON.stringify(registry.getSkillNames())}`,
    );
  }

  // Print summary
  console.log("\n--- Test Summary ---");
  results.forEach((r) => console.log(`  ${r}`));

  const passCount = results.filter((r) => r.startsWith("PASS")).length;
  const failCount = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(
    `\n${passCount} passed, ${failCount} failed`,
  );

  // Cleanup
  await rm(SKILLS_DIR, { recursive: true, force: true });
  server.stop();
  process.exit(failCount > 0 ? 1 : 0);
});

// Timeout
setTimeout(async () => {
  log("FAIL: test timed out after 10s");
  await rm(SKILLS_DIR, { recursive: true, force: true });
  server.stop();
  process.exit(1);
}, 10000);
