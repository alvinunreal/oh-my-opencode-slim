export const TODO_HYGIENE_REMINDER =
  'If the active task changed or finished, update the todo list to match the current work state.';
export const TODO_FINAL_ACTIVE_REMINDER =
  'If you are finishing now, do not leave the active todo in_progress. Mark it completed, or move unfinished work back to pending.';

const RESET = new Set(['todowrite']);
const IGNORE = new Set(['auto_continue']);

type Reason = 'general' | 'final_active';

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

interface RequestStartInput {
  sessionID: string;
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
  const pending = new Map<string, Set<Reason>>();
  const active = new Set<string>();

  function clearCycle(sessionID: string): void {
    pending.delete(sessionID);
  }

  function clear(sessionID: string): void {
    clearCycle(sessionID);
    active.delete(sessionID);
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

  function mark(sessionID: string, reason: Reason): void {
    const reasons = pending.get(sessionID) ?? new Set<Reason>();
    reasons.add(reason);
    pending.set(sessionID, reasons);
  }

  function pick(reasons: Set<Reason>): string {
    if (reasons.has('final_active')) {
      return TODO_FINAL_ACTIVE_REMINDER;
    }

    return TODO_HYGIENE_REMINDER;
  }

  return {
    handleRequestStart(input: RequestStartInput): void {
      clear(input.sessionID);
    },

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
          active.add(input.sessionID);
          clearCycle(input.sessionID);
          const state = await options.getTodoState(input.sessionID);
          if (!state.hasOpenTodos) {
            active.delete(input.sessionID);
            options.log?.('Cleared todo hygiene cycle', {
              sessionID: input.sessionID,
              tool,
            });
            return;
          }

          if (!isFinalActive(state)) {
            options.log?.('Reset todo hygiene cycle', {
              sessionID: input.sessionID,
              tool,
            });
            return;
          }

          mark(input.sessionID, 'final_active');
          options.log?.('Armed final-active todo hygiene reminder', {
            sessionID: input.sessionID,
            tool,
          });
          return;
        }

        if (!active.has(input.sessionID)) {
          return;
        }

        if (pending.get(input.sessionID)?.has('final_active')) {
          return;
        }

        if (options.shouldInject && !options.shouldInject(input.sessionID)) {
          clear(input.sessionID);
          return;
        }

        const state = await options.getTodoState(input.sessionID);
        if (!state.hasOpenTodos) {
          clear(input.sessionID);
          return;
        }

        if (isFinalActive(state)) {
          mark(input.sessionID, 'final_active');
        } else {
          mark(input.sessionID, 'general');
        }

        options.log?.('Armed todo hygiene reminder', {
          sessionID: input.sessionID,
          tool,
          reasons: Array.from(pending.get(input.sessionID) ?? []),
        });
      } catch (error) {
        options.log?.(
          'Skipped todo hygiene reminder: failed to inspect todos',
          {
            sessionID: input.sessionID,
            tool,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    },

    async handleChatSystemTransform(
      input: SystemInput,
      output: SystemOutput,
    ): Promise<void> {
      if (!input.sessionID) {
        return;
      }

      const reasons = pending.get(input.sessionID);
      if (!reasons || reasons.size === 0) {
        return;
      }

      const reminder = pick(reasons);

      if (options.shouldInject && !options.shouldInject(input.sessionID)) {
        clear(input.sessionID);
        return;
      }

      try {
        const state = await options.getTodoState(input.sessionID);
        if (!state.hasOpenTodos) {
          clear(input.sessionID);
          return;
        }

        pending.delete(input.sessionID);
        output.system.push(reminder);
        options.log?.('Injected todo hygiene reminder', {
          sessionID: input.sessionID,
          reminder,
          reasons: Array.from(reasons),
        });
      } catch (error) {
        pending.delete(input.sessionID);
        options.log?.(
          'Skipped todo hygiene reminder: failed to inspect todos',
          {
            sessionID: input.sessionID,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    },

    handleEvent(event: EventInput): void {
      if (event.type !== 'session.deleted') {
        return;
      }

      const sessionID =
        event.properties?.sessionID ?? event.properties?.info?.id;
      if (!sessionID) {
        return;
      }

      clear(sessionID);
    },
  };
}
