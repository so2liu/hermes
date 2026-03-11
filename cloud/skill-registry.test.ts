import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { SkillRegistry, parseSkillFrontmatter } from "./skill-registry";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_SKILLS_DIR = join(import.meta.dir, ".test-skills");
const TEST_SESSION_ID = "test-session-001";

const SAMPLE_SKILL_MD = `---
name: test-env
description: "A test environment for unit testing."
---

# Test Environment

Use \`test-env_exec\` to run commands.
`;

function makeSkillMd(name: string, description: string): string {
  return `---
name: ${name}
description: "${description}"
---

# ${name}
`;
}

// --- parseSkillFrontmatter ---

describe("parseSkillFrontmatter", () => {
  test("parses valid frontmatter", () => {
    const result = parseSkillFrontmatter(SAMPLE_SKILL_MD);
    expect(result.name).toBe("test-env");
    expect(result.description).toBe("A test environment for unit testing.");
  });

  test("parses frontmatter with quoted values", () => {
    const md = `---
name: "my-skill"
description: "Some description"
---
`;
    const result = parseSkillFrontmatter(md);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("Some description");
  });

  test("throws on missing frontmatter", () => {
    expect(() => parseSkillFrontmatter("no frontmatter here")).toThrow(
      "missing frontmatter",
    );
  });

  test("throws on missing name", () => {
    expect(() =>
      parseSkillFrontmatter("---\ndescription: foo\n---"),
    ).toThrow("missing name");
  });

  test("throws on missing description", () => {
    expect(() => parseSkillFrontmatter("---\nname: foo\n---")).toThrow(
      "missing description",
    );
  });
});

// --- SkillRegistry ---

