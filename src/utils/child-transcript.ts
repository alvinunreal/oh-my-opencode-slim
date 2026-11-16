/**
 * Shared child-session transcript evidence extraction and fetch.
 *
 * Native task observation and council seats need the child's trailing
 * transcript. This module reads a v1-style
 * `{data: [{info, parts}]}` messages response and classifying the
 * trailing assistant turn — and for fetching that transcript:
 * `fetchChildTranscript` binds the client's `session.messages` endpoint
 * (degraded hosts may not expose it) and surfaces `response.error` as a
 * normalized `Error`, replacing the bind/call/unwrap boilerplate that was
 * previously duplicated at every call site. `responseError` and
 * `stringifyError` are the shared response-error extraction and error-text
 * helpers for session-endpoint call sites.
 */

import type { PluginInput } from '@opencode-ai/plugin';

import { isRecord } from './guards';
import type { HostRoundState } from './session-runtime-status';

export type ChildTerminalEvidence =
  | { kind: 'ready'; text: string }
  | { kind: 'textless' }
  | { kind: 'pending' }
  | { kind: 'error'; errorText: string; aborted?: true }
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
    rawFinish?: unknown;
    summary?: unknown;
    time?: { created?: unknown; completed?: unknown; streamed?: unknown };
  };
  parts?: unknown[];
}

export type TranscriptMessage = LooseMessage;

/** Slice UTF-16 without splitting a surrogate pair at either boundary. */
function diagnosticSlice(text: string, start: number, end?: number): string {
  let sliced = text.slice(start, end);
  if (/^[\uDC00-\uDFFF]/u.test(sliced)) sliced = sliced.slice(1);
  if (/[\uD800-\uDBFF]$/u.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

/** Read only known error-message fields; never serialize arbitrary error data. */
function diagnosticErrorText(error: unknown) {
  const candidates =
    typeof error === 'string'
      ? [error]
      : isRecord(error)
        ? [isRecord(error.data) ? error.data.message : undefined, error.message]
        : [];
  let truncated = false;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = diagnosticSlice(candidate, -480);
    truncated ||= candidate.length > text.length;
    if (text.trim()) return { text, truncated };
  }
  return truncated
    ? { text: '[error details truncated]', truncated: true }
    : undefined;
}

/** UTF-8-safe tail trimming, without allocating a copy of an unbounded string. */
export function diagnosticTail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const tail = diagnosticSlice(text, -maxBytes);
  // Bun's Buffer.byteLength undercounts lone surrogates; encode once instead.
  let bytes = new TextEncoder().encode(tail).byteLength;
  let start = 0;
  let end = tail.length;
  while (bytes > maxBytes) {
    const code = tail.charCodeAt(start++);
    const next = start < end ? tail.charCodeAt(start) : NaN;
    const dropsLow = next >= 0xdc00 && next <= 0xdfff;
    // Each cut also removes a leading low and a trailing high, if present.
    if (code >= 0xd800 && code <= 0xdbff && dropsLow) {
      bytes -= 4;
      start++;
    } else {
      bytes -= code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      if (dropsLow) {
        bytes -= 3;
        start++;
      }
    }
    const last = tail.charCodeAt(end - 1);
    if (start < end && last >= 0xd800 && last <= 0xdbff) {
      end--;
      bytes -= 3;
    }
  }
  return tail.slice(start, end);
}

/**
 * Index of the latest delivered input entry, or -1 when none exists.
 *
 * One shared tail-first boundary scan for every transcript consumer. The
 * default predicate matches a delivered user or synthetic source (falling
 * back to `role`); `roleOnly` keeps the v1 delivered-round contract
 * (`info.role === 'user'`).
 * Byte-identical to the five scans it replaced.
 */
function latestInputIndexOf(
  entries: TranscriptMessage[],
  options: { roleOnly?: boolean } = {},
): number {
  return entries.findLastIndex((entry) => {
    if (options.roleOnly) return entry.info?.role === 'user';
    const source = sourceTypeOf(entry);
    return source === 'user' || source === 'synthetic';
  });
}

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
  | { verdict: 'error'; text: string; aborted?: true }
  | { verdict: 'absent' }
  | { verdict: 'retry'; reason: string };

