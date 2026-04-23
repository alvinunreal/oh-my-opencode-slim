import { describe, expect, test } from 'bun:test';
import { TaskSessionTracker } from './task-session-tracker';

describe('TaskSessionTracker', () => {
  test('register stores a session and get retrieves it', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_child1', 'ses_parent', 'fixer');

    const session = tracker.get('ses_child1');
    expect(session).toBeDefined();
    expect(session?.sessionId).toBe('ses_child1');
    expect(session?.parentSessionId).toBe('ses_parent');
    expect(session?.agent).toBe('fixer');
    expect(session?.status).toBe('active');
  });

  test('register without agent stores undefined agent', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_child1', 'ses_parent');

    const session = tracker.get('ses_child1');
    expect(session).toBeDefined();
    expect(session?.agent).toBeUndefined();
  });

  test('register ignores duplicate session IDs', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_child1', 'ses_parent1', 'fixer');
    tracker.register('ses_child1', 'ses_parent2', 'explorer');

    const session = tracker.get('ses_child1');
    expect(session?.parentSessionId).toBe('ses_parent1');
    expect(session?.agent).toBe('fixer');
  });

  test('markInterrupted updates status', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_child1', 'ses_parent', 'fixer');
    tracker.markInterrupted('ses_child1');

    expect(tracker.get('ses_child1')?.status).toBe('interrupted');
  });

  test('markCompleted updates status', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_child1', 'ses_parent', 'fixer');
    tracker.markCompleted('ses_child1');

    expect(tracker.get('ses_child1')?.status).toBe('completed');
  });

  test('markInterrupted on unknown session is a no-op', () => {
    const tracker = new TaskSessionTracker();
    expect(() => tracker.markInterrupted('ses_unknown')).not.toThrow();
  });

  test('markCompleted on unknown session is a no-op', () => {
    const tracker = new TaskSessionTracker();
    expect(() => tracker.markCompleted('ses_unknown')).not.toThrow();
  });

  test('cleanup removes a session', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_child1', 'ses_parent', 'fixer');
    tracker.cleanup('ses_child1');

    expect(tracker.get('ses_child1')).toBeUndefined();
  });

  test('cleanup on unknown session is a no-op', () => {
    const tracker = new TaskSessionTracker();
    expect(() => tracker.cleanup('ses_unknown')).not.toThrow();
  });

  test('sweepStale removes old entries', () => {
    const tracker = new TaskSessionTracker();
    tracker.register('ses_old', 'ses_parent', 'fixer');

    // Manually backdate the entry
    const session = tracker.get('ses_old');
    expect(session).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by toBeDefined above
    session!.createdAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    tracker.register('ses_new', 'ses_parent', 'explorer');
    tracker.sweepStale();

    expect(tracker.get('ses_old')).toBeUndefined();
    expect(tracker.get('ses_new')).toBeDefined();
  });
});
