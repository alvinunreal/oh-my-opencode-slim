import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "write-blocking-"));
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

  if (
    !hooks.tool?.advance_wave ||
    !hooks.tool.accept_plan ||
    !hooks["tool.execute.before"] ||
    !hooks["tool.execute.after"]
  ) {
    throw new Error("Plugin hooks are incomplete");
  }

  return {
    beforeHook: hooks["tool.execute.before"],
    afterHook: hooks["tool.execute.after"],
    advanceWave: hooks.tool.advance_wave,
    acceptPlan: hooks.tool.accept_plan
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

describe("tool.execute.before", () => {
  test("blocks plan writes during wave 1 and 2", async () => {
    const worktree = createWorktree();
    const { beforeHook, advanceWave } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-wave12");

    await advanceWave.execute({ sessionID: "session-wave12" }, context);
    const wave1Error = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID: "session-wave12", callID: "c1" },
        { args: { filePath: "tasks/plans/foo.md" } }
      )
    );

    await advanceWave.execute({ sessionID: "session-wave12" }, context);
    const wave2Error = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID: "session-wave12", callID: "c2" },
        { args: { filePath: "tasks/plans/foo.md" } }
      )
    );

    expect(wave1Error).toContain("Cannot write plan files until Wave 3");
    expect(wave2Error).toContain("Cannot write plan files until Wave 3");
  });

  test("allows plan writes during wave 3 and 4", async () => {
    const worktree = createWorktree();
    const { beforeHook, afterHook, advanceWave } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-wave34");

    await advanceWave.execute({ sessionID: "session-wave34" }, context);
    await advanceWave.execute({ sessionID: "session-wave34" }, context);
    await markOracleReviewed(afterHook, "session-wave34");
    await advanceWave.execute({ sessionID: "session-wave34" }, context);

    const wave3Error = await getErrorMessage(() =>
      beforeHook(
        { tool: "edit", sessionID: "session-wave34", callID: "c3" },
        { args: { filePath: "tasks/plans/foo.md" } }
      )
    );

    await advanceWave.execute({ sessionID: "session-wave34" }, context);
    const wave4Error = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID: "session-wave34", callID: "c4" },
        { args: { filePath: "tasks/plans/foo.md" } }
      )
    );

    expect(wave3Error).toBeUndefined();
    expect(wave4Error).toBeUndefined();
  });

  test("allows writes to non-plan paths", async () => {
    const worktree = createWorktree();
    const { beforeHook, advanceWave } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-other-path");

    await advanceWave.execute({ sessionID: "session-other-path" }, context);
    const error = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID: "session-other-path", callID: "c5" },
        { args: { filePath: "notes/idea.md" } }
      )
    );

    expect(error).toBeUndefined();
  });

  test("blocks .env reads but allows .env.example", async () => {
    const worktree = createWorktree();
    const { beforeHook } = await createPlugin(worktree);

    const envError = await getErrorMessage(() =>
      beforeHook(
        { tool: "read", sessionID: "session-read", callID: "c6" },
        { args: { filePath: ".env.local" } }
      )
    );

    const envExampleError = await getErrorMessage(() =>
      beforeHook(
        { tool: "read", sessionID: "session-read", callID: "c7" },
        { args: { filePath: ".env.example" } }
      )
    );

    expect(envError).toContain("Reading .env files is blocked");
    expect(envExampleError).toBeUndefined();
  });

  test("blocks case-insensitive .env variants and bare .env", async () => {
    const worktree = createWorktree();
    const { beforeHook } = await createPlugin(worktree);

    const cases = [
      { file: ".env", blocked: true },
      { file: ".ENV", blocked: true },
      { file: ".Env.Production", blocked: true },
      { file: ".env.development", blocked: true },
      { file: ".env.example", blocked: false },
      { file: ".ENV.EXAMPLE", blocked: false }
    ];

    for (const { file, blocked } of cases) {
      const error = await getErrorMessage(() =>
        beforeHook(
          { tool: "read", sessionID: "session-env-case", callID: `c-${file}` },
          { args: { filePath: file } }
        )
      );

      if (blocked) {
        expect(error).toContain("Reading .env files is blocked");
      } else {
        expect(error).toBeUndefined();
      }
    }
  });

  test("does not block non-plan sessions without wave state", async () => {
    const worktree = createWorktree();
    const { beforeHook } = await createPlugin(worktree);

    const error = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID: "session-unknown", callID: "c8" },
        { args: { filePath: "tasks/plans/foo.md" } }
      )
    );

    expect(error).toBeUndefined();
  });

  test("marks accepted plan sessions as read-only", async () => {
    const worktree = createWorktree();
    const { beforeHook, afterHook, advanceWave, acceptPlan } = await createPlugin(worktree);
    const context = createToolContext(worktree, "session-accepted");

    const waveResult = await advanceWave.execute({ sessionID: "session-accepted" }, context);
    const match = waveResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Failed to parse plan name");
    }

    const planPath = join(worktree, "tasks", "plans", `${match[1]}.md`);
    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(planPath, "# Accepted plan\n", "utf8");

    await advanceWave.execute({ sessionID: "session-accepted" }, context);
    await markOracleReviewed(afterHook, "session-accepted");
    await advanceWave.execute({ sessionID: "session-accepted" }, context);
    await advanceWave.execute({ sessionID: "session-accepted" }, context);

    await acceptPlan.execute(
      {
        sessionID: "session-accepted",
        action: "accept"
      },
      context
    );

    const error = await getErrorMessage(() =>
      beforeHook(
        { tool: "write", sessionID: "session-accepted", callID: "c9" },
        { args: { filePath: "src/main.ts" } }
      )
    );

    expect(error).toContain("Plan session is read-only after accept_plan");
  });
});
