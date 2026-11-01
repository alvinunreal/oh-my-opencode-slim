import type { Server } from 'node:http';
import type { InterviewConfig, PluginConfig } from '../config';
import { createDashboardManager } from '../interview/dashboard-manager';
import { computeInterviewMode } from '../interview/manager';
import type { InterviewSessionRuntime } from '../interview/runtime';
import { createInterviewServer } from '../interview/server';
import { createInterviewService } from '../interview/service';
import type { InterviewMessage } from '../interview/types';
import { log } from '../utils/logger';
import { createSessionListShim, resolveV2Directory } from './client-shim';
import {
  createInternalSyntheticMessageID,
  recordInternalAdmission,
} from './internal-admissions';
import { resolveV2EventPayload } from './runtime-profiles';
import {
  createSessionSubmit,
  replayMarkerExpansions,
  type V1CommandBeforeHook,
} from './session-submit';
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
  const commandContexts = new Set<string>();
  const pendingNotices = new Map<string, string[]>();
  // Reduced hosts may omit the session domain entirely.
  const methods = (ctx.session ?? {}) as V2Session;
  const submitUserText = createSessionSubmit(ctx);

  const runtime: InterviewSessionRuntime = {
    messages: async (sessionID) => transcripts.get(sessionID) ?? [],
    notify: async (sessionID, text) => {
      if (commandContexts.has(sessionID)) {
        const notices = pendingNotices.get(sessionID) ?? [];
        notices.push(text);
        pendingNotices.set(sessionID, notices);
        return;
      }
      // synthetic only — no prompt fallback: `resume: false` admits the
      // input WITHOUT waking the session, mirroring the v1 noReply prompt
      // (a prompt fallback would double-send and wake the loop).
      if (typeof methods.synthetic !== 'function') {
        log('[v2][interview] synthetic unavailable for notify', { sessionID });
        return;
      }
      try {
        const description = text
          .replace(/\s*\[system status:[^\]]*\]\s*$/, '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .join(' · ');
        await methods.synthetic({
          sessionID,
          text,
          description,
          resume: false,
        });
      } catch (err) {
        log('[v2][interview] synthetic notify failed', {
          sessionID,
          err: String(err),
        });
      }
    },
    continue: async (sessionID, text) => {
      if (typeof methods.synthetic !== 'function') {
        throw new Error('session.synthetic is unavailable');
      }
      const id = createInternalSyntheticMessageID();
      recordInternalAdmission(sessionID, id);
      await methods.synthetic({
        sessionID,
        id,
        text,
        description: 'Interview update',
        resume: true,
      });
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
  const pluginContext = { directory: resolveV2Directory(ctx) } as never;
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
          hostFlavor: 'v2',
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

  const commandBefore: V1CommandBeforeHook = async (input, output) => {
    commandContexts.add(input.sessionID);
    try {
      await (dashboardManager ?? service).handleCommandExecuteBefore(
        input,
        output,
      );
    } finally {
      commandContexts.delete(input.sessionID);
    }
  };

  async function handleContext(event: V2SessionContextEvent): Promise<void> {
    await replayMarkerExpansions(
      event,
      commandBefore,
      (text) => {
        const interview = text.match(INTERVIEW_MARKER_PATTERN);
        if (interview && options.commandEnabled !== false) {
          return { name: 'interview', args: interview[1] };
        }
        const implement = text.match(IMPLEMENT_MARKER_PATTERN);
        if (implement && options.implementEnabled !== false) {
          return { name: 'implement', args: implement[1] };
        }
      },
      (index) =>
        !event.messages
          .slice(index + 1)
          .some(
            (message) =>
              message.role === 'assistant' || message.role === 'tool',
          ),
      () => transcripts.set(event.sessionID, toInterviewMessages(event)),
    );
    if (isManagedInterviewSession(event.sessionID)) {
      transcripts.set(event.sessionID, toInterviewMessages(event));
    }
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

  function textMessageID(
    properties: Record<string, unknown>,
  ): string | undefined {
    const id = properties.assistantMessageID;
    return typeof id === 'string' && id ? id : undefined;
  }

  async function handleEvent(event: Record<string, unknown>): Promise<void> {
    const type = typeof event.type === 'string' ? event.type : '';
    // Data-first: live v2 hosts key the event payload under `data` (the
    // OpenCodeEvent wire shape); `properties` is the legacy/test spelling.
    // Reading only `properties` left this handler dead on live v2 for ALL
    // events. handleContext is unaffected (different event type).
    const properties = resolveV2EventPayload(event);
    const sessionID =
      (typeof properties.sessionID === 'string' && properties.sessionID) ||
      ((properties.info as { id?: string } | undefined)?.id ?? '');
    if (!sessionID) return;

    const managed = isManagedInterviewSession(sessionID);
    if (type === 'session.text.started') {
      if (!managed) return;
      const messageID = textMessageID(properties);
      activeText.set(sessionID, '');
      if (messageID) activeMessageIDs.set(sessionID, messageID);
      beginText(sessionID, messageID);
      return;
    }
    if (type === 'session.text.delta') {
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
    if (type === 'session.text.ended') {
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
      pendingNotices.delete(sessionID);
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
      if (statusType === 'idle') {
        const notices = pendingNotices.get(sessionID) ?? [];
        pendingNotices.delete(sessionID);
        for (const text of notices) await runtime.notify(sessionID, text);
      }
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
      commandContexts.clear();
      pendingNotices.clear();
      transcripts.clear();
      log('[v2][interview] bridge disposed');
    },
  };
}
