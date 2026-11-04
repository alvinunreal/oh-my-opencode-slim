/**
 * Orca multiplexer implementation
 *
 * Splits panes for sub-agent sessions inside the Orca tab that hosts the
 * OpenCode TUI (Orca 1.4.239, verified live on Linux).
 *
 * Environment detection: Orca exports `ORCA_TERMINAL_HANDLE` (the opaque
 * handle of the pane the client runs in) and `TERM_PROGRAM=Orca`. The handle
 * is the anchor: every split names it explicitly with `--terminal`, so the
 * active pane is never used implicitly. The split's own `handle` is this
 * adapter's opaque pane id — each split pane lists individually in
 * `orca terminal list`, and `orca terminal close --terminal <handle>` closes
 * exactly that one pane.
 *
 * CLI: the binary lives at `$ORCA_CLI_BIN_DIR/orca`, falling back to `orca`
 * on `PATH`. Availability is `orca status --json` reporting
 * `ok: true` with `result.app.running === true`.
 *
 * Layout: Orca has no layout primitives and `main_pane_size` is ignored. The configured
 * layout only maps to the split direction at spawn time; every child splits
 * the anchor, so there is no shared placement state and no spawn mutex.
 *
 * Failure classification (wezterm's guarded pattern): a split that times out
 * is a *soft* failure — the pane may still have opened, so it is never
 * reported as `not_found` (pane loss) and never as `hard`; only a missing
 * anchor is `not_found`, and only a CLI error without a handle is `hard`.
 *
 * Windows: refused. The viewer command is POSIX-quoted, and typing it into a
 * cmd/PowerShell pane is the #1620 class of bug; no pane is created instead.
 *
 * Titles: not set. `orca terminal set-pane-title` works but the pane's shell
 * auto-titles over it, so a title is never reliable enough to carry the
 * `omosc:` sweep marker — crash-leftover sweeping is therefore unsupported
 * (same stance as WezTerm, whose CLI cannot set a title at all).
 *
 * Working directory: `terminal split` has no `--cwd`, so panes open at the
 * worktree path rather than the project directory (documented limitation);
 * the v2 `mini` viewer, which takes no directory, `cd`s there itself.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  buildViewCommand,
  findBinary,
  isPosixShell,
  markViewerCommand,
  normalizePathForShell,
  quoteShellArg,
  shellSupportsAndChain,
  viewerNeedsPaneCwd,
  withParentEnvPassword,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';

/** Platform timer handle; fake harnesses may return bare numeric ids. */
type TimerHandle = Timer;

type SplitDirection = 'horizontal' | 'vertical';

/** Bound for `orca terminal split`; a hung CLI must not stall the spawn. */
const SPLIT_TIMEOUT_MS = 5_000;
/** Bound for the `orca status` availability probe. */
const STATUS_TIMEOUT_MS = 2_000;
/** Bound for `orca terminal close`. */
const CLOSE_TIMEOUT_MS = 5_000;

export interface OrcaMultiplexerOptions {
  /** Timeout seam; tests inject `src/utils/test-timers.ts` harness timers. */
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

/** Outcome of one bounded CLI call. */
interface CliRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The call exceeded its bound; the process was killed. */
  timedOut: boolean;
  /** The spawn itself threw (never a timeout). */
  failed: boolean;
}

export class OrcaMultiplexer implements Multiplexer {
  readonly type = 'orca' as const;

