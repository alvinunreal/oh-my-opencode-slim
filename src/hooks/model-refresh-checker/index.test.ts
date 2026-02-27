import { describe, expect, test } from 'bun:test';
import { shouldRunModelRefresh } from './index';

describe('model-refresh-checker', () => {
  test('runs when state has no successful refresh yet', () => {
    const shouldRun = shouldRunModelRefresh({
      state: {},
      nowMs: Date.now(),
      intervalMs: 24 * 60 * 60 * 1000,
    });

    expect(shouldRun).toBe(true);
  });

  test('runs when saved timestamp is invalid', () => {
    const shouldRun = shouldRunModelRefresh({
      state: { lastSuccessAt: 'not-a-date' },
      nowMs: Date.now(),
      intervalMs: 24 * 60 * 60 * 1000,
    });

    expect(shouldRun).toBe(true);
  });

  test('does not run before interval elapsed', () => {
    const nowMs = Date.parse('2026-02-17T10:00:00.000Z');
    const shouldRun = shouldRunModelRefresh({
      state: { lastSuccessAt: '2026-02-17T00:30:00.000Z' },
      nowMs,
      intervalMs: 24 * 60 * 60 * 1000,
    });

    expect(shouldRun).toBe(false);
  });

  test('runs after interval elapsed', () => {
    const nowMs = Date.parse('2026-02-18T12:00:00.000Z');
    const shouldRun = shouldRunModelRefresh({
      state: { lastSuccessAt: '2026-02-17T00:00:00.000Z' },
      nowMs,
      intervalMs: 24 * 60 * 60 * 1000,
    });

    expect(shouldRun).toBe(true);
  });
});
