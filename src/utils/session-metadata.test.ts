import { describe, expect, test } from 'bun:test';
import { SessionMetadataStore } from './session-metadata';

describe('SessionMetadataStore', () => {
  test('keeps two active orchestrators through metadata overflow', () => {
    const store = new SessionMetadataStore({ maxEntries: 3 });

    store.setAgent('orchestrator-a', 'orchestrator');
    store.setAgent('orchestrator-b', 'orchestrator');
    store.setAgent('old-specialist', 'explore');
    store.setDirectory('new-session', '/tmp/project');

    expect(store.size).toBe(3);
    expect(store.getAgent('orchestrator-a')).toBe('orchestrator');
    expect(store.getAgent('orchestrator-b')).toBe('orchestrator');
    expect(store.hasAgent('old-specialist')).toBe(false);
  });

  test('makes an idle orchestrator evictable without dropping another active one', () => {
    const store = new SessionMetadataStore({ maxEntries: 3 });

    store.setAgent('orchestrator-a', 'orchestrator');
    store.setAgent('orchestrator-b', 'orchestrator');
    store.setAgent('old-specialist', 'explore');
    store.markOrchestratorIdle('orchestrator-a');
    store.setDirectory('new-session', '/tmp/project');

    expect(store.size).toBe(3);
    expect(store.hasAgent('orchestrator-a')).toBe(false);
    expect(store.getAgent('orchestrator-b')).toBe('orchestrator');
    expect(store.hasAgent('old-specialist')).toBe(true);
  });

  test('bounds agent-only metadata', () => {
    const store = new SessionMetadataStore({ maxEntries: 2 });

    store.setAgent('agent-a', 'explore');
    store.setAgent('agent-b', 'oracle');
    store.setAgent('agent-c', 'fixer');

    expect(store.size).toBe(2);
    expect(store.hasAgent('agent-a')).toBe(false);
    expect(store.hasAgent('agent-b')).toBe(true);
    expect(store.hasAgent('agent-c')).toBe(true);
  });

  test('eviction removes directory and agent metadata for one session', () => {
    const evicted: string[] = [];
    const store = new SessionMetadataStore({
      maxEntries: 1,
      onEvict: (sessionID) => evicted.push(sessionID),
    });

    store.setDirectory('old-session', '/tmp/project');
    store.setAgent('old-session', 'explore');
    store.setDirectory('new-session', '/tmp/project');

    expect(store.size).toBe(1);
    expect(store.hasDirectory('old-session')).toBe(false);
    expect(store.hasAgent('old-session')).toBe(false);
    expect(evicted).toEqual(['old-session']);
  });

  test('keeps the size bound when every session is an active orchestrator', () => {
    const evicted: string[] = [];
    const store = new SessionMetadataStore({
      maxEntries: 2,
      onEvict: (sessionID) => evicted.push(sessionID),
    });
    store.setAgent('parent-a', 'orchestrator');
    store.setModel('parent-a', 'provider/model');
    store.setDirectory('parent-a', '/project');
    store.setAgent('parent-b', 'orchestrator');
    store.setAgent('parent-c', 'orchestrator');

    expect(store.size).toBe(2);
    expect(store.getAgent('parent-a')).toBeUndefined();
    expect(store.getModel('parent-a')).toBeUndefined();
    expect(store.getDirectory('parent-a')).toBeUndefined();
    expect(store.getAgent('parent-b')).toBe('orchestrator');
    expect(store.getAgent('parent-c')).toBe('orchestrator');
    expect(evicted).toEqual(['parent-a']);
  });
});
