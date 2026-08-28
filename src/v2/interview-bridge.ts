import type { InterviewConfig, PluginConfig } from '../config';
import { DEFAULT_DASHBOARD_PORT } from '../interview/dashboard';
import { createDashboardManager } from '../interview/dashboard-manager';
import type { InterviewSessionRuntime } from '../interview/runtime';
import { createInterviewServer } from '../interview/server';
import { createInterviewService } from '../interview/service';
import type { InterviewMessage } from '../interview/types';
import { log } from '../utils/logger';
import { createSessionSubmit, textFromContent } from './session-submit';
import type {
  V2CommandDraft,
  V2Context,
  V2Session,
  V2SessionContextEvent,
} from './types';

export const INTERVIEW_COMMAND_MARKER =
  '<omos-interview-command>$ARGUMENTS</omos-interview-command>';

// Whole-text anchored: v2 writes the marker as the entire submitted prompt,
// so whole-text anchoring is the contract. A user-typed embedded marker must
// not hijack dispatch in the merged session context hook.
const MARKER_PATTERN =
  /^\s*<omos-interview-command>\s*([\s\S]*?)\s*<\/omos-interview-command>\s*$/;

/** Render the `/interview` command marker with the given arguments. */
export function markerText(args: string): string {
  // Function replacer: a string replacer would interpret `$`-sequences in
  // args (`$&`, `` $` ``, `$$`, ...) instead of emitting them byte-exact.
  return INTERVIEW_COMMAND_MARKER.replace('$ARGUMENTS', () => args);
}

function toInterviewMessages(event: V2SessionContextEvent): InterviewMessage[] {
  return event.messages.map((message) => ({
    info: { role: message.role, id: message.id },
    parts: message.content.map((part) => ({
      type: typeof part.type === 'string' ? part.type : undefined,
      text: typeof part.text === 'string' ? part.text : undefined,
    })),
  }));
}

export interface V2InterviewBridge {
  readonly service: ReturnType<typeof createInterviewService>;
  readonly runtime: InterviewSessionRuntime;
  registerCommand(draft: V2CommandDraft): void;
  handleContext(event: V2SessionContextEvent): Promise<void>;
  handleEvent(event: Record<string, unknown>): Promise<void>;
  getTranscript(sessionID: string): InterviewMessage[];
  dispose(): void;
}

/** Mutate the trailing command message from hook-produced parts. When the
 * hook produced nothing, strip the marker and leave the raw args text.
 * Only the trailing message is mutated; earlier messages are left
 * byte-for-byte untouched so provider prompt prefixes remain cacheable. */
export function applyInterviewCommandParts(
  trailing: { role: string; content: Array<Record<string, unknown>> },
  text: string,
  parts: Array<Record<string, unknown>>,
): void {
  if (parts.length > 0) {
    trailing.content = parts.map((part) => ({ ...part }));
    return;
  }
  trailing.content = [
    {
      type: 'text',
      // Function replacer: a string replacer would interpret `$`-sequences.
      text: text.replace(MARKER_PATTERN, (_match, args: string) => args),
    },
  ];
}

