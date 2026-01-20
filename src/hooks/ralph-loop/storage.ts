import { load as parseYaml, dump as stringifyYaml } from "js-yaml";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RalphLoopState } from "./types";
import { STATE_FILENAME } from "./constants";

export function serializeStateFile(state: RalphLoopState): string {
  const frontmatter = stringifyYaml({
    task: state.task,
    completionPromise: state.completionPromise,
    maxIterations: state.maxIterations,
    currentIteration: state.currentIteration,
    status: state.status,
    startedAt: state.startedAt,
    lastIterationAt: state.lastIterationAt,
  });

  return `---
${frontmatter.trim()}
---

# Ralph Loop State

## Task
${state.task}

## Progress
- Iteration ${state.currentIteration}/${state.maxIterations}
- Status: ${state.status}
- Started: ${state.startedAt}
- Last activity: ${state.lastIterationAt}
`;
}

export function parseStateFile(content: string): RalphLoopState {
  const match = content.match(/^---\n([\s\S]+?)\n---/);
  if (!match) {
    throw new Error("Invalid state file format: missing frontmatter");
  }

  const frontmatter = parseYaml(match[1]) as any;

  return {
    task: frontmatter.task,
    completionPromise: frontmatter.completionPromise,
    maxIterations: frontmatter.maxIterations,
    currentIteration: frontmatter.currentIteration,
    status: frontmatter.status,
    startedAt: frontmatter.startedAt,
    lastIterationAt: frontmatter.lastIterationAt,
  };
}

export async function loadState(ctx: any): Promise<RalphLoopState | null> {
  const stateDir = ctx.config.ralph_loop?.state_dir || ".orchestrator";
  const statePath = join(ctx.directory, stateDir, STATE_FILENAME);

  try {
    const content = await readFile(statePath, "utf-8");
    return parseStateFile(content);
  } catch {
    return null;
  }
}

export async function saveState(ctx: any, state: RalphLoopState): Promise<void> {
  const stateDir = ctx.config.ralph_loop?.state_dir || ".orchestrator";
  const dirPath = join(ctx.directory, stateDir);
  const statePath = join(dirPath, STATE_FILENAME);

  // Create directory if it doesn't exist
  await mkdir(dirPath, { recursive: true });

  const content = serializeStateFile(state);
  await writeFile(statePath, content, "utf-8");
}

export async function deleteState(ctx: any): Promise<void> {
  const stateDir = ctx.config.ralph_loop?.state_dir || ".orchestrator";
  const statePath = join(ctx.directory, stateDir, STATE_FILENAME);

  try {
    await unlink(statePath);
  } catch {
    // Ignore if file doesn't exist
  }
}
