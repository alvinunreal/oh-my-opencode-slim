/**
 * Airlock Hook - Caps tool outputs to prevent context bloat.
 *
 * Applies limits from omoslim.json tool_caps:
 * - bash / run-command: 250 lines
 * - git diff: 400 lines
 * - git log: 100 lines
 * - read / write: 12 KB
 * - web_fetch / fetch: 8 KB
 * - context7 / mcp tools: 16 KB
 * - grep_app: 200 results (lines)
 */

import { capBytes, capLines } from '../../token-discipline/airlock';
import { TOOL_CAPS } from '../../token-discipline/config';

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

type CapSpec = { type: 'lines' | 'bytes'; limit: number };

// Maps tool name patterns → cap specification.
// Keys are matched case-insensitively via the normalisation below.
const TOOL_CAP_MAP: Record<string, CapSpec> = {
  // Bash / shell execution
  bash: { type: 'lines', limit: TOOL_CAPS.bash.maxLines },
  'run-command': { type: 'lines', limit: TOOL_CAPS.bash.maxLines },
  // Git operations (output is line-oriented)
  'git-diff': { type: 'lines', limit: TOOL_CAPS.git_diff.maxLines },
  git_diff: { type: 'lines', limit: TOOL_CAPS.git_diff.maxLines },
  'git-log': { type: 'lines', limit: TOOL_CAPS.git_log.maxLines },
  git_log: { type: 'lines', limit: TOOL_CAPS.git_log.maxLines },
  // File I/O
  read: { type: 'bytes', limit: TOOL_CAPS.file_read.maxBytes },
  write: { type: 'bytes', limit: TOOL_CAPS.file_read.maxBytes },
  // Web / MCP fetch tools
  web_fetch: { type: 'bytes', limit: TOOL_CAPS.web_fetch.maxBytes },
  'web-fetch': { type: 'bytes', limit: TOOL_CAPS.web_fetch.maxBytes },
  fetch: { type: 'bytes', limit: TOOL_CAPS.web_fetch.maxBytes },
  // Context7 MCP library docs
  context7: { type: 'bytes', limit: TOOL_CAPS.context7.maxBytes },
  // grep_app MCP search results (treat each result line as a unit)
  grep_app: { type: 'lines', limit: TOOL_CAPS.grep_app.maxResults },
  'grep-app': { type: 'lines', limit: TOOL_CAPS.grep_app.maxResults },
};

/**
 * Look up cap spec for a tool name, supporting MCP-namespaced names like
 * `context7_get-library-docs` or `grep_app_search`.
 */
function getCapSpec(toolName: string): CapSpec | undefined {
  const lower = toolName.toLowerCase();

  // Exact match first
  if (TOOL_CAP_MAP[lower]) return TOOL_CAP_MAP[lower];

  // MCP-namespaced: e.g. "context7_get-library-docs" → prefix "context7"
  for (const key of Object.keys(TOOL_CAP_MAP)) {
    if (lower.startsWith(`${key}_`) || lower.startsWith(`${key}-`)) {
      return TOOL_CAP_MAP[key];
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
      const capConfig = getCapSpec(input.tool);

      if (!capConfig) {
        return;
      }

      const rawOutput = output.output;
      const capped =
        capConfig.type === 'lines'
          ? capLines(rawOutput, capConfig.limit)
          : capBytes(rawOutput, capConfig.limit);

      if (capped !== rawOutput) {
        output.output = capped;
      }
    },
  };
}
