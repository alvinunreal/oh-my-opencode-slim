/**
 * FR-8 sweep logic tests: only dead-owner + terminal-child encoded panes are
 * closed; every uncertainty keeps the pane (fail-closed), and every failure
 * fails soft without aborting the pass.
 *
 * Candidate discovery is adapter-owned (title scan for tmux/zellij/herdr/
 * kitty, launch-argv marker for cmux); these tests feed both shapes because
 * the decision logic must be identical for either.
 */

import { describe, expect, test } from 'bun:test';
import type { DiagnosticLogger } from './diagnostics';
import { encodePaneTitle } from './pane-title';
import {
  asSweepAdapter,
  defaultIsProcessAlive,
  type SweepAdapter,
  type SweepPane,
  type SweepScanResult,
  sweepLeftoverPanes,
} from './sweep';

class CapturingLogger implements DiagnosticLogger {
  readonly entries: Array<{ message: string; data?: unknown }> = [];

  log(message: string, data?: unknown): void {
    this.entries.push({ message, data });
  }

  outcomes(): string[] {
    return this.entries
      .map(
        (entry) => (entry.data as { outcome?: unknown } | undefined)?.outcome,
      )
      .filter((outcome): outcome is string => typeof outcome === 'string');
  }
}

class FakeAdapter implements SweepAdapter {
  panes: SweepPane[] = [];
  /** When true, discovery reports a partial (incomplete) scan. */
  incomplete = false;
  readonly closed: string[] = [];
  closeResult = true;
  closeError: Error | null = null;
  listError: Error | null = null;

  async listPanesWithTitles(): Promise<SweepPane[] | SweepScanResult> {
    if (this.listError) throw this.listError;
    const panes = [...this.panes];
    return this.incomplete ? { panes, incomplete: true } : panes;
  }

  async closePane(paneId: string): Promise<boolean> {
    if (this.closeError) throw this.closeError;
    this.closed.push(paneId);
    return this.closeResult;
  }
}

const DEAD_PID = 999_999;
const TERMINAL_CHILD = 'ses_gone';
const ACTIVE_CHILD = 'ses_alive';

function makePorts(
  adapter: FakeAdapter,
  overrides: {
    isProcessAlive?: (pid: number) => boolean;
    isSessionTerminal?: (childSessionId: string) => Promise<boolean>;
    logger?: CapturingLogger;
  } = {},
) {
  return {
    adapter,
    isProcessAlive: overrides.isProcessAlive ?? (() => false),
    isSessionTerminal: overrides.isSessionTerminal ?? (async () => true),
    logger: overrides.logger ?? new CapturingLogger(),
  };
}

