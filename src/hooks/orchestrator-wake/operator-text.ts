/**
 * Pure operator-message helpers and delta texts, split out of the wake
 * scheduler so light consumers (src/index.ts, task-session-manager) can use
 * them without loading the whole v1 scheduler implementation.
 *
 * Byte-for-byte moved from ./index.ts; re-exported there for existing
 * callers. Keep this module dependency-free apart from the two guards
 * leaves: no host APIs, no scheduler state, no board.
 */
import { isRecord as isObjectRecord } from '../../utils/guards';
import { isInternalInitiatorPart } from '../../utils/internal-initiator';

/**
 * True only for a genuine external operator message. Plugin-injected nudges
 * must never rearm the no-progress cap or clear wait state:
 * - synthetic parts (board tails, revived-run terminal notifications,
 *   internal-initiator wake replays) are host/internal, not operator input.
 *   Phase reminders ride only the anchored first eligible user message since
 *   the phase-reminder first-anchor change, so the phaseReminder metadata veto
 *   below applies only to that anchored message; non-anchor historical user
 *   messages carry no tag and fall through to the remaining arms;
 * - `noReply` prompts (interview URL
 *   notifications) never expect an operator turn;
 * - v2 command-marker submits (`ctx.session.prompt` text-only submits) carry
 *   no chat.message messageID identity, so they fail the operator-identity
 *   gate below.
 *
 * Exported for unit tests and shared with task-session-manager (single
 * source of truth for the genuine-operator verdict).
 */
export function isGenuineOperatorMessage(
  inputMessage: Record<string, unknown> | undefined,
  outputMessage: Record<string, unknown> | undefined,
  parts: unknown,
): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false;
  for (const part of parts) {
    if (!isObjectRecord(part)) continue;
    // Any synthetic or internal-initiator part vetoes the whole message:
    // a single plugin-injected part marks the turn as plugin-injected even
    // when it rides alongside genuine operator text (e.g. a wake replay
    // appended to an operator turn). Fail closed toward no-rearm.
    if (part.synthetic === true || isInternalInitiatorPart(part)) return false;
    // Non-text/non-file/non-image parts (e.g. step-start markers) carry no
    // operator content.
    if (
      !(
        (part.type === 'text' && typeof part.text === 'string') ||
        part.type === 'file' ||
        part.type === 'image'
      )
    ) {
      continue;
    }
    // Tagged synthetic-adjacent injections (board/phase metadata keys) that
    // survived without the synthetic flag are still not operator input. The
    // phase key now narrows to the anchored first eligible message only.
    if (isObjectRecord(part.metadata)) {
      const metadata = part.metadata as Record<string, unknown>;
      if (
        metadata['oh-my-opencode-slim.backgroundJobBoard'] === true ||
        metadata['oh-my-opencode-slim.phaseReminder'] === true ||
        metadata['oh-my-opencode-slim.deepworkGoal'] === true ||
        metadata['oh-my-opencode-slim.internalInitiator'] === true
      ) {
        return false;
      }
    }
  }
  // Operator identity: the host assigns a messageID to real chat.message
  // turns. v2 command submits and bare notify injections arrive without one.
  // Upstream's messageIdentity seam (input.messageID → output.message.id →
  // same-process output.message object, fail closed) is the identity half
  // of this verdict; the checks above are the genuineness half. Both must
  // pass: callers keep their own messageIdentity computation and additionally
  // require this helper, so neither seam can pass an injection alone.
  const inputMessageID = inputMessage?.messageID;
  const outputMessageID = outputMessage?.id;
  const hasOperatorIdentity =
    (typeof inputMessageID === 'string' && inputMessageID.length > 0) ||
    (typeof outputMessageID === 'string' && outputMessageID.length > 0);
  if (!hasOperatorIdentity) return false;
  // noReply injections never expect an operator turn.
  if (inputMessage?.noReply === true || outputMessage?.noReply === true) {
    return false;
  }
  return true;
}

/** Self-contained terminal delta appended to the stopped-job recovery wake.
 * The board cannot serve this wake: internal-initiator turns (which this
 * wake is) are excluded from board placement, so the first board the
 * parent sees after the wake reflects a board state from BEFORE the job
 * stopped. A wake that says "check the board" with no board entry behind
 * it leaves the parent guessing. The delta carries the facts
 * of the triggering stop inline: alias, task id, state, and why it stopped.
 * Deduplicated per execution by the caller. */
export function formatStoppedJobDelta(record: {
  alias: string;
  taskID: string;
  generation: number;
  state: string;
  reason: string;
}): string {
  return `<stopped-job>\nalias: ${record.alias}\ntask: ${record.taskID}\nstate: ${record.state}\nreason: ${record.reason}\n</stopped-job>`;
}

/** Self-contained result for a later terminal publication not covered by the
 * host's native first-publication notifier. The result text is carried
 * verbatim; the generation/revision fence travels in part metadata, never in
 * the prompt-visible body. */
export function formatCompletedJobDelta(record: {
  alias: string;
  taskID: string;
  state: 'completed' | 'error';
  resultSummary: string;
}): string {
  return `<completed-job>\nalias: ${record.alias}\ntask: ${record.taskID}\nstate: ${record.state}\nresult: ${record.resultSummary}\n</completed-job>`;
}

/** Host-attributed stop outcome (shared with the stopped-recovery wake
 * gate in src/index.ts): the host's own report that it interrupted or
 * cancelled the run, committed by the terminal gate as a terminal result
 * summary. Anchor of both the honest recovery reason below and the
 * wake skip for host-attributed stops (foreground tool calls, and
 * background ones unless an emergency stop is pending). */
export const HOST_ATTRIBUTED_STOP_OUTCOME =
  /^Host reported outcome: (interrupted|cancelled)\./;

/** Reason line for a stopped-job recovery delta. A stop committed from a
 * host-attributed interruption/cancellation DOES carry a terminal result
 * (the host's own outcome report); blaming a missing result misinforms
 * the woken parent about what recovery means here. */
export function stoppedJobRecoveryReason(record: {
  timedOut: boolean;
  statusUncertain: boolean;
  resultSummary?: string;
}): string {
  if (record.timedOut) return 'external task-wait timeout';
  if (record.statusUncertain) return 'runtime status uncertain';
  const attributed = HOST_ATTRIBUTED_STOP_OUTCOME.exec(
    record.resultSummary ?? '',
  );
  if (attributed) {
    const kind =
      attributed[1] === 'interrupted' ? 'interruption' : 'cancellation';
    return `host-attributed ${kind} (terminal result present)`;
  }
  return 'stopped without a terminal result';
}

/** Self-contained delta for a child input-wait wake (same rationale as
 * formatStoppedJobDelta: the wake carries the facts inline). Deduplicated
 * per (taskID, requestID) by the caller. */
export function formatChildInputWaitDelta(record: {
  alias: string;
  taskID: string;
  kind: 'question' | 'permission';
  requestID: string;
  detail: string;
}): string {
  return `<child-input-wait>\nalias: ${record.alias}\ntask: ${record.taskID}\nkind: ${record.kind}\nrequest: ${record.requestID}\n${record.detail}</child-input-wait>`;
}
