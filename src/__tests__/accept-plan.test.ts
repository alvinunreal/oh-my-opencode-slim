import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "accept-plan-"));
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

async function createTools(worktree: string, client: FakeClient = {}) {
  const hooks = await DisciplinePlugin({
    client: client as never,
    project: {} as never,
    directory: worktree,
    worktree,
    serverUrl: new URL("http://localhost"),
    $: {} as never
  });

  if (!hooks.tool?.advance_wave || !hooks.tool.accept_plan || !hooks["tool.execute.after"]) {
    throw new Error("Expected tools were not registered");
  }

  return {
    advanceWave: hooks.tool.advance_wave,
    acceptPlan: hooks.tool.accept_plan,
    afterHook: hooks["tool.execute.after"]
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("accept_plan tool", () => {
  test("revise keeps plan session active and returns revise directive", async () => {
    const worktree = createWorktree();
    const { advanceWave, acceptPlan } = await createTools(worktree);
    const context = createToolContext(worktree, "session-revise");

    await advanceWave.execute({ sessionID: "session-revise" }, context);
    const reviseResult = await acceptPlan.execute(
      { sessionID: "session-revise", action: "revise" },
      context
    );
    const wave2Result = await advanceWave.execute({ sessionID: "session-revise" }, context);

    expect(reviseResult).toContain("Plan revision requested");
    expect(reviseResult).toContain("call advance_wave until Wave 4");
    expect(wave2Result).toContain("Wave 2 (Gap Analysis)");
  });

  test("accept creates build handoff payload with plan path", async () => {
    const worktree = createWorktree();

    let promptInput: Record<string, unknown> | undefined;
    const fakeClient: FakeClient = {
      session: {
        async create() {
          return { id: "build-session-1" };
        },
        async prompt(input) {
          promptInput = input;
          return { ok: true };
        }
      }
    };

    const { advanceWave, acceptPlan, afterHook } = await createTools(worktree, fakeClient);
    const context = createToolContext(worktree, "session-accept");
    const startResult = await advanceWave.execute({ sessionID: "session-accept" }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    const planName = match[1];
    const relativePath = `tasks/plans/${planName}.md`;
    const absolutePath = join(worktree, relativePath);
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(absolutePath, "# Test plan\n", "utf8");

    await advanceWave.execute({ sessionID: "session-accept" }, context);
    await markOracleReviewed(afterHook, "session-accept");
    await advanceWave.execute({ sessionID: "session-accept" }, context);
    await advanceWave.execute({ sessionID: "session-accept" }, context);

    const acceptResult = await acceptPlan.execute(
      {
        sessionID: "session-accept",
        action: "accept"
      },
      context
    );

    expect(acceptResult).toContain("Plan accepted and handed off to Build");
    expect(acceptResult).toContain("build-session-1");
    expect(promptInput).toBeDefined();
    expect((promptInput?.path as { id: string }).id).toBe("build-session-1");

    const body = promptInput?.body as {
      parts: Array<{ type: string; text: string }>;
      system: string;
      agent: string;
    };

    expect(body.agent).toBe("build");
    expect(body.system).toContain("Use only this file as source of truth");
    expect(body.parts[0].text).toContain(`Read ${relativePath}`);
  });

  test("accept fails when plan file is missing", async () => {
    const worktree = createWorktree();
    const { advanceWave, acceptPlan, afterHook } = await createTools(worktree);
    const context = createToolContext(worktree, "session-missing");

    const startResult = await advanceWave.execute({ sessionID: "session-missing" }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    await advanceWave.execute({ sessionID: "session-missing" }, context);
    await markOracleReviewed(afterHook, "session-missing");
    await advanceWave.execute({ sessionID: "session-missing" }, context);
    await advanceWave.execute({ sessionID: "session-missing" }, context);

    const result = await acceptPlan.execute(
      {
        sessionID: "session-missing",
        action: "accept"
      },
      context
    );

    expect(result).toContain("missing or unreadable");
  });

  test("rejects non-plan agents", async () => {
    const worktree = createWorktree();
    const { acceptPlan } = await createTools(worktree);

    const result = await acceptPlan.execute(
      { sessionID: "session-non-plan", action: "revise" },
      createToolContext(worktree, "session-non-plan", "build")
    );

    expect(result).toBe("Error: accept_plan is only available to the Plan agent.");
  });

  test("accept is blocked before wave 4", async () => {
    const worktree = createWorktree();
    const { advanceWave, acceptPlan } = await createTools(worktree);
    const context = createToolContext(worktree, "session-early-accept");

    await advanceWave.execute({ sessionID: "session-early-accept" }, context);

    const result = await acceptPlan.execute(
      {
        sessionID: "session-early-accept",
        action: "accept"
      },
      context
    );

    expect(result).toContain("only available in Wave 4");
  });

  test("falls back gracefully when session.prompt throws after successful create", async () => {
    const worktree = createWorktree();
    const fakeClient: FakeClient = {
      session: {
        async create() {
          return { id: "build-partial" };
        },
        async prompt() {
          throw new Error("prompt failed");
        }
      }
    };

    const { advanceWave, acceptPlan, afterHook } = await createTools(worktree, fakeClient);
    const sessionID = "session-prompt-fail";
    const context = createToolContext(worktree, sessionID);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    const planName = match[1];
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${planName}.md`), "# Test plan\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    const result = await acceptPlan.execute(
      { sessionID, action: "accept" },
      context
    );

    expect(result).toContain("Direct session handoff is unavailable");
    expect(result).toContain("accepted timestamp");
  });

  test("accept success message tells agent session is complete", async () => {
    const worktree = createWorktree();
    const fakeClient: FakeClient = {
      session: {
        async create() {
          return { id: "build-complete-check" };
        },
        async prompt() {
          return { ok: true };
        }
      }
    };

    const { advanceWave, acceptPlan, afterHook } = await createTools(worktree, fakeClient);
    const sessionID = "session-complete-msg";
    const context = createToolContext(worktree, sessionID);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) throw new Error("Could not parse plan name");

    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${match[1]}.md`), "# Test\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    const result = await acceptPlan.execute({ sessionID, action: "accept" }, context);
    expect(result).toContain("planning session is now COMPLETE");
    expect(result).toContain("Do NOT call advance_wave");
  });

  test("accept fallback message tells agent session is complete", async () => {
    const worktree = createWorktree();
    const { advanceWave, acceptPlan, afterHook } = await createTools(worktree);
    const sessionID = "session-fallback-msg";
    const context = createToolContext(worktree, sessionID);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) throw new Error("Could not parse plan name");

    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${match[1]}.md`), "# Test\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    const result = await acceptPlan.execute({ sessionID, action: "accept" }, context);
    expect(result).toContain("planning session is now COMPLETE");
    expect(result).toContain("Do NOT call advance_wave");
  });

  test("rejects plan paths outside tasks/plans", async () => {
    const worktree = createWorktree();
    const { advanceWave, acceptPlan, afterHook } = await createTools(worktree);
    const context = createToolContext(worktree, "session-path-check");

    await advanceWave.execute({ sessionID: "session-path-check" }, context);
    await advanceWave.execute({ sessionID: "session-path-check" }, context);
    await markOracleReviewed(afterHook, "session-path-check");
    await advanceWave.execute({ sessionID: "session-path-check" }, context);
    await advanceWave.execute({ sessionID: "session-path-check" }, context);

    const result = await acceptPlan.execute(
      {
        sessionID: "session-path-check",
        action: "accept",
        planPath: "../outside.md"
      },
      context
    );

    expect(result).toContain("must point to tasks/plans");
  });
});
