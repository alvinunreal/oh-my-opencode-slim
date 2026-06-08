import { createInternalAgentTextPart } from '../../utils';

const COMMAND_NAME = 'deepwork';

function activationPrompt(task: string): string {
  return [
    'Use the deepwork skill for this task. Treat it as a heavy coding session.',
    '',
    'Deepwork requirements:',
    '- create/update a `.slim/deepwork/` progress file;',
    '- keep OpenCode todos synced with the current phase;',
    '- draft a plan and get `@oracle` review before implementation;',
    '- create and review a phased implementation/delegation plan;',
    '- execute phase by phase with background specialists where useful;',
    '- wait for hook-driven background completion, reconcile results, validate, and ask `@oracle` to review each phase;',
    '- ask `@oracle` to include simplify/readability feedback in phase reviews;',
    '- fix actionable review issues before continuing.',
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
      const commandConfig = opencodeConfig.command as
        | Record<string, unknown>
        | undefined;
      if (commandConfig?.[COMMAND_NAME]) return;
      if (!opencodeConfig.command) opencodeConfig.command = {};
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Start a deepwork session for a complex coding task',
        description:
          'Use the deepwork workflow for heavy multi-phase coding work',
      };
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