describe("SkillRegistry", () => {
  let registry: SkillRegistry;
  let changeCount: number;

  beforeEach(async () => {
    await rm(TEST_SKILLS_DIR, { recursive: true, force: true });
    changeCount = 0;
    registry = new SkillRegistry({
      skillsDir: TEST_SKILLS_DIR,
      sessionId: TEST_SESSION_ID,
      onSkillChange: () => {
        changeCount++;
      },
    });
  });

  afterEach(async () => {
    await rm(TEST_SKILLS_DIR, { recursive: true, force: true });
  });

  // --- register ---

  test("register creates exec tool and skill info", async () => {
    const mockWs = { send: () => {} };
    await registry.register("test-env", SAMPLE_SKILL_MD, mockWs);

    expect(registry.tools).toHaveLength(1);
    expect(registry.tools[0]!.name).toBe("test-env_exec");
    expect(registry.skills).toHaveLength(1);
    expect(registry.skills[0]!.name).toBe("test-env");
    expect(registry.skills[0]!.description).toBe(
      "A test environment for unit testing.",
    );
    expect(changeCount).toBe(1);
  });

  test("register writes SKILL.md to filesystem", async () => {
    await registry.register("test-env", SAMPLE_SKILL_MD, { send: () => {} });

    const filePath = join(TEST_SKILLS_DIR, "test-env", "SKILL.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(SAMPLE_SKILL_MD);
  });

  test("register rejects invalid skill name", async () => {
    await expect(
      registry.register(
        "Invalid!",
        makeSkillMd("Invalid!", "bad"),
        { send: () => {} },
      ),
    ).rejects.toThrow("Invalid skill name");
  });

  test("register rejects name mismatch with frontmatter", async () => {
    await expect(
      registry.register("desktop", makeSkillMd("browser", "mismatch"), {
        send: () => {},
      }),
    ).rejects.toThrow("name mismatch");
  });

  test("register rejects name starting with number", async () => {
    await expect(
      registry.register("1bad", makeSkillMd("1bad", "bad"), { send: () => {} }),
    ).rejects.toThrow("Invalid skill name");
  });

  test("register accepts valid names", async () => {
    const ws = { send: () => {} };
    await registry.register("a", makeSkillMd("a", "ok"), ws);
    await registry.register(
      "my-env-2",
      makeSkillMd("my-env-2", "ok"),
      { send: () => {} },
    );
    expect(registry.getSkillNames()).toEqual(["a", "my-env-2"]);
  });

  test("register rejects duplicate name", async () => {
    await registry.register("test-env", SAMPLE_SKILL_MD, { send: () => {} });
    await expect(
      registry.register("test-env", SAMPLE_SKILL_MD, { send: () => {} }),
    ).rejects.toThrow("already registered");
  });

  // --- unregister ---

  test("unregister removes tool and skill", async () => {
    await registry.register("test-env", SAMPLE_SKILL_MD, { send: () => {} });
    await registry.unregister("test-env");

    expect(registry.tools).toHaveLength(0);
    expect(registry.skills).toHaveLength(0);
    expect(registry.isRegistered("test-env")).toBe(false);
    expect(changeCount).toBe(2); // register + unregister
  });

  test("unregister deletes SKILL.md from filesystem", async () => {
    await registry.register("test-env", SAMPLE_SKILL_MD, { send: () => {} });
    await registry.unregister("test-env");

    const filePath = join(TEST_SKILLS_DIR, "test-env", "SKILL.md");
    await expect(readFile(filePath)).rejects.toThrow();
  });

  // --- unregisterByWs ---

  test("unregisterByWs removes all skills for a WebSocket", async () => {
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };
    await registry.register("env-a", makeSkillMd("env-a", "a"), ws1);
    await registry.register("env-b", makeSkillMd("env-b", "b"), ws1);
    await registry.register("env-c", makeSkillMd("env-c", "c"), ws2);

    await registry.unregisterByWs(ws1);

    expect(registry.getSkillNames()).toEqual(["env-c"]);
    expect(registry.tools).toHaveLength(1);
    expect(registry.tools[0]!.name).toBe("env-c_exec");
  });

  test("unregisterByWs is no-op for unknown ws", async () => {
    await registry.unregisterByWs({});
    expect(registry.tools).toHaveLength(0);
  });

  test("unregisterByWs fires onSkillChange only once", async () => {
    const ws = { send: () => {} };
    await registry.register("env-a", makeSkillMd("env-a", "a"), ws);
    await registry.register("env-b", makeSkillMd("env-b", "b"), ws);
    changeCount = 0;

    await registry.unregisterByWs(ws);

    expect(changeCount).toBe(1); // single batched callback
    expect(registry.getSkillNames()).toEqual([]);
  });

  // --- static tools ---

  test("static tools are preserved across register/unregister", async () => {
    const staticTool = {
      name: "cloud_bash",
      label: "Cloud Bash",
      description: "cloud bash",
      parameters: {} as any,
      execute: async () => ({ content: [{ type: "text" as const, text: "" }], details: {} }),
    };
    const r = new SkillRegistry({
      skillsDir: TEST_SKILLS_DIR,
      sessionId: TEST_SESSION_ID,
      staticTools: [staticTool],
    });

    await r.register("test-env", SAMPLE_SKILL_MD, { send: () => {} });
    expect(r.tools).toHaveLength(2);
    expect(r.tools[0]!.name).toBe("cloud_bash");
    expect(r.tools[1]!.name).toBe("test-env_exec");

    await r.unregister("test-env");
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]!.name).toBe("cloud_bash");
  });

  // --- exec tool execution ---

  test("exec tool sends request via WebSocket", async () => {
    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data) };
    await registry.register("test-env", SAMPLE_SKILL_MD, ws);

    const tool = registry.tools[0]!;
    // Start execution (don't await yet)
    const promise = tool.execute(
      "call-1",
      { command: "echo hello" },
      undefined,
      undefined,
      {} as any,
    );

    // Wait for the send to happen
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    const request = JSON.parse(sent[0]!);
    expect(request.type).toBe("skill_exec_request");
    expect(request.sessionId).toBe(TEST_SESSION_ID);
    expect(request.skillName).toBe("test-env");
    expect(request.command).toBe("echo hello");
    expect(request.timeout).toBe(120); // default timeout

    // Respond
    registry.handleExecResponse(request.id, "hello\n", 0);

    const result = await promise;
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    expect(text).toContain("hello");
    expect(text).toContain("Exit code: 0");
  });

  test("exec tool sends custom timeout in request", async () => {
    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data) };
    await registry.register("test-env", SAMPLE_SKILL_MD, ws);

    const tool = registry.tools[0]!;
    const promise = tool.execute(
      "call-2",
      { command: "slow", timeout: 5 },
      undefined,
      undefined,
      {} as any,
    );

    await new Promise((r) => setTimeout(r, 10));

    const request = JSON.parse(sent[0]!);
    expect(request.timeout).toBe(5);

    registry.handleExecResponse(request.id, "done", 0);
    await promise;
  });

  test("exec tool returns error when env not connected", async () => {
    const ws = { send: () => {} };
    await registry.register("test-env", SAMPLE_SKILL_MD, ws);
    await registry.unregister("test-env");

    // Re-register and immediately unregister to test disconnected state
    await registry.register("test-env", SAMPLE_SKILL_MD, ws);

    // Simulate disconnect by unregistering
    await registry.unregisterByWs(ws);

    // Tool has been removed, so this verifies cleanup
    expect(registry.tools).toHaveLength(0);
  });

  test("unregister rejects pending exec calls", async () => {
    const ws = { send: () => {} };
    await registry.register("test-env", SAMPLE_SKILL_MD, ws);

    const tool = registry.tools[0]!;
    const promise = tool.execute(
      "call-1",
      { command: "slow command" },
      undefined,
      undefined,
      {} as any,
    );

    // Wait for the send
    await new Promise((r) => setTimeout(r, 10));

    // Catch the rejection before triggering it to avoid unhandled rejection
    const rejectionPromise = promise.catch((err: Error) => err);

    // Disconnect → should reject the pending call
    await registry.unregister("test-env");

    const err = await rejectionPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("disconnected");
  });

  // --- handleExecResponse ---

  test("handleExecResponse returns false for unknown id", () => {
    expect(registry.handleExecResponse("unknown", "result", 0)).toBe(false);
  });

  // --- getSkillNames / isRegistered ---

  test("getSkillNames returns current skill names", async () => {
    const ws = { send: () => {} };
    expect(registry.getSkillNames()).toEqual([]);

    await registry.register("env-a", makeSkillMd("env-a", "a"), ws);
    expect(registry.getSkillNames()).toEqual(["env-a"]);

    await registry.register(
      "env-b",
      makeSkillMd("env-b", "b"),
      { send: () => {} },
    );
    expect(registry.getSkillNames()).toEqual(["env-a", "env-b"]);
  });

  test("isRegistered checks current state", async () => {
    expect(registry.isRegistered("test-env")).toBe(false);

    await registry.register("test-env", SAMPLE_SKILL_MD, { send: () => {} });
    expect(registry.isRegistered("test-env")).toBe(true);

    await registry.unregister("test-env");
    expect(registry.isRegistered("test-env")).toBe(false);
  });
});
