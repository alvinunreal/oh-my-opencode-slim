import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { DisciplinePlugin } from "../index";
import { installProjectCommandFiles, installGlobalCommandFiles } from "../commands";

const tempDirs: string[] = [];

function createWorktree() {
  const root = mkdtempSync(join(tmpdir(), "commands-test-"));
  tempDirs.push(root);
  return root;
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

  if (!hooks.config) {
    throw new Error("Expected config hook to be available");
  }

  return { config: hooks.config };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("command config", () => {
  test("injects simplify, batch, and deep-review commands from commands directory", async () => {
    const worktree = createWorktree();
    const { config } = await createPlugin(worktree);

    const input = {} as Record<string, unknown>;
    await config(input);

    const commands = input.command as Record<string, Record<string, unknown>>;
    expect(commands).toBeDefined();
    expect(commands.simplify).toBeDefined();
    expect(commands.simplify.agent).toBe("build");
    expect(typeof commands.simplify.description).toBe("string");

    const template = commands.simplify.template as string;
    expect(template).toContain("recently changed code");
    expect(template).toContain("three parallel reviewer subtasks");
    expect(template).toContain("$ARGUMENTS");
    expect(template).toContain("git diff");
    expect(template).toContain("Verify using the project's own commands");

    expect(commands.batch).toBeDefined();
    expect(commands.batch.agent).toBe("plan");
    expect(typeof commands.batch.description).toBe("string");

    const batchTemplate = commands.batch.template as string;
    expect(batchTemplate).toContain("Batch request: $ARGUMENTS");
    expect(batchTemplate).toContain("explicit approval");
    expect(batchTemplate).toContain("Phase 1");
    expect(batchTemplate).toContain("Phase 2");
    expect(batchTemplate).toContain("Phase 3");
    expect(batchTemplate).toContain('subagent_type="build"');
    expect(batchTemplate).toContain("You do NOT edit code directly");

    expect(commands["deep-review"]).toBeDefined();
    expect(commands["deep-review"].agent).toBe("build");
    expect(typeof commands["deep-review"].description).toBe("string");

    const reviewTemplate = commands["deep-review"].template as string;
    expect(reviewTemplate).toContain("$ARGUMENTS");
    expect(reviewTemplate).toContain("three parallel reviewer subtasks");
    expect(reviewTemplate).toContain("APPROVE");
    expect(reviewTemplate).toContain("CRITICAL");
    expect(reviewTemplate).toContain("Do NOT edit or fix code");
  });

  test("preserves per-field user overrides and custom commands", async () => {
    const worktree = createWorktree();
    const { config } = await createPlugin(worktree);

    const input = {
      command: {
        simplify: {
          description: "Team-specific simplify flow",
          subtask: true
        },
        docs: {
          template: "Generate docs",
          description: "Docs helper"
        }
      }
    } as Record<string, unknown>;

    await config(input);

    const commands = input.command as Record<string, Record<string, unknown>>;
    expect(commands.docs).toBeDefined();
    expect(commands.docs.template).toBe("Generate docs");

    expect(commands.simplify.description).toBe("Team-specific simplify flow");
    expect(commands.simplify.subtask).toBe(true);
    expect(typeof commands.simplify.template).toBe("string");
    expect(commands.simplify.agent).toBe("build");
  });
});

describe("installProjectCommandFiles", () => {
  test("copies command files to .opencode/commands/ with marker", () => {
    const worktree = createWorktree();
    const sourceDir = join(__dirname, "../../commands");

    installProjectCommandFiles(sourceDir, worktree);

    const targetDir = join(worktree, ".opencode", "commands");
    expect(existsSync(targetDir)).toBe(true);

    for (const name of ["simplify.md", "batch.md", "deep-review.md"]) {
      const dest = join(targetDir, name);
      expect(existsSync(dest)).toBe(true);

      const content = readFileSync(dest, "utf-8");
      expect(content).toContain("# managed-by: opencode-discipline");
      expect(content).toContain("---");
    }
  });

  test("does not overwrite user-created command files (no marker)", () => {
    const worktree = createWorktree();
    const sourceDir = join(__dirname, "../../commands");
    const targetDir = join(worktree, ".opencode", "commands");
    mkdirSync(targetDir, { recursive: true });

    // User creates their own simplify.md without the marker
    const userContent = "---\ndescription: my custom simplify\n---\nDo my thing.";
    writeFileSync(join(targetDir, "simplify.md"), userContent, "utf-8");

    installProjectCommandFiles(sourceDir, worktree);

    // User file should be preserved
    const result = readFileSync(join(targetDir, "simplify.md"), "utf-8");
    expect(result).toBe(userContent);

    // Other plugin files should still be installed
    expect(existsSync(join(targetDir, "batch.md"))).toBe(true);
    expect(existsSync(join(targetDir, "deep-review.md"))).toBe(true);
  });

  test("overwrites plugin-managed files (has marker)", () => {
    const worktree = createWorktree();
    const sourceDir = join(__dirname, "../../commands");
    const targetDir = join(worktree, ".opencode", "commands");
    mkdirSync(targetDir, { recursive: true });

    // Simulate a previously installed plugin file
    const oldContent = "---\n# managed-by: opencode-discipline\ndescription: old version\n---\nOld template.";
    writeFileSync(join(targetDir, "simplify.md"), oldContent, "utf-8");

    installProjectCommandFiles(sourceDir, worktree);

    // Should be updated with the new content
    const result = readFileSync(join(targetDir, "simplify.md"), "utf-8");
    expect(result).not.toBe(oldContent);
    expect(result).toContain("# managed-by: opencode-discipline");
    expect(result).toContain("recently changed code");
  });
});

describe("installGlobalCommandFiles", () => {
  test("copies command files into global config commands directory", () => {
    const tempConfigHome = createWorktree();
    const sourceDir = join(__dirname, "../../commands");

    installGlobalCommandFiles(sourceDir, tempConfigHome);

    const targetDir = join(tempConfigHome, "opencode", "commands");
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, "simplify.md"))).toBe(true);
    expect(existsSync(join(targetDir, "batch.md"))).toBe(true);
    expect(existsSync(join(targetDir, "deep-review.md"))).toBe(true);
  });
});
