import { createInternalAgentTextPart } from '../../utils';

const COMMAND_NAME = 'loop';

function historyDir(): string {
  const shortID = Math.random().toString(36).slice(2, 8);
  const timestamp = Date.now().toString(36);
  return `.opencode/loop-history/loop-${timestamp}-${shortID}`;
}

function activationPrompt(text: string): string {
  const dir = historyDir();

  return [
    'The user ran `/loop`. From the text below, extract: goal, successCriteria, maxAttempts.',
    '',
    'If ANY are missing or unclear - push back and ask the user to clarify.',
    'Do not assume or guess. All three must be explicit.',
    '',
    'Once all three are clear, run the loop:',
    '',
    text,
    '',
    'For each attempt:',
    `1. Read \`${dir}/\` for prior results`,
    '2. Dispatch @fixer with the goal',
    '3. Verify per the successCriteria',
    `4. Write result to \`${dir}/history-{NNN}.md\` (PASS/FAIL + reason)`,
    '5. PASS -> stop. FAIL under maxAttempts -> retry. FAIL at max -> escalate.',
  ].join('\n');
}

function helpPrompt(): string {
  return [
    'Usage: `/loop <description>`',
    '',
    'Describe what to accomplish, what success looks like, and how many tries.',
    '',
    'Examples:',
    '  `/loop fix typescript errors until typecheck passes, max 3 tries`',
    '  `/loop improve api performance until response under 500ms, try 5 times`',
    '  `/loop refactor auth module, tests must pass, 4 attempts max`',
  ].join('\n');
}

export function createLoopCommandHook(): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
} {
  return {
    registerCommand: (opencodeConfig) => {
      const cfg = opencodeConfig.command as Record<string, unknown> | undefined;
      if (cfg?.[COMMAND_NAME]) return;
      if (!opencodeConfig.command) opencodeConfig.command = {};
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Run an automated execute-verify loop',
        description:
          'Dispatch fixer, verify, iterate with file-based history on disk.',
      };
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      output.parts.length = 0;
      const args = input.arguments.trim();
      if (!args) {
        output.parts.push(createInternalAgentTextPart(helpPrompt()));
        return;
      }

      output.parts.push({ type: 'text', text: activationPrompt(args) });
    },
  };
}
