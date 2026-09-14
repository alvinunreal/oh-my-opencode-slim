/**
 * Post-tool nudge — delegation reminder after implementation tool use.
 *
 * Catches the "inspect/edit files → implement myself" anti-pattern
 * (#1099-class) and the stronger-model variant where the orchestrator
 * drifts into doing the delegated work itself via shell, edits, or
 * patches instead of dispatching specialists (#1012).
 *
 * Delivery is fully history-derived, never session-state-derived:
 *
 * - Stable part: every eligible user message whose PRECEDING assistant
 *   block used nudge tools carries the nudge. The condition is
 *   evaluable on the message's first render and never changes, so
 *   re-renders reproduce byte-identical history (cache-safe).
 * - Volatile trailing message: when the payload currently ENDS in an
 *   assistant block that used nudge tools (a tool loop in progress),
 *   the nudge rides as its own tagged trailing message behind all
 *   stable content. Whether it exists depends only on the payload
 *   shape, so the stable prefix is never rewritten between renders.
 *
 * The pending flag is used only to suppress nothing here — it exists
 * for the legacy `tool.execute.after` consumers; this hook keeps it
 * wired so session deletion still clears external pending state.
 */

import { IMPLEMENTATION_DRIFT_NUDGE } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import { isRecord } from '../../utils/guards';
import {
  appendTaggedSyntheticPart,
  appendTrailingVolatileMessage,
  isTaggedPart,
  isVolatileTaggedMessage,
} from '../cache-safe-injection';
import type { SessionLifecycle } from '../session-lifecycle';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../task-session-manager/board-injection';
import {
  isMessageWithParts,
  isUserMessageWithParts,
  type MessageWithParts,
} from '../types';

/** Implementation-surface tools: using them as the primary workspace
 * signals the coordinator is doing specialist work itself (#1012).
 * Purely-coordination tools (task*, grep on its own) stay exempt so
 * verification reads and dispatch prep do not spam the reminder. */
const NUDGE_TOOLS = new Set([
  // file mutation/inspection the original nudge covered
  'Read',
  'read',
  'Write',
  'write',
  // implementation drift: editing code, running builds/tests, patching
  'Edit',
  'edit',
  'apply_patch',
  'bash',
  'Bash',
  'shell',
]);

interface PostFileToolNudgeOptions {
  shouldInject?: (sessionID: string) => boolean;
  coordinator?: SessionLifecycle;
}

export const IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY =
  'oh-my-opencode-slim.implementationDriftNudge';

interface ToolPartShape {
  type?: string;
  tool?: unknown;
}

function blockUsedNudgeTools(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return (parts as ToolPartShape[]).some(
    (part) =>
      part.type === 'tool' &&
      typeof part.tool === 'string' &&
      NUDGE_TOOLS.has(part.tool),
  );
}

export function createPostFileToolNudgeHook(
  options: PostFileToolNudgeOptions = {},
) {
  const { coordinator } = options;

  if (coordinator) {
    coordinator.onSessionDeleted((sid) => coordinator.clearSession(sid));
  }

  return {
    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      _output: unknown,
    ): Promise<void> => {
      if (!NUDGE_TOOLS.has(input.tool) || !input.sessionID) return;
      // Kept for external pending-state consumers; delivery below is
      // history-derived and never consults this flag.
      coordinator?.markPending(input.sessionID);
    },
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];
      reconcileStableNudges(messages, options, allowedMap(options));
    },
    /**
     * Late-phase trailing publication (#1012): runs AFTER phase-reminder
     * and the background job board so (a) neither hook can append to or
     * anchor on the volatile message, and (b) eligibility is evaluated
     * against the real payload tail, exactly as the next turn's early
     * cleanup will see it.
     */
    deliverTrailingNudge: async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];
      // The semantic tail skips ONLY infrastructure trailing messages
      // identified by their own tags: the job board injected its own
      // volatile message earlier in this pipeline. Synthetic-but-real
      // user turns (internal-initiator wakes) are persisted history and
      // DO count as the tail — a payload ending in one is not mid-loop.
      let tailIndex = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (
          isVolatileTaggedMessage(
            messages[i],
            BACKGROUND_JOB_BOARD_METADATA_KEY,
          ) ||
          isOwnVolatileDriftMessage(messages[i])
        ) {
          continue;
        }
        tailIndex = i;
        break;
      }
      if (tailIndex < 0) return;
      const tail = messages[tailIndex] as
        | {
            info?: { role?: string; agent?: string; sessionID?: string };
            parts?: unknown;
          }
        | undefined;
      if (tail?.info?.role !== 'assistant') return;
      if (tail.info.agent !== undefined && tail.info.agent !== 'orchestrator') {
        return;
      }
      if (!blockUsedNudgeTools(tail.parts)) return;
      const sessionID = tail.info?.sessionID;
      if (!sessionID) return;
      if (!isAllowedSession(options, allowedMap(options), sessionID)) return;
      appendTrailingVolatileMessage(
        messages,
        { role: 'user', agent: 'orchestrator', sessionID },
        {
          text: IMPLEMENTATION_DRIFT_NUDGE,
          metadataKey: IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY,
        },
      );
    },
  };
}

/** True when the message is this hook's own volatile trailing message:
 * every part is plugin-synthetic and at least one carries this hook's
 * tag (covers a phase-reminder part appended to it by an older render
 * of the pre-split pipeline). Real user turns always carry a
 * non-synthetic or internal-tagged part without this key. */
