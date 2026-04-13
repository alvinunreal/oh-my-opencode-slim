export const TODO_HYGIENE_REMINDER =
  'If the active task changed or finished, update the todo list to match the current work state.';
export const TODO_FINAL_ACTIVE_REMINDER =
  'If you are finishing now, do not leave the active todo in_progress. Mark it completed, or move unfinished work back to pending.';

const RESET = new Set(['todowrite']);
const IGNORE = new Set(['auto_continue']);

interface ToolInput {
  tool: string;
  sessionID?: string;
}

interface SystemInput {
  sessionID?: string;
}

interface SystemOutput {
  system: string[];
}

interface EventInput {
  type: string;
  properties?: {
    info?: { id?: string };
    sessionID?: string;
  };
}

interface Options {
  getTodoState: (sessionID: string) => Promise<{
    hasOpenTodos: boolean;
    openCount: number;
    inProgressCount: number;
    pendingCount: number;
  }>;
  shouldInject?: (sessionID: string) => boolean;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export function createTodoHygiene(options: Options) {
  const pending = new Set<string>();
  const done = new Set<string>();

  function clear(sessionID: string): void {
    pending.delete(sessionID);
    done.delete(sessionID);
  }

  function isFinalActive(state: {
    openCount: number;
    inProgressCount: number;
    pendingCount: number;
  }): boolean {
    return (
      state.inProgressCount === 1 &&
      state.pendingCount === 0 &&
      state.openCount === 1
    );
  }

  return {
    async handleToolExecuteAfter(input: ToolInput): Promise<void> {
      if (!input.sessionID) {
        return;
      }

      const tool = input.tool.toLowerCase();
      if (IGNORE.has(tool)) {
        return;
      }

      try {
        if (RESET.has(tool)) {
          const state = await options.getTodoState(input.sessionID);
          if (!state.hasOpenTodos) {
            clear(input.sessionID);
            options.log?.('Cleared todo hygiene cycle', {
              sessionID: input.sessionID,
              tool,
            });
            return;
          }

          pending.delete(input.sessionID);
          done.delete(input.sessionID);

          if (isFinalActive(state)) {
            pending.add(input.sessionID);
            options.log?.('Armed final-active todo hygiene reminder', {
              sessionID: input.sessionID,
              tool,
            });
            return;
          }

          options.log?.('Reset todo hygiene cycle', {
            sessionID: input.sessionID,
            tool,
          });
          return;
        }

        if (pending.has(input.sessionID) || done.has(input.sessionID)) {
          return;
        }

        if (!(await options.getTodoState(input.sessionID)).hasOpenTodos) {
          return;
        }

        pending.add(input.sessionID);
        options.log?.('Armed todo hygiene reminder', {
          sessionID: input.sessionID,
          tool,
        });
      } catch (error) {
        if (RESET.has(tool)) {
          clear(input.sessionID);
        }
        options.log?.('Skipped todo hygiene reminder: failed to inspect todos', {
          sessionID: input.sessionID,
          tool,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async handleChatSystemTransform(
      input: SystemInput,
      output: SystemOutput,
    ): Promise<void> {
      if (!input.sessionID || !pending.has(input.sessionID)) {
        return;
      }

      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        pending.delete(input.sessionID);
        done.add(input.sessionID);
        return;
      }

      try {
        const state = await options.getTodoState(input.sessionID);
        if (!state.hasOpenTodos) {
          clear(input.sessionID);
          return;
        }

        const finalActive = isFinalActive(state);
        const reminder = finalActive
          ? TODO_FINAL_ACTIVE_REMINDER
          : TODO_HYGIENE_REMINDER;

        pending.delete(input.sessionID);
        done.add(input.sessionID);
        output.system.push(reminder);
        options.log?.('Injected todo hygiene reminder', {
          sessionID: input.sessionID,
          reminder: finalActive ? 'final-active' : 'general',
        });
      } catch (error) {
        clear(input.sessionID);
        options.log?.('Skipped todo hygiene reminder: failed to inspect todos', {
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    handleEvent(event: EventInput): void {
      if (event.type !== 'session.deleted') {
        return;
      }

      const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
      if (!sessionID) {
        return;
      }

      clear(sessionID);
    },

  };
}
