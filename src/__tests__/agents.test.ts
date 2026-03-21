import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { loadAgentConfigs } from "../agents";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agents-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadAgentConfigs", () => {
  test("parses frontmatter and markdown body from .md files", () => {
    const dir = createTempDir();
    writeFileSync(
      join(dir, "test-agent.md"),
      [
        "---",
        "description: Test agent",
        "model: test/model-1",
        "temperature: 0",
        "mode: primary",
        "tools:",
        "  read: true",
        "  write: false",
        "permission:",
        "  bash:",
        '    "*": deny',
        '    "echo *": allow',
        "---",
        "",
        "You are a test agent.",
        "",
        "## Instructions",
        "",
        "Do the thing."
      ].join("\n"),
      "utf-8"
    );

    const configs = loadAgentConfigs(dir);

    expect(configs["test-agent"]).toBeDefined();
    expect(configs["test-agent"].description).toBe("Test agent");
    expect(configs["test-agent"].model).toBe("test/model-1");
    expect(configs["test-agent"].temperature).toBe(0);
    expect(configs["test-agent"].mode).toBe("primary");
    expect(configs["test-agent"].tools).toEqual({ read: true, write: false });
    expect(configs["test-agent"].permission).toEqual({
      bash: { "*": "deny", "echo *": "allow" }
    });
    expect(configs["test-agent"].prompt).toContain("You are a test agent.");
    expect(configs["test-agent"].prompt).toContain("## Instructions");
  });

  test("loads multiple agent files", () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "alpha.md"), "---\nmodel: a/1\n---\nAlpha prompt\n", "utf-8");
    writeFileSync(join(dir, "beta.md"), "---\nmodel: b/2\ncolor: \"#FF0000\"\n---\nBeta prompt\n", "utf-8");

    const configs = loadAgentConfigs(dir);

    expect(Object.keys(configs).sort()).toEqual(["alpha", "beta"]);
    expect(configs.alpha.model).toBe("a/1");
    expect(configs.alpha.prompt).toBe("Alpha prompt");
    expect(configs.beta.model).toBe("b/2");
    expect(configs.beta.color).toBe("#FF0000");
    expect(configs.beta.prompt).toBe("Beta prompt");
  });

  test("skips README.md", () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "README.md"), "# Readme\nNot an agent.\n", "utf-8");
    writeFileSync(join(dir, "agent.md"), "---\nmodel: x\n---\nPrompt\n", "utf-8");

    const configs = loadAgentConfigs(dir);

    expect(Object.keys(configs)).toEqual(["agent"]);
  });

  test("returns empty object for non-existent directory", () => {
    const configs = loadAgentConfigs(`/tmp/nonexistent-agents-dir-${Date.now()}`);
    expect(configs).toEqual({});
  });

  test("handles .md file without frontmatter", () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "bare.md"), "Just a prompt with no frontmatter.\n", "utf-8");

    const configs = loadAgentConfigs(dir);

    expect(configs.bare).toBeDefined();
    expect(configs.bare.prompt).toBe("Just a prompt with no frontmatter.");
  });

  test("loads real agent files from the project agents directory", () => {
    const agentsDir = resolve(__dirname, "../../agents");
    const configs = loadAgentConfigs(agentsDir);

    expect(Object.keys(configs).length).toBeGreaterThanOrEqual(7);

    expect(configs.plan).toBeDefined();
    expect(configs.plan.model).toBe("anthropic/claude-opus-4-6");
    expect(configs.plan.mode).toBe("primary");
    expect(configs.plan.temperature).toBe(0);
    expect(typeof configs.plan.prompt).toBe("string");
    expect((configs.plan.prompt as string).length).toBeGreaterThan(100);

    expect(configs.build).toBeDefined();
    expect(configs.build.model).toBe("anthropic/claude-opus-4-6");
    expect(configs.build.mode).toBe("primary");

    expect(configs.oracle).toBeDefined();
    expect(configs.oracle.mode).toBe("subagent");

    expect(configs.explore).toBeDefined();
    expect(configs.explore.mode).toBe("subagent");
  });

  test("all agents with deny-default bash include echo allow", () => {
    const agentsDir = resolve(__dirname, "../../agents");
    const configs = loadAgentConfigs(agentsDir);

    for (const [name, config] of Object.entries(configs)) {
      const permission = config.permission as Record<string, unknown> | undefined;
      if (!permission) continue;

      const bash = permission.bash as Record<string, string> | undefined;
      if (!bash || bash["*"] !== "deny") continue;

      expect(bash["echo *"]).toBe(
        "allow"
      );
    }
  });
});
