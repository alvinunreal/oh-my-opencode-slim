import { describe, expect, test } from 'bun:test';
import {
  createOnceGate,
  DIAGNOSTIC_EVENT_NO_PANE,
  DIAGNOSTIC_EVENT_PANE_CREATED,
  type DiagnosticLogger,
  logNoPane,
  logPaneCreated,
  PLUGIN_LOG_SINK,
} from './diagnostics';
import { NO_PANE_REASONS, type NoPaneReason } from './types';

interface CapturedEntry {
  message: string;
  data: unknown;
}

function createCapturingLogger(): {
  entries: CapturedEntry[];
  logger: DiagnosticLogger;
} {
  const entries: CapturedEntry[] = [];
  return {
    entries,
    logger: {
      log: (message, data) => {
        entries.push({ message, data });
      },
    },
  };
}

describe('no-pane diagnostics', () => {
  test('the reason enumeration matches the FR-13 categories', () => {
    expect([...NO_PANE_REASONS].sort()).toEqual([
      'adapter-hard',
      'adapter-not-found',
      'adapter-unavailable',
      'admission-mismatch',
      'admission-none',
      'admission-unavailable',
      'backfill-skipped',
      'host-unreachable',
      'not-our-child',
      'readiness-timeout',
    ]);
  });

  for (const reason of NO_PANE_REASONS) {
    test(`reason "${reason}" is recorded distinguishably`, () => {
      const { entries, logger } = createCapturingLogger();
      logNoPane(logger, reason, {
        childSessionId: 'child-1',
        parentSessionId: 'parent-1',
        adapter: 'tmux',
        anchoredTarget: '%0',
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toContain(reason);
      expect(entries[0]?.data).toMatchObject({
        event: DIAGNOSTIC_EVENT_NO_PANE,
        reason,
        childSessionId: 'child-1',
        parentSessionId: 'parent-1',
        adapter: 'tmux',
        anchoredTarget: '%0',
      });
    });
  }

  test('records the reason even without context', () => {
    const { entries, logger } = createCapturingLogger();
    logNoPane(logger, 'not-our-child');
    expect(entries[0]?.data).toEqual({
      event: DIAGNOSTIC_EVENT_NO_PANE,
      reason: 'not-our-child',
    });
  });

  test('different reasons produce different structured records', () => {
    const { entries, logger } = createCapturingLogger();
    const reasons: NoPaneReason[] = ['admission-none', 'adapter-hard'];
    for (const reason of reasons) logNoPane(logger, reason);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.data).not.toEqual(entries[1]?.data);
  });
});

describe('pane-created diagnostics', () => {
  test('records child, parent, adapter, pane id, and anchor', () => {
    const { entries, logger } = createCapturingLogger();
    logPaneCreated(logger, {
      childSessionId: 'child-9',
      parentSessionId: 'parent-3',
      adapter: 'cmux',
      paneId: 'pane-42',
      anchoredTarget: 'pane-7',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toContain('pane-42');
    expect(entries[0]?.data).toEqual({
      event: DIAGNOSTIC_EVENT_PANE_CREATED,
      childSessionId: 'child-9',
      parentSessionId: 'parent-3',
      adapter: 'cmux',
      paneId: 'pane-42',
      anchoredTarget: 'pane-7',
    });
  });
});

describe('createOnceGate', () => {
  test('allows a key exactly once', () => {
    const once = createOnceGate();
    expect(once('admission-none')).toBe(true);
    expect(once('admission-none')).toBe(false);
    expect(once('admission-none')).toBe(false);
  });

  test('tracks distinct keys independently', () => {
    const once = createOnceGate();
    expect(once('host-unreachable')).toBe(true);
    expect(once('readiness-timeout')).toBe(true);
    expect(once('host-unreachable')).toBe(false);
    expect(once('readiness-timeout')).toBe(false);
  });

  test('gates are isolated per instance', () => {
    const first = createOnceGate();
    const second = createOnceGate();
    expect(first('key')).toBe(true);
    expect(second('key')).toBe(true);
  });
});

describe('PLUGIN_LOG_SINK', () => {
  test('is safe to call before logger initialization', () => {
    expect(() =>
      PLUGIN_LOG_SINK.log('[multiplexer] test', { reason: 'admission-none' }),
    ).not.toThrow();
  });
});
