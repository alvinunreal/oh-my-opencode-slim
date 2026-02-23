/**
 * Airlock Hook - Caps tool outputs to prevent context bloat.
 *
 * Applies limits from omoslim.json tool_caps via capToolOutput:
 * - bash / run-command: 250 lines
 * - git diff: 400 lines
 * - git log: 100 lines
 * - read / write: 12 KB
 * - web_fetch / fetch: 8 KB
 * - context7 / mcp tools: 16 KB
 * - grep_app: 200 results (lines)
 *
 * Noise stripping (npm/yarn/pnpm warnings, progress bars) is applied
 * before capping via capToolOutput.
 */

import { capToolOutput } from '../../token-discipline/airlock';
import type { TOOL_CAPS } from '../../token-discipline/config';

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

// Normalised tool name → TOOL_CAPS key.
// Supports MCP-namespaced names like `context7_get-library-docs`.
const TOOL_NAME_MAP: Record<string, keyof typeof TOOL_CAPS> = {
  // Bash / shell execution
  bash: 'bash',
  'run-command': 'bash',
  // Git operations
  'git-diff': 'git_diff',
  git_diff: 'git_diff',
  'git-log': 'git_log',
  git_log: 'git_log',
  // File I/O
  read: 'file_read',
  write: 'file_read',
  // Web / MCP fetch tools
  web_fetch: 'web_fetch',
  'web-fetch': 'web_fetch',
  fetch: 'web_fetch',
  // Context7 MCP library docs
  context7: 'context7',
  // grep_app MCP search results
  grep_app: 'grep_app',
  'grep-app': 'grep_app',
};

/**
 * Resolve the TOOL_CAPS key for a raw tool name, handling MCP-namespaced
 * names like `context7_get-library-docs` or `grep_app_search`.
 */
function resolveToolCapsKey(
  toolName: string,
): keyof typeof TOOL_CAPS | undefined {
  const lower = toolName.toLowerCase();

  if (TOOL_NAME_MAP[lower]) return TOOL_NAME_MAP[lower];

  for (const key of Object.keys(TOOL_NAME_MAP)) {
    if (lower.startsWith(`${key}_`) || lower.startsWith(`${key}-`)) {
      return TOOL_NAME_MAP[key];
    }
  }

  return undefined;
}

export function createAirlockHook() {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const capsKey = resolveToolCapsKey(input.tool);
      if (!capsKey) return;

      const capped = capToolOutput(capsKey, output.output);
      if (capped !== output.output) {
        output.output = capped;
      }
    },
  };
}
