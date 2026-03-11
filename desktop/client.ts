import { spawn } from "node:child_process";
import * as readline from "node:readline";

// --- WebSocket protocol types ---

type ServerMessage =
  | { type: "agent_event"; event: AgentEvent }
  | { type: "local_tool_request"; id: string; tool: string; params: { command: string; timeout?: number } }
  | { type: "error"; message: string }
  | { type: "status"; agent: "idle" | "busy"; localToolsAvailable: boolean };

type AgentEvent = {
  type: string;
  [key: string]: unknown;
};

// --- Local tool execution ---

async function executeLocalBash(
  command: string,
  timeout?: number
): Promise<{ result: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn("bash", ["-c", command], {
      cwd: process.env.HOME,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeout * 1000)
      : undefined;

    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => chunks.push(data));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = Buffer.concat(chunks).toString();
      if (timedOut) {
        resolve({ result: result + "\n[TIMED OUT]", exitCode: null });
      } else {
        resolve({ result, exitCode: code });
      }
    });
  });
}

// --- Agent event rendering ---

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "message_update": {
      const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ae?.type === "text_delta" && typeof ae.delta === "string") {
        process.stdout.write(ae.delta);
      }
      break;
    }
    case "tool_execution_start": {
      const name = (event as any).tool?.name ?? "unknown";
      const params = (event as any).params;
      console.log(`\n\x1b[36m[tool: ${name}]\x1b[0m`);
      if (params?.command) {
        console.log(`\x1b[90m$ ${params.command}\x1b[0m`);
      }
      break;
    }
    case "tool_execution_end": {
      const result = (event as any).result;
      if (result?.result) {
        const output = String(result.result);
        // Truncate long outputs
        const lines = output.split("\n");
        if (lines.length > 20) {
          console.log(lines.slice(0, 10).join("\n"));
          console.log(`\x1b[90m... (${lines.length - 20} lines omitted) ...\x1b[0m`);
          console.log(lines.slice(-10).join("\n"));
        } else {
          console.log(output);
        }
      }
      break;
    }
    case "agent_end":
      console.log(); // newline after agent response
      break;
  }
}

// --- WebSocket connection ---

const CLOUD_URL = process.env.HERMES_CLOUD_URL ?? "ws://localhost:8765";

console.log(`\x1b[1mHermes Desktop Client\x1b[0m`);
console.log(`Connecting to ${CLOUD_URL}...`);

const ws = new WebSocket(CLOUD_URL);

let agentBusy = false;

ws.addEventListener("open", () => {
  console.log("Connected to Hermes Cloud");
  console.log('Type your message and press Enter. Type "exit" to quit.\n');
  promptUser();
});

ws.addEventListener("close", () => {
  console.log("\nDisconnected from Hermes Cloud");
  process.exit(0);
});

ws.addEventListener("error", (event) => {
  console.error("WebSocket error:", event);
  process.exit(1);
});

ws.addEventListener("message", async (event) => {
  const msg: ServerMessage = JSON.parse(
    typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
  );

  switch (msg.type) {
    case "agent_event":
      renderEvent(msg.event);
      break;

    case "local_tool_request": {
      console.log(`\n\x1b[33m[local execution requested]\x1b[0m`);
      try {
        const { result, exitCode } = await executeLocalBash(
          msg.params.command,
          msg.params.timeout
        );
        ws.send(
          JSON.stringify({
            type: "local_tool_response",
            id: msg.id,
            result,
            exitCode,
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "local_tool_response",
            id: msg.id,
            result: `Error: ${err instanceof Error ? err.message : String(err)}`,
            exitCode: 1,
          })
        );
      }
      break;
    }

    case "status":
      agentBusy = msg.agent === "busy";
      if (!agentBusy) {
        promptUser();
      }
      break;

    case "error":
      console.error(`\n\x1b[31mError: ${msg.message}\x1b[0m`);
      if (!agentBusy) promptUser();
      break;
  }
});

// --- User input ---

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptUser() {
  rl.question("\x1b[32m> \x1b[0m", (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      promptUser();
      return;
    }
    if (trimmed === "exit") {
      ws.close();
      rl.close();
      return;
    }
    ws.send(JSON.stringify({ type: "message", content: trimmed }));
  });
}