export function createV2InterviewBridge(
  ctx: V2Context,
  config?: InterviewConfig,
): V2InterviewBridge {
  const transcripts = new Map<string, InterviewMessage[]>();
  const activeText = new Map<string, string>();
  // Reduced hosts may omit the session domain entirely.
  const methods = (ctx.session ?? {}) as V2Session;
  const submitUserText = createSessionSubmit(ctx);

  const runtime: InterviewSessionRuntime = {
    messages: async (sessionID) => transcripts.get(sessionID) ?? [],
    notify: async (sessionID, text) => {
      // synthetic only — no prompt fallback: synthetic avoids triggering an
      // agent turn; a prompt fallback would double-send and wake the loop.
      if (typeof methods.synthetic !== 'function') {
        log('[v2][interview] synthetic unavailable for notify', { sessionID });
        return;
      }
      try {
        await methods.synthetic({ sessionID, text });
      } catch (err) {
        log('[v2][interview] synthetic notify failed', {
          sessionID,
          err: String(err),
        });
      }
    },
    continue: async (sessionID, text) => {
      // Best-effort switch to the orchestrator agent, then a flat prompt.
      try {
        await methods.switchAgent?.({ sessionID, agent: 'orchestrator' });
      } catch (err) {
        log('[v2][interview] switchAgent failed (best-effort)', {
          sessionID,
          err: String(err),
        });
      }
      await submitUserText(sessionID, text);
    },
    rename: async (sessionID, title) => {
      if (typeof methods.rename !== 'function') {
        log('[v2][interview] session rename unavailable', { sessionID });
        return;
      }
      try {
        await methods.rename({ sessionID, title });
      } catch (err) {
        log('[v2][interview] session rename failed', {
          sessionID,
          err: String(err),
        });
      }
    },
  };

  const dashboardEnabled =
    config?.dashboard === true || (config?.port ?? 0) > 0;
  const outputFolder = config?.outputFolder ?? 'interview';
  const dashboardPort =
    (config?.port ?? 0) > 0 ? (config?.port ?? 0) : DEFAULT_DASHBOARD_PORT;
  const pluginContext = { directory: process.cwd() } as never;
  const dashboardManager = dashboardEnabled
    ? createDashboardManager(
        pluginContext,
        { interview: config } as PluginConfig,
        dashboardPort,
        outputFolder,
        {
          runtime,
          sessionClient: {
            list: async () => ({ data: [] }),
          } as never,
        },
      )
    : null;
  const service =
    dashboardManager?.service ??
    createInterviewService(pluginContext, config, { runtime });
  const server = dashboardManager
    ? null
    : createInterviewServer({
        getState: (interviewID) => service.getInterviewState(interviewID),
        listInterviewFiles: () => service.listInterviewFiles(),
        listInterviews: () => service.listInterviews(),
        submitAnswers: (interviewID, answers) =>
          service.submitAnswers(interviewID, answers),
        submitBlockComment: (interviewID, section, comment) =>
          service.submitBlockComment(interviewID, section, comment),
        submitChat: (interviewID, message) =>
          service.submitChat(interviewID, message),
        handleNudgeAction: (interviewID, action) =>
          service.handleNudgeAction(interviewID, action),
        outputFolder,
        port: 0,
      });
  if (server) service.setBaseUrlResolver(() => server.ensureStarted());

  function registerCommand(draft: V2CommandDraft): void {
    // v2 command drafts are add-only. `/interview` renders its marker as a
    // user prompt; the context hook below consumes it.
    if (typeof draft.add !== 'function') {
      log('[v2][interview] command draft has no add');
      return;
    }
    draft.add({
      name: 'interview',
      description: 'Open a localhost interview UI for a feature idea',
      execute: async (invocation) => {
        // Never throw: v2 surfaces command execution errors to the user.
        try {
          await submitUserText(
            invocation?.sessionID ?? '',
            markerText(invocation?.prompt?.text ?? ''),
          );
        } catch (err) {
          log('[v2][interview] command execute failed', String(err));
        }
      },
    });
  }

  async function handleContext(event: V2SessionContextEvent): Promise<void> {
    const messages = toInterviewMessages(event);
    transcripts.set(event.sessionID, messages);

    const trailing = event.messages.at(-1);
    if (trailing?.role !== 'user') return;
    const text = textFromContent(trailing.content);
    const match = text.match(MARKER_PATTERN);
    if (!match) return;

    const output = {
      parts: [] as Array<{
        type: string;
        text?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      }>,
    };
    await (dashboardManager ?? service).handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: event.sessionID,
        arguments: match[1].trim(),
      },
      output,
    );

    applyInterviewCommandParts(trailing, text, output.parts);
    transcripts.set(event.sessionID, toInterviewMessages(event));
  }

  function appendText(sessionID: string, text: string): void {
    const messages = transcripts.get(sessionID) ?? [];
    const last = messages.at(-1);
    if (last?.info?.role === 'assistant') {
      const part = last.parts?.find((item) => item.type === 'text');
      if (part) {
        part.text = text;
      } else {
        last.parts = [{ type: 'text', text }];
      }
    } else {
      messages.push({
        info: { role: 'assistant' },
        parts: [{ type: 'text', text }],
      });
    }
    transcripts.set(sessionID, messages);
  }

  function beginText(sessionID: string): void {
    const messages = transcripts.get(sessionID) ?? [];
    messages.push({
      info: { role: 'assistant' },
      parts: [{ type: 'text', text: '' }],
    });
    transcripts.set(sessionID, messages);
  }

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = typeof event.type === 'string' ? event.type : '';
    const properties = (event.properties ?? {}) as Record<string, unknown>;
    const sessionID =
      (typeof properties.sessionID === 'string' && properties.sessionID) ||
      ((properties.info as { id?: string } | undefined)?.id ?? '');
    if (!sessionID) return;

    if (type === 'session.next.text.started') {
      activeText.set(sessionID, '');
      beginText(sessionID);
      return;
    }
    if (type === 'session.next.text.delta') {
      const text = `${activeText.get(sessionID) ?? ''}${typeof properties.delta === 'string' ? properties.delta : ''}`;
      activeText.set(sessionID, text);
      appendText(sessionID, text);
      return;
    }
    if (type === 'session.next.text.ended') {
      const text =
        typeof properties.text === 'string'
          ? properties.text
          : (activeText.get(sessionID) ?? '');
      activeText.delete(sessionID);
      appendText(sessionID, text);
      await (dashboardManager ?? service).handleEvent({
        event: { type, properties },
      });
      return;
    }
    if (type === 'session.deleted') {
      activeText.delete(sessionID);
      transcripts.delete(sessionID);
      await (dashboardManager ?? service).handleEvent({
        event: { type: 'session.deleted', properties: { sessionID } },
      });
      return;
    }

    if (type === 'session.status') {
      await (dashboardManager ?? service).handleEvent({
        event: { type, properties },
      });
    }
  }

  return {
    service,
    runtime,
    registerCommand,
    handleContext,
    handleEvent,
    getTranscript: (sessionID) => transcripts.get(sessionID) ?? [],
    dispose: async () => {
      if (dashboardManager) await dashboardManager.dispose();
      server?.close();
      activeText.clear();
      transcripts.clear();
      log('[v2][interview] bridge disposed');
    },
  };
}
