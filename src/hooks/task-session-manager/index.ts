import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { AgentName } from '../../config';
import {
  type ContextFile,
  deriveTaskSessionLabel,
  parseTaskIdFromTaskOutput,
  SessionManager,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils';

interface TaskArgs {
  description?: unknown;
  prompt?: unknown;
  subagent_type?: unknown;
  task_id?: unknown;
}

interface PendingTaskCall {
  callId: string;
  parentSessionId: string;
  agentType: AgentName;
  label: string;
  resumedTaskId?: string;
}

const AGENT_NAME_SET = new Set<AgentName>([
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
  'observer',
  'council',
  'councillor',
]);

const MAX_PENDING_TASK_CALLS = 100;

interface PendingContextFile {
  path: string;
  lines: Set<number>;
  lastReadAt: number;
}

interface ChatMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  info: {
    role: string;
    agent?: string;
    sessionID?: string;
  };
  parts: ChatMessagePart[];
}

const RESUMABLE_SESSIONS_START = '<resumable_sessions>';
const RESUMABLE_SESSIONS_END = '</resumable_sessions>';

function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && AGENT_NAME_SET.has(value as AgentName);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractPath(output: string): string | undefined {
  return /<path>([^<]+)<\/path>/.exec(output)?.[1];
}

function normalizePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return file;
  }
  return relative;
}

function extractReadFiles(
  root: string,
  output: { output: unknown; metadata?: unknown },
): ContextFile[] {
  if (typeof output.output !== 'string') return [];

  const file = extractPath(output.output);
  if (!file) return [];

  return [
    {
      path: normalizePath(root, file),
      lineCount: countReadLines(output.output).length,
      lineNumbers: countReadLines(output.output),
      lastReadAt: Date.now(),
    },
  ];
}

function countReadLines(output: string): number[] {
  const lines = new Set<number>();
  for (const match of output.matchAll(/^([0-9]+):/gm)) {
    lines.add(Number(match[1]));
  }
  return [...lines];
}

