import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { serializeStateFile, parseStateFile, loadState, saveState, deleteState } from "./storage";
import type { RalphLoopState } from "./types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "ralph-loop-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("serializeStateFile", () => {
  test("generates valid markdown with YAML frontmatter", () => {
    // #given
    const state: RalphLoopState = {
      task: "Refactor API endpoints",
      completionPromise: "DONE",
      maxIterations: 100,
      currentIteration: 5,
      status: "active",
      startedAt: "2026-01-20T10:00:00Z",
      lastIterationAt: "2026-01-20T10:05:00Z",
    };

    // #when
    const result = serializeStateFile(state);

    // #then
    expect(result).toContain("---");
    expect(result).toContain("task: Refactor API endpoints");
    expect(result).toContain("currentIteration: 5");
    expect(result).toContain("# Ralph Loop State");
  });
});

describe("parseStateFile", () => {
  test("parses valid frontmatter", () => {
    // #given
    const content = `---
task: Test task
completionPromise: DONE
maxIterations: 50
currentIteration: 10
status: active
startedAt: '2026-01-20T10:00:00Z'
lastIterationAt: '2026-01-20T10:10:00Z'
---

# Ralph Loop State
`;

    // #when
    const result = parseStateFile(content);

    // #then
    expect(result.task).toBe("Test task");
    expect(result.currentIteration).toBe(10);
    expect(result.status).toBe("active");
  });

  test("throws on missing frontmatter", () => {
    // #given
    const content = "# Ralph Loop State\nNo frontmatter";

    // #when / #then
    expect(() => parseStateFile(content)).toThrow("Invalid state file format");
  });

  test("throws on malformed YAML", () => {
    // #given
    const content = `---
task: "Test
invalid yaml
---`;

    // #when / #then
    expect(() => parseStateFile(content)).toThrow();
  });
});

describe("loadState", () => {
  test("returns null when state file doesn't exist", async () => {
    // #given
    const ctx = { 
      directory: testDir,
      config: { ralph_loop: { state_dir: ".orchestrator" } }
    };

    // #when
    const result = await loadState(ctx);

    // #then
    expect(result).toBeNull();
  });

  test("loads existing state file", async () => {
    // #given
    const ctx = { 
      directory: testDir,
      config: { ralph_loop: { state_dir: ".orchestrator" } }
    };
    const state: RalphLoopState = {
      task: "Test",
      completionPromise: "DONE",
      maxIterations: 10,
      currentIteration: 5,
      status: "active",
      startedAt: "2026-01-20T10:00:00Z",
      lastIterationAt: "2026-01-20T10:05:00Z",
    };
    await saveState(ctx, state);

    // #when
    const result = await loadState(ctx);

    // #then
    expect(result).not.toBeNull();
    expect(result?.task).toBe("Test");
    expect(result?.currentIteration).toBe(5);
  });
});

describe("saveState", () => {
  test("creates state file with correct content", async () => {
    // #given
    const ctx = { 
      directory: testDir,
      config: { ralph_loop: { state_dir: ".orchestrator" } }
    };
    const state: RalphLoopState = {
      task: "Test",
      completionPromise: "DONE",
      maxIterations: 10,
      currentIteration: 5,
      status: "active",
      startedAt: "2026-01-20T10:00:00Z",
      lastIterationAt: "2026-01-20T10:05:00Z",
    };

    // #when
    await saveState(ctx, state);

    // #then
    const loaded = await loadState(ctx);
    expect(loaded?.task).toBe("Test");
  });

  test("creates state directory if missing", async () => {
    // #given
    const ctx = { 
      directory: testDir,
      config: { ralph_loop: { state_dir: ".orchestrator" } }
    };
    const state: RalphLoopState = {
      task: "Test",
      completionPromise: "DONE",
      maxIterations: 10,
      currentIteration: 0,
      status: "active",
      startedAt: "2026-01-20T10:00:00Z",
      lastIterationAt: "2026-01-20T10:00:00Z",
    };

    // #when
    await saveState(ctx, state);

    // #then
    const loaded = await loadState(ctx);
    expect(loaded).not.toBeNull();
  });
});

describe("deleteState", () => {
  test("removes state file", async () => {
    // #given
    const ctx = { 
      directory: testDir,
      config: { ralph_loop: { state_dir: ".orchestrator" } }
    };
    const state: RalphLoopState = {
      task: "Test",
      completionPromise: "DONE",
      maxIterations: 10,
      currentIteration: 5,
      status: "active",
      startedAt: "2026-01-20T10:00:00Z",
      lastIterationAt: "2026-01-20T10:05:00Z",
    };
    await saveState(ctx, state);

    // #when
    await deleteState(ctx);

    // #then
    const result = await loadState(ctx);
    expect(result).toBeNull();
  });

  test("does not throw when file doesn't exist", async () => {
    // #given
    const ctx = { 
      directory: testDir,
      config: { ralph_loop: { state_dir: ".orchestrator" } }
    };

    // #when / #then
    // Should not throw when deleting non-existent file
    await deleteState(ctx);
    // If we reach here, no exception was thrown - test passes
  });
});
