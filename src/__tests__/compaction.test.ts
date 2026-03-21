import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "compaction-"));
  tempDirs.push(root);
  return root;
}

function createToolContext(worktree: string, sessionID: string) {
  return {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: "plan",
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

  if (!hooks.tool?.advance_wave || !hooks["experimental.session.compacting"]) {
    throw new Error("Expected hooks are not available");
  }

  return {
    advanceWave: hooks.tool.advance_wave,
    compact: hooks["experimental.session.compacting"]
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("experimental.session.compacting", () => {
  test("includes compaction context when wave state exists", async () => {
    const worktree = createWorktree();
    const { advanceWave, compact } = await createPlugin(worktree);

    await advanceWave.execute(
      { sessionID: "session-compaction" },
      createToolContext(worktree, "session-compaction")
    );

    const output = { context: [] as string[] };
    await compact({ sessionID: "session-compaction" }, output);

    const merged = output.context.join("\n");
    expect(merged).toContain("## Discipline Plugin — Compaction Context");
    expect(merged).toContain("Current planning wave: 1 (Interview)");
    expect(merged).toContain("Resume from Wave 1 after compaction.");
  });

  test("leaves context unchanged when no active plan exists", async () => {
    const worktree = createWorktree();
    const { compact } = await createPlugin(worktree);

    const output = { context: [] as string[] };
    await compact({ sessionID: "session-empty" }, output);

    expect(output.context.length).toBe(0);
  });
});
