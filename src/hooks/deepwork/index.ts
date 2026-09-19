import { createInternalAgentTextPart } from '../../utils';
import {
  DELIVERY_HANDOFF_CONTRACT,
  registerCommandHook,
} from '../command-hook-utils';

const COMMAND_NAME = 'deepwork';

function activationPrompt(task: string): string {
  return [
    'The user ran `/deepwork`. This slash command is a user-entry adapter;',
    'the parent/orchestrator is the sole lifecycle controller and',
    'coordinates the deepwork protocol. Load the deepwork skill and follow',
    'it as the initiative planning and coordination protocol for this',
    'initiative. `/deepwork` is never a callable procedure.',
    '',
    'Use `/deepwork` for every Tier-2 initiative (including single-unit',
    'work) and for long-horizon Tier-1 coordination without Tier-2 gates.',
    'Risk and horizon are separate axes; splitting a Tier-2 initiative',
    'into multiple delivery units must not downgrade risk.',
    '',
    'Canonical records: use `.slim/plans/<initiative>/PLAN.md` and',
    '`REVIEW-LOG.md`. Do not create or use `.slim/deepwork/`.',
    '',
    'Prohibited:',
    '- do not run per-phase Oracle gates (the single Oracle gate runs',
    '  once at Tier-2 initiative completion; plan review and',
    '  implementation review assess distinct objects, not phases);',
    '- do not spin up a second retry controller;',
    '- do not treat `/deepwork` as a callable subprocedure.',
    '',
    DELIVERY_HANDOFF_CONTRACT,
    '',
    'User context:',
    task,
  ].join('\n');
}

export function createDeepworkCommandHook(): {
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
        'Coordinate a deepwork initiative for consequential or long-horizon work',
        'User-entry adapter for the canonical deepwork Tier-2 coordination protocol.',
      );
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      output.parts.length = 0;
      const task = input.arguments.trim();
      if (!task) {
        output.parts.push(
          createInternalAgentTextPart(
            'What initiative should deepwork coordinate? Run `/deepwork <initiative>`.',
          ),
        );
        return;
      }

      output.parts.push({ type: 'text', text: activationPrompt(task) });
    },
  };
}
