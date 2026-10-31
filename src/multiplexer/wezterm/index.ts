/**
 * WezTerm multiplexer implementation
 *
 * Uses WezTerm's built-in mux CLI (`wezterm cli`) to manage panes. The CLI
 * reaches the running WezTerm through `WEZTERM_UNIX_SOCKET`, which WezTerm
 * exports to every pane, so it works from OpenCode's detached processes
 * without extra configuration. Every call passes `--no-auto-start` so a stale
 * socket fails fast instead of starting a background mux server.
 *
 * Binary: the `wezterm` CLI next to `WEZTERM_EXECUTABLE` (the running GUI,
 * which WezTerm exports to every pane) is preferred, so app installs that are
 * not on `PATH` (macOS bundles) still work; `PATH` is the fallback.
 *
 * Client-local anchoring:
 * - detection is pane-scoped (`WEZTERM_PANE`),
 * - the parent pane is the anchor: every split carries an explicit
 *   `--pane-id`, so the active pane is never used implicitly,
 * - `split-pane` focuses the new pane, so the pane the user had focused
 *   before the split (read from `list-clients`) is focused again afterwards,
 *   falling back to the anchor when it cannot be read.
 *
 * Layout: WezTerm has no preset layouts, so the plugin layout is approximated
 * through split order, like the herdr adapter:
 * - main-vertical: the first child splits the anchor to the right at
 *   `100 - main_pane_size` percent; later children stack below inside that
 *   agent pane,
 * - main-horizontal: the mirror (agent row below, later children to the
 *   right),
 * - even-horizontal / tiled: every child splits the anchor to the right,
 * - even-vertical: every child splits the anchor below.
 * Panes are never rebalanced afterwards. Stacking falls back to the anchor
 * only when WezTerm reports the agent pane as gone; any other failure is a
 * hard error, because a split that fails to report can still have created a
 * pane (for example with mismatched CLI and GUI versions).
 *
 * Viewer password: `split-pane` has no flag to set the spawned program's
 * environment, and the pane inherits WezTerm's environment rather than this
 * client's. When the viewer must authenticate (v2 remote password, or a v1
 * client started with `OPENCODE_SERVER_PASSWORD`), the command is wrapped with
 * `withParentEnvPassword`, which reads the secret from this process's `/proc`
 * environ so it never appears in argv. That bridge needs Linux and a POSIX
 * shell; elsewhere no pane is created rather than leaking the secret or
 * opening a viewer that fails to authenticate. A custom v1
 * `OPENCODE_SERVER_USERNAME` (not a secret) is exported in the same script.
 *
 * Crash-leftover sweep (FR-8) is not supported: WezTerm's CLI cannot set a
 * pane title and the attached viewer replaces it, so there is no stable
 * place to carry the `omosc:` marker.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildShellLaunchArgs,
  buildViewCommand,
  findBinary,
  gracefulClosePane,
  isPosixShell,
  markViewerCommand,
  normalizePathForShell,
  quoteShellArg,
  withParentEnvPassword,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';

type SplitDirection = '--right' | '--bottom';

interface SplitPlan {
  /** Direction of the first split, taken from the anchor pane. */
  first: SplitDirection;
  /** Direction for later children inside the agent area (main-* only). */
  stack: SplitDirection | null;
  /** Whether the first split is sized by `main_pane_size`. */
  sized: boolean;
}

type SplitResult =
  | { ok: true; paneId: string }
  | { ok: false; targetGone: boolean };

/** Upper bound for the best-effort focus read and restore around a spawn. */
const FOCUS_TIMEOUT_MS = 2000;

/** WezTerm's error when a `--pane-id` no longer exists. */
const PANE_GONE_PATTERN = /pane_id \d+ invalid/;

/**
 * One structured diagnostic per process for the viewer-secret bridge gate,
 * matching the zellij and cmux-tui adapters.
 */
let viewerSecretGateLogged = false;

function logViewerSecretGateFailure(reason: string, shell: string): void {
  if (viewerSecretGateLogged) return;
  viewerSecretGateLogged = true;
  log('[wezterm] spawnPane: viewer password bridge unavailable', {
    stage: 'viewer-secret',
    reason,
    platform: process.platform,
    shell,
  });
}

