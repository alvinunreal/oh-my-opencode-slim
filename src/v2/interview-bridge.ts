import type { Server } from 'node:http';
import type { InterviewConfig, PluginConfig } from '../config';
import { createDashboardManager } from '../interview/dashboard-manager';
import { computeInterviewMode } from '../interview/manager';
import type { InterviewSessionRuntime } from '../interview/runtime';
import { createInterviewServer } from '../interview/server';
import { createInterviewService } from '../interview/service';
import type { InterviewMessage } from '../interview/types';
import { isRecord } from '../utils/guards';
import { log } from '../utils/logger';
import { createSessionListShim } from './client-shim';
import { createSessionSubmit, textFromContent } from './session-submit';
import type {
  V2CommandDraft,
  V2Context,
  V2Session,
  V2SessionContextEvent,
} from './types';

export const INTERVIEW_COMMAND_MARKER =
  '<omos-interview-command>$ARGUMENTS</omos-interview-command>';

export const IMPLEMENT_COMMAND_MARKER =
  '<omos-implement-command>$ARGUMENTS</omos-implement-command>';

// Whole-text anchored: v2 writes the marker as the entire submitted prompt,
// so whole-text anchoring is the contract. A user-typed embedded marker must
// not hijack dispatch in the merged session context hook.
const INTERVIEW_MARKER_PATTERN =
  /^\s*<omos-interview-command>\s*([\s\S]*?)\s*<\/omos-interview-command>\s*$/;
const IMPLEMENT_MARKER_PATTERN =
  /^\s*<omos-implement-command>\s*([\s\S]*?)\s*<\/omos-implement-command>\s*$/;

/** Render the `/interview` command marker with the given arguments. */
export function markerText(args: string): string {
  // Function replacer: a string replacer would interpret `$`-sequences in
  // args (`$&`, `` $` ``, `$$`, ...) instead of emitting them byte-exact.
  return INTERVIEW_COMMAND_MARKER.replace('$ARGUMENTS', () => args);
}

/** Render the `/implement` command marker with the given arguments. */
export function implementMarkerText(args: string): string {
  return IMPLEMENT_COMMAND_MARKER.replace('$ARGUMENTS', () => args);
}