function isOwnVolatileDriftMessage(message: unknown): boolean {
  return (
    isMessageWithParts(message) &&
    message.parts.length > 0 &&
    message.parts.every((part) => isSyntheticPart(part)) &&
    message.parts.some((part) =>
      isTaggedPart(part, IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY),
    )
  );
}

function isSyntheticPart(part: unknown): boolean {
  return isRecord(part) && part.synthetic === true;
}

/**
 * Idempotent selective reconciliation of the stable in-message nudge
 * parts (#1012). Never strip-and-reappend: a part that still
 * corresponds to history stays at its exact position (byte-stable
 * across renders even when other hooks already appended their own parts
 * after it), a part that no longer corresponds is removed from that
 * message alone, and a missing part is appended at the message tail.
 * Own volatile trailing messages are removed wherever they sit, so
 * residue never survives an ineligible render and later hooks
 * (phase-reminder, the job board) never see a volatile drift message.
 */
function reconcileStableNudges(
  messages: unknown[],
  options: PostFileToolNudgeOptions,
  allowed: Map<string, boolean> | undefined,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isOwnVolatileDriftMessage(messages[i])) messages.splice(i, 1);
  }
  for (const [index, message] of messages.entries()) {
    if (!isMessageWithParts(message)) continue;
    // Board infrastructure (checkpoint snapshots and its trailing
    // message) is never a nudge recipient: every part carries the board
    // tag. Mutating it would rewrite infra bytes and misattribute drift.
    if (isVolatileTaggedMessage(message, BACKGROUND_JOB_BOARD_METADATA_KEY)) {
      continue;
    }
    const eligible = getEligibleMessage(message);
    // History eligibility is immutable for an existing message (its
    // preceding block cannot change); the session gate is NOT — it reads
    // mutable agent metadata. A part that history still qualifies must
    // stay even if the gate flipped to false after that part was
    // rendered: removing it would rewrite the cached prompt prefix. The
    // gate only decides whether a MISSING part may be appended now.
    const historyQualifies =
      eligible !== undefined &&
      precedingBlockUsedNudgeTools(messages, index, eligible.sessionID);
    const shouldHave =
      historyQualifies &&
      eligible !== undefined &&
      isAllowedSession(options, allowed, eligible.sessionID);
    let kept = false;
    message.parts = message.parts.filter((part) => {
      if (!isTaggedPart(part, IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY)) {
        return true;
      }
      if (historyQualifies && !kept) {
        kept = true;
        return true;
      }
      return false;
    });
    if (shouldHave && !kept) {
      appendTaggedSyntheticPart(message, {
        text: IMPLEMENTATION_DRIFT_NUDGE,
        metadataKey: IMPLEMENTATION_DRIFT_NUDGE_METADATA_KEY,
      });
    }
  }
}

function allowedMap(
  options: PostFileToolNudgeOptions,
): Map<string, boolean> | undefined {
  return options.shouldInject ? new Map<string, boolean>() : undefined;
}

function isAllowedSession(
  options: PostFileToolNudgeOptions,
  allowed: Map<string, boolean> | undefined,
  sessionID: string,
): boolean {
  if (!options.shouldInject) return true;
  if (!allowed) return options.shouldInject(sessionID);
  if (!allowed.has(sessionID)) {
    allowed.set(sessionID, options.shouldInject(sessionID));
  }
  return allowed.get(sessionID) === true;
}

/**
 * True when the assistant block immediately preceding the message at
 * `index` (scanning back to the previous user message) belongs to the
 * SAME session's orchestrator and contains a tool part for a nudge
 * tool — i.e. that orchestrator's previous turn did implementation work
 * itself. Assistant blocks from other agents or sessions never count:
 * a specialist's edits must not nudge the coordinator.
 */
function precedingBlockUsedNudgeTools(
  messages: unknown[],
  index: number,
  sessionID: string,
): boolean {
  for (let j = index - 1; j >= 0; j -= 1) {
    const candidate = messages[j] as
      | {
          info?: { role?: string; agent?: string; sessionID?: string };
          parts?: unknown;
        }
      | undefined;
    if (!candidate || !Array.isArray(candidate.parts)) break;
    // Board infrastructure (checkpoint snapshots) is transparent to the
    // scan: skip it BEFORE the user cut so a replayed snapshot between
    // the assistant block and the real user message neither stops the
    // scan nor contributes tools.
    if (isVolatileTaggedMessage(candidate, BACKGROUND_JOB_BOARD_METADATA_KEY)) {
      continue;
    }
    if (candidate.info?.role === 'user') break;
    if (candidate.info?.role !== 'assistant') continue;
    if (
      candidate.info.agent !== undefined &&
      candidate.info.agent !== 'orchestrator'
    ) {
      continue;
    }
    if (candidate.info.sessionID !== sessionID) continue;
    if (blockUsedNudgeTools(candidate.parts)) return true;
  }
  return false;
}

function getEligibleMessage(
  message: unknown,
): { message: MessageWithParts; sessionID: string } | undefined {
  if (
    !isUserMessageWithParts(message) ||
    !message.info.sessionID ||
    message.info.agent !== 'orchestrator'
  ) {
    return undefined;
  }

  const textPart = message.parts.find(
    (part) => part.type === 'text' && part.text !== undefined,
  );
  if (!textPart || isInternalInitiatorPart(textPart)) {
    return undefined;
  }

  return { message, sessionID: message.info.sessionID };
}
