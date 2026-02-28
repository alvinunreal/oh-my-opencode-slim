import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../../config';

const AUTOPILOT_CONTINUE_PROMPT =
  '[AUTOPILOT] Continue working through remaining todos in this same session. Pick the next pending or in-progress todo and execute it now. Do not wait for a new user message. Stop only when all todos are completed or cancelled.';

const TERMINAL_TODO_STATUSES = new Set(['completed', 'cancelled', 'done']);

interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

interface MessagePart {
  type: string;
  text?: string;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

interface SessionAutopilotState {
  enabled: boolean;
  autoContinueCount: number;
  lastKickAt: number;
}

interface TodoEntry {
  status?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasKeyword(text: string, keyword: string): boolean {
  if (!keyword.trim()) return false;
  const escaped = escapeRegExp(keyword.trim());
  const pattern = new RegExp(
    `(^|[^a-zA-Z0-9_])${escaped}([^a-zA-Z0-9_]|$)`,
    'i',
  );
  return pattern.test(text);
}

function extractTodoList(data: unknown): TodoEntry[] {
  if (Array.isArray(data)) {
    return data.filter((item): item is TodoEntry => typeof item === 'object');
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as { items?: unknown; todos?: unknown };
  if (Array.isArray(record.items)) {
    return record.items.filter(
      (item): item is TodoEntry => typeof item === 'object',
    );
  }

  if (Array.isArray(record.todos)) {
    return record.todos.filter(
      (item): item is TodoEntry => typeof item === 'object',
    );
  }

  return [];
}

function isActiveTodo(todo: TodoEntry): boolean {
  const status = todo.status?.toLowerCase();
  if (!status) return true;
  return !TERMINAL_TODO_STATUSES.has(status);
}

export function createAutopilotHook(ctx: PluginInput, config: PluginConfig) {
  const autopilotConfig = config.autopilot;
  const enabled = autopilotConfig?.enabled ?? true;
  const keyword = autopilotConfig?.keyword ?? 'autopilot';
  const disableKeyword = autopilotConfig?.disableKeyword ?? 'manual';
  const cooldownMs = autopilotConfig?.cooldownMs ?? 8000;
  const maxAutoContinues = autopilotConfig?.maxAutoContinues ?? 10;

  const stateBySession = new Map<string, SessionAutopilotState>();

  const getOrCreateState = (sessionID: string): SessionAutopilotState => {
    const existing = stateBySession.get(sessionID);
    if (existing) return existing;
    const created: SessionAutopilotState = {
      enabled: false,
      autoContinueCount: 0,
      lastKickAt: 0,
    };
    stateBySession.set(sessionID, created);
    return created;
  };

  const maybeContinueSession = async (sessionID: string): Promise<void> => {
    const current = stateBySession.get(sessionID);
    if (!current?.enabled) return;

    const now = Date.now();
    if (now - current.lastKickAt < cooldownMs) return;

    if (current.autoContinueCount >= maxAutoContinues) {
      current.enabled = false;
      return;
    }

    const todoFn = (
      ctx.client.session as unknown as {
        todo?: (args: { path: { id: string } }) => Promise<{ data?: unknown }>;
      }
    ).todo;

    if (!todoFn) {
      return;
    }

    const todoResult = await todoFn({ path: { id: sessionID } });
    const todos = extractTodoList(todoResult.data);
    const hasActiveTodos = todos.some(isActiveTodo);

    if (!hasActiveTodos) {
      current.enabled = false;
      current.autoContinueCount = 0;
      return;
    }

    await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: 'text', text: AUTOPILOT_CONTINUE_PROMPT }],
      },
    });

    current.autoContinueCount += 1;
    current.lastKickAt = now;
  };

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      if (!enabled) return;

      const { messages } = output;
      if (messages.length === 0) return;

      let lastUserMessage: MessageWithParts | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === 'user') {
          lastUserMessage = messages[i];
          break;
        }
      }

      if (!lastUserMessage) return;

      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') return;

      const sessionID = lastUserMessage.info.sessionID;
      if (!sessionID) return;

      const textPart = lastUserMessage.parts.find(
        (part) => part.type === 'text' && typeof part.text === 'string',
      );
      if (!textPart?.text) return;

      const text = textPart.text;
      const shouldDisable = hasKeyword(text, disableKeyword);
      const shouldEnable = hasKeyword(text, keyword);

      if (!shouldDisable && !shouldEnable) return;

      const state = getOrCreateState(sessionID);
      if (shouldDisable) {
        state.enabled = false;
        state.autoContinueCount = 0;
        return;
      }

      state.enabled = true;
      state.autoContinueCount = 0;
      state.lastKickAt = 0;
    },

    event: async (input: {
      event: {
        type: string;
        properties?: {
          sessionID?: string;
          status?: { type?: string };
          info?: { id?: string };
        };
      };
    }): Promise<void> => {
      if (!enabled) return;

      const event = input.event;

      if (event.type === 'session.deleted') {
        const sessionID =
          event.properties?.sessionID ?? event.properties?.info?.id;
        if (sessionID) {
          stateBySession.delete(sessionID);
        }
        return;
      }

      if (event.type !== 'session.status') return;

      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;

      if (event.properties?.status?.type !== 'idle') return;

      try {
        await maybeContinueSession(sessionID);
      } catch {
        // Fail safe: do not break plugin event loop if todo API/prompt fails.
      }
    },
  };
}

export { AUTOPILOT_CONTINUE_PROMPT, extractTodoList, hasKeyword, isActiveTodo };
