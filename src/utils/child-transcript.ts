/**
 * Shared child-session transcript evidence extraction and fetch.
 *
 * Two consumers need "what did the child session end with?":
 * - `revived-run-tracker` (revive probes, strict v1 transcript shape)
 * - the quiescent host-outcome settle path in `task-session-manager`
 *   (v2 shim shape — `info` carries only `{id, role}`; terminality is
 *   confirmed upstream via `Session.Info.outcome`)
 *
 * Both previously carried their own (and subtly different) extraction
 * logic. This module is the single source of truth for reading a v1-style
 * `{data: [{info, parts}]}` messages response and classifying the
 * trailing assistant turn — and for fetching that transcript:
 * `fetchChildTranscript` binds the client's `session.messages` endpoint
 * (degraded hosts may not expose it) and surfaces `response.error` as a
 * normalized `Error`, replacing the bind/call/unwrap boilerplate that was
 * previously duplicated at every call site. `responseError` and
 * `stringifyError` are the shared response-error extraction and error-text
 * helpers for session-endpoint call sites (revive probes, notification
 * transport, task cancellation).
 */

import type { PluginInput } from '@opencode-ai/plugin';

import { isRecord } from './guards';

export type ChildTerminalEvidence =
  | { kind: 'ready'; text: string }
  | { kind: 'textless' }
  | { kind: 'pending' }
  | { kind: 'error'; errorText: string }
  | { kind: 'no-assistant' };

/**
 * Fetch a child session's transcript via `client.session.messages`.
 *
 * Returns the raw response, or `undefined` when the host client does not
 * expose a callable `session.messages` endpoint (degraded hosts) — each
 * call site decides how to degrade. Transport failures propagate to the
 * caller. A `response.error` payload is surfaced as a normalized `Error`
 * whose message is `stringifyError(response.error)`, matching the
 * error-surfacing style previously duplicated at the call sites.
 *
 * `limit` asks the host for only the newest N messages (still oldest-first);
 * a host that ignores it returns the whole transcript, so callers must
 * tolerate either.
 */
export async function fetchChildTranscript(
  client: PluginInput['client'],
  sessionID: string,
  directory: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const session = client.session;
  const messages =
    typeof session?.messages === 'function'
      ? session.messages.bind(session)
      : undefined;
  if (typeof messages !== 'function') return undefined;
  const response = await messages({
    path: { id: sessionID },
    query: { directory, limit },
    ...(signal ? { signal } : {}),
  });
  const error = responseError(response);
  if (error !== undefined) throw new Error(stringifyError(error));
  return response;
}

/** Extract a non-null `response.error` payload from an SDK-style
 * response; `undefined` when the response carries no error. */
export function responseError(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  return response.error === undefined || response.error === null
    ? undefined
    : response.error;
}

/** Normalize an unknown error payload to a displayable message string. */
export function stringifyError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    if (error instanceof Error)
      return JSON.stringify({ name: error.name, ...(error as object) });
    const serialized = JSON.stringify(error);
    return serialized ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Extract a human-readable message from a serialized session error.
 *
 * The core publishes session errors through NamedError.toObject(), whose
 * wire shape is `{ name: string; data: ... }` — the message lives in
 * `data.message` (APIError, ProviderAuthError, ...), not at the top
 * level. Reading only `error.message` yields undefined for every
 * serialized NamedError and the board fell back to the generic
 * "Session error" even when the detail existed two levels down (#1200
 * diagnostics). Plain `{ message }` shapes are still honored for
 * non-NamedError payloads.
 */
export function structuredErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const data = error.data;
  if (isRecord(data)) {
    const inner = data.message;
    // Whitespace-only strings must not bypass the generic fallback
    // (an empty board summary is worse than "Session error").
    if (typeof inner === 'string' && inner.trim().length > 0) return inner;
  }
  const direct = error.message;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  return undefined;
}

