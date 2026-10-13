/**
 * Deepwork goal pointer.
 *
 * The /deepwork activation message is the only window copy of this session's
 * pinned head path; compaction eats it, and with it the model's ability to
 * find its own progress state (SKILL.md's "read the chain on resume" line is
 * a probabilistic backstop, not a mechanism). This hook re-derives a single
 * state-neutral pointer from disk truth every request, so it survives every
 * compaction the host performs:
 *
 * - Placement: one trailing volatile message (strip + re-append each
 *   request), the same ownership model as the job board's volatile tail.
 *   It is never persisted, so the stable prefix — every real message — is
 *   byte-identical across requests: a mid-session activation, a head
 *   rewrite, or a head deletion only ever changes the volatile tail zone,
 *   which re-caches every turn anyway. Earlier messages are never mutated
 *   or reordered. Eligibility is re-checked every request, so the pointer
 *   is also frozen per window: within a compaction epoch the decision
 *   inputs (disk gate, announcement visibility) are append-only, so the
 *   pointer never flips mid-epoch in either direction.
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
 * changes. The pointer transform runs LAST (after the board) so the strip
 * order in a re-entered transform stays deterministic.
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
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from '../task-session-manager/board-injection';
import {
  findLatestUserMessage,
  isMessageWithParts,
  type MessagePart,
} from '../types';

export const GOAL_POINTER_METADATA_KEY = 'oh-my-opencode-slim.deepworkGoal';

/** The head's tombstone flip (SKILL.md contract; mirrors deepwork-guard). */
const COMPLETED_FLIP = /^status:\s*completed\b/m;

/** Bound on the mtime cache (FIFO eviction), mirroring the prompt bridge. */
const MAX_TRACKED_HEADS = 256;

function pointerText(sessionID: string): string | undefined {
  return omittedOrFull(
    formatSystemReminder(
      `Deepwork: this session's router head is \`.slim/deepwork/${sessionID}.md\` — read it before acting; the file is authoritative.`,
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
      active = !COMPLETED_FLIP.test(readFileSync(headPath, 'utf8'));
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

export function createDeepworkGoalHook(options: DeepworkGoalOptions) {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];
      // Re-entry idempotence: strip first so repeated transforms on a
      // shared array leave exactly one pointer behind.
      stripTaggedContent(messages, GOAL_POINTER_METADATA_KEY);

      const sessionID = findLatestUserMessage(messages)?.info.sessionID;
      if (!sessionID || !options.isEligible(sessionID)) return;

      // Head announcement visible in any genuine part: the path is already
      // in front of the model, inject nothing.
      const announcement = routerHeadAnnouncement(sessionID);
      for (const message of messages) {
        if (!isMessageWithParts(message)) continue;
        for (const part of message.parts) {
          if (isGenuineTextPart(part) && part.text.includes(announcement)) {
            return;
          }
        }
      }

      const text = pointerText(sessionID);
      if (!text) return;
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
    },
  };
}
