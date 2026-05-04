import type { PluginInput } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import {
  createInternalAgentTextPart,
  log,
  SLIM_INTERNAL_INITIATOR_MARKER,
  withTimeout,
} from '../../utils';
import { createTodoHygiene } from './todo-hygiene';

const HOOK_NAME = 'todo-continuation';
const COMMAND_NAME = 'auto-continue';
const TODO_STATE_TIMEOUT_MS = 500;

const CONTINUATION_PROMPT =
  '[Auto-continue: enabled - there are incomplete todos remaining. Continue with the next uncompleted item. Press Esc to cancel. If you need user input or review for the next item, ask instead of proceeding.]';
const TODO_HYGIENE_INSTRUCTION_OPEN = '<instruction name="todo_hygiene">';
const TODO_HYGIENE_INSTRUCTION_CLOSE = '</instruction>';

// Suppress window after user abort (Esc/Ctrl+C) to avoid immediately
// re-continuing something the user explicitly stopped
const SUPPRESS_AFTER_ABORT_MS = 5_000;
const NOTIFICATION_BUSY_GRACE_MS = 250;

const QUESTION_PHRASES = [
  'would you like',
  'should i',
  'do you want',
  'please review',
  'let me know',
  'what do you think',
  'can you confirm',
  'would you prefer',
  'shall i',
  'any thoughts',
];

// Statuses that indicate a todo is terminal (won't be worked on further).
// Uses denylist approach: any status not listed here is considered incomplete.
const TERMINAL_TODO_STATUSES = ['completed', 'cancelled'];

interface ContinuationState {
  enabled: boolean;
  consecutiveContinuations: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  pendingTimerSessionId: string | null;
  suppressUntil: number;
  orchestratorSessionIds: Set<string>;
  sawChatMessage: boolean;
  // True while our auto-injection prompt is in flight — prevents counter reset
  // on session.status→busy and blocks duplicate injections
  isAutoInjecting: boolean;
  // session IDs with an in-flight noReply countdown notification.
  notifyingSessionIds: Set<string>;
  // sessionID → timestamp until which just-completed noReply countdown
  // notification busy transitions are ignored, covering HTTP/SSE reordering.
  notificationBusyUntilBySession: Map<string, number>;
}

function isQuestion(text: string): boolean {
  const lowerText = text.toLowerCase().trim();
  // Match trailing '?' with optional whitespace after it
  if (/\?\s*$/.test(lowerText)) {
    return true;
  }
  return QUESTION_PHRASES.some((phrase) => lowerText.includes(phrase));
}

interface TodoItem {
  id: string;
  content: string;
  status: string;
  priority: string;
}

interface MessageInfo {
  role?: string;
  [key: string]: unknown;
}

interface MessagePart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface ChatTransformMessage {
  info: {
    id?: string;
    role?: string;
    agent?: string;
    sessionID?: string;
  };
  parts: MessagePart[];
}

interface LastExternalUserMessage {
  sessionID?: string;
  agent?: string;
  signature: string;
  message: ChatTransformMessage;
}

interface Message {
  info?: MessageInfo;
  parts?: MessagePart[];
}

function cancelPendingTimer(state: ContinuationState): void {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }
  state.pendingTimerSessionId = null;
}

function resetState(state: ContinuationState): void {
  cancelPendingTimer(state);
  state.consecutiveContinuations = 0;
  state.suppressUntil = 0;
  state.isAutoInjecting = false;
  state.notifyingSessionIds.clear();
  state.notificationBusyUntilBySession.clear();
}

function stripTodoHygieneInstruction(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(TODO_HYGIENE_INSTRUCTION_CLOSE)) {
    return trimmed;
  }

  const start = trimmed.lastIndexOf(TODO_HYGIENE_INSTRUCTION_OPEN);
  if (start === -1) {
    return trimmed;
  }

  return trimmed.slice(0, start).trimEnd();
}

function appendTodoHygieneInstruction(
  message: ChatTransformMessage,
  reminder: string,
): void {
  const textPart = [...message.parts]
    .reverse()
    .find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart) return;

  const baseText = stripTodoHygieneInstruction(textPart.text ?? '');
  const instruction = `${TODO_HYGIENE_INSTRUCTION_OPEN}\n${reminder}\n${TODO_HYGIENE_INSTRUCTION_CLOSE}`;
  textPart.text = baseText ? `${baseText}\n\n${instruction}` : instruction;
}

