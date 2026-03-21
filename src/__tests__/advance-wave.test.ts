import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "advance-wave-"));
  tempDirs.push(root);
  return root;
}

async function createAdvanceWaveTool(worktree: string) {
  const hooks = await DisciplinePlugin({
    client: {} as never,
    project: {} as never,
    directory: worktree,
    worktree,
    serverUrl: new URL("http://localhost"),
    $: {} as never
  });

  if (!hooks.tool?.advance_wave || !hooks["tool.execute.after"]) {
    throw new Error("advance_wave tool hooks were not registered");
  }

  return {
    advanceWave: hooks.tool.advance_wave,
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

describe("advance_wave tool", () => {
  test("rejects non-plan agents", async () => {
    const worktree = createWorktree();
    const { advanceWave } = await createAdvanceWaveTool(worktree);

    const result = await advanceWave.execute(
      { sessionID: "session-a" },
      {
        sessionID: "session-a",
        messageID: "message-a",
        agent: "build",
        directory: worktree,
        worktree,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {}
      }
    );

    expect(result).toBe("Error: advance_wave is only available to the Plan agent.");
  });

  test("first call starts at wave 1", async () => {
    const worktree = createWorktree();
    const { advanceWave } = await createAdvanceWaveTool(worktree);

    const result = await advanceWave.execute(
      { sessionID: "session-b" },
      {
        sessionID: "session-b",
        messageID: "message-b",
        agent: "plan",
        directory: worktree,
        worktree,
        abort: new AbortController().signal,
        metadata() {},
        async ask() {}
      }
    );

    expect(result).toContain("Wave 1 (Interview) started");
    expect(result).toMatch(/plan '[a-z]+-[a-z]+-[a-z]+'/);
  });

  test("blocks Wave 2 -> Wave 3 before oracle review", async () => {
    const worktree = createWorktree();
    const { advanceWave } = await createAdvanceWaveTool(worktree);
    const context = {
      sessionID: "session-oracle-gate",
      messageID: "message-oracle-gate",
      agent: "plan",
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {}
    };

    await advanceWave.execute({ sessionID: "session-oracle-gate" }, context);
    await advanceWave.execute({ sessionID: "session-oracle-gate" }, context);

    const wave3 = await advanceWave.execute({ sessionID: "session-oracle-gate" }, context);
    expect(wave3).toContain("Error:");
    expect(wave3).toContain("Oracle gap review");
    expect(wave3).toContain("Do NOT call advance_wave again");
  });

  test("subsequent calls advance through waves after oracle review", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook } = await createAdvanceWaveTool(worktree);
    const context = {
      sessionID: "session-c",
      messageID: "message-c",
      agent: "plan",
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {}
    };

    const wave1 = await advanceWave.execute({ sessionID: "session-c" }, context);
    const wave2 = await advanceWave.execute({ sessionID: "session-c" }, context);
    await markOracleReviewed(afterHook, "session-c");
    const wave3 = await advanceWave.execute({ sessionID: "session-c" }, context);
    const wave4 = await advanceWave.execute({ sessionID: "session-c" }, context);

    expect(wave1).toContain("Wave 1 (Interview)");
    expect(wave2).toContain("Wave 2 (Gap Analysis)");
    expect(wave3).toContain("Wave 3 (Plan Generation)");
    expect(wave4).toContain("Wave 4 (Review)");
  });

  test("returns error after wave 4", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook } = await createAdvanceWaveTool(worktree);
    const context = {
      sessionID: "session-d",
      messageID: "message-d",
      agent: "plan",
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {}
    };

    await advanceWave.execute({ sessionID: "session-d" }, context);
    await advanceWave.execute({ sessionID: "session-d" }, context);
    await markOracleReviewed(afterHook, "session-d");
    await advanceWave.execute({ sessionID: "session-d" }, context);
    await advanceWave.execute({ sessionID: "session-d" }, context);

    const result = await advanceWave.execute({ sessionID: "session-d" }, context);
    expect(result).toContain("Error:");
    expect(result).toContain("cannot be advanced further");
  });

  test("returns error after plan is accepted", async () => {
    const worktree = createWorktree();

    const hooks = await (await import("../index")).DisciplinePlugin({
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

    const context = {
      sessionID: "session-post-accept",
      messageID: "message-post-accept",
      agent: "plan",
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {}
    };

    const startResult = await advanceWave.execute({ sessionID: "session-post-accept" }, context);
    await advanceWave.execute({ sessionID: "session-post-accept" }, context);
    await markOracleReviewed(afterHook, "session-post-accept");
    await advanceWave.execute({ sessionID: "session-post-accept" }, context);
    await advanceWave.execute({ sessionID: "session-post-accept" }, context);

    // Create the plan file so accept_plan succeeds
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) throw new Error("Could not parse plan name");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${match[1]}.md`), "# Test\n", "utf8");

    await acceptPlan.execute({ sessionID: "session-post-accept", action: "accept" }, context);

    const result = await advanceWave.execute({ sessionID: "session-post-accept" }, context);
    expect(result).toContain("Error:");
    expect(result).toContain("already been accepted");
  });
});