export class WeztermMultiplexer implements Multiplexer {
  readonly type = 'wezterm' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private layout: MultiplexerLayout;
  private mainPaneSize: number;
  // First child pane of a main-* layout; later children split it.
  private agentAreaPaneId: string | null = null;
  // Serialize spawns so concurrent children cannot race on agentAreaPaneId.
  private spawnMutex: Promise<unknown> = Promise.resolve();

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.layout = layout;
    this.mainPaneSize = mainPaneSize;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }
    this.binaryPath = resolveSiblingCli() ?? (await findBinary('wezterm'));
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.WEZTERM_PANE;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    const prev = this.spawnMutex;
    let release!: () => void;
    this.spawnMutex = new Promise<void>((r) => (release = r));
    await prev;

    try {
      return await this.doSpawn(
        sessionId,
        description,
        serverUrl,
        directory,
        options,
      );
    } finally {
      release();
    }
  }

  private async doSpawn(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // Anchor first: without the parent pane id no target can be resolved, so
    // no wezterm command may be issued.
    const anchorPaneId = this.resolveAnchorPaneId();
    if (!anchorPaneId) {
      log(
        '[wezterm] spawnPane: WEZTERM_PANE is not set; cannot resolve target',
      );
      return { success: false, error: 'not_found' };
    }

    const shell = process.env.SHELL;
    if (process.platform === 'win32' && !shell) {
      // buildShellLaunchArgs would fall back to /bin/sh, which does not exist
      // on native Windows; the pane would die while reporting success.
      log('[wezterm] spawnPane: SHELL is not set on Windows; no pane');
      return { success: false, error: 'unavailable' };
    }

    const wezterm = await this.getBinary();
    if (!wezterm) {
      log('[wezterm] spawnPane: wezterm binary not found');
      return { success: false, error: 'unavailable' };
    }

    const passwordVar = viewerPasswordVariable(options);
    if (passwordVar) {
      const resolvedShell = shell || '/bin/sh';
      if (process.platform !== 'linux') {
        logViewerSecretGateFailure(
          'password-bridge-requires-linux',
          resolvedShell,
        );
        return { success: false, error: 'unavailable' };
      }
      if (!isPosixShell(resolvedShell)) {
        logViewerSecretGateFailure(
          'password-bridge-requires-posix-shell',
          resolvedShell,
        );
        return { success: false, error: 'unavailable' };
      }
    }

    try {
      const attachDir = normalizePathForShell(directory);
      const viewerCommand = markViewerCommand(
        buildViewCommand(sessionId, serverUrl, directory, options),
      );
      const command = passwordVar
        ? withParentEnvPassword(
            withViewerUsername(viewerCommand, passwordVar),
            passwordVar,
          )
        : viewerCommand;
      const shellArgs = buildShellLaunchArgs(command);

      const focusedPaneId = await this.readFocusedPaneId(wezterm);
      const plan = getSplitPlan(this.layout);
      let paneId: string | null = null;

      if (plan.stack && this.agentAreaPaneId) {
        const stacked = await this.runSplit(
          wezterm,
          this.agentAreaPaneId,
          plan.stack,
          null,
          attachDir,
          shellArgs,
        );
        if (stacked.ok) {
          paneId = stacked.paneId;
        } else if (stacked.targetGone) {
          log('[wezterm] agent pane is gone, splitting the anchor again', {
            agentAreaPaneId: this.agentAreaPaneId,
          });
          this.agentAreaPaneId = null;
        } else {
          return { success: false, error: 'hard' };
        }
      }

      if (!paneId) {
        const percent = plan.sized
          ? clampPercent(100 - this.mainPaneSize)
          : null;
        const first = await this.runSplit(
          wezterm,
          anchorPaneId,
          plan.first,
          percent,
          attachDir,
          shellArgs,
        );
        if (!first.ok) {
          return {
            success: false,
            error: first.targetGone ? 'not_found' : 'hard',
          };
        }
        paneId = first.paneId;
        if (plan.stack) this.agentAreaPaneId = paneId;
      }

      // split-pane focuses the new pane; give focus back to where it was.
      await this.restoreFocus(wezterm, focusedPaneId ?? anchorPaneId);

      log('[wezterm] spawnPane: SUCCESS', { paneId, description });
      return { success: true, paneId };
    } catch (err) {
      log('[wezterm] spawnPane: exception', { error: String(err) });
      return { success: false, error: 'hard' };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!this.isInsideSession()) {
      log(
        '[wezterm] closePane: OpenCode is not running inside WezTerm; ' +
          'cannot target a pane',
      );
      return false;
    }
    const wezterm = await this.getBinary();
    const closed = await gracefulClosePane(wezterm, paneId, {
      ctrlC: cliArgs(['send-text', '--pane-id', paneId, '--no-paste', '\x03']),
      close: cliArgs(['kill-pane', '--pane-id', paneId]),
      // `kill-pane` also exits 1 on transport/protocol errors while the pane
      // still exists, so only WezTerm's missing-pane error counts as closed.
      isAlreadyClosed: (stderr) => isPaneMissing(stderr, paneId),
      emptyPaneReturnsTrue: true,
    });
    if (!closed) {
      log('[wezterm] closePane: kill-pane failed; keeping the pane tracked', {
        paneId,
      });
    }
    if (closed && paneId === this.agentAreaPaneId) {
      this.agentAreaPaneId = null;
    }
    return closed;
  }

  /** Splits `targetPaneId`; reports whether a failure means it is gone. */
  private async runSplit(
    wezterm: string,
    targetPaneId: string,
    direction: SplitDirection,
    percent: number | null,
    cwd: string,
    shellArgs: string[],
  ): Promise<SplitResult> {
    const args = cliArgs([
      'split-pane',
      '--pane-id',
      targetPaneId,
      direction,
      ...(percent === null ? [] : ['--percent', String(percent)]),
      '--cwd',
      cwd,
      '--',
      ...shellArgs,
    ]);
    const proc = crossSpawn([wezterm, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);
    const paneId = parsePaneId(stdout);
    if (exitCode === 0 && paneId) return { ok: true, paneId };

    log('[wezterm] split-pane failed', {
      targetPaneId,
      direction,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    });
    return {
      ok: false,
      targetGone: exitCode !== 0 && PANE_GONE_PATTERN.test(stderr),
    };
  }

  /**
   * The pane the user has focused, from the most recently active client, or
   * null when it cannot be read (best effort; the anchor is the fallback).
   */
  private async readFocusedPaneId(wezterm: string): Promise<string | null> {
    try {
      const proc = crossSpawn(
        [wezterm, ...cliArgs(['list-clients', '--format', 'json'])],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      // Spawns are serialized, so a hung best-effort read must not block
      // every later spawn: give up after a short timeout.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          proc.kill();
          resolve(null);
        }, FOCUS_TIMEOUT_MS);
      });
      const read = Promise.all([proc.exited, proc.stdout()]).then(
        ([exitCode, stdout]) =>
          exitCode === 0
            ? pickFocusedPaneId(JSON.parse(stdout) as unknown)
            : null,
      );
      try {
        return await Promise.race([read, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  /**
   * Best-effort refocus after a split. The pane already exists, so a failure
   * or hang here must neither lose it nor hold the spawn mutex: bounded by
   * the same timeout as the focus read, and never throws.
   */
  private async restoreFocus(wezterm: string, paneId: string): Promise<void> {
    try {
      const proc = crossSpawn(
        [wezterm, ...cliArgs(['activate-pane', '--pane-id', paneId])],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<number | null>((resolve) => {
        timer = setTimeout(() => {
          proc.kill();
          resolve(null);
        }, FOCUS_TIMEOUT_MS);
      });
      const run = Promise.all([proc.exited, proc.stdout(), proc.stderr()]);
      // The timeout can win the race; never surface the losing rejection.
      run.catch(() => {});
      try {
        const exitCode = await Promise.race([
          run.then(([code, , stderr]) => {
            if (code !== 0) {
              log('[wezterm] command failed', {
                command: 'activate-pane',
                exitCode: code,
                stderr: stderr.trim(),
              });
            }
            return code;
          }),
          timedOut,
        ]);
        if (exitCode === null) {
          log('[wezterm] activate-pane timed out', { paneId });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log('[wezterm] activate-pane failed', { error: String(err) });
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  /** The pane this client runs in; re-resolved on each call. */
  private resolveAnchorPaneId(): string | null {
    const paneId = process.env.WEZTERM_PANE?.trim();
    return paneId ? paneId : null;
  }
}

/** WezTerm's server-side error when the pane being closed no longer exists. */
function isPaneMissing(stderr: string, paneId: string): boolean {
  return new RegExp(`no such pane ${paneId}\\b`).test(stderr);
}

/** `wezterm cli` argv; never auto-start a mux server from a stale socket. */
function cliArgs(args: string[]): string[] {
  return ['cli', '--no-auto-start', ...args];
}

/** The `wezterm` CLI installed next to the running GUI, if present. */
function resolveSiblingCli(): string | null {
  const gui = process.env.WEZTERM_EXECUTABLE?.trim();
  if (!gui) return null;
  const name = process.platform === 'win32' ? 'wezterm.exe' : 'wezterm';
  const candidate = join(dirname(gui), name);
  return existsSync(candidate) ? candidate : null;
}

/**
 * The environment variable the viewer needs its password in, or null when
 * the viewer does not authenticate. v2 remote viewers get the password from
 * the host wiring; a v1 `opencode attach` viewer authenticates with the same
 * `OPENCODE_SERVER_PASSWORD` this client was started with.
 */
function viewerPasswordVariable(
  options?: PaneSpawnOptions,
): 'OPENCODE_PASSWORD' | 'OPENCODE_SERVER_PASSWORD' | null {
  const flavor = options?.viewerFlavor ?? 'v1';
  if (flavor === 'v2-remote') {
    return options?.viewerPassword !== undefined ? 'OPENCODE_PASSWORD' : null;
  }
  if (flavor === 'v1' && process.env.OPENCODE_SERVER_PASSWORD) {
    return 'OPENCODE_SERVER_PASSWORD';
  }
  return null;
}

/**
 * v1 viewers also need a custom `OPENCODE_SERVER_USERNAME`, which the pane
 * does not inherit. It is not a secret, so it is exported in the script.
 */
function withViewerUsername(
  command: string,
  passwordVar: 'OPENCODE_PASSWORD' | 'OPENCODE_SERVER_PASSWORD',
): string {
  const username = process.env.OPENCODE_SERVER_USERNAME;
  if (passwordVar !== 'OPENCODE_SERVER_PASSWORD' || username === undefined) {
    return command;
  }
  return `export OPENCODE_SERVER_USERNAME=${quoteShellArg(username)}\n${command}`;
}

/** Focused pane of the most recently active `list-clients` entry. */
function pickFocusedPaneId(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let best: { paneId: string; idle: number } | null = null;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      focused_pane_id?: unknown;
      idle_time?: { secs?: unknown; nanos?: unknown };
    };
    if (typeof record.focused_pane_id !== 'number') continue;
    const secs = Number(record.idle_time?.secs ?? Number.POSITIVE_INFINITY);
    const nanos = Number(record.idle_time?.nanos ?? 0);
    const idle = secs + nanos / 1e9;
    if (!best || idle < best.idle) {
      best = { paneId: String(record.focused_pane_id), idle };
    }
  }
  return best?.paneId ?? null;
}

/** `split-pane` prints the new pane id on stdout. */
function parsePaneId(stdout: string): string | null {
  const id = stdout.trim().split('\n').at(-1)?.trim() ?? '';
  return /^\d+$/.test(id) ? id : null;
}

function clampPercent(value: number): number {
  return Math.min(80, Math.max(20, Math.round(value)));
}

function getSplitPlan(layout: MultiplexerLayout): SplitPlan {
  switch (layout) {
    case 'main-vertical':
      return { first: '--right', stack: '--bottom', sized: true };
    case 'main-horizontal':
      return { first: '--bottom', stack: '--right', sized: true };
    case 'even-horizontal':
    case 'tiled':
      return { first: '--right', stack: null, sized: false };
    case 'even-vertical':
      return { first: '--bottom', stack: null, sized: false };
    default: {
      const _exhaustive: never = layout;
      return _exhaustive;
    }
  }
}