function stripTodoHygieneInstructionFromMessage(
  message: ChatTransformMessage,
): void {
  const textPart = [...message.parts]
    .reverse()
    .find((part) => part.type === 'text' && typeof part.text === 'string');
  if (!textPart) return;

  textPart.text = stripTodoHygieneInstruction(textPart.text ?? '');
}

export function createTodoContinuationHook(
  ctx: PluginInput,
  config?: {
    maxContinuations?: number;
    cooldownMs?: number;
    autoEnable?: boolean;
    autoEnableThreshold?: number;
  },
): {
  tool: Record<string, unknown>;
  handleToolExecuteAfter: (
    input: {
      tool: string;
      sessionID?: string;
    },
    output?: { output?: unknown },
  ) => Promise<void>;
  handleMessagesTransform: (output: {
    messages: ChatTransformMessage[];
  }) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  handleChatMessage: (input: { sessionID: string; agent?: string }) => void;
  handleCommandExecuteBefore: (
    input: {
      command: string;
      sessionID: string;
      arguments: string;
    },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
} {
  const maxContinuations = config?.maxContinuations ?? 5;
  const cooldownMs = config?.cooldownMs ?? 3000;
  const autoEnable = config?.autoEnable ?? false;
  const autoEnableThreshold = config?.autoEnableThreshold ?? 4;
  const requestSignatureBySession = new Map<string, string>();

  const state: ContinuationState = {
    enabled: false,
    consecutiveContinuations: 0,
    pendingTimer: null,
    pendingTimerSessionId: null,
    suppressUntil: 0,
    orchestratorSessionIds: new Set<string>(),
    sawChatMessage: false,
    isAutoInjecting: false,
    notifyingSessionIds: new Set<string>(),
    notificationBusyUntilBySession: new Map<string, number>(),
  };

  async function fetchTodos(sessionID: string): Promise<TodoItem[]> {
    const result = await withTimeout(
      ctx.client.session.todo({
        path: { id: sessionID },
      }),
      TODO_STATE_TIMEOUT_MS,
      `Todo state lookup timed out after ${TODO_STATE_TIMEOUT_MS}ms`,
    );
    return result.data as TodoItem[];
  }

  const hygiene = createTodoHygiene({
    getTodoState: async (sessionID) => {
      const todos = await fetchTodos(sessionID);
      const openTodos = todos.filter(
        (todo) => !TERMINAL_TODO_STATUSES.includes(todo.status),
      );
      return {
        hasOpenTodos: openTodos.length > 0,
        openCount: openTodos.length,
        inProgressCount: openTodos.filter(
          (todo) => todo.status === 'in_progress',
        ).length,
        pendingCount: openTodos.filter((todo) => todo.status === 'pending')
          .length,
      };
    },
    shouldInject: (sessionID) => isOrchestratorSession(sessionID),
    log: (message, meta) => log(`[${HOOK_NAME}] ${message}`, meta),
  });

  function inferSessionID(
    messages: ChatTransformMessage[],
    index: number,
  ): string | undefined {
    const direct = messages[index]?.info.sessionID;
    if (direct) {
      return direct;
    }

    for (let i = index - 1; i >= 0; i--) {
      const sessionID = messages[i]?.info.sessionID;
      if (sessionID) {
        return sessionID;
      }
    }

    for (let i = index + 1; i < messages.length; i++) {
      const sessionID = messages[i]?.info.sessionID;
      if (sessionID) {
        return sessionID;
      }
    }

    if (state.orchestratorSessionIds.size === 1) {
      return Array.from(state.orchestratorSessionIds)[0];
    }

    return undefined;
  }

  function isExternalUserMessage(message: ChatTransformMessage): boolean {
    if (message.info.role !== 'user') {
      return false;
    }

    const visibleText = message.parts
      .filter(
        (part) =>
          part.type === 'text' &&
          typeof part.text === 'string' &&
          !part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER),
      )
      .map((part) => part.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n');
    const hasNonTextPart = message.parts.some((part) => part.type !== 'text');

    return !(
      !visibleText &&
      !hasNonTextPart &&
      message.parts.some(
        (part) =>
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER),
      )
    );
  }

  function getLastExternalUserMessage(
    messages: ChatTransformMessage[],
  ): LastExternalUserMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!isExternalUserMessage(message)) {
        continue;
      }

      const sessionID = inferSessionID(messages, i);

      const partSignature = message.parts
        .map((part) => {
          if (part.type === 'text' && typeof part.text === 'string') {
            const text = stripTodoHygieneInstruction(part.text);
            return `${part.type}:${text.includes(SLIM_INTERNAL_INITIATOR_MARKER) ? '<internal>' : text.trim()}`;
          }
          return part.type ?? 'unknown';
        })
        .join('|');
      const ordinal = messages
        .slice(0, i + 1)
        .filter((item) => isExternalUserMessage(item)).length;

      return {
        sessionID,
        agent: message.info.agent,
        message,
        signature: message.info.id
          ? `${message.info.id}:${partSignature}`
          : `${ordinal}:${partSignature}`,
      };
    }

    return null;
  }

  async function handleMessagesTransform(output: {
    messages: ChatTransformMessage[];
  }): Promise<void> {
    const lastUserMessage = getLastExternalUserMessage(output.messages);
    if (!lastUserMessage) {
      return;
    }

    if (lastUserMessage.agent && lastUserMessage.agent !== 'orchestrator') {
      return;
    }

    if (!lastUserMessage.sessionID) {
      for (const sessionID of state.orchestratorSessionIds) {
        requestSignatureBySession.delete(sessionID);
        hygiene.handleRequestStart({ sessionID });
      }
      return;
    }

    const knownOrchestrator = isOrchestratorSession(lastUserMessage.sessionID);
    if (lastUserMessage.agent === 'orchestrator') {
      registerOrchestratorSession(lastUserMessage.sessionID);
    } else if (!knownOrchestrator) {
      return;
    }

    if (
      requestSignatureBySession.get(lastUserMessage.sessionID) ===
      lastUserMessage.signature
    ) {
      const reminder = hygiene.getPendingReminder(lastUserMessage.sessionID);
      if (reminder) {
        appendTodoHygieneInstruction(lastUserMessage.message, reminder);
      } else {
        stripTodoHygieneInstructionFromMessage(lastUserMessage.message);
      }
      return;
    }

    requestSignatureBySession.set(
      lastUserMessage.sessionID,
      lastUserMessage.signature,
    );
    stripTodoHygieneInstructionFromMessage(lastUserMessage.message);
    hygiene.handleRequestStart({ sessionID: lastUserMessage.sessionID });
  }

  function markNotificationStarted(sessionID: string): void {
    state.notifyingSessionIds.add(sessionID);
  }

  function markNotificationFinished(sessionID: string): void {
    state.notifyingSessionIds.delete(sessionID);
    state.notificationBusyUntilBySession.set(
      sessionID,
      Date.now() + NOTIFICATION_BUSY_GRACE_MS,
    );
  }

  function clearNotificationState(sessionID: string): void {
    state.notifyingSessionIds.delete(sessionID);
    state.notificationBusyUntilBySession.delete(sessionID);
  }

  function isNotificationBusy(sessionID: string): boolean {
    if (state.notifyingSessionIds.has(sessionID)) {
      return true;
    }

    const until = state.notificationBusyUntilBySession.get(sessionID) ?? 0;
    if (until <= Date.now()) {
      state.notificationBusyUntilBySession.delete(sessionID);
      return false;
    }
    return true;
  }

  function isOrchestratorSession(sessionID: string): boolean {
    return state.orchestratorSessionIds.has(sessionID);
  }

  function registerOrchestratorSession(sessionID: string): void {
    state.orchestratorSessionIds.add(sessionID);
  }

  function handleChatMessage(input: {
    sessionID: string;
    agent?: string;
  }): void {
    if (!input.agent) {
      return;
    }

    state.sawChatMessage = true;
    if (input.agent === 'orchestrator') {
      registerOrchestratorSession(input.sessionID);
    }
  }

  const autoContinue = tool({
    description:
      'Toggle auto-continuation for incomplete todos. When enabled, the orchestrator will automatically continue working through its todo list when it stops with incomplete items.',
    args: { enabled: tool.schema.boolean() },
    execute: async (args) => {
      const enabled = args.enabled;
      state.enabled = enabled;
      state.consecutiveContinuations = 0;

      if (enabled) {
        state.suppressUntil = 0;
        log(`[${HOOK_NAME}] Auto-continue enabled`, { maxContinuations });
        return `Auto-continue enabled. Will auto-continue for up to ${maxContinuations} consecutive injections.`;
      }

      // Cancel any pending timer on disable
      cancelPendingTimer(state);
      log(`[${HOOK_NAME}] Auto-continue disabled`);
      return 'Auto-continue disabled.';
    },
  });

  async function handleEvent(input: {
    event: { type: string; properties?: Record<string, unknown> };
  }): Promise<void> {
    const { event } = input;
    const properties = event.properties ?? {};

    hygiene.handleEvent({
      type: event.type,
      properties: {
        info: properties.info as { id?: string } | undefined,
        sessionID: properties.sessionID as string | undefined,
      },
    });

    if (
      event.type === 'session.idle' ||
      (event.type === 'session.status' &&
        (properties.status as { type?: string } | undefined)?.type === 'idle')
    ) {
      const sessionID = properties.sessionID as string;
      if (!sessionID) {
        return;
      }

      log(`[${HOOK_NAME}] Session idle`, { sessionID });

      // Backward compatibility: if no chat.message has identified the
      // orchestrator yet, fall back to the first idle session.
      if (!state.sawChatMessage && state.orchestratorSessionIds.size === 0) {
        registerOrchestratorSession(sessionID);
        log(`[${HOOK_NAME}] Tracked orchestrator session`, {
          sessionID,
        });
      }

      // Gate: session is orchestrator (needed before auto-enable check)
      if (!isOrchestratorSession(sessionID)) {
        log(`[${HOOK_NAME}] Skipped: not orchestrator session`, {
          sessionID,
        });
        return;
      }

      // Auto-enable check: if configured, not yet enabled, and enough
      // todos exist, automatically enable auto-continue.
      if (autoEnable && !state.enabled) {
        try {
          const todos = await fetchTodos(sessionID);
          const incompleteCount = todos.filter(
            (t) => !TERMINAL_TODO_STATUSES.includes(t.status),
          ).length;
          if (incompleteCount >= autoEnableThreshold) {
            state.enabled = true;
            state.consecutiveContinuations = 0;
            state.suppressUntil = 0;
            log(
              `[${HOOK_NAME}] Auto-enabled: ${incompleteCount} incomplete todos >= threshold ${autoEnableThreshold}`,
              { sessionID },
            );
          } else {
            log(
              `[${HOOK_NAME}] Auto-enable skipped: ${incompleteCount} incomplete todos < threshold ${autoEnableThreshold}`,
              { sessionID },
            );
          }
        } catch (error) {
          log(
            `[${HOOK_NAME}] Warning: failed to fetch todos for auto-enable check`,
            {
              sessionID,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }

      // Safety gate 1: enabled
      if (!state.enabled) {
        log(`[${HOOK_NAME}] Skipped: auto-continue not enabled`, {
          sessionID,
        });
        return;
      }

      // Safety gate 2: incomplete todos exist
      let hasIncompleteTodos = false;
      let incompleteCount = 0;
      try {
        const todos = await fetchTodos(sessionID);
        incompleteCount = todos.filter(
          (t) => !TERMINAL_TODO_STATUSES.includes(t.status),
        ).length;
        hasIncompleteTodos = incompleteCount > 0;
        log(`[${HOOK_NAME}] Fetched todos`, {
          sessionID,
          hasIncompleteTodos,
          total: todos.length,
        });
      } catch (error) {
        log(`[${HOOK_NAME}] Warning: failed to fetch todos`, {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (!hasIncompleteTodos) {
        log(`[${HOOK_NAME}] Skipped: no incomplete todos`, { sessionID });
        return;
      }

      // Safety gate 3: last assistant message is not a question
      let lastAssistantIsQuestion = false;
      try {
        const messagesResult = await ctx.client.session.messages({
          path: { id: sessionID },
        });
        const messages = messagesResult.data as Message[];
        const lastAssistantMessage = messages
          .slice()
          .reverse()
          .find((m) => m.info?.role === 'assistant');
        if (lastAssistantMessage?.parts) {
          const lastText = lastAssistantMessage.parts
            .map((p) => p.text ?? '')
            .join(' ');
          lastAssistantIsQuestion = isQuestion(lastText);
        }
        log(`[${HOOK_NAME}] Fetched messages`, {
          sessionID,
          lastAssistantIsQuestion,
        });
      } catch (error) {
        log(`[${HOOK_NAME}] Warning: failed to fetch messages`, {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (lastAssistantIsQuestion) {
        log(`[${HOOK_NAME}] Skipped: last message is question`, {
          sessionID,
        });
        return;
      }

      // Safety gate 4: below max continuations
      if (state.consecutiveContinuations >= maxContinuations) {
        log(`[${HOOK_NAME}] Skipped: max continuations reached`, {
          sessionID,
          consecutive: state.consecutiveContinuations,
          max: maxContinuations,
        });
        return;
      }

      // Safety gate 5: not in suppress window
      const now = Date.now();
      if (now < state.suppressUntil) {
        log(`[${HOOK_NAME}] Skipped: in suppress window`, {
          sessionID,
          suppressUntil: state.suppressUntil,
        });
        return;
      }

      // Safety gate 6: no pending timer AND no injection in flight
      if (state.pendingTimer !== null || state.isAutoInjecting) {
        log(`[${HOOK_NAME}] Skipped: timer pending or injection in flight`, {
          sessionID,
        });
        return;
      }

      // Schedule continuation
      log(`[${HOOK_NAME}] Scheduling continuation`, {
        sessionID,
        delayMs: cooldownMs,
      });

      // Show countdown notification (noReply = agent doesn't respond)
      markNotificationStarted(sessionID);
      ctx.client.session
        .prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [
              {
                type: 'text',
                text: [
                  `⎔ Auto-continue: ${incompleteCount} incomplete todos remaining — resuming in ${cooldownMs / 1000}s — Esc×2 to cancel`,
                  '',
                  '[system status: continue without acknowledging this notification]',
                ].join('\n'),
              },
            ],
          },
        })
        .catch(() => {
          /* best-effort notification */
        })
        .finally(() => {
          markNotificationFinished(sessionID);
        });

      state.pendingTimerSessionId = sessionID;
      state.pendingTimer = setTimeout(async () => {
        state.pendingTimer = null;
        state.pendingTimerSessionId = null;
        clearNotificationState(sessionID);

        // Guard: may have been disabled during cooldown
        if (!state.enabled) {
          log(`[${HOOK_NAME}] Cancelled: disabled during cooldown`, {
            sessionID,
          });
          return;
        }

        state.isAutoInjecting = true;
        try {
          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [createInternalAgentTextPart(CONTINUATION_PROMPT)],
            },
          });
          state.consecutiveContinuations++;
          log(`[${HOOK_NAME}] Continuation injected`, {
            sessionID,
            consecutive: state.consecutiveContinuations,
          });
        } catch (error) {
          log(`[${HOOK_NAME}] Error: failed to inject continuation`, {
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          state.isAutoInjecting = false;
        }
      }, cooldownMs);
    } else if (event.type === 'session.status') {
      const status = properties.status as { type: string };
      const sessionID = properties.sessionID as string;
      if (status?.type === 'busy') {
        const isOrchestrator = isOrchestratorSession(sessionID);
        const isNotification = isNotificationBusy(sessionID);

        // Only cancel timer for orchestrator session — sub-agents going
        // busy must not silently kill the orchestrator's continuation.
        if (
          isOrchestrator &&
          !isNotification &&
          state.pendingTimerSessionId === sessionID
        ) {
          cancelPendingTimer(state);
        }

        // Only reset consecutive counter for user-initiated activity,
        // not for our own auto-injection prompt. Scope to orchestrator only.
        if (
          !state.isAutoInjecting &&
          !isNotification &&
          isOrchestrator &&
          state.consecutiveContinuations > 0
        ) {
          state.consecutiveContinuations = 0;
          log(`[${HOOK_NAME}] Reset consecutive count on user activity`, {
            sessionID,
          });
        }
      }
    } else if (event.type === 'session.error') {
      const error = properties.error as { name?: string };
      const sessionID = properties.sessionID as string;
      const errorName = error?.name;
      const isOrchestrator = isOrchestratorSession(sessionID);
      if (
        isOrchestrator &&
        (errorName === 'MessageAbortedError' || errorName === 'AbortError')
      ) {
        state.suppressUntil = Date.now() + SUPPRESS_AFTER_ABORT_MS;
        log(`[${HOOK_NAME}] Suppressed continuation after abort`, {
          sessionID,
          errorName,
        });
      }
      if (isOrchestrator) {
        cancelPendingTimer(state);
        log(`[${HOOK_NAME}] Cancelled pending timer on error`, {
          sessionID,
        });
      }
    } else if (event.type === 'session.deleted') {
      // OpenCode sends sessionID in two shapes:
      // properties.info.id (from session store) or properties.sessionID (from event)
      const deletedSessionId =
        (properties.info as { id?: string })?.id ??
        (properties.sessionID as string);

      if (deletedSessionId && isOrchestratorSession(deletedSessionId)) {
        requestSignatureBySession.delete(deletedSessionId);
        if (state.pendingTimerSessionId === deletedSessionId) {
          cancelPendingTimer(state);
          log(`[${HOOK_NAME}] Cancelled pending timer on orchestrator delete`, {
            sessionID: deletedSessionId,
          });
        }

        state.orchestratorSessionIds.delete(deletedSessionId);
        clearNotificationState(deletedSessionId);
        if (state.orchestratorSessionIds.size === 0) {
          resetState(state);
          state.sawChatMessage = false;
        }
        log(`[${HOOK_NAME}] Reset orchestrator session on delete`, {
          sessionID: deletedSessionId,
        });
      }
    }
  }

  async function handleCommandExecuteBefore(
    input: {
      command: string;
      sessionID: string;
      arguments: string;
    },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command !== COMMAND_NAME) {
      return;
    }

    // Seed orchestrator session from slash command (more reliable than
    // first-idle heuristic — slash commands only fire in main chat)
    registerOrchestratorSession(input.sessionID);

    // Clear template text — hook handles everything directly
    output.parts.length = 0;

    // Accept explicit on/off argument, toggle only when no arg
    const arg = input.arguments.trim().toLowerCase();
    let newEnabled: boolean;
    if (arg === 'on') {
      newEnabled = true;
    } else if (arg === 'off') {
      newEnabled = false;
    } else {
      newEnabled = !state.enabled;
    }

    state.enabled = newEnabled;
    state.consecutiveContinuations = 0;

    if (!newEnabled) {
      // Cancel any pending timer on disable
      cancelPendingTimer(state);
      output.parts.push(
        createInternalAgentTextPart(
          '[Auto-continue: disabled by user command.]',
        ),
      );
      log(`[${HOOK_NAME}] Disabled via /${COMMAND_NAME} command`);
      return;
    }

    // Clear suppress window on explicit re-enable
    state.suppressUntil = 0;

    log(`[${HOOK_NAME}] Enabled via /${COMMAND_NAME} command`, {
      maxContinuations,
    });

    // Check for incomplete todos to decide on immediate continuation
    let hasIncompleteTodos = false;
    try {
      const todos = await fetchTodos(input.sessionID);
      hasIncompleteTodos = todos.some(
        (t) => !TERMINAL_TODO_STATUSES.includes(t.status),
      );
    } catch (error) {
      log(`[${HOOK_NAME}] Warning: failed to fetch todos in command hook`, {
        sessionID: input.sessionID,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (hasIncompleteTodos) {
      output.parts.push(
        createInternalAgentTextPart(
          `${CONTINUATION_PROMPT} [Auto-continue enabled: up to ${maxContinuations} continuations.]`,
        ),
      );
    } else {
      output.parts.push(
        createInternalAgentTextPart(
          `[Auto-continue: enabled for up to ${maxContinuations} continuations. No incomplete todos right now.]`,
        ),
      );
    }
  }

  return {
    tool: { auto_continue: autoContinue },
    handleToolExecuteAfter: hygiene.handleToolExecuteAfter,
    handleMessagesTransform,
    handleEvent,
    handleChatMessage,
    handleCommandExecuteBefore,
  };
}