function verdictFromEvidence(
  evidence: ChildTerminalEvidence,
): TerminalEvidenceVerdict {
  switch (evidence.kind) {
    case 'ready':
      return { verdict: 'completed', text: evidence.text };
    case 'error':
      return {
        verdict: 'error',
        text: evidence.errorText,
        ...(evidence.aborted ? { aborted: true } : {}),
      };
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

function isHostAbortError(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.type === 'aborted' || error.name === 'MessageAbortedError')
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
    const error = last.info.error;
    return {
      kind: 'error',
      errorText: stringifyError(error),
      ...(isHostAbortError(error) ? { aborted: true } : {}),
    };
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

function transcriptOrderKey(message: TranscriptMessage): number | undefined {
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

  const latestUser = latestInputIndexOf(messages, { roleOnly: true });
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

/** Invalidate a parsed host terminal when its transcript has newer assistant
 * activity. This adds attribution only; hostRoundStateOf/composeHostRound
 * still own projection parsing, input boundaries, and outcome composition. */
export function attributeHostRoundToTranscript(
  state: HostRoundState,
  transcript: unknown,
): HostRoundState {
  if (state.kind !== 'terminal') return state;
  const entries = transcriptEntries(transcript);
  if (!Array.isArray(entries)) {
    return { kind: 'unknown', reason: entries.reason };
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as TranscriptMessage;
    const source = sourceTypeOf(entry);
    if (source === 'user' || source === 'synthetic') break;
    if (source !== 'assistant') continue;
    const at = transcriptOrderKey(entry);
    if (at === undefined) {
      return { kind: 'unknown', reason: 'assistant time is missing' };
    }
    const finished = assistantCompletedAt(entry);
    if (
      at > state.idleAt ||
      (finished !== undefined && finished > state.idleAt)
    ) {
      return { kind: 'pending' };
    }
  }
  return state;
}

/** Latest delivered user/synthetic input timestamp in a host transcript. */
export function latestInputAtOf(transcript: unknown): number | undefined {
  const entries = transcriptEntries(transcript);
  if (!Array.isArray(entries)) return undefined;
  const boundary = latestInputIndexOf(entries);
  return boundary < 0 ? undefined : transcriptOrderKey(entries[boundary]);
}

/** Text of the latest assistant entry after the latest user/synthetic input. */
export function terminalTextOf(transcript: unknown): string | undefined {
  const entries = transcriptEntries(transcript);
  if (!Array.isArray(entries)) return undefined;
  const boundary = latestInputIndexOf(entries);
  for (let index = entries.length - 1; index > boundary; index -= 1) {
    const entry = entries[index] as TranscriptMessage;
    if (sourceTypeOf(entry) === 'assistant') return textOf(entry);
  }
  return undefined;
}

/** Latest host or assistant error in the current round. */
export function terminalErrorOf(transcript: unknown): string | undefined {
  const entries = transcriptEntries(transcript);
  if (!Array.isArray(entries)) return undefined;
  const boundary = latestInputIndexOf(entries);
  for (let index = entries.length - 1; index > boundary; index -= 1) {
    const entry = entries[index] as TranscriptMessage;
    const source = sourceTypeOf(entry);
    if (source === 'idle' || source === 'assistant') {
      const error = diagnosticErrorText(entry.info?.error);
      if (error) return error.text;
    }
  }
  return undefined;
}

/** A v1 closure in history with no observed v2 lifecycle evidence. */
export function classifyMigratedV1Round(
  response: unknown,
): CurrentRoundClassification | undefined {
  const messages = transcriptEntries(response);
  if (!Array.isArray(messages)) return undefined;
  // shortcut: marker-free v2 history resembles migration; upgrade when the host exposes migration provenance.
  if (
    messages.some(
      (message) =>
        sourceTypeOf(message) === 'idle' ||
        message.info?.rawFinish !== undefined ||
        message.info?.time?.streamed !== undefined ||
        message.info?.outcome !== undefined,
    )
  )
    return undefined;
  const assistant = messages.findLast(
    (message) => message.info?.role === 'assistant',
  );
  if (
    !assistant ||
    assistantCompletedAt(assistant) === undefined ||
    (assistant.info?.finish === undefined && assistant.info?.error == null)
  )
    return undefined;
  return classifyCurrentDeliveredRound(response);
}
