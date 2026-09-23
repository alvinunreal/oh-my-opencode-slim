/**
 * FR-8 crash-leftover sweep (task 3.8).
 *
 * After a client crashes, its panes survive. This module scans the client's
 * own multiplexer for leftovers whose metadata carries
 * `omosc:<pid>:<childSessionId>`, and best-effort closes the ones where BOTH
 * hold:
 *
 * - the encoded owner pid is dead, and
 * - the child session is gone from the server (positive evidence only).
 *
 * Candidate discovery is adapter-owned (task 4.4): tmux/zellij/herdr/kitty
 * scan pane titles, while cmux enumerates terminals and reads back each
 * launch argv for the `# omosc:` data marker. Both paths hand the core the
 * same candidate shape — an opaque adapter handle plus the extracted strict
 * `omosc:<pid>:<childSessionId>` token — so the decision logic below stays
 * adapter-agnostic; `closePane` is likewise the adapter's own close primitive
 * (cmux: `terminal close`, which also ends the process).
 *
 * Safety rules:
 * - a live owner is never touched (its panes are still managed);
 * - a child session that still exists is never touched (the pane may still be
 *   the only view of a running child);
 * - metadata that does not strictly parse as our encoding is user data and is
 *   skipped (NFR-5);
 * - every failure (scan, liveness probe, terminal probe, close) fails soft
 *   and never aborts the remaining panes.
 *
 * Pure logic: liveness, session state and adapter access are all injected, so
 * the sweep is unit-testable without a multiplexer or a server.
 */

import { type DiagnosticLogger, PLUGIN_LOG_SINK } from './diagnostics';
import { parsePaneTitle } from './pane-title';

/**
 * One leftover candidate as reported by a sweep-capable adapter.
 *
 * `paneId` is the adapter-local opaque close handle (cmux: terminal id) and
 * `title` is the extracted `omosc:<pid>:<childSessionId>` token — from a pane
 * title or from a launch-argv data marker, depending on the adapter. The core
 * never interprets `paneId`; only the adapter's own `closePane` does.
 */
export interface SweepPane {
  paneId: string;
  title?: string | null;
}

/**
 * Discovery result for adapters that can inspect only part of the candidate
 * set (cmux reads one launch argv per terminal): the panes that could be
 * inspected are still processed, and `incomplete` tells the caller that the
 * scan must be retried. A plain `SweepPane[]` (the four non-cmux adapters)
 * means a complete scan.
 */
export interface SweepScanResult {
  panes: SweepPane[];
  incomplete?: boolean;
}

/**
 * Structural adapter capability the sweep needs. Adapters implement it as an
 * optional extension of `Multiplexer`; the wiring narrows instances at
 * runtime, so the shared `Multiplexer` interface stays untouched.
 *
 * Discovery is adapter-owned: the title-scanning adapters return pane titles,
 * cmux returns terminal handles whose `title` was extracted from the launch
 * argv marker. Candidates without a strictly parseable token never reach a
 * close command. `listPanesWithTitles` must reject when the scan itself fails
 * wholesale (as opposed to a clean scan with zero candidates or a partial
 * scan), so callers can retry; a partial scan is reported as
 * `{ panes, incomplete: true }` instead of rejecting, so the panes that were
 * discovered are still processed.
 */
export interface SweepAdapter {
  listPanesWithTitles(): Promise<SweepPane[] | SweepScanResult>;
  closePane(paneId: string): Promise<boolean>;
}

/** Injected surface of one sweep run. */
export interface SweepPorts {
  adapter: SweepAdapter;
  /** Liveness probe for the encoded owner pid. */
  isProcessAlive(pid: number): boolean;
  /**
   * Positive-evidence terminal check: true only when the session is known to
   * be gone. Implementations must fail closed (false on any uncertainty).
   */
  isSessionTerminal(childSessionId: string): Promise<boolean>;
  /** Diagnostic sink; defaults to the plugin file logger. */
  logger?: DiagnosticLogger;
}

