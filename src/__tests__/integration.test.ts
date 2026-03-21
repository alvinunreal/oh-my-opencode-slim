import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

type FakeClient = {
  session?: {
    create?: (input: Record<string, unknown>) => Promise<unknown>;
    prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  };
};

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "discipline-integration-"));
  tempDirs.push(root);
  return root;
}

function createToolContext(worktree: string, sessionID: string, agent = "plan") {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent,
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {}
  };
}

async function createPlugin(worktree: string, client: FakeClient = {}) {
  const hooks = await DisciplinePlugin({
    client: client as never,
    project: {} as never,
    directory: worktree,
    worktree,
    serverUrl: new URL("http://localhost"),
    $: {} as never
  });

  if (
    !hooks.tool?.advance_wave ||
    !hooks.tool.accept_plan ||
    !hooks["tool.execute.before"] ||
    !hooks["tool.execute.after"] ||
    !hooks["experimental.chat.system.transform"] ||
    !hooks.config
  ) {
    throw new Error("Plugin hooks are incomplete");
  }

  return {
    advanceWave: hooks.tool.advance_wave,
    acceptPlan: hooks.tool.accept_plan,
    beforeHook: hooks["tool.execute.before"],
    afterHook: hooks["tool.execute.after"],
    systemTransform: hooks["experimental.chat.system.transform"],
    config: hooks.config
  };
}

async function markOracleReviewed(
  afterHook: (input: any, output: any) => Promise<void>,
  sessionID: string
): Promise<void> {
  await afterHook(
    {
      tool: "task",
      sessionID,
      callID: `oracle-${sessionID}`,
      args: {
        description: "Gap review",
        prompt: "oracle check",
        subagent_type: "oracle"
      }
    },
    {
      title: "Task completed",
      output: "oracle done",
      metadata: {}
    }
  );
}

async function getErrorMessage(action: () => Promise<void>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("plugin integration", () => {
  test("runs full lifecycle with build handoff", async () => {
    let promptInput: Record<string, unknown> | undefined;
    const fakeClient: FakeClient = {
      session: {
        async create() {
          return { id: "build-session-integration" };
        },
        async prompt(input) {
          promptInput = input;
          return { ok: true };
        }
      }
    };

    const worktree = createWorktree();
    const { advanceWave, acceptPlan, beforeHook, afterHook, systemTransform } = await createPlugin(
      worktree,
      fakeClient
    );
    const sessionID = "session-full";
    const context = createToolContext(worktree, sessionID);

    const wave1 = await advanceWave.execute({ sessionID }, context);
    const match = wave1.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    const planName = match[1];
    const planRelativePath = `tasks/plans/${planName}.md`;
    const statePath = join(worktree, "tasks", ".wave-state", `${planName}.json`);

    expect(existsSync(statePath)).toBe(true);

    const wave1WriteError = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID, callID: "w1" },
        { args: { filePath: planRelativePath } }
      )
    );
    expect(wave1WriteError).toContain("Cannot write plan files until Wave 3");

    await advanceWave.execute({ sessionID }, context);
    const wave2WriteError = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID, callID: "w2" },
        { args: { filePath: planRelativePath } }
      )
    );
    expect(wave2WriteError).toContain("Cannot write plan files until Wave 3");

    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    const wave3WriteError = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID, callID: "w3" },
        { args: { filePath: planRelativePath } }
      )
    );
    expect(wave3WriteError).toBeUndefined();

    await advanceWave.execute({ sessionID }, context);
    const wave4WriteError = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID, callID: "w4" },
        { args: { filePath: planRelativePath } }
      )
    );
    expect(wave4WriteError).toBeUndefined();

    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, planRelativePath), "# Integration Plan\n", "utf8");

    const acceptResult = await acceptPlan.execute(
      {
        sessionID,
        action: "accept"
      },
      context
    );

    expect(acceptResult).toContain("Plan accepted and handed off to Build");
    expect(acceptResult).toContain("build-session-integration");
    expect(promptInput).toBeDefined();

    const promptBody = promptInput?.body as {
      agent: string;
      parts: Array<{ text: string }>;
      system: string;
    };
    expect(promptBody.agent).toBe("build");
    expect(promptBody.parts[0].text).toContain(`Read ${planRelativePath}`);
    expect(promptBody.parts[0].text).not.toContain("Wave");
    expect(promptBody.system).toContain("Use only this file as source of truth");

    const savedState = JSON.parse(readFileSync(statePath, "utf8"));
    expect(savedState.accepted).toBe(true);
    expect(savedState.acceptedAt).toBeDefined();
    expect(savedState.acceptedBySessionID).toBe("build-session-integration");

    const readOnlyError = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID, callID: "readonly" },
        { args: { filePath: "src/new-file.ts" } }
      )
    );
    expect(readOnlyError).toContain("Plan session is read-only after accept_plan");

    const systemOutput = { system: [] as string[] };
    await systemTransform(
      {
        sessionID,
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      systemOutput
    );
    expect(systemOutput.system.join("\n")).toContain(planName);
  });

  test("config hook injects agents from .md files", async () => {
    const worktree = createWorktree();
    const { config } = await createPlugin(worktree);

    const input = {} as Record<string, unknown>;
    await config(input);

    const agents = input.agent as Record<string, Record<string, unknown>>;
    expect(agents).toBeDefined();
    expect(agents.plan).toBeDefined();
    expect(agents.plan.model).toBe("anthropic/claude-opus-4-6");
    expect(agents.plan.mode).toBe("primary");
    expect(typeof agents.plan.prompt).toBe("string");

    expect(agents.build).toBeDefined();
    expect(agents.build.model).toBe("anthropic/claude-opus-4-6");

    expect(agents.oracle).toBeDefined();
    expect(agents.oracle.mode).toBe("subagent");

    expect(agents.explore).toBeDefined();
    expect(agents.explore.mode).toBe("subagent");
  });

  test("config hook preserves user overrides per field", async () => {
    const worktree = createWorktree();
    const { config } = await createPlugin(worktree);

    const input = {
      agent: {
        plan: { model: "custom/user-model", temperature: 0.5 },
        custom_agent: { model: "custom/agent", description: "User-defined agent" }
      }
    } as Record<string, unknown>;

    await config(input);

    const agents = input.agent as Record<string, Record<string, unknown>>;

    // User override wins per field
    expect(agents.plan.model).toBe("custom/user-model");
    expect(agents.plan.temperature).toBe(0.5);
    // Plugin fields are still present for non-overridden fields
    expect(agents.plan.mode).toBe("primary");
    expect(typeof agents.plan.prompt).toBe("string");

    // User-defined agents outside the plugin are preserved
    expect(agents.custom_agent).toBeDefined();
    expect(agents.custom_agent.model).toBe("custom/agent");
  });

  test("returns deterministic fallback instructions when session switching is unavailable", async () => {
    const worktree = createWorktree();
    const { advanceWave, acceptPlan, afterHook } = await createPlugin(worktree, {});
    const sessionID = "session-fallback";
    const context = createToolContext(worktree, sessionID);

    const wave1 = await advanceWave.execute({ sessionID }, context);
    const match = wave1.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    const planName = match[1];
    const planPath = join(worktree, "tasks", "plans", `${planName}.md`);
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(planPath, "# Fallback plan\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    const result = await acceptPlan.execute(
      {
        sessionID,
        action: "accept"
      },
      context
    );

    expect(result).toContain("Direct session handoff is unavailable");
    expect(result).toContain("switch to the Build agent");
    expect(result).toContain(`tasks/plans/${planName}.md`);
  });
});
