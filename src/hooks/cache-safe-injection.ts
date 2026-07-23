/**
 * Cache-safe prompt injection helpers.
 *
 * Provider prompt caches are exact byte-prefix matches over the rendered
 * request (tools → system → messages). Any transform that rewrites or
 * reorders earlier conversation content invalidates the cache for everything
 * after the first changed byte, so every later request in the session re-pays
 * full input cost and latency.
 *
 * These helpers are the single supported way for hooks to add content to the
 * outgoing payload:
 *
 * - `appendTaggedSyntheticPart` appends deterministic content at the tail of
 *   an existing message. Safe because re-running the transform on the next
 *   turn reproduces the same bytes at the same position.
 * - `stripTaggedContent` + `appendTrailingVolatileMessage` own content that
 *   changes between turns (job boards, status blocks): strip every previously
 *   injected occurrence, then re-append one synthetic message at the very end
 *   of the payload, so churn only ever costs the tail of the prompt.
 *
 * Rules the helpers encode (and the cache-safety property tests enforce):
 * never mutate or reorder earlier messages, never inject unmarked parts, and
 * never put timestamps or randomness into content injected before the tail.
 * See docs/cache-verification.md.
 */

import { isRecord } from '../utils/guards';
import {
  isMessageWithParts,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
} from './types';

export interface TaggedSyntheticPartSpec {
  /** Text content of the injected part. */
  text: string;
  /**
   * Metadata key marking the part as plugin-injected. Used for dedupe and
   * strip-before-reappend; must be stable for the lifetime of the feature.
   */
  metadataKey: string;
  /** Additional metadata merged into the part (the tag key always wins). */
  extraMetadata?: Record<string, unknown>;
}

/** Build a synthetic text part tagged with the given metadata key. */
export function createTaggedSyntheticPart(
  spec: TaggedSyntheticPartSpec,
): MessagePart {
  return {
    type: 'text',
    synthetic: true,
    text: spec.text,
    metadata: { ...(spec.extraMetadata ?? {}), [spec.metadataKey]: true },
  };
}

/** True when the part is a synthetic part tagged with the metadata key. */
export function isTaggedPart(part: unknown, metadataKey: string): boolean {
  return (
    isRecord(part) &&
    part.synthetic === true &&
    isRecord(part.metadata) &&
    part.metadata[metadataKey] === true
  );
}

/** True when any part of the message carries the tag. */
export function hasTaggedPart(
  message: MessageWithParts,
  metadataKey: string,
): boolean {
  return message.parts.some((part) => isTaggedPart(part, metadataKey));
}

/**
 * Append deterministic content as a tagged synthetic part at the message
 * tail. The content must be a pure function of session-stable inputs so the
 * next turn's transform reproduces identical bytes at the same position.
 */
export function appendTaggedSyntheticPart(
  message: MessageWithParts,
  spec: TaggedSyntheticPartSpec,
): void {
  message.parts.push(createTaggedSyntheticPart(spec));
}

/**
 * Remove every part tagged with the metadata key across all messages and
 * drop messages this empties (covers both legacy in-message placement and
 * whole synthetic trailing messages).
 */
export function stripTaggedContent(
  messages: unknown[],
  metadataKey: string,
): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isMessageWithParts(message)) continue;
    const hadParts = message.parts.length > 0;
    message.parts = message.parts.filter(
      (part) => !isTaggedPart(part, metadataKey),
    );
    if (hadParts && message.parts.length === 0) messages.splice(i, 1);
  }
}

/**
 * Append volatile content as its own synthetic message at the very end of
 * the payload. Call `stripTaggedContent` first so at most one instance
 * exists; the volatile zone must stay strictly behind all stable content.
 */
export function appendTrailingVolatileMessage(
  messages: unknown[],
  info: MessageInfo,
  spec: TaggedSyntheticPartSpec,
): void {
  messages.push({
    info,
    parts: [createTaggedSyntheticPart(spec)],
  });
}

/**
 * True when the message consists solely of parts tagged with the metadata
 * key — i.e. it is a plugin-owned volatile trailing message. Used by the
 * cache-safety tests to separate the stable prefix from the volatile tail.
 */
export function isVolatileTaggedMessage(
  message: unknown,
  metadataKey: string,
): boolean {
  return (
    isMessageWithParts(message) &&
    message.parts.length > 0 &&
    message.parts.every((part) => isTaggedPart(part, metadataKey))
  );
}
