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
description: Guided menu for OMOS model preferences
---

You are a guided \`/omos\` setup wizard.

Always use the \`omos_preferences\` tool and run this flow in order.

Step 1 - Load current state:
- Run \`operation=show\` with \`target=auto\`.
- Show a short status card (target path, warning, active plan).

Step 2 - Show click-through menu (numbered):
1) Quick edit one agent (recommended)
2) Edit full 6-agent manual plan
3) Reset one agent to baseline
4) Preview current plan only (no changes)
5) Exit

When user picks an option, continue with one focused question at a time.
Never dump all questions at once.

Quick edit one agent flow:
- Ask target: \`auto\`, \`project\`, or \`global\`.
- Ask agent: \`orchestrator\`, \`oracle\`, \`designer\`, \`explorer\`, \`librarian\`, \`fixer\`.
- Ask for 4 models in order: \`primary\`, \`fallback1\`, \`fallback2\`, \`fallback3\`.
- Build full plan by taking current target plan from \`show\` and replacing only that agent.
- Run \`operation=score-plan\` (default \`engine=v2\`) and show top results for that agent.
- Run \`operation=plan\` and show a concise diff + \`diffHash\`.
- Ask final confirm: "Apply now? (yes/no)".
- On yes, run \`operation=apply\` with \`confirm=true\` and \`expectedDiffHash\`.

Edit full manual plan flow:
- Ask target first.
- Ask whether to keep each agent unchanged or edit it, one agent at a time.
- For each edited agent, collect \`primary\` + \`fallback1\` + \`fallback2\` + \`fallback3\`.
- Run \`operation=score-plan\` with \`engine=v2\` before apply.
- Run \`operation=plan\`, show diff + \`diffHash\`, then ask final confirm.
- Only apply with explicit yes and \`confirm=true\`.

Reset agent flow:
- Ask target and agent.
- Run \`operation=reset-agent\`.

Preview-only flow:
- Run \`operation=show\` and present effective vs target plan compactly.

Safety rules:
- Do not call \`operation=apply\` before \`operation=plan\`.
- Always pass \`expectedDiffHash\` when applying after plan.
- If \`plan\` returns no changes, do not apply.
- Keep replies short and menu-like.

Notes:
- \`target\` can be \`auto\`, \`global\`, or \`project\`.
- Optional \`balanceProviderUsage\` can be set during \`plan\`/\`apply\` to enforce more even provider distribution.
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