interface LooseMessage {
  info?: {
    id?: unknown;
    role?: unknown;
    parentID?: unknown;
    agent?: unknown;
    sourceType?: unknown;
    outcome?: unknown;
    error?: unknown;
    finish?: unknown;
    summary?: unknown;
    time?: { created?: unknown; completed?: unknown };
  };
  parts?: unknown[];
}

export type TranscriptMessage = LooseMessage;

/** A v1 compaction round (its `compaction` trigger and the `summary: true`
 * reply) is host maintenance, not the specialist's work. */
function isCompactionRound(message: TranscriptMessage): boolean {
  return (
    message.info?.summary === true ||
    (message.parts ?? []).some(
      (part) => isRecord(part) && part.type === 'compaction',
    )
  );
}

export type TerminalEvidenceVerdict =
  | { verdict: 'completed'; text: string }
  | { verdict: 'error'; text: string }
  | { verdict: 'absent' }
  | { verdict: 'retry'; reason: string };

function verdictFromEvidence(
  evidence: ChildTerminalEvidence,
): TerminalEvidenceVerdict {
  switch (evidence.kind) {
    case 'ready':
      return { verdict: 'completed', text: evidence.text };
    case 'error':
      return { verdict: 'error', text: evidence.errorText };
    case 'pending':
      return { verdict: 'retry', reason: 'pending' };
    case 'textless':
      return { verdict: 'retry', reason: 'textless' };
    default:
      return { verdict: 'retry', reason: 'unrecognized segment shape' };
  }
}

/** Host-ordered entries of a v1-style messages response, or why they are
 * unusable. */
function transcriptEntries(
  response: unknown,
): TranscriptMessage[] | { reason: string } {
  if (response === undefined)
    return { reason: 'transcript source unavailable' };
  if (responseError(response) !== undefined)
    return { reason: 'transcript read failed' };
  if (!isRecord(response) || !Array.isArray(response.data))
    return { reason: 'malformed transcript response' };
  for (const entry of response.data) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.info) ||
      (!['assistant', 'user', 'system'].includes(String(entry.info.role)) &&
        typeof entry.info.id !== 'string')
    ) {
      return { reason: 'malformed transcript entries' };
    }
    if (
      entry.parts !== undefined &&
      (!Array.isArray(entry.parts) ||
        entry.parts.some(
          (part) => !isRecord(part) || typeof part.type !== 'string',
        ))
    )
      return { reason: 'malformed transcript parts' };
  }
  return response.data;
}

/** A valid absence is not unknown evidence. Never scan through a user prompt
 * or pending assistant placeholder to recover the previous attempt's answer. */
