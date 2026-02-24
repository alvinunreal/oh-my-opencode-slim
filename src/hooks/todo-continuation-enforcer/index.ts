import { log } from '../../utils/logger';

const HOOK_NAME = 'todo-continuation-enforcer';
const CONTINUATION_COOLDOWN_MS = 30_000;

const CONTINUATION_PROMPT = `Incomplete tasks remain in your todo list. Continue with the next pending task now.

Rules:
- Continue execution without asking for additional permission
- Keep changes focused and small
- Mark completed todos as completed
- If blocked, clearly state blocker and the exact next action needed`;

type Todo = {
  content?: string;
  status?: string;
};

type SessionState = {
  enabled: boolean;
  inFlight: boolean;
  lastInjectedAt?: number;
};

export function createTodoContinuationEnforcer(args: {
  ctx: unknown;
  defaultEnabled?: boolean;
}) {
  const { ctx, defaultEnabled = true } = args;
  const stateBySession = new Map<string, SessionState>();

  const getState = (sessionID: string): SessionState => {
    const existing = stateBySession.get(sessionID);
    if (existing) return existing;
    const next: SessionState = {
      enabled: defaultEnabled,
      inFlight: false,
    };
    stateBySession.set(sessionID, next);
    return next;
  };

  const parseCommand = (text: string): 'on' | 'off' | 'status' | null => {
    const normalized = text.trim().toLowerCase();
    if (normalized === '/todo-cont on') return 'on';
    if (normalized === '/todo-cont off') return 'off';
    if (normalized === '/todo-cont status') return 'status';
    return null;
  };

  const readTextFromParts = (parts: unknown): string => {
    if (!Array.isArray(parts)) return '';
    const textPart = parts.find((p) => {
      if (!p || typeof p !== 'object') return false;
      return (p as { type?: unknown }).type === 'text';
    }) as { text?: unknown } | undefined;
    return typeof textPart?.text === 'string' ? textPart.text : '';
  };

  const writeTextToParts = (parts: unknown, text: string): void => {
    if (!Array.isArray(parts)) return;
    const idx = parts.findIndex((p) => {
      if (!p || typeof p !== 'object') return false;
      return (p as { type?: unknown }).type === 'text';
    });
    if (idx >= 0) {
      const next = parts[idx] as Record<string, unknown>;
      next.text = text;
    }
  };

  const runContinuation = async (sessionID: string): Promise<void> => {
    const sessionState = getState(sessionID);

    if (!sessionState.enabled) {
      return;
    }

    if (sessionState.inFlight) {
      return;
    }

    const now = Date.now();
    if (
      sessionState.lastInjectedAt &&
      now - sessionState.lastInjectedAt < CONTINUATION_COOLDOWN_MS
    ) {
      return;
    }

    const client = (ctx as {
      client?: {
        session?: {
          todo?: (input: { path: { id: string } }) => Promise<unknown>;
          promptAsync?: (input: {
            path: { id: string };
            body: {
              parts: Array<{ type: 'text'; text: string }>;
            };
            query: { directory: string };
          }) => Promise<unknown>;
        };
      };
      directory?: string;
    }).client;

    const directory = (ctx as { directory?: string }).directory;

    if (!client?.session?.todo || !client?.session?.promptAsync || !directory) {
      return;
    }

    let todos: Todo[] = [];
    try {
      const response = await client.session.todo({ path: { id: sessionID } });
      const maybe = response as { data?: unknown };
      const data = Array.isArray(maybe?.data)
        ? maybe.data
        : Array.isArray(response)
          ? response
          : [];
      todos = data as Todo[];
    } catch (error) {
      log(`[${HOOK_NAME}] failed to fetch todos`, {
        sessionID,
        error: String(error),
      });
      return;
    }

    const remaining = todos.filter(
      (todo) => todo?.status !== 'completed' && todo?.status !== 'cancelled',
    );

    if (remaining.length === 0) {
      return;
    }

    const todoList = remaining
      .map((todo) => `- [${todo.status ?? 'pending'}] ${todo.content ?? '(untitled)'}`)
      .join('\n');

    sessionState.inFlight = true;
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [
            {
              type: 'text',
              text: `${CONTINUATION_PROMPT}\n\nRemaining tasks:\n${todoList}`,
            },
          ],
        },
        query: { directory },
      });

      sessionState.lastInjectedAt = Date.now();
      log(`[${HOOK_NAME}] continuation injected`, {
        sessionID,
        remaining: remaining.length,
      });
    } catch (error) {
      log(`[${HOOK_NAME}] continuation injection failed`, {
        sessionID,
        error: String(error),
      });
    } finally {
      sessionState.inFlight = false;
    }
  };

  return {
    'chat.message': async (
      input: { sessionID?: string },
      output: { parts?: unknown },
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID) return;

      const text = readTextFromParts(output.parts);
      const command = parseCommand(text);
      if (!command) return;

      const sessionState = getState(sessionID);

      if (command === 'on') {
        sessionState.enabled = true;
        writeTextToParts(
          output.parts,
          'Todo continuation is now ON for this session. Confirm in one short sentence.',
        );
        log(`[${HOOK_NAME}] toggled on`, { sessionID });
        return;
      }

      if (command === 'off') {
        sessionState.enabled = false;
        writeTextToParts(
          output.parts,
          'Todo continuation is now OFF for this session. Confirm in one short sentence.',
        );
        log(`[${HOOK_NAME}] toggled off`, { sessionID });
        return;
      }

      writeTextToParts(
        output.parts,
        `Todo continuation status: ${sessionState.enabled ? 'ON' : 'OFF'} for this session. Confirm in one short sentence.`,
      );
    },

    event: async (input: {
      event: { type: string; properties?: { sessionID?: string; info?: { id?: string } } };
    }): Promise<void> => {
      const event = input.event;
      const props = event.properties;

      if (event.type === 'session.idle') {
        const sessionID = props?.sessionID;
        if (!sessionID) return;
        await runContinuation(sessionID);
        return;
      }

      if (event.type === 'session.deleted') {
        const sessionID = props?.info?.id;
        if (!sessionID) return;
        stateBySession.delete(sessionID);
      }
    },
  };
}
