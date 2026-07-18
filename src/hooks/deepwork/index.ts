import { createInternalAgentTextPart } from '../../utils';
import { registerCommandHook } from '../command-hook-utils';

const COMMAND_NAME = 'deepwork';

function activationPrompt(task: string): string {
  return [
    'Use the deepwork skill for this task. Treat it as a heavy coding session.',
    '',
    'Deepwork requirements:',
    '- before planning, delegation, or creating state, inspect existing `.gitignore` and `.ignore`; add only missing entries without duplicates: `.gitignore` must contain `.slim/deepwork/`, and `.ignore` must contain `!.slim/deepwork/` and `!.slim/deepwork/**`; this keeps state git-local yet OpenCode-readable;',
    '- create/update a `.slim/deepwork/` progress file;',
    '- save code/doc deliverables to project paths (e.g. `src/`, `docs/`); reserve `.slim/deepwork/` strictly for progress files;',
    '- keep OpenCode todos synced with the current phase;',
    '- draft a phased implementation/delegation plan with a small number of coherent phases based on dependencies and natural delivery boundaries; do not split work merely to reduce review scope;',
    '- before execution, show the user a compact overview with phase titles/order, delegated specialists and ownership/scope, plus the Oracle review total, gate after each phase, and a short reason for each;',
    '- execute phase by phase with background specialists where useful;',
    '- wait for hook-driven background completion, reconcile results, validate and update state, then ask `@oracle` to review every planned phase before continuing;',
    '- batch material actionable Oracle findings, including simplify/readability feedback, into one bounded remediation pass and validate it with focused evidence; only re-review when the remediation changes the reviewed decision/risk or the original concern cannot otherwise be verified.',
    '',
    'Task:',
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
        'Start a deepwork session for a complex coding task',
        'Use the deepwork workflow for heavy multi-phase coding work',
      );
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      output.parts.length = 0;
      const task = input.arguments.trim();
      if (!task) {
        output.parts.push(
          createInternalAgentTextPart(
            'What task should deepwork manage? Run `/deepwork <task>`.',
          ),
        );
        return;
      }

      output.parts.push({ type: 'text', text: activationPrompt(task) });
    },
  };
}