export function createTaskSessionManagerHook(
  _ctx: PluginInput,
  options: {
    maxSessionsPerAgent: number;
    readContextMinLines?: number;
    readContextMaxFiles?: number;
    shouldManageSession: (sessionID: string) => boolean;
  },
) {
  const sessionManager = new SessionManager(options.maxSessionsPerAgent, {
    readContextMinLines: options.readContextMinLines,
    readContextMaxFiles: options.readContextMaxFiles,
  });
  const pendingCalls = new Map<string, PendingTaskCall>();
  const pendingCallOrder: string[] = [];
  const contextByTask = new Map<string, Map<string, PendingContextFile>>();
  const pendingManagedTaskIds = new Set<string>();
  let anonymousPendingCallId = 0;

  function addTaskContext(taskId: string, files: ContextFile[]): void {
    if (files.length === 0) return;

    let context = contextByTask.get(taskId);
    if (!context) {
      context = new Map();
      contextByTask.set(taskId, context);
    }
    for (const file of files) {
      const pending = context.get(file.path) ?? {
        path: file.path,
        lines: new Set<number>(),
        lastReadAt: file.lastReadAt,
      };
      for (const line of file.lineNumbers ?? []) {
        pending.lines.add(line);
      }
      pending.lastReadAt = Math.max(pending.lastReadAt, file.lastReadAt);
      context.set(file.path, pending);
    }

    sessionManager.addContext(taskId, contextFilesForPrompt(context));
  }

  function contextFilesForPrompt(
    context: Map<string, PendingContextFile> | undefined,
  ): ContextFile[] {
    if (!context) return [];
    return [...context.values()].map((file) => ({
      path: file.path,
      lineCount: file.lines.size,
      lastReadAt: file.lastReadAt,
    }));
  }

  function canTrackTaskContext(taskId: string): boolean {
    return (
      pendingManagedTaskIds.has(taskId) || sessionManager.taskIds().has(taskId)
    );
  }

  function pruneContext(): void {
    const remembered = sessionManager.taskIds();
    for (const taskId of contextByTask.keys()) {
      if (!pendingManagedTaskIds.has(taskId) && !remembered.has(taskId)) {
        contextByTask.delete(taskId);
      }
    }
  }

  function isMissingRememberedSessionError(output: string): boolean {
    const firstLine = output.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? '';
    return (
      firstLine.startsWith('[error]') &&
      firstLine.includes('session') &&
      (firstLine.includes('not found') || firstLine.includes('no session'))
    );
  }

  function pendingCallId(input: {
    callID?: string;
    sessionID?: string;
  }): string {
    return (
      input.callID ??
      `${input.sessionID ?? 'unknown'}:anonymous-${++anonymousPendingCallId}`
    );
  }

  function rememberPendingCall(call: PendingTaskCall): void {
    const existingIndex = pendingCallOrder.indexOf(call.callId);
    if (existingIndex >= 0) {
      pendingCallOrder.splice(existingIndex, 1);
    }

    pendingCalls.set(call.callId, call);
    pendingCallOrder.push(call.callId);

    while (pendingCallOrder.length > MAX_PENDING_TASK_CALLS) {
      const evictedCallId = pendingCallOrder.shift();
      if (!evictedCallId) {
        break;
      }
      pendingCalls.delete(evictedCallId);
    }
  }

  function takePendingCall(
    callId?: string,
    parentSessionId?: string,
  ): PendingTaskCall | undefined {
    const resolvedCallId = callId ?? firstPendingCallForParent(parentSessionId);
    if (!resolvedCallId) return undefined;

    const pending = pendingCalls.get(resolvedCallId);
    pendingCalls.delete(resolvedCallId);

    const orderIndex = pendingCallOrder.indexOf(resolvedCallId);
    if (orderIndex >= 0) {
      pendingCallOrder.splice(orderIndex, 1);
    }

    return pending;
  }

  function firstPendingCallForParent(
    parentSessionId?: string,
  ): string | undefined {
    if (!parentSessionId) return undefined;
    return pendingCallOrder.find(
      (callId) => pendingCalls.get(callId)?.parentSessionId === parentSessionId,
    );
  }

  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;
      if (!input.sessionID || !options.shouldManageSession(input.sessionID)) {
        return;
      }
      if (!isObjectRecord(output.args)) return;

      const args = output.args as TaskArgs;
      if (!isAgentName(args.subagent_type)) return;

      const label = deriveTaskSessionLabel({
        description:
          typeof args.description === 'string' ? args.description : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        agentType: args.subagent_type,
      });

      const pendingCall: PendingTaskCall = {
        callId: pendingCallId({
          callID: input.callID,
          sessionID: input.sessionID,
        }),
        parentSessionId: input.sessionID,
        agentType: args.subagent_type,
        label,
      };
      rememberPendingCall(pendingCall);

      if (typeof args.task_id !== 'string' || args.task_id.trim() === '') {
        return;
      }

      const requested = args.task_id.trim();
      const remembered = sessionManager.resolve(
        input.sessionID,
        args.subagent_type,
        requested,
      );

      if (!remembered) {
        delete args.task_id;
        return;
      }

      args.task_id = remembered.taskId;
      pendingManagedTaskIds.add(remembered.taskId);
      sessionManager.markUsed(
        input.sessionID,
        args.subagent_type,
        remembered.taskId,
      );
      pendingCall.resumedTaskId = remembered.taskId;
      rememberPendingCall(pendingCall);
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() === 'read') {
        if (input.sessionID && canTrackTaskContext(input.sessionID)) {
          addTaskContext(
            input.sessionID,
            extractReadFiles(_ctx.directory, output),
          );
        }
        return;
      }

      if (input.tool.toLowerCase() !== 'task') return;

      const pending = takePendingCall(input.callID, input.sessionID);

      if (!pending || typeof output.output !== 'string') return;
      const taskId = parseTaskIdFromTaskOutput(output.output);
      if (!taskId) {
        if (
          pending.resumedTaskId &&
          isMissingRememberedSessionError(output.output)
        ) {
          sessionManager.drop(
            pending.parentSessionId,
            pending.agentType,
            pending.resumedTaskId,
          );
        }
        return;
      }

      if (pending.resumedTaskId && pending.resumedTaskId !== taskId) {
        sessionManager.drop(
          pending.parentSessionId,
          pending.agentType,
          pending.resumedTaskId,
        );
      }

      sessionManager.remember({
        parentSessionId: pending.parentSessionId,
        taskId,
        agentType: pending.agentType,
        label: pending.label,
      });
      pendingManagedTaskIds.delete(taskId);
      const contextFiles = contextFilesForPrompt(contextByTask.get(taskId));
      sessionManager.addContext(taskId, contextFiles);
      pruneContext();
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: ChatMessage[] },
    ): Promise<void> => {
      for (let i = output.messages.length - 1; i >= 0; i -= 1) {
        const message = output.messages[i];
        if (message.info.role !== 'user') continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') return;
        if (
          !message.info.sessionID ||
          !options.shouldManageSession(message.info.sessionID)
        ) {
          return;
        }

        const reminder = sessionManager.formatForPrompt(message.info.sessionID);
        if (!reminder) return;

        const textPart = message.parts.find(
          (part) => part.type === 'text' && typeof part.text === 'string',
        );
        if (!textPart) return;
        if (textPart.text?.includes(SLIM_INTERNAL_INITIATOR_MARKER)) return;
        if (textPart.text?.includes(RESUMABLE_SESSIONS_START)) return;

        textPart.text = [
          textPart.text ?? '',
          '',
          RESUMABLE_SESSIONS_START,
          reminder,
          RESUMABLE_SESSIONS_END,
        ].join('\n');
        return;
      }
    },

    event: async (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string; parentID?: string };
          sessionID?: string;
        };
      };
    }): Promise<void> => {
      if (input.event.type === 'session.created') {
        const info = input.event.properties?.info;
        if (
          info?.id &&
          info.parentID &&
          options.shouldManageSession(info.parentID)
        ) {
          pendingManagedTaskIds.add(info.id);
        }
        return;
      }

      if (input.event.type !== 'session.deleted') return;
      const sessionId =
        input.event.properties?.info?.id ?? input.event.properties?.sessionID;
      if (!sessionId) return;

      sessionManager.dropTask(sessionId);
      sessionManager.clearParent(sessionId);
      contextByTask.delete(sessionId);
      pendingManagedTaskIds.delete(sessionId);
      pruneContext();

      for (const [callId, pending] of pendingCalls.entries()) {
        if (pending.parentSessionId !== sessionId) {
          continue;
        }
        takePendingCall(callId);
      }
    },
  };
}
