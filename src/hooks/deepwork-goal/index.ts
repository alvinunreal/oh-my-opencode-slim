/**
 * Deepwork goal pointer.
 *
 * The /deepwork activation message is the only window copy of this session's
 * pinned head path; compaction eats it, and with it the model's ability to
 * find its own progress state (SKILL.md's "read the chain on resume" line is
 * a probabilistic backstop, not a mechanism). This hook re-derives a single
 * state-neutral pointer from disk truth and delivers it once per compaction
 * epoch, so it survives every compaction the host performs:
 *
 * - Placement: one trailing volatile message (strip + append), the same
 *   ownership model as the job board's volatile tail. It is never persisted,
 *   so the stable prefix — every real message — is byte-identical across
 *   requests: a mid-session activation, a head rewrite, or a head deletion
 *   only ever changes the volatile tail zone, which re-caches every turn
 *   anyway. Earlier messages are never mutated or reordered.
 * - Once per epoch: within a compaction epoch the window is append-only
 *   (the cache-safety stable-prefix invariant), so the first message ID
 *   identifies the epoch. The pointer is injected on the first eligible
 *   request of an epoch whose announcement is not visible, then skipped —
 *   a per-request pointer reads as a per-turn directive and weak models
 *   answer it with read-and-report loops. A new epoch (compaction rebuilt
 *   the window) re-arms the pointer. Windows without message IDs fail open
 *   and inject every request, as before. A rewind into a claimed epoch
 *   (session undo) stays suppressed: inside the run the announcement still
 *   shows the path, and rewinding past activation must not re-add a
 *   pointer the user unwound.
 * - Skip at zero cost: while the activation message — or any intact quote
 *   of its head announcement — is visible in a genuine (non-synthetic,
 *   non-wake) part, the path is already in front of the model and the
 *   pointer would be pure duplication.
 * - Gate: the head file exists and has not flipped to `status: completed`
 *   (fail open — any read or parse doubt keeps the pointer alive; a
 *   drifted status line can only over-inject, never silently drop it).
 * - Fail closed on identity: no session message in the window → no
 *   injection. Wake continuations carry a user message, so unattended
 *   post-compaction runs are covered.
 *
 * Placement contract: the pointer message is tagged with BOTH its own key
 * and the job board's key, because the board's strip/anchor/trigger
 * machinery classifies its volatile tail zone by the board key. Carrying
 * the board key makes the pointer a first-class resident of that zone —
 * the board strips and re-anchors around it, the v2 breakpoint skips it,
 * and the cache-safety fingerprints exclude it — with zero board-module
 * changes. The pointer transform runs LAST (after the board) so a
 * re-entered transform chain stays ordered: the board's trailing-zone
 * strip removes the dual-tagged pointer mid-chain, and a matching claim
 * restores it by array identity (a fresh array is a new request the epoch
 * already served and stays suppressed).
 *
 * Switch: list "deepwork-goal" in disabled_hooks (disabled = never
 * injected).
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { formatSystemReminder } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import {
  appendTrailingVolatileMessage,
  omittedOrFull,
  stripTaggedContent,
} from '../cache-safe-injection';
import { routerHeadAnnouncement } from '../deepwork';
import {
  type MessageTransformView,
  resolveView,
} from '../message-transform-view';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../task-session-manager/board-injection';
import type { MessagePart, MessageWithParts } from '../types';

export const GOAL_POINTER_METADATA_KEY = 'oh-my-opencode-slim.deepworkGoal';

/** Bound on the mtime cache (FIFO eviction), mirroring the prompt bridge. */
const MAX_TRACKED_HEADS = 256;

/** The tombstone flip: the SKILL.md contract's completion shape (first line
 * `status: completed`), single machine implementation shared with the goal
 * pointer's head gate. Pinned by the SSoT fixture test. */
export function isCompletedFlip(text: string): boolean {
  return /^status:\s*completed\b/.test(text.trimStart());
}

function pointerText(sessionID: string): string | undefined {
  return omittedOrFull(
    formatSystemReminder(
      `Deepwork router head: \`.slim/deepwork/${sessionID}.md\`.`,
    ),
    400,
  );
}

/**
 * Production disk gate factory: the head exists and has not flipped to
 * completed. One statSync per request; the file is re-read only when its
 * mtime moves.
 */
export function createDeepworkHeadGate(
  directory: string,
): (sessionID: string) => boolean {
  const cache = new Map<string, { mtimeMs: number; active: boolean }>();
  return (sessionID) => {
    const headPath = path.join(directory, '.slim/deepwork', `${sessionID}.md`);
    let mtimeMs: number;
    try {
      const stat = statSync(headPath);
      if (!stat.isFile()) return false;
      mtimeMs = stat.mtimeMs;
    } catch {
      return false; // no head → gate closed
    }
    const hit = cache.get(sessionID);
    if (hit && hit.mtimeMs === mtimeMs) return hit.active;

    let active = true;
    try {
      active = !isCompletedFlip(readFileSync(headPath, 'utf8'));
    } catch {
      active = true; // read doubt → fail open
    }
    if (cache.size >= MAX_TRACKED_HEADS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sessionID, { mtimeMs, active });
    return active;
  };
}

