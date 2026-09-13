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

interface ChildTranscriptOptions {
  /** Only consider messages after this baseline message id (revive flow). */
  baselineMessageID?: string;
  /** Require `info.time.completed` on the trailing assistant (v1 hosts
   * always provide it once the turn finalizes). Defaults to true; v2
   * shim shapes pass false because the flat mapping drops `time` —
   * terminality there is confirmed via the host outcome gate before
   * this extractor runs. */
  requireCompletionTime?: boolean;
  /** When the ABSOLUTE trailing message is not an assistant, scan
   * backward for the last assistant and classify that message instead.
   * v2 sessions can carry structurally valid non-assistant tails
   * (synthetic/system/skill); the default (false) keeps the strict
   * trailing-message semantics the revive probe relies on. */
  scanBackToLastAssistant?: boolean;
}

export type ChildTerminalEvidence =
  | { kind: 'ready'; text: string }
  | { kind: 'textless' }
  | { kind: 'pending' }
  | { kind: 'error'; errorText: string }
  | { kind: 'no-assistant' }
  | { kind: 'no-new-messages' };

/**
 * Fetch a child session's transcript via `client.session.messages`.
 *
 * Returns the raw response, or `undefined` when the host client does not
 * expose a callable `session.messages` endpoint (degraded hosts) — each
 * call site decides how to degrade. Transport failures propagate to the
 * caller. A `response.error` payload is surfaced as a normalized `Error`
 * whose message is `stringifyError(response.error)`, matching the
 * error-surfacing style previously duplicated at the call sites.
 */
export async function fetchChildTranscript(
  client: PluginInput['client'],
  sessionID: string,
  directory: string,
): Promise<unknown> {
  const session = client.session;
  const messages =
    typeof session?.messages === 'function'
      ? session.messages.bind(session)
      : undefined;
  if (typeof messages !== 'function') return undefined;
  const response = await messages({
    path: { id: sessionID },
    query: { directory },
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
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

interface LooseMessage {
  info?: {
    id?: unknown;
    role?: unknown;
    error?: unknown;
    finish?: unknown;
    time?: { completed?: unknown };
  };
  parts?: unknown[];
}

export function extractChildTerminalEvidence(
  response: unknown,
  options: ChildTranscriptOptions = {},
): ChildTerminalEvidence {
  const data =
    isRecord(response) && Array.isArray(response.data)
      ? (response.data as unknown[])
      : [];
  const messages = data.filter(isRecord) as LooseMessage[];
  if (messages.length === 0) return { kind: 'no-assistant' };

  const baselineIndex = options.baselineMessageID
    ? messages.findIndex((m) => m.info?.id === options.baselineMessageID)
    : -1;
  if (options.baselineMessageID && baselineIndex < 0) {
    return { kind: 'no-new-messages' };
  }
  const lastIndex = messages.length - 1;
  if (baselineIndex >= 0 && lastIndex <= baselineIndex) {
    return { kind: 'no-new-messages' };
  }

  let targetIndex = lastIndex;
  if (
    options.scanBackToLastAssistant &&
    messages[targetIndex].info?.role !== 'assistant'
  ) {
    targetIndex = -1;
    for (let i = lastIndex; i >= 0; i -= 1) {
      if (messages[i].info?.role === 'assistant') {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return { kind: 'no-assistant' };
  }

  const last = messages[targetIndex];
  if (last.info?.role !== 'assistant') return { kind: 'no-assistant' };

  const requireCompletionTime = options.requireCompletionTime ?? true;
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

  if (last.info?.error !== undefined && last.info?.error !== null) {
    return { kind: 'error', errorText: stringifyError(last.info.error) };
  }

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
