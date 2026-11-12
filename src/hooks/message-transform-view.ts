/**
 * Request-local view over one transform invocation's `messages` array.
 *
 * The message-transform pipeline funnels one array through several stages
 * (interview collapse, mention rewrite, image processing, the task manager,
 * phase reminder, council injection, the job-board tail, deepwork goal).
 * Each stage used to re-scan the whole transcript to skip malformed entries
 * and to find the latest user message. This view captures those facts once
 * per invocation, plus per-request memoized image decodes.
 *
 * The view snapshots nothing but message identity and index: parts, text,
 * and tags are read from the live message objects at consumption time,
 * because earlier hooks append or replace parts after the view exists.
 * Consumers that run after a stage which can add or remove messages must
 * receive a view rebuilt afterwards — `resolveView` is the failsafe, not the
 * contract.
 */

import { asImagePart, type ImagePartView } from './image-part';
import {
  isMessageWithParts,
  isUserMessageWithParts,
  type MessageWithParts,
} from './types';

/** A well-formed user message with its position in the source array. */
interface UserMessageEntry {
  readonly index: number;
  readonly message: MessageWithParts;
}

export interface MessageTransformView {
  readonly messages: unknown[];
  readonly length: number;
  /** Well-formed messages, in order — live references, no snapshot. */
  readonly valid: readonly MessageWithParts[];
  /** Well-formed user messages, in order — live references. */
  readonly userMessages: readonly MessageWithParts[];
  /** User messages with their source-array indices. */
  readonly userEntries: readonly UserMessageEntry[];
  /** Latest well-formed user message (what findLatestUserMessage returns). */
  readonly latestUser: MessageWithParts | undefined;
  /** Latest user message's sessionID, falling back to the first well-formed
   * message's — the root transform's derivation. */
  readonly sessionID: string | undefined;
  /** Normalized image view for a part, decoded at most once per request:
   * memoized by part identity within this view (a replaced part object is a
   * fresh decode); never shared across views. */
  imageView(part: unknown): ImagePartView | null;
}

export function createMessageTransformView(
  messages: unknown[],
): MessageTransformView {
  const source = Array.isArray(messages) ? messages : [];
  const valid: MessageWithParts[] = [];
  const userEntries: UserMessageEntry[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const message = source[index];
    if (!isMessageWithParts(message)) {
      continue;
    }
    valid.push(message);
    if (isUserMessageWithParts(message)) {
      userEntries.push({ index, message });
    }
  }
  const latestUser = userEntries.at(-1)?.message;
  const imageViews = new WeakMap<object, ImagePartView | null>();

  return {
    messages: source,
    length: source.length,
    valid,
    userMessages: userEntries.map((entry) => entry.message),
    userEntries,
    latestUser,
    sessionID: latestUser?.info.sessionID ?? valid.at(0)?.info.sessionID,
    imageView(part: unknown): ImagePartView | null {
      if (part === null || typeof part !== 'object') {
        return asImagePart(part);
      }
      const cached = imageViews.get(part);
      if (cached !== undefined) {
        return cached;
      }
      const decoded = asImagePart(part);
      imageViews.set(part, decoded);
      return decoded;
    },
  };
}

/**
 * Resolve the view a transform should use: the caller's view when it covers
 * the current array (same identity, same length), a freshly built one
 * otherwise. Identity+length catches the two structural events a view must
 * not survive — the job board's tail append and a volatile-zone strip — but
 * not a strip and an append that cancel out; the root rebuild points are the
 * contract, this is only the failsafe. A mismatch silently falls back to the
 * transform's pre-view behavior.
 */
export function resolveView(
  view: MessageTransformView | undefined,
  messages: unknown[],
): MessageTransformView {
  if (view && view.messages === messages && view.length === messages.length) {
    return view;
  }
  return createMessageTransformView(messages);
}