  private binaryPath: string | null = null;
  private availabilityPromise: Promise<boolean> | null = null;
  private readonly layout: MultiplexerLayout;
  private readonly setTimer: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    options: OrcaMultiplexerOptions = {},
  ) {
    this.layout = layout;
    this.setTimer =
      options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  async isAvailable(): Promise<boolean> {
    // Cache and await the in-flight probe so concurrent callers (e.g. two
    // child sessions spawning together) share one availability check instead
    // of racing on a half-set flag.
    if (!this.availabilityPromise) {
      this.availabilityPromise = this.probeAvailability();
    }
    return this.availabilityPromise;
  }

  private async probeAvailability(): Promise<boolean> {
    const binary = await resolveBinary();
    if (!binary) return false;

    const run = await this.runCli(
      [binary, 'status', '--json'],
      STATUS_TIMEOUT_MS,
    );
    const running = run.exitCode === 0 && statusReportsRunning(run.stdout);
    if (!running) {
      log('[orca] isAvailable: orca status does not report a running app', {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        stderr: run.stderr.trim(),
      });
      return false;
    }
    this.binaryPath = binary;
    return true;
  }

  isInsideSession(): boolean {
    return !!(
      process.env.ORCA_TERMINAL_HANDLE && process.env.TERM_PROGRAM === 'Orca'
    );
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    if (process.platform === 'win32') {
      // Never type a POSIX-quoted viewer command into cmd/PowerShell (#1620).
      log('[orca] spawnPane: Windows hosts are unsupported; no pane');
      return { success: false, error: 'unavailable' };
    }

    // Anchor first: without the handle no target can be resolved, so no
    // orca command may be issued (no `--current` fallback).
    const anchor = process.env.ORCA_TERMINAL_HANDLE?.trim();
    if (!anchor) {
      log('[orca] spawnPane: ORCA_TERMINAL_HANDLE is not set; no target');
      return { success: false, error: 'not_found' };
    }

    // v2 remote viewers authenticate with OPENCODE_PASSWORD and
    // `terminal split` has no env flag, so the launch script reads the
    // secret from this process's /proc environ. That needs Linux and a
    // POSIX shell; anything else creates no pane rather than exposing it.
    const needsSecretBridge =
      options?.viewerFlavor === 'v2-remote' &&
      options.viewerPassword !== undefined;
    if (
      needsSecretBridge &&
      (process.platform !== 'linux' ||
        !isPosixShell(process.env.SHELL || '/bin/sh'))
    ) {
      log('[orca] spawnPane: viewer password bridge unavailable; no pane', {
        platform: process.platform,
      });
      return { success: false, error: 'unavailable' };
    }

    const orca = await this.getBinary();
    if (!orca) {
      log('[orca] spawnPane: orca binary not found or app not running');
      return { success: false, error: 'unavailable' };
    }

    try {
      const viewerCommand = markViewerCommand(
        buildViewCommand(sessionId, serverUrl, directory, options),
      );
      // v2 mini omits the directory and `terminal split` has no cwd flag,
      // so the command changes directory itself.
      const withCwd =
        viewerNeedsPaneCwd(options) && shellSupportsAndChain()
          ? `cd ${quoteShellArg(normalizePathForShell(directory))} && ${viewerCommand}`
          : viewerCommand;
      const command = needsSecretBridge
        ? withParentEnvPassword(withCwd)
        : withCwd;
      const direction = splitDirection(this.layout);
      const run = await this.runCli(
        [
          orca,
          'terminal',
          'split',
          '--terminal',
          anchor,
          '--direction',
          direction,
          '--command',
          command,
          '--json',
        ],
        SPLIT_TIMEOUT_MS,
      );

      if (run.timedOut) {
        // Soft: a timed-out split may still have opened the pane, so this is
        // never `not_found` (which would assert pane loss) and never `hard`.
        log('[orca] spawnPane: split timed out; the pane may still be open', {
          anchor,
          direction,
        });
        return { success: false, error: 'unavailable' };
      }
      if (run.failed) {
        log('[orca] spawnPane: split threw', { error: run.stderr });
        return { success: false, error: 'hard' };
      }

      const handle = parseSplitHandle(run.stdout);
      if (run.exitCode === 0 && handle) {
        log('[orca] spawnPane: SUCCESS', { paneId: handle, description });
        return { success: true, paneId: handle };
      }

      log('[orca] spawnPane: split failed', {
        anchor,
        direction,
        exitCode: run.exitCode,
        stdout: run.stdout.trim(),
        stderr: run.stderr.trim(),
      });
      return { success: false, error: 'hard' };
    } catch (err) {
      log('[orca] spawnPane: exception', { error: String(err) });
      return { success: false, error: 'hard' };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId || paneId === 'unknown') return false;
    const orca = await this.getBinary();
    if (!orca) return false;

    // Orca has no send-keys primitive, so the close is immediate: exit 0 is
    // the only success, and any other outcome keeps the pane tracked rather
    // than forgetting a live viewer.
    const run = await this.runCli(
      [orca, 'terminal', 'close', '--terminal', paneId, '--json'],
      CLOSE_TIMEOUT_MS,
    );
    if (run.exitCode === 0) return true;
    log('[orca] closePane: close failed; keeping the pane tracked', {
      paneId,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stderr: run.stderr.trim(),
    });
    return false;
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  /** One bounded CLI call; a timeout kills the process and reports it. */
  private async runCli(args: string[], timeoutMs: number): Promise<CliRun> {
    const proc = crossSpawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const settled = Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
    // The timeout can win the race; never surface the losing rejection.
    settled.catch(() => {});

    let timer: TimerHandle | undefined;
    const timedOut = new Promise<{ timedOut: true }>((resolve) => {
      timer = this.setTimer(() => {
        proc.kill('SIGTERM');
        resolve({ timedOut: true });
      }, timeoutMs);
    });

    try {
      const outcome = await Promise.race([settled, timedOut]);
      if ('timedOut' in outcome) {
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: true,
          failed: false,
        };
      }
      return { ...outcome, timedOut: false, failed: false };
    } catch (err) {
      return {
        exitCode: null,
        stdout: '',
        stderr: String(err),
        timedOut: false,
        failed: true,
      };
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
    }
  }
}