describe('sweepLeftoverPanes (FR-8)', () => {
  test('closes a dead-owner terminal-child encoded pane', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      {
        paneId: 'pane-leftover',
        title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD),
      },
    ];
    const logger = new CapturingLogger();

    const stats = await sweepLeftoverPanes(makePorts(adapter, { logger }));

    expect(adapter.closed).toEqual(['pane-leftover']);
    expect(stats).toMatchObject({
      scanned: 1,
      encoded: 1,
      closed: 1,
      skippedLiveOwner: 0,
      skippedActiveSession: 0,
      skippedUnparsable: 0,
      closeFailures: 0,
      scanFailed: false,
    });
    expect(logger.outcomes()).toEqual(['closed']);
  });

  test('never closes a live-owner pane', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      { paneId: 'pane-owned', title: encodePaneTitle(4242, TERMINAL_CHILD) },
    ];
    const probed: string[] = [];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isProcessAlive: (pid) => pid === 4242,
        isSessionTerminal: async (child) => {
          probed.push(child);
          return true;
        },
      }),
    );

    expect(adapter.closed).toEqual([]);
    expect(probed).toEqual([]); // a live owner is never even probed
    expect(stats.skippedLiveOwner).toBe(1);
  });

  test('never closes a pane whose child session still exists', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      { paneId: 'pane-active', title: encodePaneTitle(DEAD_PID, ACTIVE_CHILD) },
    ];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isSessionTerminal: async (child) => child !== ACTIVE_CHILD,
      }),
    );

    expect(adapter.closed).toEqual([]);
    expect(stats.skippedActiveSession).toBe(1);
  });

  test('skips user titles and malformed metadata without probing them', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      { paneId: 'pane-user', title: 'vim' },
      { paneId: 'pane-shell', title: 'user@host: ~/src' },
      { paneId: 'pane-malformed', title: 'omosc:not-a-pid:ses_gone' },
      { paneId: 'pane-injected', title: 'omosc:12:ses_a;rm -rf /' },
      { paneId: 'pane-empty' },
      { paneId: '', title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD) },
    ];
    const probed: string[] = [];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isSessionTerminal: async (child) => {
          probed.push(child);
          return true;
        },
      }),
    );

    expect(adapter.closed).toEqual([]);
    expect(probed).toEqual([]);
    expect(stats.skippedUnparsable).toBe(6);
    expect(stats.encoded).toBe(0);
  });

  test('a failing close is counted and the pass continues', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      { paneId: 'pane-fail', title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD) },
      { paneId: 'pane-ok', title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD) },
    ];
    const logger = new CapturingLogger();
    let calls = 0;
    const originalClose = adapter.closePane.bind(adapter);
    adapter.closePane = async (paneId: string): Promise<boolean> => {
      calls += 1;
      if (calls === 1) return false;
      return originalClose(paneId);
    };

    const stats = await sweepLeftoverPanes(makePorts(adapter, { logger }));

    expect(stats.closed).toBe(1);
    expect(stats.closeFailures).toBe(1);
    expect(adapter.closed).toEqual(['pane-ok']);
    expect(logger.outcomes()).toEqual(['close-failed', 'closed']);
  });

  test('a throwing close is counted and the pass continues', async () => {
    const adapter = new FakeAdapter();
    adapter.closeError = new Error('boom');
    adapter.panes = [
      {
        paneId: 'pane-throw',
        title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD),
      },
    ];

    const stats = await sweepLeftoverPanes(makePorts(adapter));

    expect(stats.closeFailures).toBe(1);
    expect(stats.closed).toBe(0);
  });

  test('a throwing liveness probe counts as alive (fail-closed)', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      {
        paneId: 'pane-throw',
        title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD),
      },
    ];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isProcessAlive: () => {
          throw new Error('liveness unavailable');
        },
      }),
    );

    expect(adapter.closed).toEqual([]);
    expect(stats.skippedLiveOwner).toBe(1);
  });

  test('a throwing terminal probe keeps the pane (fail-closed)', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      {
        paneId: 'pane-unknown',
        title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD),
      },
    ];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isSessionTerminal: async () => {
          throw new Error('server unavailable');
        },
      }),
    );

    expect(adapter.closed).toEqual([]);
    expect(stats.skippedActiveSession).toBe(1);
  });

  test('a failing pane scan returns fail-soft stats flagged as failed', async () => {
    const adapter = new FakeAdapter();
    adapter.listError = new Error('no multiplexer');
    const logger = new CapturingLogger();

    const stats = await sweepLeftoverPanes(makePorts(adapter, { logger }));

    expect(stats).toEqual({
      scanned: 0,
      encoded: 0,
      closed: 0,
      skippedLiveOwner: 0,
      skippedActiveSession: 0,
      skippedUnparsable: 0,
      closeFailures: 0,
      scanFailed: true,
      scanIncomplete: false,
    });
    expect(logger.outcomes()).toEqual(['scan-failed']);
  });

  test('an incomplete scan still closes discovered candidates and stays retryable', async () => {
    const adapter = new FakeAdapter();
    adapter.incomplete = true;
    adapter.panes = [
      {
        paneId: 'pane-leftover',
        title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD),
      },
    ];
    const logger = new CapturingLogger();

    const stats = await sweepLeftoverPanes(makePorts(adapter, { logger }));

    // Progress is preserved: the candidate discovered before the
    // uninspectable terminal is still closed...
    expect(adapter.closed).toEqual(['pane-leftover']);
    expect(stats).toMatchObject({
      scanned: 1,
      closed: 1,
      scanFailed: false,
      scanIncomplete: true,
    });
    expect(logger.outcomes()).toEqual(['closed']);
  });
});

