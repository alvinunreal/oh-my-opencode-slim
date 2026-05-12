/**
 * Command registration manager for subtask functionality.
 *
 * Manages the /subtask slash command registration and the SUBTASK_COMMAND
 * template that guides the AI in generating subtask prompts.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import type { SubtaskState } from './state';

const COMMAND_NAME = 'subtask';

/**
 * The subtask command template that guides the AI in generating subtask
 * prompts.
 */
const SUBTASK_COMMAND_TEMPLATE = `Start a focused subtask worker.

The user's request below is the full scope for the worker. Do not broaden it.
Create a self-contained worker prompt that includes:
- the exact objective
- relevant context from this conversation
- specific files/paths that matter
- expected deliverables
- validation the worker should run, if applicable

USER REQUEST:
$ARGUMENTS

Then call the subtask tool:
\`subtask(prompt="...", files=["src/foo.ts", "docs/bar.md"])\`

Only include files that are clearly relevant. If no files are needed, omit files.`;

/**
 * Creates a subtask command manager.
 *
 * Handles registration of the /subtask command and processing of chat
 * messages to inject synthetic file parts for subtask sessions.
 */
export function createSubtaskCommandManager(
  _ctx: PluginInput,
  state: SubtaskState,
) {
  /**
   * Register the /subtask command in the OpenCode config.
   */
  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        description: 'Create a focused subtask prompt for a new session',
        template: SUBTASK_COMMAND_TEMPLATE,
      };
    }
  }

  return {
    registerCommand,
    handleEvent(input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string; parentID?: string };
          sessionID?: string;
        };
      };
    }): void {
      if (input.event.type === 'session.created') {
        const info = input.event.properties?.info;
        if (!info?.id || !info.parentID) return;

        const source = state.sourceFor(info.parentID);
        if (source) state.markSession(info.id, source);
        return;
      }

      if (input.event.type !== 'session.deleted') return;
      const sessionID =
        input.event.properties?.info?.id ?? input.event.properties?.sessionID;
      if (sessionID) state.unmarkSession(sessionID);
    },
  };
}

export type SubtaskCommandManager = ReturnType<
  typeof createSubtaskCommandManager
>;