/** `$ORCA_CLI_BIN_DIR/orca` when present, else `orca` on `PATH`. */
async function resolveBinary(): Promise<string | null> {
  const binDir = process.env.ORCA_CLI_BIN_DIR?.trim();
  if (binDir) {
    const candidate = join(binDir, 'orca');
    if (existsSync(candidate)) return candidate;
  }
  return findBinary('orca');
}

/** `orca status --json` says the app is up: `ok` plus `result.app.running`. */
function statusReportsRunning(stdout: string): boolean {
  const parsed = parseJsonLine(stdout);
  if (!parsed) return false;
  const result = isRecord(parsed.result) ? parsed.result : undefined;
  const app = result && isRecord(result.app) ? result.app : undefined;
  return parsed.ok === true && app?.running === true;
}

/**
 * `result.split.handle` of a `terminal split --json` reply. The reply is one
 * JSON object; a line-scanned fallback tolerates NDJSON-style output.
 */
function parseSplitHandle(stdout: string): string | null {
  const fromObject = parseJsonLine(stdout);
  const handle = splitHandleOf(fromObject);
  if (handle) return handle;
  for (const line of stdout.split('\n')) {
    const handle = splitHandleOf(parseJsonLine(line));
    if (handle) return handle;
  }
  return null;
}

function splitHandleOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const result = isRecord(value.result) ? value.result : undefined;
  const split = result && isRecord(result.split) ? result.split : undefined;
  const handle = split?.handle;
  return typeof handle === 'string' && handle.length > 0 ? handle : null;
}

function parseJsonLine(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Layout → split direction, mapped the way the wezterm adapter maps its
 * layouts (its `--right` is side-by-side, its `--bottom` is stacked).
 * `horizontal` is assumed to mean side-by-side; flip these if the Orca GUI
 * shows otherwise. All five schema layouts are covered, so an unsupported
 * layout is a type error rather than a runtime fallback.
 */
function splitDirection(layout: MultiplexerLayout): SplitDirection {
  switch (layout) {
    case 'main-vertical':
    case 'even-horizontal':
    case 'tiled':
      return 'horizontal';
    case 'main-horizontal':
    case 'even-vertical':
      return 'vertical';
    default: {
      const _exhaustive: never = layout;
      return _exhaustive;
    }
  }
}
