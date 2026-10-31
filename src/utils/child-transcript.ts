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
import {
  composeHostRound,
  type HostRoundState,
  hostRoundStateOf,
} from './session-runtime-status';

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
 * `historyBoundary` is a plugin-local identity hint for terminal evidence:
 * after compaction, the V2 shim reads persisted history back to that message
 * without changing ordinary context reads. V1 clients ignore the hint.
 */
export async function fetchChildTranscript(
  client: PluginInput['client'],
  sessionID: string,
  directory: string,
  limit?: number,
  signal?: AbortSignal,
  historyBoundary?: string,
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
    ...(historyBoundary ? { historyBoundary } : {}),
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
    rawFinish?: unknown;
    summary?: unknown;
    time?: { created?: unknown; completed?: unknown; streamed?: unknown };
  };
  parts?: unknown[];
}

export type TranscriptMessage = LooseMessage;

export const DIAGNOSTIC_MAX_BYTES = 6_144;
const DIAGNOSTIC_MESSAGE_CHARS = 2_000;
const DIAGNOSTIC_ITEM_CHARS = 500;
const DIAGNOSTIC_MESSAGE_PARTS = 100;
const DIAGNOSTIC_MESSAGES = 40;

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
  let tail = diagnosticSlice(text, -maxBytes);
  while (new TextEncoder().encode(tail).byteLength > maxBytes) {
    tail = diagnosticSlice(tail, 1);
  }
  return tail;
}

/** Select before validation: even malformed older entries must not cause an
 * unbounded walk. Parts are bounded before the shared parser inspects them. */
function diagnosticWindow(response: unknown):
  | { unavailable: string }
  | {
      entries: TranscriptMessage[];
      omittedMessages: number;
      partsTruncated: boolean;
    } {
  if (response === undefined)
    return { unavailable: 'transcript source not exposed by host' };
  if (responseError(response) !== undefined)
    return { unavailable: 'transcript read failed' };
  if (!isRecord(response) || !Array.isArray(response.data))
    return { unavailable: 'malformed transcript response' };
  const omittedMessages = Math.max(
    0,
    response.data.length - DIAGNOSTIC_MESSAGES,
  );
  let partsTruncated = false;
  const data = response.data.slice(omittedMessages).map((entry: unknown) => {
    if (!isRecord(entry) || !Array.isArray(entry.parts)) return entry;
    if (entry.parts.length > DIAGNOSTIC_MESSAGE_PARTS) partsTruncated = true;
    return {
      info: entry.info,
      parts: entry.parts.slice(-DIAGNOSTIC_MESSAGE_PARTS),
    };
  });
  const entries = transcriptEntries({ data });
  if (!Array.isArray(entries)) return { unavailable: entries.reason };
  return { entries, omittedMessages, partsTruncated };
}

/** Keep v2 maintenance recognition local: ordinary terminal readers retain
 * their existing host-specific classification contracts. */
function isDiagnosticCompactionRound(message: TranscriptMessage): boolean {
  return sourceTypeOf(message) === 'compaction' || isCompactionRound(message);
}

/**
 * Index of the latest delivered input entry, or -1 when none exists.
 *
 * One shared tail-first boundary scan for every transcript consumer. The
 * default predicate matches a delivered user or synthetic source (falling
 * back to `role`); `roleOnly` keeps the v1 delivered-round contract
 * (`info.role === 'user'`) and `skipCompaction` ignores maintenance rounds.
 * Byte-identical to the five scans it replaced.
 */
function latestInputIndexOf(
  entries: TranscriptMessage[],
  options: { roleOnly?: boolean; skipCompaction?: boolean } = {},
): number {
  return entries.findLastIndex((entry) => {
    if (options.skipCompaction && isDiagnosticCompactionRound(entry)) {
      return false;
    }
    if (options.roleOnly) return entry.info?.role === 'user';
    const source = sourceTypeOf(entry);
    return source === 'user' || source === 'synthetic';
  });
}

/** Bounded, non-final assistant evidence. Never includes tool inputs or
 * successful tool output. Validation uses the shared rules on the tail only. */
