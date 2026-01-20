import { load as parseYaml, dump as stringifyYaml } from "js-yaml";
import type { RalphLoopState } from "./types";

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