/** A real, model-visible text part: not synthetic, not an internal wake. */
function isGenuineTextPart(
  part: MessagePart,
): part is MessagePart & { text: string } {
  return (
    part.type === 'text' &&
    typeof part.text === 'string' &&
    part.synthetic !== true &&
    !isInternalInitiatorPart(part)
  );
}

interface DeepworkGoalOptions {
  /** True when the session may see the pointer. */
  isEligible: (sessionID: string) => boolean;
}

/** FIFO bound on the per-session epoch claims, mirroring the head gate. */
const MAX_TRACKED_EPOCHS = 256;

/** The window's epoch token: the first non-synthetic message that carries
 * an ID. The stable-prefix invariant keeps the window append-only within a
 * compaction epoch, and every compaction rebuild drops the epoch's first
 * real message (v1 summary anchor, v2 truncation marker), so the token
 * changes across epochs. Synthetic entries (summaries, wakes) are skipped
 * so a rebuilt window is still anchored by a real message. Takes the view's
 * live `valid` refs — parts are read at consumption time, so a strip that
 * replaced a trailing message's parts is still seen correctly. */
function epochOf(messages: readonly MessageWithParts[]): string | undefined {
  for (const message of messages) {
    if (
      message.info.role === 'user' &&
      message.parts.every((part) => !isGenuineTextPart(part))
    ) {
      continue;
    }
    const id = message.info.id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

export function createDeepworkGoalHook(options: DeepworkGoalOptions) {
  // Once-per-epoch claim: sessionID → epoch whose pointer was delivered.
  const claimedEpochs = new Map<string, string>();
  // Arrays this hook already delivered into: a matching claim on the same
  // array means a re-entered transform chain (the board's trailing-zone
  // strip removes the dual-tagged pointer), so the pass restores it. A
  // fresh array means a new request the epoch already served.
  const deliveredArrays = new WeakSet<object>();

  const claim = (sessionID: string, epoch: string) => {
    // Re-set even on an existing claim so the LRU order tracks the hot
    // session, not the first insertion.
    claimedEpochs.delete(sessionID);
    if (claimedEpochs.size >= MAX_TRACKED_EPOCHS) {
      const oldest = claimedEpochs.keys().next().value;
      if (oldest !== undefined) claimedEpochs.delete(oldest);
    }
    claimedEpochs.set(sessionID, epoch);
  };

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
      view?: MessageTransformView,
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      // The pointer runs LAST, after the board's trailing zone: the root
      // forwards a view rebuilt after that append/strip. resolveView is only
      // the failsafe (identity+length); the rebuild is the contract.
      const resolved = resolveView(view, messages);

      const sessionID = resolved.latestUser?.info.sessionID;
      if (!sessionID || !options.isEligible(sessionID)) {
        // Ineligible: drop any stale pointer so a head deletion or a
        // completed flip only ever costs the volatile tail.
        stripTaggedContent(messages, GOAL_POINTER_METADATA_KEY);
        return;
      }

      // Head announcement visible in any genuine part: the path is already
      // in front of the model, inject nothing. This counts as delivery:
      // recording the epoch here keeps the revert guarantee intact — an
      // undo that rewinds past the activation message must not re-add a
      // pointer the user unwound, even though the announcement vanished.
      const epoch = epochOf(resolved.valid);
      const announcement = routerHeadAnnouncement(sessionID);
      for (const message of resolved.valid) {
        for (const part of message.parts) {
          if (isGenuineTextPart(part) && part.text.includes(announcement)) {
            stripTaggedContent(messages, GOAL_POINTER_METADATA_KEY);
            if (epoch !== undefined) claim(sessionID, epoch);
            return;
          }
        }
      }

      // Already delivered in this epoch. A fresh array stays suppressed —
      // the host renders one per request, and the pointer was delivered
      // once. The same array re-entering the chain means the board's
      // trailing-zone strip removed the dual-tagged pointer mid-chain:
      // strip + re-append restores exactly one pointer for this payload.
      if (epoch !== undefined && claimedEpochs.get(sessionID) === epoch) {
        if (!deliveredArrays.has(messages)) return;
        const text = pointerText(sessionID);
        if (!text) return;
        stripTaggedContent(messages, GOAL_POINTER_METADATA_KEY);
        appendTrailingVolatileMessage(
          messages,
          {
            role: 'user',
            agent: 'orchestrator',
            sessionID,
            id: `deepwork-goal-${sessionID}`,
          },
          {
            text,
            metadataKey: GOAL_POINTER_METADATA_KEY,
            extraMetadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
          },
        );
        return;
      }

      const text = pointerText(sessionID);
      if (!text) return;
      stripTaggedContent(messages, GOAL_POINTER_METADATA_KEY);
      appendTrailingVolatileMessage(
        messages,
        {
          role: 'user',
          agent: 'orchestrator',
          sessionID,
          id: `deepwork-goal-${sessionID}`,
        },
        {
          text,
          metadataKey: GOAL_POINTER_METADATA_KEY,
          extraMetadata: { [BACKGROUND_JOB_BOARD_METADATA_KEY]: true },
        },
      );
      if (epoch !== undefined) {
        claim(sessionID, epoch);
        deliveredArrays.add(messages);
      }
    },
  };
}
