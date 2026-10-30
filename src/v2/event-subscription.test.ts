/** Focused tests for the setup-fixed native event filter.
 *
 * The union is pinned to the names the production v2 pump actually
 * consumes (verified live against the pinned host surface; the
 * compile-time membership guard lives in `mirror-conformance.ts`).
 * Stream text deltas are included only when the `/interview` subsystem
 * is enabled — their only consumer.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildV2EventSubscriptionTypes,
  isV2StreamDeltaType,
} from './event-subscription';

/** Source event types the production pipeline consumes, independent of
 *  the implementation list (names verified against the pinned host
 *  `OpenCodeEvent` union). */
const PRODUCTION_REQUIRED = [
  // Identity + lifecycle: permission-rules bridge (created/agent.
  // selected/deleted), profile prewarm + preset removal (created/
  // deleted), event-directory scope + foreign task observation (moved).
  'session.created',
  'session.deleted',
  'session.agent.selected',
  'session.moved',
  // Native run lifecycle: mapV2EventToV1 → v1 busy/idle/error shapes
  // (task-session-manager, orchestrator-wake, foreground fallback); the
  // raw events are also consumed by the interview bridge and the
  // foreground fallback directly.
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  // v1 status/idle consumers read the native passthrough too.
  'session.status',
  'session.idle',
  // Telemetry → deduplicated completed-assistant message.updated
  // (cache-monitor) + task-activity.
  'session.usage.updated',
  'session.step.started',
  'session.step.failed',
  'session.step.ended',
  // Form flow → v1 question.* (input-wait tracker, companion, wake).
  'form.created',
  'form.replied',
  'form.cancelled',
  // Permission asks/replies: raw-first delivery + v1 shape synthesis.
  'permission.asked',
  'permission.replied',
] as const;

const INTERVIEW_TEXT_STREAM = [
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
] as const;

describe('buildV2EventSubscriptionTypes', () => {
  test('includes every production-required source event type', () => {
    const types = buildV2EventSubscriptionTypes();
    for (const name of PRODUCTION_REQUIRED) {
      expect(types).toContain(name);
    }
    expect(types.length).toBe(PRODUCTION_REQUIRED.length);
  });

  test('omits stream text events when the interview consumer is disabled', () => {
    const types = buildV2EventSubscriptionTypes({ interview: false });
    expect(types).not.toContain('session.text.delta');
    expect(types).not.toContain('session.text.started');
    expect(types).not.toContain('session.text.ended');
    // No synthetic/legacy names leak into the native filter: those arrive
    // synthesized (mapV2EventToV1) or are host-side only.
    expect(types).not.toContain('server.connected');
    expect(types).not.toContain('message.updated');
    expect(types).not.toContain('message.part.updated');
    expect(types).not.toContain('session.error');
    expect(types).not.toContain('question.asked');
    expect(types).not.toContain('step-finish');
    expect(types).not.toContain('server.instance.disposed');
  });

  test('includes interview stream text events when enabled', () => {
    const types = buildV2EventSubscriptionTypes({ interview: true });
    for (const name of INTERVIEW_TEXT_STREAM) {
      expect(types).toContain(name);
    }
    expect(types.length).toBe(
      PRODUCTION_REQUIRED.length + INTERVIEW_TEXT_STREAM.length,
    );
  });

  test('the union is frozen once built — no per-request surface changes', () => {
    const types = buildV2EventSubscriptionTypes();
    expect(Object.isFrozen(types)).toBe(true);
    expect(() => {
      (types as Array<string>).push('session.forked');
    }).toThrow();
    const again = buildV2EventSubscriptionTypes();
    expect(Object.isFrozen(again)).toBe(true);
  });
});

describe('isV2StreamDeltaType', () => {
  test('only the interview text delta is a stream delta', () => {
    expect(isV2StreamDeltaType('session.text.delta')).toBe(true);
    expect(isV2StreamDeltaType('session.text.started')).toBe(false);
    expect(isV2StreamDeltaType('session.text.ended')).toBe(false);
    // Legacy names the current pump hardcodes are dead on the pinned host
    // (they are not in its event union), so they must not be treated as
    // stream deltas either.
    expect(isV2StreamDeltaType('session.next.text.delta')).toBe(false);
    expect(isV2StreamDeltaType('message.part.delta')).toBe(false);
    expect(isV2StreamDeltaType('session.reasoning.delta')).toBe(false);
  });
});
