/**
 * Trusted native host completion delivery evidence.
 *
 * v2: the host's `sessions.synthetic` part opens with the
 * `<subagent sessionID="..." state="...">` tag AND carries
 * `metadata: { source: 'subagent', childID, state }`. The context hook
 * strips metadata, so its caller may use the exact native header instead,
 * but only behind parent, timestamp and terminal-state fences.
 * v1: the host delivers a `synthetic: true` part opening with
 * `<task id="..." state="...">`.
 */
import { isRecord } from '../../utils/guards';
import {
  parseTaskIdFromTaskOutput,
  parseTaskStateFromOutput,
} from '../../utils/task';
import type { MessagePart, MessageWithParts } from '../types';

export type NativeDeliveryState = 'completed' | 'error' | 'cancelled';

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
  allowContextHeader = false,
): NativeDelivery | undefined {
  const text = part.text;
  if (
    part.type === 'text' &&
    part.synthetic === true &&
    typeof text === 'string'
  ) {
    const v1 =
      /^<task id="(ses_[A-Za-z0-9_-]+)" state="(completed|error|cancelled)">/.exec(
        text,
      );
    if (v1) return { taskID: v1[1], state: v1[2] as NativeDeliveryState };
  }
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
    meta === undefined &&
    allowContextHeader &&
    /^<subagent sessionID="ses_[A-Za-z0-9_-]+" state="(?:completed|error|cancelled)"(?:>| [^>\r\n]*>)/.test(
      text,
    )
  ) {
    return { taskID, state: state as NativeDeliveryState };
  }
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
