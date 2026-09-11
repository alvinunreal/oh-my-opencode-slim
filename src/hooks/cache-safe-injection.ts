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

import { AsyncLocalStorage } from 'node:async_hooks';
import { isRecord } from '../utils/guards';
import {
  isMessageWithParts,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
} from './types';

/**
 * Cache hint mirrored from the v2 LLM `ContentPart.cache` (`LLM.CacheHint`).
 * Honored by anthropic-messages / google-vertex / bedrock-converse /
 * openrouter as a manual cache-breakpoint placement; a no-op elsewhere.
 */
export interface SyntheticPartCacheHint {
  type: 'ephemeral' | 'persistent';
  ttlSeconds?: number;
}

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
  /**
   * Optional cache hint copied onto the created part. v1 callers never
   * pass it, so the v1 payload stays byte-identical; the v2 context
   * bridge scopes a per-request default via
   * `runWithSyntheticPartCacheHintScope` +
   * `setDefaultSyntheticPartCacheHint` so every part injected on v2
   * carries it, with concurrent transforms isolated.
   */
  cache?: SyntheticPartCacheHint;
}

/**
 * Request-scoped default applied to parts whose spec omits `cache`.
 *
 * The v2 context bridge runs each bridged messages transform inside its own
 * scope (`runWithSyntheticPartCacheHintScope`) because the v2 host serves
 * different sessions' requests concurrently (per-session serialization
 * only). A plain module global would let one session's restore clobber the
 * default another session's in-flight transform still depends on — the
 * AsyncLocalStorage store keeps concurrent set/restore pairs isolated.
 *
 * Outside a scope, a module-level fallback keeps the legacy set/restore
 * helper working. The v1 pipeline never enters a scope and never sets a
 * default, so v1 bytes never change.
 */
const hintScope = new AsyncLocalStorage<{
  hint?: SyntheticPartCacheHint;
}>();

/** Legacy fallback for `setDefaultSyntheticPartCacheHint` calls made outside
 * a `runWithSyntheticPartCacheHintScope` (the v1 pipeline never makes any). */
let unscopedDefaultCacheHint: SyntheticPartCacheHint | undefined;

/**
 * Run `fn` with an isolated cache-hint scope: `setDefaultSyntheticPartCacheHint`
 * calls inside `fn` (and its async descendants) mutate only this scope, so
 * concurrent callers cannot interleave their set/restore operations.
 */
export function runWithSyntheticPartCacheHintScope<T>(fn: () => T): T {
  return hintScope.run({}, fn);
}

/**
 * Set the scoped default cache hint for parts created while the returned
 * restore function has not been called. Returns a restore closure that
 * reinstates the previous default (call it in a `finally`).
 */
export function setDefaultSyntheticPartCacheHint(
  hint: SyntheticPartCacheHint | undefined,
): () => void {
  const store = hintScope.getStore();
  if (store) {
    const previous = store.hint;
    store.hint = hint;
    return () => {
      store.hint = previous;
    };
  }
  const previous = unscopedDefaultCacheHint;
  unscopedDefaultCacheHint = hint;
  return () => {
    unscopedDefaultCacheHint = previous;
  };
}

/** Build a synthetic text part tagged with the given metadata key. */
export function createTaggedSyntheticPart(
  spec: TaggedSyntheticPartSpec,
): MessagePart {
  const cache =
    spec.cache ?? hintScope.getStore()?.hint ?? unscopedDefaultCacheHint;
  return {
    type: 'text',
    synthetic: true,
    text: spec.text,
    metadata: { ...(spec.extraMetadata ?? {}), [spec.metadataKey]: true },
    // Copied (never shared) so later mutation of the spec/default cannot
    // drift an already-created part.
    ...(cache
      ? {
          cache: {
            type: cache.type,
            ...(cache.ttlSeconds !== undefined
              ? { ttlSeconds: cache.ttlSeconds }
              : {}),
          },
        }
      : {}),
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
