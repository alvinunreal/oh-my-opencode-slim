import { stripFrontmatter } from '../../cli/custom-skills';
import skillMarkdown from '../../skills/deepwork/SKILL.md' with {
  type: 'text',
};
import { createInternalAgentTextPart } from '../../utils';
import { registerCommandHook } from '../command-hook-utils';

const COMMAND_NAME = 'deepwork';

// SKILL.md is the single contract source. The /deepwork command is
// self-contained: it injects the full body (bundled at build time) plus the
// pinned per-session path, so it works regardless of whether the resident
// skill is registered — listing `deepwork` in disabled_skills removes the
// resident listing without losing the command (#1332).
const instructions = stripFrontmatter(skillMarkdown).trim();

/**
 * The activation message's head announcement. Single contract source: the
 * deepwork-goal hook skips injection while this exact sentence (or any
 * intact quote of it) is visible in a genuine part, because it already
 * names the head path.
 */
export function routerHeadAnnouncement(sessionID: string): string {
  return `Your deepwork router head is \`.slim/deepwork/${sessionID}.md\`; the skill covers setup, planning, gates, and state rules.`;
}

function activationPrompt(task: string, sessionID: string): string {
  return [
    instructions,
    '',
    routerHeadAnnouncement(sessionID),
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

      output.parts.push({
        type: 'text',
        text: activationPrompt(task, input.sessionID),
      });
    },
  };
}
