import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

type Todo = {
  id?: string;
  content: string;
  status: string;
  priority: string;
};

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "todo-seeding-"));
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

async function createPlugin(worktree: string, todoReader: () => Todo[] | Promise<Todo[]>) {
  const hooks = await DisciplinePlugin({
    client: {
      session: {
        async todo() {
          return todoReader();
        }
      }
    } as never,
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

function buildPlanningChecklistTodos(planName: string): Todo[] {
  return [
    {
      id: "todo-1",
      content: "Wave 1: Interview - clarify requirements, scope, constraints, and success criteria",
      status: "in_progress",
      priority: "high"
    },
    {
      id: "todo-2",
      content: "Wave 2: Gap Analysis - surface hidden intent, ambiguity, risks, and breaking changes",
      status: "pending",
      priority: "high"
    },
    {
      id: "todo-3",
      content: `Wave 3: Plan Generation - write the structured plan file at tasks/plans/${planName}.md`,
      status: "pending",
      priority: "high"
    },
    {
      id: "todo-4",
      content: "Wave 4: Review - self-review clarity, verification, scope, and implementation readiness",
      status: "pending",
      priority: "high"
    },
    {
      id: "todo-5",
      content:
        "Step 5: Ask user to confirm - choose one: Accept plan, clear context and build. / Start work later / I have modifications to make",
      status: "pending",
      priority: "high"
    }
  ];
}

async function markPlanningChecklist(
  afterHook: (input: any, output: any) => Promise<void>,
  sessionID: string,
  planName: string
): Promise<void> {
  await afterHook(
    {
      tool: "todowrite",
      sessionID,
      callID: `todo-${sessionID}`,
      args: {
        todos: buildPlanningChecklistTodos(planName)
      }
    },
    {
      title: "Todo updated",
      output: "ok",
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

describe("todo seeding nudges", () => {
  test("blocks Wave 1 -> Wave 2 until planning checklist exists", async () => {
    const worktree = createWorktree();
    const { advanceWave } = await createPlugin(worktree, () => []);
    const sessionID = "session-checklist-blocked";

    await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));
    const blocked = await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));

    expect(blocked).toContain("Error: planning checklist is missing");
    expect(blocked).toContain("Call `todowrite`");
  });

  test("allows Wave 1 -> Wave 2 after todowrite checklist is created", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook } = await createPlugin(worktree, () => []);
    const sessionID = "session-checklist-seeded";

    const wave1 = await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));
    const match = wave1.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    await markPlanningChecklist(afterHook, sessionID, match[1]);
    const wave2 = await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));

    expect(wave2).toContain("Wave 2 (Gap Analysis)");
  });

  test("allows Wave 1 -> Wave 2 with LLM-customized todo descriptions", async () => {
    const worktree = createWorktree();
    const { advanceWave, afterHook } = await createPlugin(worktree, () => []);
    const sessionID = "session-checklist-custom";

    const wave1 = await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));
    const match = wave1.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    // Simulate LLM writing contextual todo descriptions instead of exact expected text
    await afterHook(
      {
        tool: "todowrite",
        sessionID,
        callID: `todo-${sessionID}`,
        args: {
          todos: [
            { id: "t1", content: "Wave 1: Interview — clarify requirements for downgrade feature", status: "completed", priority: "high" },
            { id: "t2", content: "Wave 2: Gap analysis — check codebase for hidden dependencies", status: "in_progress", priority: "high" },
            { id: "t3", content: "Wave 3: Generate plan document", status: "pending", priority: "high" },
            { id: "t4", content: "Wave 4: Self-review the plan", status: "pending", priority: "high" },
            { id: "t5", content: "Step 5: Present plan and handoff", status: "pending", priority: "high" }
          ]
        }
      },
      { title: "Todo updated", output: "ok", metadata: {} }
    );

    const wave2 = await advanceWave.execute({ sessionID }, createToolContext(worktree, sessionID));
    expect(wave2).toContain("Wave 2 (Gap Analysis)");
  });

  test("injects initial todowrite reminder when plan starts and no todos exist", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree, () => []);

    const wave1 = await advanceWave.execute(
      { sessionID: "session-seed-1" },
      createToolContext(worktree, "session-seed-1")
    );

    const match = wave1.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }

    const output = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-seed-1",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      output
    );

    const merged = output.system.join("\n");
    expect(merged).toContain("## Discipline Plugin — Todo Seed");
    expect(merged).toContain("Call `todowrite` now");
    expect(merged).toContain("Wave 1: Interview");
    expect(merged).toContain("Wave 2: Gap Analysis");
    expect(merged).toContain("Wave 3: Plan Generation");
    expect(merged).toContain("Wave 4: Review");
    expect(merged).toContain("Step 5: Ask user to confirm");
    expect(merged).toContain(match[1]);
  });

  test("injects one targeted retry reminder when todo is still missing", async () => {
    const worktree = createWorktree();
    const { advanceWave, transform } = await createPlugin(worktree, () => []);

    await advanceWave.execute(
      { sessionID: "session-seed-2" },
      createToolContext(worktree, "session-seed-2")
    );

    const first = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-seed-2",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      first
    );

    const second = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-seed-2",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      second
    );

    expect(first.system.join("\n")).toContain("## Discipline Plugin — Todo Seed");
    expect(second.system.join("\n")).toContain("## Discipline Plugin — Todo Seed Retry");
  });

  test("stops reminding once kickoff todo exists", async () => {
    const worktree = createWorktree();
    let calls = 0;
    let planName = "";

    const { advanceWave, transform } = await createPlugin(worktree, () => {
      calls += 1;
      if (calls === 1) {
        return [];
      }

      return [
        {
          id: "todo-1",
          content:
            "Wave 1: Interview - clarify requirements, scope, constraints, and success criteria",
          status: "in_progress",
          priority: "high"
        },
        {
          id: "todo-2",
          content:
            "Wave 2: Gap Analysis - surface hidden intent, ambiguity, risks, and breaking changes",
          status: "pending",
          priority: "high"
        },
        {
          id: "todo-3",
          content: `Wave 3: Plan Generation - write the structured plan file at tasks/plans/${planName}.md`,
          status: "pending",
          priority: "high"
        },
        {
          id: "todo-4",
          content:
            "Wave 4: Review - self-review clarity, verification, scope, and implementation readiness",
          status: "pending",
          priority: "high"
        },
        {
          id: "todo-5",
          content:
            "Step 5: Ask user to confirm - choose one: Accept plan, clear context and build. / Start work later / I have modifications to make",
          status: "pending",
          priority: "high"
        }
      ];
    });

    const wave1 = await advanceWave.execute(
      { sessionID: "session-seed-3" },
      createToolContext(worktree, "session-seed-3")
    );

    const match = wave1.match(/plan '([a-z]+-[a-z]+-[a-z]+)'/);
    if (!match) {
      throw new Error("Could not parse generated plan name");
    }
    planName = match[1];

    const first = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-seed-3",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      first
    );

    const second = { system: [] as string[] };
    await transform(
      {
        sessionID: "session-seed-3",
        model: { id: "model" } as never,
        agent: "plan"
      } as never,
      second
    );

    expect(first.system.join("\n")).toContain("Todo Seed");
    const secondOutput = second.system.join("\n");
    expect(secondOutput).not.toContain("Todo Seed");
    expect(secondOutput).not.toContain("Todo Seed Retry");
  });
});
