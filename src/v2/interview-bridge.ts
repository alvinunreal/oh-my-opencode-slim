import type { Server } from 'node:http';
import type { InterviewConfig, PluginConfig } from '../config';
import { DEFAULT_DASHBOARD_PORT } from '../interview/dashboard';
import { createDashboardManager } from '../interview/dashboard-manager';
import type { InterviewSessionRuntime } from '../interview/runtime';
import { createInterviewServer } from '../interview/server';
import { createInterviewService } from '../interview/service';
import type { InterviewMessage } from '../interview/types';
import { log } from '../utils/logger';
import { createSessionListShim } from './client-shim';
import { createCommandMarkerKit } from './command-marker';
import { createSessionSubmit, textFromContent } from './session-submit';
import type {
  V2CommandDraft,
  V2Context,
  V2Session,
  V2SessionContextEvent,
} from './types';

/** Interview command marker kit — shared, byte-stable marker machinery;
 * see ./command-marker.ts. Whole-text anchored: v2 writes the marker as
 * the entire submitted prompt, so whole-text anchoring is the contract. A
 * user-typed embedded marker must not hijack dispatch in the merged
 * session context hook. Exported for tests: command-marker.test.ts pins
 * the configured pattern bytes against config drift. */
export const INTERVIEW_MARKER = createCommandMarkerKit({
  tag: 'omos-interview-command',
  trimArgs: true,
});

/** Cap on per-session state retained by the bridge (FIFO eviction).
 * Context events fire for every LLM request of every session; without a
 * bound a long-lived host would retain one transcript per session it has
 * ever seen. Mirrors MAX_PROMPT_BRIDGE_SESSIONS in ./setup.ts. */
const MAX_RETAINED_SESSIONS = 1024;

/** Render the `/interview` command marker with the given arguments. */
export function markerText(args: string): string {
  return INTERVIEW_MARKER.wrap({ args });
}

function projectContent(
  content: Array<Record<string, unknown>>,
): InterviewMessage['parts'] {
  return content.map((part) => ({
    type: typeof part.type === 'string' ? part.type : undefined,
    text: typeof part.text === 'string' ? part.text : undefined,
  }));
}

function toInterviewMessages(event: V2SessionContextEvent): InterviewMessage[] {
  return event.messages.map((message) => ({
    info: { role: message.role, id: message.id },
    parts: projectContent(message.content),
  }));
}

export interface V2InterviewBridge {
  readonly service: ReturnType<typeof createInterviewService>;
  readonly runtime: InterviewSessionRuntime;
  registerCommand(draft: V2CommandDraft): void;
  handleContext(event: V2SessionContextEvent): Promise<void>;
  handleEvent(event: Record<string, unknown>): Promise<void>;
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
      // Function replacer under the hood: `$`-sequences in the captured
      // args survive the strip (see ./command-marker.ts).
      text: INTERVIEW_MARKER.strip(text),
    },
  ];
}

