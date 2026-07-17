import { createInternalAgentTextPart } from '../../utils';
import { registerCommandHook } from '../command-hook-utils';

const COMMAND_NAME = 'report-issue';

function activationPrompt(text: string): string {
  return [
    'The user ran `/report-issue`. Follow the `report-issue` skill',
    'instructions (finalize issue details first, then collect environment +',
    'relevant plugin log, scrub secrets, draft, confirm before submitting).',
    '',
    `User's request: ${text}`,
  ].join('\n');
}

function helpPrompt(): string {
  return [
    'Usage: `/report-issue <description>`',
    '',
    'File a GitHub issue for oh-my-opencode-slim with scrubbed logs.',
    '',
    'Examples:',
    '  `/report-issue the council summary is too verbose`',
    '  `/report-issue feature: add a dry-run flag to /preset`',
    '  `/report-issue bug: /reflect hangs on large conversations`',
  ].join('\n');
}

export function createReportIssueCommandHook(): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
} {
  return {
    registerCommand: (opencodeConfig) => {
      registerCommandHook(
        opencodeConfig,
        COMMAND_NAME,
        'File a GitHub issue for oh-my-opencode-slim with scrubbed logs',
        'Collect env + logs, scrub secrets, draft, confirm, submit via issue form.',
      );
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
