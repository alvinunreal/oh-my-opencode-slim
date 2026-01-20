import { describe, expect, test } from "bun:test";
import { serializeStateFile, parseStateFile } from "./storage";
import type { RalphLoopState } from "./types";

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
