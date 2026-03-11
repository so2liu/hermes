import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  createBashTool,
  createReadTool,
  createExtensionRuntime,
  type ResourceLoader,
  type ToolDefinition,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { SkillRegistry } from "./skill-registry";

// --- WebSocket protocol types ---

type ClientMessage =
  | { type: "message"; content: string }
  | { type: "register_skill"; skill: { name: string; skillMd: string } }
  | {
      type: "skill_exec_response";
      id: string;
      result: string;
      exitCode: number | null;
    };

type ServerMessage =
  | { type: "agent_event"; event: Record<string, unknown> }
  | {
      type: "skill_exec_request";
      id: string;
      sessionId: string;
      skillName: string;
      command: string;
      timeout: number;
    }
  | { type: "error"; message: string }
  | { type: "status"; agent: "idle" | "busy"; skills: string[] };

// --- Static tools ---

const CWD = process.cwd();
const baseBashTool = createBashTool(CWD);
const readTool = createReadTool(CWD);

const cloudBashDef: ToolDefinition = {
  name: "cloud_bash",
  label: "Cloud Bash",
  description:
    "Execute a shell command in the CLOUD sandbox environment. Use for code execution, package installation, or untrusted operations.",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(
      Type.Number({ description: "Timeout in seconds" }),
    ),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    return baseBashTool.execute(toolCallId, params as any, signal, onUpdate);
  },
};

// --- Skill Registry + reload scheduling ---

const SKILLS_DIR = join(CWD, ".hermes", "skills");
let reloadPending = false;
let reloadInFlight = false;
let agentBusy = false;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"];

async function doReload() {
  if (reloadInFlight) {
    reloadPending = true;
    return;
  }
  reloadInFlight = true;
  try {
    await session.reload();
  } finally {
    reloadInFlight = false;
    if (reloadPending) {
      reloadPending = false;
      doReload();
    }
  }
}

// TODO: MVP 硬编码单 session，多用户时需为每个用户创建独立 sessionId
const SESSION_ID = crypto.randomUUID();

const registry = new SkillRegistry({
  skillsDir: SKILLS_DIR,
  sessionId: SESSION_ID,
  staticTools: [cloudBashDef],
  onSkillChange: () => {
    if (!agentBusy && session) {
      doReload();
    } else {
      reloadPending = true;
    }
  },
});

// --- Client tracking (broadcast to all connected clients) ---

const clients = new Set<{ send: (data: string) => void }>();

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    ws.send(data);
  }
}

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
    getSkills: () => ({ skills: registry.skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => {
      const skillList = registry.skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join("\n");
      const skillSection = skillList
        ? `\n\nAvailable Skills:\n${skillList}\n\nTo use a skill, first read its SKILL.md file at .hermes/skills/{name}/SKILL.md to learn the available commands, then use the corresponding {name}_exec tool.`
        : "";
      return `You are Hermes, an AI assistant that can execute tasks in a cloud sandbox and dynamically registered environments.

You have the following tools:
- cloud_bash: Runs in a cloud sandbox. Use for code execution, package installation, or untrusted operations.
${skillSection}

Current cloud working directory: ${CWD}`;
    },
    getAppendSystemPrompt: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  };

  const result = await createAgentSession({
    cwd: CWD,
    agentDir: "/tmp/hermes-agent",
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [readTool],
    customTools: registry.tools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return result.session;
}

// --- Auth ---

const AUTH_TOKEN = process.env.HERMES_AUTH_TOKEN?.trim() || undefined;
if (!AUTH_TOKEN) {
  console.warn(
    "⚠ HERMES_AUTH_TOKEN not set — server is open to anyone who can reach it!",
  );
}

// --- WebSocket server ---

const PORT = parseInt(process.env.PORT ?? "8765");

session = await createHermesAgent();

console.log(`Hermes Cloud server starting on port ${PORT}...`);

Bun.serve({
  port: PORT,
  fetch(req, server) {
    // Only authenticate WebSocket upgrade requests; allow health checks through
    const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isUpgrade) {
      if (AUTH_TOKEN) {
        const url = new URL(req.url);
        const provided = url.searchParams.get("token") ?? "";
        const a = Buffer.from(provided);
        const b = Buffer.from(AUTH_TOKEN);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      if (server.upgrade(req)) return;
    }
    return new Response("Hermes Cloud Server", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("Client connected");
      clients.add(ws);
      ws.send(
        JSON.stringify({
          type: "status",
          agent: agentBusy ? "busy" : "idle",
          skills: registry.getSkillNames(),
        } satisfies ServerMessage),
      );
    },

    async close(ws) {
      console.log("Client disconnected");
      clients.delete(ws);
      const hadSkills = registry.getSkillNames().length > 0;
      await registry.unregisterByWs(ws);
      if (hadSkills) {
        broadcast({
          type: "status",
          agent: agentBusy ? "busy" : "idle",
          skills: registry.getSkillNames(),
        });
      }
    },

    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw),
        );
      } catch {
        console.error("[server] Invalid JSON from client");
        return;
      }

      if (msg.type === "register_skill") {
        try {
          await registry.register(msg.skill.name, msg.skill.skillMd, ws);
          console.log(`Skill registered: ${msg.skill.name}`);
          broadcast({
            type: "status",
            agent: agentBusy ? "busy" : "idle",
            skills: registry.getSkillNames(),
          });
        } catch (err) {
          console.error(`Skill registration failed: ${err}`);
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Skill registration failed: ${err instanceof Error ? err.message : String(err)}`,
            } satisfies ServerMessage),
          );
        }
        return;
      }

      if (msg.type === "skill_exec_response") {
        registry.handleExecResponse(msg.id, msg.result, msg.exitCode);
        return;
      }

      if (msg.type === "message") {
        if (agentBusy) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Agent is busy processing a previous message. Please wait.",
            } satisfies ServerMessage),
          );
          return;
        }

        agentBusy = true;
        broadcast({
          type: "status",
          agent: "busy",
          skills: registry.getSkillNames(),
        });

        const unsubscribe = session.subscribe((event) => {
          broadcast({
            type: "agent_event",
            event: event as unknown as Record<string, unknown>,
          });
        });

        try {
          console.log(
            `[server] Prompting agent with: "${msg.content.slice(0, 100)}"`,
          );
          await session.prompt(msg.content);
          console.log("[server] Agent prompt completed");
        } catch (err) {
          console.error("[server] Agent error:", err);
          broadcast({
            type: "error",
            message: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
          });
        } finally {
          unsubscribe();
          agentBusy = false;

          if (reloadPending) {
            reloadPending = false;
            await doReload();
          }

          broadcast({
            type: "status",
            agent: "idle",
            skills: registry.getSkillNames(),
          });
        }
      }
    },
  },
});

console.log(`Hermes Cloud server running on ws://localhost:${PORT}`);