export function classifyTerminalEvidence(
  response: unknown,
  options: {
    baselineMessageID?: string;
    /** An admitted queued user input, not a pre-send history watermark. */
    promptMessageID?: string;
    runStartedAt?: number;
    terminalOutcomeConfirmed?: boolean;
  } = {},
): TerminalEvidenceVerdict {
  const all = transcriptEntries(response);
  if (!Array.isArray(all)) return { verdict: 'retry', reason: all.reason };
  if (options.promptMessageID) {
    const prompt = all.findIndex(
      (message) =>
        message.info?.id === options.promptMessageID &&
        message.info?.role === 'user',
    );
    if (prompt < 0)
      return { verdict: 'retry', reason: 'queued prompt not delivered' };
    const nextPrompt = all.findIndex(
      (message, index) => index > prompt && message.info?.role === 'user',
    );
    const turn = all.slice(prompt, nextPrompt < 0 ? undefined : nextPrompt);
    let target = turn.length - 1;
    while (target > 0 && turn[target].info?.role !== 'assistant') target--;
    if (target === 0)
      return { verdict: 'retry', reason: 'queued prompt has no answer yet' };
    return verdictFromEvidence(
      classifyAssistantTurnEvidence(turn, target, 0, true),
    );
  }
  if (options.baselineMessageID) {
    const baseline = all.findIndex(
      (message) => message.info?.id === options.baselineMessageID,
    );
    if (baseline < 0)
      return { verdict: 'retry', reason: 'baseline message missing' };
    const segment = all.slice(baseline + 1);
    let target = segment.length - 1;
    // Compaction rounds are skipped in place: the anchor and indices hold.
    while (target >= 0) {
      const role = segment[target].info?.role;
      if (
        !isCompactionRound(segment[target]) &&
        (typeof role !== 'string' || role === 'assistant' || role === 'user')
      )
        break;
      target -= 1;
    }
    if (target < 0) return { verdict: 'absent' };
    if (segment[target].info?.role === 'user') {
      return segment.some((message) => message.info?.role === 'assistant')
        ? { verdict: 'retry', reason: 'user message after last assistant' }
        : { verdict: 'absent' };
    }
    return verdictFromEvidence(
      classifyAssistantTurnEvidence(
        all,
        baseline + 1 + target,
        baseline,
        !options.terminalOutcomeConfirmed,
      ),
    );
  }
  let target = all.length - 1;
  while (
    target >= 0 &&
    (all[target].info?.role === 'system' || isCompactionRound(all[target]))
  )
    target--;
  const trailing = all[target];
  if (!trailing || trailing.info?.role === 'user') return { verdict: 'absent' };
  if (trailing.info?.role !== 'assistant')
    return {
      verdict: 'retry',
      reason: 'no baseline; cannot attribute a historical assistant turn',
    };
  const completedAt = trailing.info?.time?.completed;
  if (
    options.runStartedAt !== undefined &&
    typeof completedAt === 'number' &&
    completedAt < options.runStartedAt
  )
    return { verdict: 'absent' };
  return verdictFromEvidence(
    classifyAssistantTurnEvidence(
      all,
      target,
      -1,
      !options.terminalOutcomeConfirmed,
    ),
  );
}

/**
 * Single source of truth for classifying ONE assistant turn as the
 * terminal evidence of a run: pending finish states, completion time,
 * segment-wide pending tool calls, terminal error precedence, and
 * usable text. Both the revived-run tracker probe and the stop gate's
 * evidence classifier delegate here so their terminality contracts
 * cannot diverge (a second independent classifier had already dropped
 * the pending-tool rule).
 */
export function classifyAssistantTurnEvidence(
  messages: TranscriptMessage[],
  targetIndex: number,
  baselineIndex: number,
  requireCompletionTime = true,
): ChildTerminalEvidence {
  const last = messages[targetIndex];
  if (last?.info?.role !== 'assistant') return { kind: 'no-assistant' };

  // Terminal error precedence: an assistant turn that carries a
  // terminal error is an error EVEN when a residual `finish` value
  // (e.g. 'tool-calls'/'unknown') survived the failure — the error is
  // the outcome, the finish flag is leftover state.
  if (last.info?.error !== undefined && last.info?.error !== null) {
    return { kind: 'error', errorText: stringifyError(last.info.error) };
  }

  const finish = last.info?.finish;
  if (finish === 'tool-calls' || finish === 'unknown') {
    return { kind: 'pending' };
  }
  if (
    requireCompletionTime &&
    !(isRecord(last.info?.time) && typeof last.info.time.completed === 'number')
  ) {
    return { kind: 'pending' };
  }

  const postBaseline = messages.slice(baselineIndex + 1);
  const hasPendingToolCall = postBaseline.some((message) =>
    (Array.isArray(message.parts) ? message.parts : []).some((part) => {
      if (!isRecord(part) || part.type !== 'tool') return false;
      const status = isRecord(part.state)
        ? typeof part.state.status === 'string'
          ? part.state.status
          : undefined
        : undefined;
      return status !== 'completed' && status !== 'error';
    }),
  );
  if (hasPendingToolCall) return { kind: 'pending' };

  const text = (Array.isArray(last.parts) ? last.parts : [])
    .filter(
      (part) =>
        isRecord(part) &&
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.length > 0,
    )
    .map((part) => (part as { text: string }).text)
    .join('\n\n')
    .trim();
  return text.length > 0 ? { kind: 'ready', text } : { kind: 'textless' };
}