function toInterviewMessages(event: V2SessionContextEvent): InterviewMessage[] {
  return event.messages.map((message) => ({
    info: { role: message.role, id: message.id },
    // Tool parts are intentionally dropped because interview parsing consumes
    // the textual transcript only.
    parts: message.content.flatMap((part) =>
      typeof part.text === 'string' ? [{ type: 'text', text: part.text }] : [],
    ),
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
      text: text
        .replace(INTERVIEW_MARKER_PATTERN, (_match, args: string) => args)
        .replace(IMPLEMENT_MARKER_PATTERN, (_match, args: string) => args),
    },
  ];
}

export function createV2InterviewBridge(
  ctx: V2Context,
  config?: InterviewConfig,
  options: {
    /** Whether the /interview command is enabled for this host. */
    commandEnabled?: boolean;
    /** Whether the /implement command is enabled for this host. */
    implementEnabled?: boolean;
    /** Already-listening server for the dashboard role to adopt. */
    server?: Server;
  } = {},
): V2InterviewBridge {
  const transcripts = new Map<string, InterviewMessage[]>();
  const activeText = new Map<string, string>();
  const activeMessageIDs = new Map<string, string>();
  // Reduced hosts may omit the session domain entirely.
  const methods = (ctx.session ?? {}) as V2Session;
  const submitUserText = createSessionSubmit(ctx);

  const runtime: InterviewSessionRuntime = {
    messages: async (sessionID) => transcripts.get(sessionID) ?? [],
    notify: async (sessionID, text) => {
      // synthetic only — no prompt fallback: `resume: false` admits the
      // input WITHOUT waking the session, mirroring the v1 noReply prompt
      // (a prompt fallback would double-send and wake the loop).
      if (typeof methods.synthetic !== 'function') {
        log('[v2][interview] synthetic unavailable for notify', { sessionID });
        return;
      }
      try {
        await methods.synthetic({ sessionID, text, resume: false });
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
      if (typeof methods.prompt !== 'function') {
        throw new Error('session.prompt is unavailable');
      }
      await methods.prompt({ sessionID, text });
    },
    rename: async (sessionID, title) => {
      // Renames go through session.update({sessionID, title}).
      if (typeof methods.update !== 'function') {
        log('[v2][interview] session rename unavailable', { sessionID });
        return;
      }
      try {
        await methods.update({ sessionID, title });
      } catch (err) {
        log('[v2][interview] session rename failed', {
          sessionID,
          err: String(err),
        });
      }
    },
  };

  const { dashboardEnabled, outputFolder, dashboardPort } =
    computeInterviewMode(config);
  const pluginContext = { directory: process.cwd() } as never;
  const dashboardManager = dashboardEnabled
    ? createDashboardManager(
        pluginContext,
        { interview: config } as PluginConfig,
        dashboardPort,
        outputFolder,
        {
          runtime,
          // v1-shaped list over v2 session.list (directory discovery for
          // the dashboard's session scan); empty page when the host lacks
          // the method.
          sessionClient: {
            list: createSessionListShim(methods),
          } as never,
          server: options.server,
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
    if (options.commandEnabled !== false) {
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
    if (options.implementEnabled !== false) {
      draft.add({
        name: 'implement',
        description: 'Read the completed interview markdown and implement it',
        execute: async (invocation) => {
          try {
            await submitUserText(
              invocation?.sessionID ?? '',
              implementMarkerText(invocation?.prompt?.text ?? ''),
            );
          } catch (err) {
            log(
              '[v2][interview] implement command execute failed',
              String(err),
            );
          }
        },
      });
    }
  }

  function isManagedInterviewSession(sessionID: string): boolean {
    return (
      transcripts.has(sessionID) ||
      Boolean(
        (dashboardManager?.service ?? service).getActiveInterviewId(sessionID),
      )
    );
  }

  async function handleContext(event: V2SessionContextEvent): Promise<void> {
    const trailing = event.messages.at(-1);
    const text =
      trailing?.role === 'user' ? textFromContent(trailing.content) : '';
    const interviewMatch = text.match(INTERVIEW_MARKER_PATTERN);
    const implementMatch = text.match(IMPLEMENT_MARKER_PATTERN);
    if (interviewMatch && options.commandEnabled === false) return;
    if (implementMatch && options.implementEnabled === false) return;
    const match = interviewMatch ?? implementMatch;
    const managed = isManagedInterviewSession(event.sessionID);
    if (!match && !managed) return;

    // Capture the current view before executing /interview so resume and
    // creation can read the history. Ordinary sessions never enter here.
    transcripts.set(event.sessionID, toInterviewMessages(event));
    if (!match || trailing?.role !== 'user') return;

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
        command: interviewMatch ? 'interview' : 'implement',
        sessionID: event.sessionID,
        arguments: match[1].trim(),
      },
      output,
    );

    applyInterviewCommandParts(trailing, text, output.parts);
    transcripts.set(event.sessionID, toInterviewMessages(event));
  }

  function appendText(
    sessionID: string,
    text: string,
    messageID?: string,
  ): void {
    const messages = transcripts.get(sessionID) ?? [];
    const last = messages.at(-1);
    if (last?.info?.role === 'assistant') {
      if (messageID) last.info = { ...last.info, id: messageID };
      const part = last.parts?.find((item) => item.type === 'text');
      if (part) {
        part.text = text;
      } else {
        last.parts = [{ type: 'text', text }];
      }
    } else {
      messages.push({
        info: { role: 'assistant', ...(messageID ? { id: messageID } : {}) },
        parts: [{ type: 'text', text }],
      });
    }
    transcripts.set(sessionID, messages);
  }

  function beginText(sessionID: string, messageID?: string): void {
    const messages = transcripts.get(sessionID) ?? [];
    messages.push({
      info: { role: 'assistant', ...(messageID ? { id: messageID } : {}) },
      parts: [{ type: 'text', text: '' }],
    });
    transcripts.set(sessionID, messages);
  }

  /** Resolve the assistant message id carried by a v2 text event, when the
   * host surfaces one (live payloads vary: messageID/info.id/message.id). */
  function textMessageID(
    properties: Record<string, unknown>,
  ): string | undefined {
    const direct = properties.messageID;
    if (typeof direct === 'string' && direct) return direct;
    const info = isRecord(properties.info) ? properties.info : undefined;
    if (info && typeof info.id === 'string' && info.id) return info.id;
    const message = isRecord(properties.message)
      ? properties.message
      : undefined;
    if (message && typeof message.id === 'string' && message.id) {
      return message.id;
    }
    return undefined;
  }

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = typeof event.type === 'string' ? event.type : '';
    // Data-first: live v2 hosts key the event payload under `data` (the
    // OpenCodeEvent wire shape); `properties` is the legacy/test spelling.
    // Reading only `properties` left this handler dead on live v2 for ALL
    // events. handleContext is unaffected (different event type).
    const properties = isRecord(event.data)
      ? event.data
      : isRecord(event.properties)
        ? event.properties
        : {};
    const sessionID =
      (typeof properties.sessionID === 'string' && properties.sessionID) ||
      ((properties.info as { id?: string } | undefined)?.id ?? '');
    if (!sessionID) return;

    const managed = isManagedInterviewSession(sessionID);
    if (type === 'session.next.text.started') {
      if (!managed) return;
      const messageID = textMessageID(properties);
      activeText.set(sessionID, '');
      if (messageID) activeMessageIDs.set(sessionID, messageID);
      beginText(sessionID, messageID);
      return;
    }
    if (type === 'session.next.text.delta') {
      if (!managed) return;
      const text = `${activeText.get(sessionID) ?? ''}${typeof properties.delta === 'string' ? properties.delta : ''}`;
      activeText.set(sessionID, text);
      appendText(
        sessionID,
        text,
        textMessageID(properties) ?? activeMessageIDs.get(sessionID),
      );
      return;
    }
    if (type === 'session.next.text.ended') {
      if (!managed) return;
      const text =
        typeof properties.text === 'string'
          ? properties.text
          : (activeText.get(sessionID) ?? '');
      const messageID =
        textMessageID(properties) ?? activeMessageIDs.get(sessionID);
      activeText.delete(sessionID);
      activeMessageIDs.delete(sessionID);
      appendText(sessionID, text, messageID);
      await (dashboardManager ?? service).handleEvent({
        event: { type, properties },
      });
      return;
    }
    if (type === 'session.deleted') {
      activeText.delete(sessionID);
      activeMessageIDs.delete(sessionID);
      transcripts.delete(sessionID);
      await (dashboardManager ?? service).handleEvent({
        event: { type: 'session.deleted', properties: { sessionID } },
      });
      return;
    }

    if (
      type === 'session.execution.started' ||
      type === 'session.execution.succeeded' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted'
    ) {
      // Live v2 publishes lifecycle as durable `session.execution.*` events
      // and no longer streams busy/idle `session.status` (see
      // event-adapter.ts). The bridge receives the RAW event, so without this
      // mapping the v2 service never sees a turn end and never posts notices.
      const statusType = type === 'session.execution.started' ? 'busy' : 'idle';
      await (dashboardManager ?? service).handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID, status: { type: statusType } },
        },
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
      activeMessageIDs.clear();
      transcripts.clear();
      log('[v2][interview] bridge disposed');
    },
  };
}
