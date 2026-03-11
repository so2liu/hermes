import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const SKILL_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation: boolean;
}

export interface SkillRegistryOptions {
  skillsDir: string;
  sessionId: string;
  staticTools?: ToolDefinition[];
  onSkillChange?: () => void;
}

interface PendingCall {
  skillName: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: { result: string; exitCode: number | null }) => void;
  reject: (reason: Error) => void;
}

export class SkillRegistry {
  /** Mutable array — pass by reference to PiCodeAgent's customTools */
  readonly tools: ToolDefinition[];
  /** Mutable array — returned by resourceLoader.getSkills() */
  readonly skills: SkillInfo[] = [];

  private readonly skillsDir: string;
  private readonly sessionId: string;
  private readonly onSkillChange: (() => void) | undefined;
  private readonly wsBySkill = new Map<string, { send: (data: string) => void }>();
  private readonly skillsByWs = new Map<object, Set<string>>();
  private readonly pendingCalls = new Map<string, PendingCall>();

  constructor(options: SkillRegistryOptions) {
    this.skillsDir = options.skillsDir;
    this.sessionId = options.sessionId;
    this.tools = [...(options.staticTools ?? [])];
    this.onSkillChange = options.onSkillChange;
  }

  async register(
    skillName: string,
    skillMd: string,
    ws: { send: (data: string) => void },
  ): Promise<void> {
    if (!SKILL_NAME_RE.test(skillName)) {
      throw new Error(
        `Invalid skill name "${skillName}": must match /^[a-z][a-z0-9-]*$/`,
      );
    }
    if (this.wsBySkill.has(skillName)) {
      throw new Error(`Skill "${skillName}" is already registered`);
    }

    const metadata = parseSkillFrontmatter(skillMd);

    // Validate frontmatter name matches registered name
    if (metadata.name !== skillName) {
      throw new Error(
        `Skill name mismatch: registered as "${skillName}" but SKILL.md declares "${metadata.name}"`,
      );
    }

    // Write SKILL.md so the agent can read it with built-in Read tool
    const skillDir = join(this.skillsDir, skillName);
    await mkdir(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    await writeFile(filePath, skillMd);

    // Create the exec tool for this skill
    this.tools.push(this.createExecTool(skillName));

    // Register skill metadata (used by resourceLoader.getSkills())
    this.skills.push({
      name: skillName,
      description: metadata.description,
      filePath,
      baseDir: skillDir,
      source: "dynamic",
      disableModelInvocation: false,
    });

    // Track ws ↔ skill mappings
    this.wsBySkill.set(skillName, ws);
    if (!this.skillsByWs.has(ws)) {
      this.skillsByWs.set(ws, new Set());
    }
    this.skillsByWs.get(ws)!.add(skillName);

    this.onSkillChange?.();
  }

  async unregister(skillName: string): Promise<void> {
    // Remove exec tool
    const toolIdx = this.tools.findIndex(
      (t) => t.name === `${skillName}_exec`,
    );
    if (toolIdx !== -1) this.tools.splice(toolIdx, 1);

    // Remove skill info
    const skillIdx = this.skills.findIndex((s) => s.name === skillName);
    if (skillIdx !== -1) this.skills.splice(skillIdx, 1);

    // Reject pending calls for this skill
    for (const [id, call] of this.pendingCalls) {
      if (call.skillName === skillName) {
        clearTimeout(call.timer);
        call.reject(new Error(`${skillName} environment disconnected`));
        this.pendingCalls.delete(id);
      }
    }

    // Clean ws ↔ skill mappings
    const ws = this.wsBySkill.get(skillName);
    if (ws) {
      const names = this.skillsByWs.get(ws);
      names?.delete(skillName);
      if (names?.size === 0) this.skillsByWs.delete(ws);
    }
    this.wsBySkill.delete(skillName);

    // Delete SKILL.md from filesystem
    try {
      await rm(join(this.skillsDir, skillName), { recursive: true });
    } catch {
      // Ignore if already deleted
    }

    this.onSkillChange?.();
  }

  async unregisterByWs(ws: object): Promise<void> {
    const names = this.skillsByWs.get(ws);
    if (!names || names.size === 0) return;
    // Temporarily suppress per-skill onSkillChange, fire once at the end
    const savedCallback = this.onSkillChange;
    (this as any).onSkillChange = undefined;
    for (const name of [...names]) {
      await this.unregister(name);
    }
    (this as any).onSkillChange = savedCallback;
    savedCallback?.();
  }

  handleExecResponse(
    id: string,
    result: string,
    exitCode: number | null,
  ): boolean {
    const call = this.pendingCalls.get(id);
    if (!call) return false;
    clearTimeout(call.timer);
    call.resolve({ result, exitCode });
    this.pendingCalls.delete(id);
    return true;
  }

  getSkillNames(): string[] {
    return this.skills.map((s) => s.name);
  }

  isRegistered(name: string): boolean {
    return this.wsBySkill.has(name);
  }

  private createExecTool(skillName: string): ToolDefinition {
    const registry = this;
    return {
      name: `${skillName}_exec`,
      label: `${skillName} exec`,
      description: `Execute a command in the ${skillName} environment. Read .hermes/skills/${skillName}/SKILL.md for usage instructions.`,
      parameters: Type.Object({
        command: Type.String({ description: "Command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in seconds" }),
        ),
      }),
      async execute(toolCallId, params, signal) {
        const { command, timeout: userTimeout } = params as {
          command: string;
          timeout?: number;
        };
        const ws = registry.wsBySkill.get(skillName);
        if (!ws) {
          return {
            result: `Error: ${skillName} environment is not connected.`,
            details: {},
          };
        }

        const id = crypto.randomUUID();
        const timeoutSec = userTimeout ?? 120;

        const response = await new Promise<{
          result: string;
          exitCode: number | null;
        }>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (registry.pendingCalls.has(id)) {
              registry.pendingCalls.delete(id);
              reject(
                new Error(
                  `${skillName} execution timed out after ${timeoutSec}s`,
                ),
              );
            }
          }, timeoutSec * 1000);

          // Register pending call BEFORE sending to avoid lost-response race
          registry.pendingCalls.set(id, { skillName, timer, resolve, reject });

          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            registry.pendingCalls.delete(id);
            reject(new Error("Aborted"));
          });

          try {
            ws.send(
              JSON.stringify({
                type: "skill_exec_request",
                id,
                sessionId: registry.sessionId,
                skillName,
                command,
                timeout: timeoutSec,
              }),
            );
          } catch {
            clearTimeout(timer);
            registry.pendingCalls.delete(id);
            reject(
              new Error(`Failed to send to ${skillName} environment.`),
            );
          }
        });

        return {
          result: `Exit code: ${response.exitCode}\n${response.result}`,
          details: {},
        };
      },
    };
  }
}

export function parseSkillFrontmatter(content: string): {
  name: string;
  description: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) throw new Error("SKILL.md missing frontmatter");
  const fm = match[1]!;
  const name = fm
    .match(/^name:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  const description = fm
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!name) throw new Error("SKILL.md missing name field");
  if (!description) throw new Error("SKILL.md missing description field");
  return { name, description };
}
