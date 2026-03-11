import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  createBashTool,
  createExtensionRuntime,
  type ResourceLoader,
  type ToolDefinition,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// --- WebSocket protocol types ---

type ClientMessage =
  | { type: "message"; content: string }
  | { type: "local_tool_response"; id: string; result: string; exitCode: number | null };

type ServerMessage =
  | { type: "agent_event"; event: Record<string, unknown> }
  | {
      type: "local_tool_request";
      id: string;
      tool: string;
      params: Record<string, unknown>;
    }
  | { type: "error"; message: string }
  | { type: "status"; agent: "idle" | "busy"; localToolsAvailable: boolean };

// --- Local tool callback management ---

const pendingLocalCalls = new Map<
  string,
  {
    resolve: (value: { result: string; exitCode: number | null }) => void;
    reject: (reason: Error) => void;
  }
>();

let desktopWs: any = null;
let desktopConnected = false;

function sendToDesktop(msg: ServerMessage): boolean {
  if (!desktopConnected || !desktopWs) return false;
  desktopWs.send(JSON.stringify(msg));
  return true;
}

// --- Tool definitions ---

const CWD = process.cwd();

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

const baseBashTool = createBashTool(CWD);

const cloudBashDef: ToolDefinition = {
  name: "cloud_bash",
  label: "Cloud Bash",
  description:
    "Execute a shell command in the CLOUD sandbox environment. Use this when you need to: " +
    "run untrusted or generated code safely, " +
    "install packages or dependencies, " +
    "execute long-running computations, " +
    "or perform operations that don't require the user's local files.",
  parameters: bashSchema,
  execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
    return baseBashTool.execute(toolCallId, params, signal, onUpdate);
  },
};

const localBashDef: ToolDefinition = {
  name: "local_bash",
  label: "Local Bash",
  description:
    "Execute a shell command on the user's LOCAL machine. Use this when you need to: " +
    "access user's local files (~/Desktop, ~/Documents, etc.), " +
    "use user's installed applications, " +
    "interact with user's browser login state, " +
    "or perform operations that require the user's local environment.",
  parameters: bashSchema,
  execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
    const id = crypto.randomUUID();
    const { command, timeout: userTimeout } = params as { command: string; timeout?: number };

    const sent = sendToDesktop({
      type: "local_tool_request",
      id,
      tool: "local_bash",
      params: { command, timeout: userTimeout },
    });

    if (!sent) {
      return {
        result: "Error: Desktop client is not connected. Cannot execute local commands. Use cloud_bash instead.",
        details: {},
      };
    }

    const response = await new Promise<{ result: string; exitCode: number | null }>(
      (resolve, reject) => {
        pendingLocalCalls.set(id, { resolve, reject });

        const timeout = userTimeout ?? 120;
        setTimeout(() => {
          if (pendingLocalCalls.has(id)) {
            pendingLocalCalls.delete(id);
            reject(new Error(`Local tool execution timed out after ${timeout}s`));
          }
        }, timeout * 1000);

        signal?.addEventListener("abort", () => {
          pendingLocalCalls.delete(id);
          reject(new Error("Aborted"));
        });
      }
    );

    return {
      result: `Exit code: ${response.exitCode}\n${response.result}`,
      details: {},
    };
  },
};

// --- Agent session setup ---

async function createHermesAgent() {
  const authStorage = AuthStorage.create("/tmp/hermes-agent/auth.json");

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  let model: Model<any>;

  if (openrouterKey) {
    authStorage.setRuntimeApiKey("openrouter", openrouterKey);
    model = {
      id: "anthropic/claude-haiku-4.5",
      name: "Claude Haiku 4.5 (OpenRouter)",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
  } else if (anthropicKey) {
    authStorage.setRuntimeApiKey("anthropic", anthropicKey);
    const found = getModel("anthropic", "claude-sonnet-4-20250514");
    if (!found) throw new Error("Model not found in registry");
    model = found;
  } else {
    throw new Error("Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY env var.");
  }

  const modelRegistry = new ModelRegistry(authStorage);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      `You are Hermes, an AI assistant that can execute tasks both locally on the user's machine and in a cloud sandbox.

You have two bash tools available:
- cloud_bash: Runs in a cloud sandbox. Use for code execution, package installation, or untrusted operations.
- local_bash: Runs on the user's local machine. Use for accessing local files, using local apps, or anything needing the user's environment.

Choose the right tool based on the task. If local_bash returns an error saying the desktop client is not connected, switch to cloud_bash.

Current cloud working directory: ${CWD}`,
    getAppendSystemPrompt: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  };

  // customTools registers tools as proper function-calling tools for the LLM.
  // tools: [] disables built-in tools (read, bash, edit, write).
  const { session } = await createAgentSession({
    cwd: CWD,
    agentDir: "/tmp/hermes-agent",
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [],
    customTools: [cloudBashDef, localBashDef],
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return { session };
}

// --- WebSocket server ---

const PORT = parseInt(process.env.PORT ?? "8765");

const { session } = await createHermesAgent();
let agentBusy = false;

console.log(`Hermes Cloud server starting on port ${PORT}...`);

Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Hermes Cloud Server", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("Desktop client connected");
      desktopWs = ws;
      desktopConnected = true;

      sendToDesktop({
        type: "status",
        agent: agentBusy ? "busy" : "idle",
        localToolsAvailable: true,
      });
    },

    close(ws) {
      if (ws !== desktopWs) return; // Ignore stale socket close
      console.log("Desktop client disconnected");
      desktopConnected = false;
      desktopWs = null;

      for (const [id, { reject }] of pendingLocalCalls) {
        reject(new Error("Desktop client disconnected"));
        pendingLocalCalls.delete(id);
      }
    },

    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        );
      } catch {
        console.error("[server] Invalid JSON from client");
        return;
      }

      if (msg.type === "local_tool_response") {
        const pending = pendingLocalCalls.get(msg.id);
        if (pending) {
          pending.resolve({ result: msg.result, exitCode: msg.exitCode });
          pendingLocalCalls.delete(msg.id);
        }
        return;
      }

      if (msg.type === "message") {
        if (agentBusy) {
          sendToDesktop({
            type: "error",
            message: "Agent is busy processing a previous message. Please wait.",
          });
          return;
        }

        agentBusy = true;
        sendToDesktop({ type: "status", agent: "busy", localToolsAvailable: desktopConnected });

        const unsubscribe = session.subscribe((event) => {
          sendToDesktop({
            type: "agent_event",
            event: event as unknown as Record<string, unknown>,
          });
        });

        try {
          console.log(`[server] Prompting agent with: "${msg.content.slice(0, 100)}"`);
          await session.prompt(msg.content);
          console.log("[server] Agent prompt completed");
        } catch (err) {
          console.error("[server] Agent error:", err);
          sendToDesktop({
            type: "error",
            message: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
          });
        } finally {
          unsubscribe();
          agentBusy = false;
          sendToDesktop({ type: "status", agent: "idle", localToolsAvailable: desktopConnected });
        }
      }
    },
  },
});

console.log(`Hermes Cloud server running on ws://localhost:${PORT}`);