export function createV2InterviewBridge(
  ctx: V2Context,
  config?: InterviewConfig,
  options: {
    /** Already-listening server for the dashboard role to adopt. */
    server?: Server;
    /** Test seam: override the per-session retention cap. */
    maxRetainedSessions?: number;
  } = {},
): V2InterviewBridge {
  // Last raw context event per retained session (a reference — no
  // projection). The InterviewMessage projection is derived lazily by
  // runtime.messages() exactly where the interview service consumes it.
  const rawEvents = new Map<string, V2SessionContextEvent>();
  // Lazily derived (memoized) transcript projections + streamed assistant
  // turns. Only populated while an interview is actually active for the
  // session (or a marker dispatch is in flight).
  const transcripts = new Map<string, InterviewMessage[]>();
  const activeText = new Map<string, string>();
  const maxRetainedSessions =
    options.maxRetainedSessions ?? MAX_RETAINED_SESSIONS;
  // Reduced hosts may omit the session domain entirely.
  const methods = (ctx.session ?? {}) as V2Session;
  const submitUserText = createSessionSubmit(ctx);

  function pruneRetainedSessions(): void {
    for (const map of [rawEvents, transcripts, activeText]) {
      while (map.size > maxRetainedSessions) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  }

  function isActiveSession(sessionID: string): boolean {
    return service.getActiveInterviewId(sessionID) !== null;
  }

  /** Lazily derive (and memoize) the transcript projection from the
   * retained raw event. Memoized so the projection runs at most once per
   * context event and streamed assistant turns mutate the exact array
   * runtime.messages() hands out. */
  function transcriptFor(sessionID: string): InterviewMessage[] {
    let messages = transcripts.get(sessionID);
    if (!messages) {
      const raw = rawEvents.get(sessionID);
      if (!raw) return [];
      messages = toInterviewMessages(raw);
      transcripts.set(sessionID, messages);
      pruneRetainedSessions();
    }
    return messages;
  }

  /** Track per-session state only while an interview is actually active:
   * refresh the retained raw event (projection stays lazy), or drop stale
   * state left by a dispatch that threw mid-flight. */
  function observeContext(event: V2SessionContextEvent): void {
    if (isActiveSession(event.sessionID)) {
      rawEvents.set(event.sessionID, event);
      transcripts.delete(event.sessionID);
    } else if (rawEvents.has(event.sessionID)) {
      rawEvents.delete(event.sessionID);
      transcripts.delete(event.sessionID);
    }
    pruneRetainedSessions();
  }

  const runtime: InterviewSessionRuntime = {
    messages: async (sessionID) => transcriptFor(sessionID),
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
    const trailing = event.messages.at(-1);
    if (trailing?.role !== 'user') {
      observeContext(event);
      return;
    }
    const text = textFromContent(trailing.content);
    const parsed = INTERVIEW_MARKER.parse(text);
    if (!parsed) {
      observeContext(event);
      return;
    }

    // Bind the raw event (no projection) so the dispatch below — which
    // creates/resumes an interview and calls runtime.messages() — observes
    // this exact transcript state, including the not-yet-rewritten marker.
    rawEvents.set(event.sessionID, event);
    transcripts.delete(event.sessionID);
    pruneRetainedSessions();

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
        arguments: parsed.args.trim(),
      },
      output,
    );

    applyInterviewCommandParts(trailing, text, output.parts);
    if (rawEvents.get(event.sessionID) !== event) {
      // A concurrent context event rebound the retained state; it owns the
      // transcript from here on.
      return;
    }
    const memo = transcripts.get(event.sessionID);
    const projectedTrailing = memo?.at(-1);
    if (projectedTrailing && projectedTrailing.info?.role === trailing.role) {
      // Mutate ONLY the projected trailing message (earlier projected
      // messages stay byte-identical); the memo already holds the single
      // projection made during the dispatch, so no second pass runs. The
      // role guard keeps a mid-dispatch streamed assistant turn (appended
      // to the memo while the command hook awaited) out of the fix-up —
      // the raw event reference re-derives the rewritten marker on the
      // next projection anyway.
      projectedTrailing.parts = projectContent(trailing.content);
    }
    if (!isActiveSession(event.sessionID)) {
      // The dispatch produced no interview (e.g. the bare /interview
      // ask-for-idea prompt): nothing consumes the transcript — drop the
      // retained state.
      rawEvents.delete(event.sessionID);
      transcripts.delete(event.sessionID);
    }
  }

  /** Streamed assistant text is only recorded for sessions with an active
   * interview — the only consumer of the transcript projection. */
  function appendText(sessionID: string, text: string): void {
    if (!isActiveSession(sessionID)) return;
    const messages = transcriptFor(sessionID);
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
    if (!isActiveSession(sessionID)) return;
    const messages = transcriptFor(sessionID);
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
      // Turn-text accumulation is gated on an active interview, matching
      // beginText — nothing reads activeText for an inactive session.
      if (isActiveSession(sessionID)) {
        activeText.set(sessionID, '');
        pruneRetainedSessions();
      }
      beginText(sessionID);
      return;
    }
    if (type === 'session.next.text.delta') {
      if (!isActiveSession(sessionID)) return;
      const text = `${activeText.get(sessionID) ?? ''}${typeof properties.delta === 'string' ? properties.delta : ''}`;
      activeText.set(sessionID, text);
      pruneRetainedSessions();
      appendText(sessionID, text);
      return;
    }
    if (type === 'session.next.text.ended') {
      // properties.text wins; the activeText fallback only matters for
      // sessions whose started/deltas were retained (active interviews —
      // otherwise the get yields undefined and the gated appendText
      // discards the empty string anyway).
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
      rawEvents.delete(sessionID);
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
    dispose: async () => {
      if (dashboardManager) await dashboardManager.dispose();
      server?.close();
      activeText.clear();
      rawEvents.clear();
      transcripts.clear();
      log('[v2][interview] bridge disposed');
    },
  };
}
