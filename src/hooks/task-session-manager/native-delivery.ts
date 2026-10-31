/**
 * Trusted native v2 completion delivery evidence.
 *
 * The host's `sessions.synthetic` part opens with the
 * `<subagent sessionID="..." state="...">` tag AND carries
 * `metadata: { source: 'subagent', childID, state }`. Both are required:
 * header anchoring alone would let pasted user/assistant text masquerade
 * as a delivery, so the metadata must exist and agree with the tag. A
 * result body merely quoting foreign task markup is nested, never at the
 * header, and cannot match either.
 */
import { isRecord } from '../../utils/guards';
import {
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
} from '../../utils/task';
import type { MessagePart, MessageWithParts } from '../types';

type NativeDeliveryState = 'completed' | 'error' | 'cancelled';

/** Delivery states the native notifier publishes (never `stopped`). */
export const NATIVE_DELIVERY_STATES: ReadonlySet<string> = new Set([
  'completed',
  'error',
  'cancelled',
]);

export type NativeDelivery = {
  taskID: string;
  state: NativeDeliveryState;
};

export function parseNativeDelivery(
  part: MessagePart,
): NativeDelivery | undefined {
  const text = part.text;
  if (typeof text !== 'string' || !/^\s*<subagent\b/i.test(text)) {
    return undefined;
  }
  const taskID = parseTaskIdFromTaskOutput(text);
  const state = parseTaskStateFromOutput(text);
  if (!taskID || !state || !NATIVE_DELIVERY_STATES.has(state)) {
    return undefined;
  }
  const meta = part.metadata;
  if (
    !isRecord(meta) ||
    meta.source !== 'subagent' ||
    meta.childID !== taskID ||
    meta.state !== state
  ) {
    return undefined;
  }
  return { taskID, state: state as NativeDeliveryState };
}

export function messageCreatedAt(
  message: MessageWithParts,
): number | undefined {
  const info = message.info as { time?: unknown };
  // The v2 host decodes `Session.Message.time` into Effect `DateTime.Utc`
  // instances — structs carrying `epochMilliseconds`, NOT plain numbers —
  // so `info.time.created` fails a naive `typeof value === 'number'` check
  // and a numeric wire form (JSON round-trips, fixtures) fails
  // `isRecord`. Accept every shape this clock actually arrives in.
  const asMillis = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) return undefined;
    const millis = (value as { epochMilliseconds?: unknown }).epochMilliseconds;
    if (typeof millis === 'number' && Number.isFinite(millis)) return millis;
    return undefined;
  };
  if (!isRecord(info.time)) {
    const direct = asMillis(info.time);
    if (direct !== undefined) return direct;
    return undefined;
  }
  // An assistant turn carries only `completed`; a user turn carries
  // `created`. Both are the message's own clock, in the same unit.
  for (const key of ['created', 'completed'] as const) {
    const value = asMillis(info.time[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}
