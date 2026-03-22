import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

const tempDirs: string[] = [];
const originalNotifyMode = process.env.OPENCODE_DISCIPLINE_NOTIFY;
const originalNotifyCommand = process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "discipline-notifications-"));
  tempDirs.push(root);
  return root;
}

function createToolContext(
  worktree: string,
  sessionID: string,
  metadataEvents: Array<Record<string, unknown>>,
  agent = "plan"
) {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent,
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata(payload: unknown) {
      if (payload && typeof payload === "object") {
        metadataEvents.push(payload as Record<string, unknown>);
      }
    },
    async ask() {}
  };
}

async function createHooks(worktree: string, client: Record<string, unknown> = {}) {
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
    !hooks["session.idle"] ||
    !hooks.event
  ) {
    throw new Error("Expected hooks were not registered");
  }

  return {
    advanceWave: hooks.tool.advance_wave,
    acceptPlan: hooks.tool.accept_plan,
    beforeHook: hooks["tool.execute.before"],
    afterHook: hooks["tool.execute.after"],
    sessionIdleHook: hooks["session.idle"],
    eventHook: hooks.event
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

  if (originalNotifyMode === undefined) {
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY;
  } else {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = originalNotifyMode;
  }

  if (originalNotifyCommand === undefined) {
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;
  } else {
    process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND = originalNotifyCommand;
  }
});

function collectMetadata(): {
  events: Array<Record<string, unknown>>;
  collector: (payload: unknown) => void;
} {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    collector(payload: unknown) {
      if (payload && typeof payload === "object") {
        events.push(payload as Record<string, unknown>);
      }
    }
  };
}

function findNeedAnswersEvent(
  events: Array<Record<string, unknown>>
): Record<string, unknown> | undefined {
  return events.find(
    (item) => item.type === "discipline.notification" && item.event === "need_answers"
  );
}