export interface CurrentRoundClassification {
  verdict: 'completed' | 'error' | 'interrupted' | 'incomplete' | 'unreadable';
  text?: string;
  reason?: string;
  /** Timestamp of the latest delivered user message, when the host provided one. */
  startedAt?: number;
  /** Assistant completion time for this round, when the host provided one. */
  completedAt?: number;
}

export function transcriptOrderKey(
  message: TranscriptMessage,
): number | undefined {
  const time = message.info?.time;
  if (!isRecord(time)) return undefined;
  if (typeof time.created === 'number' && Number.isFinite(time.created)) {
    return time.created;
  }
  if (typeof time.completed === 'number' && Number.isFinite(time.completed)) {
    return time.completed;
  }
  return undefined;
}

function assistantCompletedAt(message: TranscriptMessage): number | undefined {
  const time = message.info?.time;
  if (!isRecord(time)) return undefined;
  return typeof time.completed === 'number' && Number.isFinite(time.completed)
    ? time.completed
    : undefined;
}

function isInterruptSignal(message: TranscriptMessage): boolean {
  const finish = message.info?.finish;
  if (finish === 'abort' || finish === 'aborted') return true;
  const error = message.info?.error;
  if (error === undefined || error === null) return false;
  const text = stringifyError(error).toLowerCase();
  return text.includes('abort') || text.includes('interrupted');
}

function messageIdentity(message: TranscriptMessage): string | undefined {
  const id = message.info?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function messageParentIdentity(message: TranscriptMessage): string | undefined {
  const parentID = message.info?.parentID;
  return typeof parentID === 'string' && parentID.length > 0
    ? parentID
    : undefined;
}

/**
 * Classify only the latest delivered user round.
 *
 * Pending tool parts from an older round do not block a later completed
 * round, and an older assistant answer is not reused once a newer user
 * message exists.
 */
export function classifyCurrentDeliveredRound(
  response: unknown,
): CurrentRoundClassification {
  const entries = transcriptEntries(response);
  if (!Array.isArray(entries)) {
    return { verdict: 'unreadable', reason: entries.reason };
  }
  const messages = entries.filter((message) => !isCompactionRound(message));

  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role === 'user') {
      latestUser = index;
      break;
    }
  }
  if (latestUser < 0) {
    return { verdict: 'unreadable', reason: 'no delivered user round' };
  }
  const startedAt = transcriptOrderKey(
    messages[latestUser] as TranscriptMessage,
  );

  let assistant = -1;
  for (let index = messages.length - 1; index > latestUser; index -= 1) {
    if (messages[index]?.info?.role === 'assistant') {
      assistant = index;
      break;
    }
  }
  if (assistant < 0) return { verdict: 'incomplete', startedAt };

  const turn = messages[assistant] as TranscriptMessage;
  const declaredParent = messageParentIdentity(turn);
  const latestUserID = messageIdentity(
    messages[latestUser] as TranscriptMessage,
  );
  if (declaredParent && declaredParent !== latestUserID) {
    return latestUserID
      ? { verdict: 'incomplete', startedAt }
      : {
          verdict: 'unreadable',
          reason: 'assistant parent is not the latest user',
        };
  }
  if (isInterruptSignal(turn)) {
    return {
      verdict: 'interrupted',
      startedAt,
      completedAt: assistantCompletedAt(turn),
    };
  }
  const evidence = classifyAssistantTurnEvidence(
    messages,
    assistant,
    latestUser,
    true,
  );
  const completedAt = assistantCompletedAt(turn);
  switch (evidence.kind) {
    case 'ready':
      return {
        verdict: 'completed',
        text: evidence.text,
        startedAt,
        completedAt,
      };
    case 'error':
      return {
        verdict: 'error',
        text: evidence.errorText,
        startedAt,
        completedAt,
      };
    default:
      return { verdict: 'incomplete', startedAt };
  }
}

