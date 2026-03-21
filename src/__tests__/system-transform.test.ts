import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "system-transform-"));
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

async function createPlugin(worktree: string) {
  const hooks = await DisciplinePlugin({
    client: {} as never,
    project: {} as never,
    directory: worktree,
    worktree,
    serverUrl: new URL("http://localhost"),
    $: {} as never
  });

  if (!hooks.tool?.advance_wave || !hooks["experimental.chat.system.transform"] || !hooks["tool.execute.after"]) {
    throw new Error("Expected hooks are not available");
  }

  return {
    advanceWave: hooks.tool.advance_wave,
    afterHook: hooks["tool.execute.after"],
    transform: hooks["experimental.chat.system.transform"]
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

describe("experimental.chat.system.transform", () => {
  test("includes wave state when active", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree);

    await advanceWave.execute(
      { sessionID: "session-active" },
      createToolContext(worktree, "session-active")
    );

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-active",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("## 🔒 Discipline Plugin — Wave State");
    expect(merged).toContain("**Current wave**: 1 — Interview");
    expect(merged).toContain("**Writing to tasks/plans/*.md is BLOCKED until Wave 3.**");
  });

  test("includes guidance to call advance_wave when no active plan", async () => {
    const worktree = createWorktree();
    const { transform } = await createPlugin(worktree);
    const output = { system: [] as string[] };

    await transform(
      {
        sessionID: "session-none",
        model: { id: "model" } as never
      },
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("To start a structured plan, call `advance_wave`");
  });

  test("interpolates wave number and plan name", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree);
    const start = await advanceWave.execute(
      { sessionID: "session-wave" },
      createToolContext(worktree, "session-wave")
    );
    await advanceWave.execute(
      { sessionID: "session-wave" },
      createToolContext(worktree, "session-wave")
    );

    const match = start.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Failed to parse plan name");
    }

    const planName = match[1];
    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-wave",
        model: { id: "model" } as never
      },
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("**Current wave**: 2 — Gap Analysis");
    expect(merged).toContain(`**Plan name**: ${planName}`);
    expect(merged).toContain(`**Plan file**: tasks/plans/${planName}.md`);
  });

  test("injects handoff prompt at wave 4 when plan file exists", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook, transform } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-handoff");

    const startResult = await advanceWave.execute({ sessionID: "session-handoff" }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Failed to parse plan name");
    }

    const planName = match[1];
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${planName}.md`), "# Test plan\n", "utf8");

    await advanceWave.execute({ sessionID: "session-handoff" }, context);
    await markOracleReviewed(afterHook, "session-handoff");
    await advanceWave.execute({ sessionID: "session-handoff" }, context);
    await advanceWave.execute({ sessionID: "session-handoff" }, context);

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-handoff",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("MANDATORY: Plan Handoff");
    expect(merged).toContain("Accept plan, clear context and build.");
    expect(merged).toContain("Start work later");
    expect(merged).toContain("I have modifications to make");
    expect(merged).toContain("accept_plan");
  });

  test("injects handoff prompt at wave 4 when agent field is missing", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook, transform } = await createPlugin(worktree);
    const sessionID = "session-handoff-no-agent";
    const context = createToolContext(worktree, sessionID);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Failed to parse plan name");
    }

    const planName = match[1];
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${planName}.md`), "# Test plan\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID,
        model: { id: "model" } as never
      },
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("MANDATORY: Plan Handoff");
    expect(merged).toContain("Accept plan, clear context and build.");
  });

  test("does not inject handoff prompt at wave 4 when plan file is missing", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook, transform } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-no-file");

    await advanceWave.execute({ sessionID: "session-no-file" }, context);
    await advanceWave.execute({ sessionID: "session-no-file" }, context);
    await markOracleReviewed(afterHook, "session-no-file");
    await advanceWave.execute({ sessionID: "session-no-file" }, context);
    await advanceWave.execute({ sessionID: "session-no-file" }, context);

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-no-file",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).not.toContain("MANDATORY: Plan Handoff");
  });

  test("does not inject handoff prompt before wave 4", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook, transform } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-early");

    const startResult = await advanceWave.execute({ sessionID: "session-early" }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Failed to parse plan name");
    }

    const planName = match[1];
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${planName}.md`), "# Test plan\n", "utf8");

    await advanceWave.execute({ sessionID: "session-early" }, context);
    await markOracleReviewed(afterHook, "session-early");
    await advanceWave.execute({ sessionID: "session-early" }, context);

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-early",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).not.toContain("MANDATORY: Plan Handoff");
  });

  test("injects Plan mode read-only reminder for Plan agent", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree);

    await advanceWave.execute(
      { sessionID: "session-plan" },
      createToolContext(worktree, "session-plan")
    );

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-plan",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase");
    expect(merged).toContain("Only read, analyze, delegate, and plan");
  });

  test("injects mandatory oracle check prompt in wave 2 for Plan agent", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree);

    await advanceWave.execute(
      { sessionID: "session-wave2-oracle" },
      createToolContext(worktree, "session-wave2-oracle")
    );
    await advanceWave.execute(
      { sessionID: "session-wave2-oracle" },
      createToolContext(worktree, "session-wave2-oracle")
    );

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-wave2-oracle",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("MANDATORY: Wave 2 Oracle Check");
    expect(merged).toContain("subagent_type: \"oracle\"");
  });

  test("does not inject oracle prompt after oracle review is recorded", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook, transform } = await createPlugin(worktree);
    const sessionID = "session-wave2-oracle-complete";

    await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));
    await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));
    await markOracleReviewed(afterHook, sessionID);

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID,
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).not.toContain("MANDATORY: Wave 2 Oracle Check");
  });

  test("injects post-accept prompt after plan is accepted", async () => {
    const worktree = createWorktree();
    const hooks = await DisciplinePlugin({
      client: {} as never,
      project: {} as never,
      directory: worktree,
      worktree,
      serverUrl: new URL("http://localhost"),
      $: {} as never
    });

    const advanceWave = hooks.tool!.advance_wave;
    const acceptPlan = hooks.tool!.accept_plan;
    const afterHook = hooks["tool.execute.after"]!;
    const transform = hooks["experimental.chat.system.transform"]!;

    const sessionID = "session-post-accept";
    const context = createToolContext(worktree, sessionID);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) throw new Error("Failed to parse plan name");

    const planName = match[1];
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${planName}.md`), "# Test plan\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    await acceptPlan.execute({ sessionID, action: "accept" }, context);

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID,
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("Plan Accepted");
    expect(merged).toContain("DONE");
    expect(merged).toContain("Do not call advance_wave");
    // Should NOT contain handoff prompt or other wave-specific prompts
    expect(merged).not.toContain("MANDATORY: Plan Handoff");
    expect(merged).not.toContain("CRITICAL: Plan mode ACTIVE");
    expect(merged).not.toContain("MANDATORY: Wave 2 Oracle Check");
  });

  test("injects oracle prompt in wave 2 when agent field is missing", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree);

    await advanceWave.execute(
      { sessionID: "session-wave2-no-agent" },
      createToolContext(worktree, "session-wave2-no-agent")
    );
    await advanceWave.execute(
      { sessionID: "session-wave2-no-agent" },
      createToolContext(worktree, "session-wave2-no-agent")
    );

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-wave2-no-agent",
        model: { id: "model" } as never
      },
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("MANDATORY: Wave 2 Oracle Check");
  });
});