describe("notifications", () => {
  test("shows startup toast with plugin version", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const worktree = createWorktree();

    await createHooks(worktree, {
      tui: {
        async showToast(input: Record<string, unknown>) {
          calls.push(input);
          return true;
        }
      }
    });

    expect(calls.length).toBe(1);
    const call = calls[0];
    const body = call.body as { message?: string; title?: string };
    expect(body.title).toBe("Discipline Plugin");
    expect(body.message).toContain("opencode-discipline v");
  });

  test("retries startup toast on event when initial transport is not ready", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let shouldFail = true;
    const worktree = createWorktree();

    const { eventHook } = await createHooks(worktree, {
      tui: {
        async showToast(input: Record<string, unknown>) {
          if (shouldFail) {
            throw new Error("toast transport not ready");
          }

          calls.push(input);
          return true;
        }
      }
    });

    shouldFail = false;

    await eventHook({ event: { type: "server.connected", properties: {} } });

    expect(calls.length).toBe(1);
  });

  test("emits need_answers notification when question tool is used", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "metadata";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { beforeHook } = await createHooks(worktree);
    const { events, collector } = collectMetadata();

    await (beforeHook as any)(
      { tool: "question", sessionID: "session-question", callID: "question-1" },
      {
        args: { questions: [{ question: "Need scope?", header: "Scope", options: [] }] },
        metadata: collector
      }
    );

    const event = findNeedAnswersEvent(events);
    expect(event).toBeDefined();
    expect(event?.title).toBe("Agent needs your answers");
    expect(event?.message).toBe("Need scope?");
  });

  test("uses question args when question is asked", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "metadata";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { beforeHook } = await createHooks(worktree);
    const { events, collector } = collectMetadata();

    await (beforeHook as any)(
      { tool: "question", sessionID: "session-question-answered", callID: "question-2" },
      {
        args: { questions: [{ question: "Which tier fits best?", header: "Tier", options: [] }] },
        metadata: collector
      }
    );

    const event = findNeedAnswersEvent(events);
    expect(event).toBeDefined();
    expect(event?.message).toBe("Which tier fits best?");
  });

  test("does not emit need_answers notification after question tool completes", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "metadata";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { afterHook } = await createHooks(worktree);
    const { events, collector } = collectMetadata();

    await afterHook(
      {
        tool: "question",
        sessionID: "session-question-after",
        callID: "question-3",
        args: { questions: [{ question: "Need scope?", header: "Scope", options: [] }] }
      },
      { title: "Question answered", output: "User answered", metadata: collector }
    );

    expect(findNeedAnswersEvent(events)).toBeUndefined();
  });

  test("emits plan_ready notification at wave 4 when plan file exists", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "metadata";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { advanceWave, afterHook } = await createHooks(worktree);
    const metadataEvents: Array<Record<string, unknown>> = [];
    const sessionID = "session-plan-ready";
    const context = createToolContext(worktree, sessionID, metadataEvents);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse plan name");
    }

    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${match[1]}.md`), "# Plan\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);

    const event = metadataEvents.find(
      (item) => item.type === "discipline.notification" && item.event === "plan_ready"
    );
    expect(event).toBeDefined();
    expect(event?.title).toBe("Plan is ready");
  });

  test("emits coding_complete notification on build session idle", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "metadata";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { sessionIdleHook } = await createHooks(worktree);
    const metadataEvents: Array<Record<string, unknown>> = [];

    await sessionIdleHook(
      {
        sessionID: "build-session-idle",
        agent: "build",
        metadata(payload: unknown) {
          if (payload && typeof payload === "object") {
            metadataEvents.push(payload as Record<string, unknown>);
          }
        }
      },
      {}
    );

    const event = metadataEvents.find(
      (item) => item.type === "discipline.notification" && item.event === "coding_complete"
    );
    expect(event).toBeDefined();
    expect(event?.title).toBe("OpenCode has finished");
  });

  test("emits coding_complete notification when idle session matches accepted build id", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "metadata";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { advanceWave, acceptPlan, afterHook, sessionIdleHook } = await createHooks(worktree);
    const metadataEvents: Array<Record<string, unknown>> = [];
    const sessionID = "session-idle-match";
    const context = createToolContext(worktree, sessionID, metadataEvents);

    const startResult = await advanceWave.execute({ sessionID }, context);
    const match = startResult.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse plan name");
    }

    mkdirSync(join(worktree, "tasks", "plans"), { recursive: true });
    writeFileSync(join(worktree, `tasks/plans/${match[1]}.md`), "# Plan\n", "utf8");

    await advanceWave.execute({ sessionID }, context);
    await markOracleReviewed(afterHook, sessionID);
    await advanceWave.execute({ sessionID }, context);
    await advanceWave.execute({ sessionID }, context);
    await acceptPlan.execute({ sessionID, action: "accept" }, context);

    metadataEvents.length = 0;

    await sessionIdleHook(
      {
        sessionID: "manual-build-session",
        metadata(payload: unknown) {
          if (payload && typeof payload === "object") {
            metadataEvents.push(payload as Record<string, unknown>);
          }
        }
      },
      {}
    );

    const event = metadataEvents.find(
      (item) => item.type === "discipline.notification" && item.event === "coding_complete"
    );
    expect(event).toBeDefined();
  });

  test("does not emit notifications when disabled", async () => {
    process.env.OPENCODE_DISCIPLINE_NOTIFY = "off";
    delete process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND;

    const worktree = createWorktree();
    const { sessionIdleHook } = await createHooks(worktree);
    const metadataEvents: Array<Record<string, unknown>> = [];

    await sessionIdleHook(
      {
        sessionID: "build-session-off",
        agent: "build",
        metadata(payload: unknown) {
          if (payload && typeof payload === "object") {
            metadataEvents.push(payload as Record<string, unknown>);
          }
        }
      },
      {}
    );

    expect(metadataEvents.length).toBe(0);
  });
});