function sourceTypeOf(message: TranscriptMessage): string | undefined {
  const source = message.info?.sourceType ?? message.info?.role;
  return typeof source === 'string' ? source : undefined;
}

function outcomeOf(message: TranscriptMessage): string | undefined {
  const outcome = message.info?.outcome;
  return typeof outcome === 'string' && outcome.length > 0
    ? outcome
    : undefined;
}

function textOf(message: TranscriptMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter(
      (part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => (part as { text: string }).text.trim())
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Historical v2 round. The latest user or synthetic message is the input
 * boundary. Only an idle/outcome after that boundary can confirm the round.
 * An older idle or Session-level outcome is not reused, and a missing time
 * is not treated as zero.
 */
export function classifyV2HistoricalRound(
  response: unknown,
): CurrentRoundClassification {
  if (response === undefined) {
    return { verdict: 'unreadable', reason: 'transcript source unavailable' };
  }
  if (responseError(response) !== undefined) {
    return { verdict: 'unreadable', reason: 'transcript read failed' };
  }
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return { verdict: 'unreadable', reason: 'malformed transcript response' };
  }
  const messages: TranscriptMessage[] = [];
  for (const entry of response.data) {
    if (!isRecord(entry) || !isRecord(entry.info)) {
      return { verdict: 'unreadable', reason: 'malformed transcript entries' };
    }
    messages.push(entry);
  }
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = sourceTypeOf(messages[index] as TranscriptMessage);
    if (source === 'user' || source === 'synthetic') {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) {
    return { verdict: 'unreadable', reason: 'no delivered user round' };
  }
  const startedAt = transcriptOrderKey(messages[boundary] as TranscriptMessage);
  // No user or synthetic entry follows the boundary.
  let assistant = -1;
  let closingIdle = -1;
  for (let index = boundary + 1; index < messages.length; index += 1) {
    const message = messages[index] as TranscriptMessage;
    const source = sourceTypeOf(message);
    if (source === 'assistant') {
      assistant = index;
      closingIdle = -1;
      continue;
    }
    if (source === 'idle') closingIdle = index;
  }
  if (closingIdle < 0) return { verdict: 'incomplete', startedAt };
  const idle = messages[closingIdle] as TranscriptMessage;
  const idleOutcome = outcomeOf(idle);
  const completedAt =
    transcriptOrderKey(idle) ??
    (assistant >= 0
      ? assistantCompletedAt(messages[assistant] as TranscriptMessage)
      : undefined);
  if (idleOutcome === undefined) {
    return { verdict: 'unreadable', reason: 'idle outcome is missing' };
  }
  if (idleOutcome === 'interrupted') {
    return { verdict: 'interrupted', startedAt, completedAt };
  }
  if (idleOutcome === 'failed') {
    const turn =
      assistant >= 0 ? (messages[assistant] as TranscriptMessage) : undefined;
    return {
      verdict: 'error',
      text:
        (turn ? textOf(turn) : '') ||
        'The historical round failed before an assistant result.',
      startedAt,
      completedAt,
    };
  }
  if (idleOutcome !== 'succeeded') {
    return {
      verdict: 'unreadable',
      reason: `unrecognized idle outcome ${idleOutcome}`,
    };
  }
  if (assistant < 0) return { verdict: 'incomplete', startedAt };
  const text = textOf(messages[assistant] as TranscriptMessage);
  if (!text) return { verdict: 'incomplete', startedAt };
  return {
    verdict: 'completed',
    text,
    startedAt,
    completedAt:
      assistantCompletedAt(messages[assistant] as TranscriptMessage) ??
      completedAt,
  };
}
