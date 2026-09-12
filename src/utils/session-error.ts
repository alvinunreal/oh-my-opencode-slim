/**
 * Minimal session-error classifiers for background job lanes.
 *
 * `isFailoverError` (src/hooks/foreground-fallback) is intentionally NOT reused
 * here even though it is importable without a cycle: it also matches
 * rate-limit and provider-outage payloads, so routing everything it accepts to
 * the recoverable `statusUncertain` marking would hide genuine provider
 * failures (a child dying with "Internal server error" must still surface as
 * `error`).
 *
 * Only a network/transport fault means "the child may well still be alive, we
 * simply lost the wire": that is the case the board must report as
 * `statusUncertain` ("verify or revive") instead of asserting a terminal
 * failure.
 */

/**
 * Mirror of `TRANSPORT_CODES` in `src/hooks/foreground-fallback/index.ts`.
 *
 * Kept verbatim and pinned by the drift guard in `session-error.test.ts`. Add
 * codes that foreground-fallback does not carry to
 * {@link ADDITIONAL_TRANSPORT_CODES} instead, or the guard will fail.
 */
const TRANSPORT_ERROR_CODES = [
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
] as const;

/**
 * Socket-level codes this classifier recognizes beyond the mirrored set.
 *
 * Foreground fallback only needs codes worth RETRYING a prompt for. Lane
 * classification has a wider job: any broken wire means the child's outcome is
 * unknown rather than failed, so a lane must not be terminalized on one. All
 * of these are Node/undici faults where no response was ever produced:
 *
 * - `EPIPE` / `ENETDOWN` / `ENETUNREACH` / `EHOSTUNREACH`: the local link or
 *   route died mid-stream (the wifi-drop signature this classifier exists
 *   for).
 * - `UND_ERR_SOCKET`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`:
 *   undici's own transport errors, which is what Bun/Node `fetch` surfaces
 *   when the connection fails before a body arrives.
 *
 * Must stay disjoint from the mirrored list above; the drift guard asserts it.
 */
const ADDITIONAL_TRANSPORT_CODES = [
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
] as const;

const ALL_TRANSPORT_CODES: readonly string[] = [
  ...TRANSPORT_ERROR_CODES,
  ...ADDITIONAL_TRANSPORT_CODES,
];

const TRANSPORT_CODE_SET = new Set<string>(ALL_TRANSPORT_CODES);
const TRANSPORT_CODE_PATTERN = new RegExp(
  `\\b(?:${ALL_TRANSPORT_CODES.join('|')})\\b`,
);

/**
 * Copied from `TRANSPORT_MESSAGE_PATTERNS` in
 * `src/hooks/foreground-fallback/index.ts` (~line 82).
 *
 * Copied rather than imported on purpose: `src/utils` must not depend on
 * `src/hooks`, and foreground-fallback already imports from `src/utils`
 * (logger, session, internal-initiator), so importing it here would close a
 * utils → hooks → utils cycle. `src/utils/session-error.test.ts` pins the two
 * lists together so the copy cannot silently drift.
 *
 * Only the TRANSPORT set is mirrored. The rate-limit and provider-outage sets
 * in that file are deliberately NOT reused: those are real provider failures
 * that must stay `error`, not recoverable lanes.
 *
 * These matter more than the code list in practice — OpenCode serialises
 * errors as `{ name, data: { message } }` and the underlying `code` rarely
 * survives, so the wire fault usually only appears as "fetch failed" or
 * "socket hang up".
 */
const TRANSPORT_MESSAGE_PATTERNS = [
  /^fetch failed$/i,
  /^socket hang up$/i,
  /^provider request timeout$/i,
  /^request timeout$/i,
  /^connect ECONNREFUSED\b/i,
  /^getaddrinfo ENOTFOUND\b/i,
  // Provider SDKs also report connection failures with natural-language
  // messages (e.g. "stream error: Cannot connect to API") that carry no
  // transport code. Match the narrow phrase only.
  /cannot connect to api/i,
];

function matchesTransportText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (TRANSPORT_CODE_PATTERN.test(normalized)) return true;
  return TRANSPORT_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * True when `error` carries one of the recognized transport codes, either as a
 * structured `code` field (`error.code`, `error.cause.code`, `error.data.code`)
 * or embedded in a message/response body — including the bare transport
 * phrasings OpenCode actually emits (`fetch failed`, `socket hang up`).
 */
export function isTransportError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'string') return matchesTransportText(error);
  if (typeof error !== 'object') return false;
  if (isAbortedSessionError(error)) return false;

  const err = error as {
    code?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
    data?: { code?: unknown; message?: unknown; responseBody?: unknown };
  };

  if (
    [err.code, err.cause?.code, err.data?.code].some(
      (code) => typeof code === 'string' && TRANSPORT_CODE_SET.has(code),
    )
  ) {
    return true;
  }

  return [err.message, err.data?.message, err.data?.responseBody].some(
    matchesTransportText,
  );
}

/**
 * The SDK error name OpenCode records on an aborted assistant message.
 *
 * Measured against opencode 1.18.26: aborting a child emits `session.error`
 * with this name plus `session.idle`, and NO `session.deleted` — so this name
 * is the only reliable signal that a lane was cut short before producing a
 * result. On the last assistant message it is definitive: `info.finish` is
 * `null` and no trailing `step-finish` part is present, while `info.time.
 * completed` is stamped on aborted messages too (and an interrupted tool part
 * can still read `status: "completed"`), so neither can be used to infer
 * success.
 */
export const ABORTED_SESSION_ERROR_NAME = 'MessageAbortedError';

/** True when `error` is OpenCode's "this message was aborted" marker. */
export function isAbortedSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { name?: unknown }).name === ABORTED_SESSION_ERROR_NAME;
}

/**
 * Human-readable message for an OpenCode session/message error.
 *
 * The SDK error shape is `{ name, data: { message } }`, so the message usually
 * lives on `data`; `error.message` is only present on plain `Error`-like
 * values. Falls back to the error name, then to `fallback`.
 */
export function sessionErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  if (typeof error !== 'object' || error === null) return fallback;
  const err = error as { name?: unknown; message?: unknown; data?: unknown };
  const data =
    typeof err.data === 'object' && err.data !== null ? err.data : {};
  for (const candidate of [
    err.message,
    (data as { message?: unknown }).message,
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return typeof err.name === 'string' && err.name.length > 0
    ? err.name
    : fallback;
}

/** The transport code carried by `error`, if any, for reason text. */
function transportCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const err = error as {
    code?: unknown;
    cause?: { code?: unknown };
    data?: { code?: unknown };
  };
  for (const candidate of [err.code, err.cause?.code, err.data?.code]) {
    if (typeof candidate === 'string' && TRANSPORT_CODE_SET.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Board text for a lane whose transport died.
 *
 * Deliberately says the outcome is UNKNOWN rather than failed: the child may
 * still be running on the host, so the parent's next move is to verify or
 * revive, never to treat the task as errored.
 */
export function transportSessionErrorReason(error: unknown): string {
  const detail = sessionErrorMessage(error, '') || transportCodeOf(error) || '';
  return detail
    ? `Child session lost its transport connection (${detail}); the task outcome is unknown.`
    : 'Child session lost its transport connection; the task outcome is unknown.';
}
