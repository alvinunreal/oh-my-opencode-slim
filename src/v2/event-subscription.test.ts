/** Focused tests for the setup-fixed native event filter.
 *
 * The union is pinned to the names the production v2 pump actually
 * consumes (verified live against the pinned host surface; the
 * compile-time membership guard lives in `mirror-conformance.ts`).
 * Identity events are always observed: the permission-rules bridge and
 * cleanup need them before any optional consumer exists.
 */
import { describe, expect, test } from 'bun:test';
import { buildV2EventSubscriptionTypes } from './event-subscription';

const IDENTITY = [
  'session.created',
  'session.deleted',
  'session.agent.selected',
  'session.moved',
] as const;

const LIFECYCLE = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.status',
  'session.idle',
] as const;

const STEPS = [
  'session.step.started',
  'session.step.failed',
  'session.step.ended',
] as const;

const INPUTS = [
  'form.created',
  'form.replied',
  'form.cancelled',
  'permission.asked',
  'permission.replied',
] as const;

const off = {
  sidebar: false,
  fallback: false,
  companion: false,
  cacheMonitor: false,
  toolLoopGuard: false,
  interview: false,
} as const;

describe('buildV2EventSubscriptionTypes', () => {
  test('keeps only identity events when no optional consumer exists', () => {
    expect(buildV2EventSubscriptionTypes(off)).toEqual([...IDENTITY]);
  });

  test('adds lifecycle events for every status consumer', () => {
    for (const consumer of [
      'sidebar',
      'fallback',
      'companion',
      'toolLoopGuard',
      'interview',
    ] as const) {
      const types = buildV2EventSubscriptionTypes({ ...off, [consumer]: true });
      for (const name of LIFECYCLE) expect(types).toContain(name);
    }
  });

  test('steps follow fallback, telemetry follows the cache monitor', () => {
    const fallback = buildV2EventSubscriptionTypes({
      ...off,
      fallback: true,
    });
    for (const name of STEPS) expect(fallback).toContain(name);

    const cache = buildV2EventSubscriptionTypes({
      ...off,
      cacheMonitor: true,
    });
    expect(cache).toEqual([
      ...IDENTITY,
      'session.step.started',
      'session.step.ended',
    ]);
  });

  test('forms and permissions follow Companion only', () => {
    const companion = buildV2EventSubscriptionTypes({
      ...off,
      companion: true,
    });
    for (const name of INPUTS) expect(companion).toContain(name);

    const noCompanion = buildV2EventSubscriptionTypes({
      ...off,
      sidebar: true,
      fallback: true,
    });
    for (const name of INPUTS) expect(noCompanion).not.toContain(name);
  });

  test('interview adds its failed-step refusal and text stream', () => {
    const types = buildV2EventSubscriptionTypes({
      ...off,
      interview: true,
    });
    expect(types).toContain('session.step.failed');
    expect(types).toContain('session.text.ended');
    expect(types).not.toContain('session.text.delta');
    expect(types).not.toContain('server.connected');
  });

  test('the union is frozen once built — no per-request surface changes', () => {
    const types = buildV2EventSubscriptionTypes(off);
    expect(Object.isFrozen(types)).toBe(true);
    expect(() => {
      (types as Array<string>).push('session.forked');
    }).toThrow();
    expect(buildV2EventSubscriptionTypes(off)).toEqual([...IDENTITY]);
  });
});