describe('cmux argv-marker candidates (tasks 4.4/4.5)', () => {
  test('closes terminal-handle candidates discovered from argv markers', async () => {
    const adapter = new FakeAdapter();
    // cmux discovery yields a terminal id plus the `omosc:` token extracted
    // from the launch argv; the sweep treats them exactly like title-scan
    // candidates (dead owner + terminal child -> closePane(terminal id)).
    adapter.panes = [
      { paneId: 'term-1', title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD) },
      { paneId: 'term-2', title: encodePaneTitle(DEAD_PID, ACTIVE_CHILD) },
    ];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isSessionTerminal: async (child) => child === TERMINAL_CHILD,
      }),
    );

    expect(adapter.closed).toEqual(['term-1']);
    expect(stats).toMatchObject({
      scanned: 2,
      encoded: 2,
      closed: 1,
      skippedActiveSession: 1,
      skippedUnparsable: 0,
    });
  });

  test('raw argv or shell-comment fragments never parse and are never closed', async () => {
    const adapter = new FakeAdapter();
    // Only the extracted strict token may be handed in; anything the adapter
    // passes through raw (the whole shell comment, an argv tail, an injected
    // suffix) fails the strict parse and is skipped as data (NFR-5).
    adapter.panes = [
      { paneId: 'term-raw', title: '# omosc:999999:ses_gone' },
      {
        paneId: 'term-tail',
        title: 'export OMO=1; exec sleep 9 # omosc:999999:ses_gone',
      },
      { paneId: 'term-injected', title: 'omosc:999999:ses_gone;rm -rf /' },
      { paneId: 'term-blank', title: '' },
    ];
    const probed: string[] = [];

    const stats = await sweepLeftoverPanes(
      makePorts(adapter, {
        isSessionTerminal: async (child) => {
          probed.push(child);
          return true;
        },
      }),
    );

    expect(adapter.closed).toEqual([]);
    expect(probed).toEqual([]);
    expect(stats.skippedUnparsable).toBe(4);
    expect(stats.encoded).toBe(0);
  });

  test('a close failure on a marker candidate is counted and the pass continues', async () => {
    const adapter = new FakeAdapter();
    adapter.panes = [
      { paneId: 'term-fail', title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD) },
      { paneId: 'term-ok', title: encodePaneTitle(DEAD_PID, TERMINAL_CHILD) },
    ];
    let calls = 0;
    adapter.closePane = async (paneId: string): Promise<boolean> => {
      calls += 1;
      if (calls === 1) return false;
      adapter.closed.push(paneId);
      return true;
    };

    const stats = await sweepLeftoverPanes(makePorts(adapter));

    expect(stats.closed).toBe(1);
    expect(stats.closeFailures).toBe(1);
    expect(adapter.closed).toEqual(['term-ok']);
  });
});

describe('sweep capability helpers', () => {
  test('asSweepAdapter narrows only complete capability objects', () => {
    const adapter = new FakeAdapter();
    expect(asSweepAdapter(adapter)).toBe(adapter);
    expect(asSweepAdapter(null)).toBeNull();
    expect(asSweepAdapter(undefined)).toBeNull();
    expect(asSweepAdapter({})).toBeNull();
    expect(asSweepAdapter({ closePane: async () => true })).toBeNull();
    expect(asSweepAdapter({ listPanesWithTitles: async () => [] })).toBeNull();
  });

  test('defaultIsProcessAlive reports the current process as alive', () => {
    expect(defaultIsProcessAlive(process.pid)).toBe(true);
    expect(defaultIsProcessAlive(999_999_999)).toBe(false);
  });
});
