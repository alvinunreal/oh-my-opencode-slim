/**
 * Appends the reminder to exactly one orchestrator user message: the first
 * eligible one in the session view. The anchor is fixed, so its rendered bytes
 * never change between requests — that turn-invariance protects the provider
 * prefix cache. #790 bought the same invariant by re-appending to every message
 * (O(N) copies); a fixed anchor buys it with O(1). The anchor only moves when
 * the host rewrites the prefix (compaction / trim / fork), which already
 * invalidates the cache, so re-anchoring costs nothing (aside from the first
 * injection into an already-anchored view after such a rewrite, which appends
 * into what was previously the cached prefix — same as the pre-change
 * behavior).
 * Supersedes #790's mechanism; preserves #790's invariant.
 *
 * Anchor eligibility is per-message and history-derived: agent switches never
 * add or remove bytes already emitted. On v2 the context bridge reconstructs
 * per-message agent per request from durable `agent-switched` markers
 * (src/v2/setup.ts), so switches preserve anchor bytes there too. Residuals:
 * v1-migrated sessions carry no per-message agent and track the session's
 * current agent (status quo); the segment before a first in-window marker
 * lacking `previous` (pre-2026-08-10 rows) falls back the same way, bounded
 * by the compaction window.
 *
 * Do NOT make this tail-only: a reminder pinned to the newest message rewrites
 * the previous anchor's bytes every turn and pays full input price every turn,
 * because a moving reminder is always new content and never survives long
 * enough to be cache-read.
 */
import { PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils/internal-initiator';
import {
  appendTaggedSyntheticPart,
  isTaggedPart,
} from '../cache-safe-injection';
import {
  type MessageTransformView,
  resolveView,
} from '../message-transform-view';
import type { MessagePart } from '../types';

export { PHASE_REMINDER };

export const PHASE_REMINDER_METADATA_KEY = 'oh-my-opencode-slim.phaseReminder';

export function hasPhaseReminder(part: MessagePart): boolean {
  return isTaggedPart(part, PHASE_REMINDER_METADATA_KEY);
}

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Injection eligibility is per-message (orchestrator-authored user turns only);
 * see the module docblock for the history-stability contract.
 *
 * `view` is an internal wiring argument: the root transform passes the
 * request-local message view it already built so the latest-user lookup and
 * the eligible-user iteration reuse one traversal instead of re-scanning the
 * transcript. When omitted the hook builds its own view; `resolveView`
 * rebuilds when the view's identity or length no longer matches the array.
 */
export function createPhaseReminderHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
      view?: MessageTransformView,
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      const resolved = resolveView(view, messages);

      const lastUserMessage = resolved.latestUser;
      if (!lastUserMessage) {
        return;
      }

      const { sessionID } = lastUserMessage.info;

      // Append as a separate part instead of mutating user-authored text;
      // the reminder stays out of the UI display and history (issue #448).
      for (const message of resolved.userMessages) {
        if (
          message.info.agent !== 'orchestrator' ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }

        const textPart = message.parts.find(
          (part) => part.type === 'text' && part.text !== undefined,
        );
        if (!textPart || isInternalInitiatorPart(textPart)) {
          continue;
        }

        // Anchor on the first eligible message and stop. A later anchor would
        // rewrite already-cached bytes every turn (see the module docblock).
        if (!message.parts.some(hasPhaseReminder)) {
          appendTaggedSyntheticPart(message, {
            text: PHASE_REMINDER,
            metadataKey: PHASE_REMINDER_METADATA_KEY,
          });
        }
        break;
      }
    },
  };
}
