/**
 * Internal-initiator admission tracking on v2 hosts.
 *
 * The v1 `chat.headers` hook decides whether the current provider request
 * carries an agent-initiated user message by fetching that message's parts
 * (part-level marker metadata). v2 has no `session.message` equivalent and
 * its transcript user messages are flat (`{id, text, metadata, ...}`,
 * message-level metadata), so the v2 bridge (`src/v2/setup.ts`) learns the
 * marker from in-band sources instead:
 *
 * - `session.prompt` admissions carry prompt `metadata` (the session-prompt
 *   bridge already reads the internal-initiator key) — recorded here at
 *   admission time;
 * - `session.synthetic` admissions bypass the prompt hook entirely and the
 *   host drops synthetic metadata from the LLM context envelope, so the
 *   client shim records the admission HERE, passing a client-chosen
 *   `msg_`-prefixed id the host honors (`Session.synthetic` accepts
 *   `input.id`) and preserves on the context message.
 *
 * The chat-headers bridge then matches the trailing user message id (learned
 * from context events, which fire before every `model.request`) against this
 * tracker — no per-request transcript round-trip.
 *
 * Bounded FIFO (mirrors the prompt bridge's session-map pruning): stale ids
 * from failed admissions simply never match a real context message.
 */

const MAX_TRACKED_ADMISSIONS = 4096;

const admissions = new Map<string, true>();
let syntheticIDSequence = 0;

function key(sessionID: string, messageID: string): string {
  return `${sessionID}:${messageID}`;
}

function prune(): void {
  while (admissions.size > MAX_TRACKED_ADMISSIONS) {
    const oldest = admissions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    admissions.delete(oldest);
  }
}

/** Record that `messageID` in `sessionID` was admitted by an
 * internal-initiator prompt (plugin-driven, not user-typed). */
export function recordInternalAdmission(
  sessionID: string,
  messageID: string,
): void {
  if (!sessionID || !messageID) return;
  admissions.set(key(sessionID, messageID), true);
  prune();
}

/** Whether `messageID` in `sessionID` is a known internal-initiator
 * admission. */
export function isInternalAdmission(
  sessionID: string,
  messageID: string,
): boolean {
  return admissions.has(key(sessionID, messageID));
}

/** Client-chosen message id for internal synthetic admissions. v2
 * `SessionMessage.ID` must start with `msg_`; the synthetic endpoint honors
 * `input.id` and the id survives onto the LLM context message, which is
 * what lets the shim record the admission here before the context event
 * carries it. Unique per process (the tracker is in-memory). */
export function createInternalSyntheticMessageID(): string {
  syntheticIDSequence += 1;
  return `msg_omos_${syntheticIDSequence.toString(36)}`;
}

export function __resetInternalAdmissionsForTesting(): void {
  admissions.clear();
  syntheticIDSequence = 0;
}
