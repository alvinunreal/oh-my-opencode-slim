import { createInternalAgentTextPart } from '../../utils';
import {
  DELIVERY_HANDOFF_CONTRACT,
  registerCommandHook,
} from '../command-hook-utils';

const COMMAND_NAME = 'loop';

function activationPrompt(text: string): string {
  return [
    'The user ran `/loop`. This slash command is a user-entry adapter;',
    'the parent/orchestrator coordinates the loop-engineering protocol.',
    'Load the loop-engineering skill as the bounded delivery protocol for',
    'a prepared delivery unit.',
    '',
    '`/loop` requires a prepared unit/specification and a proof contract.',
    'It must not redesign the initiative. Preserve the supplied user',
    'context below and any stricter user attempt limit as a',
    'non-resettable ceiling.',
    '',
    'Prohibited:',
    '- do not create `.opencode/loop-history/`;',
    '- do not treat a pass as initiative completion (a pass completes the',
    '  prepared unit, not the initiative);',
    '- do not use a resettable attempt budget;',
    '- do not invoke `/loop` as a callable subprocedure.',
    '',
    DELIVERY_HANDOFF_CONTRACT,
    '',
    'User context:',
    text,
  ].join('\n');
}

function helpPrompt(): string {
  return [
    'Usage: `/loop <description>`',
    '',
    '`/loop` is a user-entry adapter that directs the parent/orchestrator',
    'to load the loop-engineering protocol for a prepared delivery unit.',
    'Provide the unit description, success criteria, and proof contract.',
    'A stricter attempt limit may be supplied and is honoured as a',
    'non-resettable ceiling.',
    '',
    'It is not a callable subprocedure and does not redesign the',
    'initiative.',
    '',
    'Examples:',
    '  `/loop fix typescript errors until typecheck passes, max 3 tries`',
    '  `/loop improve api performance, response under 500ms, 5 attempts`',
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
      registerCommandHook(
        opencodeConfig,
        COMMAND_NAME,
        'Run bounded delivery via the loop-engineering protocol',
        'User-entry adapter for the loop-engineering bounded delivery protocol.',
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
