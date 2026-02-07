import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from './paths';
import type { ConfigMergeResult } from './types';

function getCommandsDir(): string {
  return join(getConfigDir(), 'commands');
}

const OMOS_COMMAND_FILE = 'omos.md';

function getOmosCommandTemplate(): string {
  return `---
description: Manage agent model preferences with preview + apply
---

Use the \`omos_preferences\` tool to manage manual model plans.

Workflow:
1) Run \`operation=show\` to inspect current effective plan.
2) Build a full 6-agent manual plan (primary + fallback1 + fallback2 + fallback3 per agent).
3) Run \`operation=plan\` with the plan payload and review the diff preview.
4) Run \`operation=apply\` with the same payload and \`confirm=true\` to persist.
5) Use \`operation=reset-agent\` with \`agent=<name>\` to reset one agent.

Notes:
- \`target\` can be \`auto\`, \`global\`, or \`project\`.
- Project config has higher precedence than global config.
- After apply, start a new session for changes to take effect.
`;
}

export function installOmosCommandEntry(): ConfigMergeResult {
  const commandsDir = getCommandsDir();
  const commandPath = join(commandsDir, OMOS_COMMAND_FILE);

  try {
    if (!existsSync(commandsDir)) {
      mkdirSync(commandsDir, { recursive: true });
    }

    writeFileSync(commandPath, getOmosCommandTemplate());
    return { success: true, configPath: commandPath };
  } catch (err) {
    return {
      success: false,
      configPath: commandPath,
      error: `Failed to install /omos command: ${err}`,
    };
  }
}