/** Outcome counters of one sweep run (FR-13 style observability). */
export interface SweepStats {
  scanned: number;
  encoded: number;
  closed: number;
  skippedLiveOwner: number;
  skippedActiveSession: number;
  skippedUnparsable: number;
  closeFailures: number;
  /**
   * True when candidate discovery itself failed (the adapter's scan threw or
   * returned a non-list). The pass stays fail-soft; callers can use this to
   * tell a failed scan from a clean empty pass and retry later.
   */
  scanFailed: boolean;
  /**
   * True when discovery processed what it could, but some candidates could
   * not be inspected, so the caller must retry. The discovered panes were
   * still processed normally — unlike `scanFailed`, this is not an early
   * return.
   */
  scanIncomplete: boolean;
}

export const SWEEP_EVENT = 'multiplexer.sweep';

/**
 * Runs one sweep pass. Never throws: a failed scan, probe or close is
 * recorded and the pass continues (fail-soft).
 */
export async function sweepLeftoverPanes(
  ports: SweepPorts,
): Promise<SweepStats> {
  const logger = ports.logger ?? PLUGIN_LOG_SINK;
  const stats: SweepStats = {
    scanned: 0,
    encoded: 0,
    closed: 0,
    skippedLiveOwner: 0,
    skippedActiveSession: 0,
    skippedUnparsable: 0,
    closeFailures: 0,
    scanFailed: false,
    scanIncomplete: false,
  };

  let panes: SweepPane[];
  try {
    const discovered = await ports.adapter.listPanesWithTitles();
    if (Array.isArray(discovered)) {
      panes = discovered;
    } else {
      panes = discovered.panes;
      stats.scanIncomplete = discovered.incomplete === true;
    }
  } catch {
    stats.scanFailed = true;
    logger.log('[multiplexer] sweep: pane scan failed', {
      event: SWEEP_EVENT,
      outcome: 'scan-failed',
    });
    return stats;
  }
  if (!Array.isArray(panes)) {
    stats.scanFailed = true;
    return stats;
  }

  for (const pane of panes) {
    stats.scanned += 1;
    if (typeof pane?.paneId !== 'string' || pane.paneId.length === 0) {
      stats.skippedUnparsable += 1;
      continue;
    }

    const metadata = parsePaneTitle(pane.title);
    if (metadata === null) {
      stats.skippedUnparsable += 1;
      continue;
    }
    stats.encoded += 1;

    // Liveness is fail-closed: an unverifiable owner counts as alive.
    let ownerAlive = true;
    try {
      ownerAlive = ports.isProcessAlive(metadata.ownerPid);
    } catch {
      ownerAlive = true;
    }
    if (ownerAlive) {
      stats.skippedLiveOwner += 1;
      continue;
    }

    // Terminal state is fail-closed: only positive evidence closes a pane.
    let terminal = false;
    try {
      terminal = await ports.isSessionTerminal(metadata.childSessionId);
    } catch {
      terminal = false;
    }
    if (!terminal) {
      stats.skippedActiveSession += 1;
      continue;
    }

    let closed = false;
    try {
      closed = await ports.adapter.closePane(pane.paneId);
    } catch {
      closed = false;
    }
    if (closed) {
      stats.closed += 1;
      logger.log('[multiplexer] sweep: closed leftover pane', {
        event: SWEEP_EVENT,
        outcome: 'closed',
        paneId: pane.paneId,
        ownerPid: metadata.ownerPid,
        childSessionId: metadata.childSessionId,
      });
    } else {
      stats.closeFailures += 1;
      logger.log('[multiplexer] sweep: close failed', {
        event: SWEEP_EVENT,
        outcome: 'close-failed',
        paneId: pane.paneId,
        ownerPid: metadata.ownerPid,
        childSessionId: metadata.childSessionId,
      });
    }
  }

  return stats;
}

/**
 * Default liveness probe. `EPERM` means the process exists but belongs to
 * another user, so it counts as alive; any other probe error fails closed.
 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Runtime narrowing of an admitted multiplexer to the sweep capability. */
export function asSweepAdapter(adapter: unknown): SweepAdapter | null {
  if (!adapter || typeof adapter !== 'object') return null;
  const candidate = adapter as Partial<SweepAdapter>;
  if (typeof candidate.listPanesWithTitles !== 'function') return null;
  if (typeof candidate.closePane !== 'function') return null;
  return candidate as SweepAdapter;
}