export function diagnosticExcerptOf(
  response: unknown,
  options: {
    maxBytes?: number;
    runStartedAt?: number;
    completedAt?: number;
    /** Recorded host admission id of this run's opening input. When
     *  present, attribution is identity-fenced: the excerpt must sit
     *  behind exactly that input or it is refused — never a timestamp
     *  guess. */
    inputMessageID?: string;
    /** Admission id of the newest input the plugin itself delivered into
     *  this same generation (v1 `task_message`, v2 steer). It is a legal
     *  excerpt boundary too: the run continued after it. */
    amendmentMessageID?: string;
  } = {},
):
  | { unavailable: string }
  | {
      text: string;
      truncated: string;
      omittedMessages: number;
      assistantError?: string;
    } {
  const window = diagnosticWindow(response);
  if ('unavailable' in window) return { unavailable: window.unavailable };
  const { entries } = window;
  const { runStartedAt, completedAt } = options;
  // The tracked reader always supplies this field, even when the record lacks
  // a usable terminal time; standalone excerpt-only callers may omit it.
  if ('completedAt' in options) {
    if (typeof completedAt !== 'number' || !Number.isFinite(completedAt))
      return { unavailable: 'recorded terminal time is unavailable' };
    // Like the lower fence, this relies on the production shared-Unix-ms
    // clock contract. Ignore maintenance, but never borrow later execution
    // activity merely because native registration has not updated the board.
    if (
      entries.some((entry) => {
        if (entry.info?.role === 'system' || isDiagnosticCompactionRound(entry))
          return false;
        const source = sourceTypeOf(entry);
        const created = entry.info?.time?.created;
        return (
          ['user', 'synthetic', 'assistant'].includes(source ?? '') &&
          typeof created === 'number' &&
          Number.isFinite(created) &&
          created > completedAt
        );
      })
    )
      return { unavailable: 'activity after the recorded terminal outcome' };
  }
  const boundary = latestInputIndexOf(entries, { skipCompaction: true });
  if (boundary < 0 && entries.length > 0)
    return {
      unavailable: 'latest input is outside the diagnostic message window',
    };
  // Identity fence: an anchored run must excerpt behind an input the plugin
  // recorded for THIS generation — its opening anchor, or a same-generation
  // amendment it delivered itself. Any other latest input means a later run
  // owns the tail; an unfound id means the window cannot prove attribution.
  // Both refuse — anchored rows never fall back to the timestamp heuristics.
  if (options.inputMessageID !== undefined) {
    const boundaryID =
      boundary < 0 || entries.length === 0
        ? undefined
        : entries[boundary]?.info?.id;
    if (typeof boundaryID !== 'string') {
      return {
        unavailable:
          'recorded run input is outside the diagnostic message window',
      };
    }
    if (
      boundaryID !== options.inputMessageID &&
      boundaryID !== options.amendmentMessageID
    ) {
      return {
        unavailable:
          'latest input is not this run’s recorded input; a later run owns the tail',
      };
    }
  }
  if (runStartedAt !== undefined && options.inputMessageID === undefined) {
    // Native registration can follow the prompt, whereas revive captures its
    // start before admission. Do not require the input to postdate registration
    // or guess a launch-time tolerance. Only assistant creation in this run's
    // time range is safe to excerpt; completion alone could belong to old work.
    const assistants = entries
      .slice(boundary + 1)
      .filter(
        (entry) =>
          entry.info?.role === 'assistant' &&
          !isDiagnosticCompactionRound(entry),
      );
    if (
      !Number.isFinite(runStartedAt) ||
      assistants.some(
        (entry) =>
          typeof entry.info?.time?.created !== 'number' ||
          !Number.isFinite(entry.info.time.created),
      )
    )
      return {
        unavailable:
          'tracked run attribution requires assistant creation timestamps',
      };
    if (
      !assistants.some(
        (entry) => (entry.info?.time?.created as number) >= runStartedAt,
      )
    )
      return {
        unavailable: 'no assistant evidence at or after the tracked run start',
      };
  }
  let charsCut = window.partsTruncated;
  const budget = Math.max(
    0,
    Math.min(DIAGNOSTIC_MAX_BYTES, options.maxBytes ?? DIAGNOSTIC_MAX_BYTES),
  );
  const chunks: string[] = [];
  let omittedMessages = window.omittedMessages + Math.max(0, boundary);
  const boundaryCounted =
    options.inputMessageID === undefined &&
    runStartedAt !== undefined &&
    typeof entries[boundary]?.info?.time?.created === 'number' &&
    (entries[boundary].info?.time?.created as number) < runStartedAt;
  if (boundaryCounted) omittedMessages++;
  let compactionMessages = 0;
  let assistantError: string | undefined;
  let bytes = 0;
  for (let index = entries.length - 1; index > boundary; index--) {
    const entry = entries[index];
    if (isDiagnosticCompactionRound(entry)) {
      compactionMessages++;
      continue;
    }
    if (entry.info?.role !== 'assistant') continue;
    // An identity-anchored read already proved this generation's latest input,
    // so transcript order after it is authoritative. A resumed foreground run
    // can register after its own output, which would make runStartedAt later
    // than the evidence this run must keep.
    if (
      options.inputMessageID === undefined &&
      runStartedAt !== undefined &&
      (entry.info?.time?.created as number) < runStartedAt
    ) {
      omittedMessages++;
      continue;
    }
    const pieces: string[] = [];
    let chars = 0;
    const add = (text: string, cap: number) => {
      const room = Math.max(0, DIAGNOSTIC_MESSAGE_CHARS - chars);
      const clipped =
        room > 0 ? diagnosticSlice(text, -Math.min(room, cap)) : '';
      if (text.length > clipped.length) charsCut = true;
      if (clipped) {
        pieces.unshift(clipped);
        chars += clipped.length + 1;
      }
    };
    const error = entry.info?.error;
    const detail = diagnosticErrorText(error);
    if (detail) {
      assistantError ??= detail.text;
      if (detail.truncated) charsCut = true;
      add(`assistant_error: ${detail.text}`, DIAGNOSTIC_ITEM_CHARS);
    }
    const parts = entry.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (!isRecord(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string')
        add(part.text, DIAGNOSTIC_MESSAGE_CHARS);
      if (
        part.type === 'tool' &&
        isRecord(part.state) &&
        part.state.status === 'error'
      ) {
        const toolError = diagnosticErrorText(part.state.error);
        if (toolError) {
          if (toolError.truncated) charsCut = true;
          add(`tool_error: ${toolError.text}`, DIAGNOSTIC_ITEM_CHARS);
        }
      }
    }
    const text = diagnosticSlice(pieces.join('\n'), -DIAGNOSTIC_MESSAGE_CHARS);
    chunks.unshift(text);
    bytes += new TextEncoder().encode(text).byteLength + 1;
    if (bytes >= budget) {
      omittedMessages += index - boundary - 1;
      charsCut = true;
      break;
    }
  }
  const omitted =
    (omittedMessages
      ? `[... ${omittedMessages} earlier messages omitted ...]\n`
      : '') +
    (compactionMessages
      ? `[... ${compactionMessages} compaction messages omitted ...]\n`
      : '');
  let text = chunks.filter(Boolean).join('\n\n');
  const encoder = new TextEncoder();
  if (encoder.encode(omitted + text).byteLength > budget) charsCut = true;
  const marker = charsCut ? '[... truncated ...]\n' : '';
  text =
    omitted +
    marker +
    diagnosticTail(text, budget - encoder.encode(omitted + marker).byteLength);
  return {
    text: diagnosticTail(text, budget),
    truncated:
      [
        omittedMessages || compactionMessages ? 'messages' : '',
        charsCut ? 'chars' : '',
      ]
        .filter(Boolean)
        .join(',') || 'none',
    omittedMessages: omittedMessages + compactionMessages,
    ...(assistantError ? { assistantError } : {}),
  };
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

/**
 * Historical v2 round. The latest user or synthetic message is the input
 * boundary. Only an idle/outcome after that boundary can confirm the round.
 * An older idle or Session-level outcome is not reused, and a missing time
 * is not treated as zero.
 */
export function classifyV2HistoricalRound(
  response: unknown,
  hasV2Lifecycle = false,
): CurrentRoundClassification {
  const messages = transcriptEntries(response);
  if (!Array.isArray(messages)) {
    return { verdict: 'unreadable', reason: messages.reason };
  }
  const migrated = hasV2Lifecycle
    ? undefined
    : classifyMigratedV1Round(response);
  if (migrated) return migrated;
  const boundary = latestInputIndexOf(messages);
  if (boundary < 0) {
    return { verdict: 'unreadable', reason: 'no delivered user round' };
  }
  const startedAt = transcriptOrderKey(messages[boundary] as TranscriptMessage);
  // No user or synthetic entry follows the boundary.
  let closingIdle = -1;
  for (let index = boundary + 1; index < messages.length; index += 1) {
    const message = messages[index] as TranscriptMessage;
    const source = sourceTypeOf(message);
    if (source === 'assistant') {
      closingIdle = -1;
      continue;
    }
    if (source === 'idle') closingIdle = index;
  }
  if (closingIdle < 0) return { verdict: 'incomplete', startedAt };
  const idle = messages[closingIdle] as TranscriptMessage;
  // A persisted idle supplies the host terminal boundary, never the
  // assistant's completion time. Apply the same attribution as on-demand
  // recovery so newer assistant activity cannot stretch an older idle.
  const state = attributeHostRoundToTranscript(
    hostRoundStateOf({
      outcome: outcomeOf(idle),
      time: { idle: transcriptOrderKey(idle) },
    }),
    response,
  );
  const round = composeHostRound(state, startedAt);
  if (round.verdict === 'completed' || round.verdict === 'error') {
    const text = terminalTextOf(response);
    if (text) round.text = text;
    else if (round.verdict === 'completed') {
      return { verdict: 'incomplete', startedAt };
    }
  }
  return round;
}
