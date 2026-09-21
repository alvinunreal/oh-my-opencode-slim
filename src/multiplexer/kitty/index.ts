/**
 * Kitty multiplexer implementation
 *
 * Uses kitty's remote-control CLI (`kitten @`) to manage windows.
 * A kitty WINDOW is the 1:1 equivalent of a tmux pane (full PTY).
 *
 * Requires `allow_remote_control` **and** `listen_on` in kitty.conf. When
 * `listen_on` is set, kitty exports `KITTY_LISTEN_ON` to its child processes
 * (including OpenCode). The plugin passes that env through to `kitten @` so
 * remote control goes via the socket instead of the controlling terminal,
 * because OpenCode spawns subagent commands in a process detached from the
 * kitty window's tty, where the tty-based remote-control path does not work.
 *
 * Layout mapping:
 * - main-vertical → tall layout (full-height main pane on left, side panes stacked on right)
 * - main-horizontal → fat layout (full-width main pane on top, side panes tiled below)
 * - tiled → grid layout (equal-sized cells)
 * - even-horizontal → horizontal layout (all panes side-by-side)
 * - even-vertical → vertical layout (all panes stacked)
 *
 * Maps each plugin layout to the closest kitty built-in layout. kitty has no
 * per-window layout API, so the chosen layout is applied as a global change to
 * the active tab (overriding whatever layout was active there).
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildOpencodeAttachCommand,
  buildShellLaunchArgs,
  findBinary,
  gracefulClosePane,
  normalizePathForShell,
} from '../shared';
import type { Multiplexer, PaneResult } from '../types';

export class KittyMultiplexer implements Multiplexer {
  readonly type = 'kitty' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private storedLayout: MultiplexerLayout;
  private appliedLayout: string | null = null;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    void mainPaneSize; // kitty uses layout bias, not main pane size
    this.storedLayout = layout;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    // Try `kitten` first (the recommended remote-control CLI). Fall back to
    // `kitty` only if `kitten` is absent — `kitty @` is an alias for
    // `kitten @` (remote control), not a request to open a new window.
    this.binaryPath =
      (await findBinary('kitten')) ?? (await findBinary('kitty'));
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.KITTY_PID || !!process.env.KITTY_WINDOW_ID;
  }

  /**
   * The kitty multiplexer needs `listen_on` configured in kitty.conf so kitty
   * exports `KITTY_LISTEN_ON` to its children. Without it, `kitten @` cannot
   * reach kitty from OpenCode's detached subagent processes (the tty path does
   * not work). Returns true when the socket env is present.
   */
  private hasListenOn(): boolean {
    return !!process.env.KITTY_LISTEN_ON;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const kitten = await this.getBinary();
    if (!kitten) {
      log('[kitty] spawnPane: kitten/kitty binary not found');
      return { success: false };
    }

    // The kitty multiplexer only works when OpenCode is itself running inside
    // a kitty window (so `kitten @` can reach the instance). If not, fail
    // cleanly instead of shelling out to a command that cannot succeed.
    if (!this.isInsideSession()) {
      log(
        '[kitty] spawnPane: OpenCode is not running inside a kitty session; ' +
          'set multiplexer.type to a different backend or run OpenCode inside kitty',
      );
      return { success: false };
    }

    // `listen_on` must be set in kitty.conf so kitty exports KITTY_LISTEN_ON.
    // Without it, remote control cannot reach kitty from detached subagent
    // processes. Fail with an actionable message instead of a silent error.
    if (!this.hasListenOn()) {
      log(
        '[kitty] spawnPane: KITTY_LISTEN_ON is not set. Add `listen_on ' +
          'unix:/tmp/kitty-rc-$(USER)` to kitty.conf and restart kitty so the ' +
          'plugin can drive kitty via the socket.',
      );
      return { success: false };
    }

    // Map layout to kitty layout and location
    const { kittyLayout, location } = getKittyLayoutConfig(this.storedLayout);

    // Ensure the correct layout is active
    await this.ensureLayout(kittyLayout);

    try {
      const opencodeCmd = buildOpencodeAttachCommand(
        sessionId,
        serverUrl,
        directory,
      );

      // Normalize for Windows/MSYS2/Git Bash (backslashes would be treated as
      // escape chars). No-op on macOS/Linux. Mirrors the herdr adapter.
      const attachDir = normalizePathForShell(directory);

      // Launch in the user's interactive shell (fish/bash/zsh/sh) so the
      // command resolves correctly — a hardcoded `sh -c` breaks under fish
      // and misses login startup files where `opencode` may live on PATH.
      const shellArgs = buildShellLaunchArgs(opencodeCmd);

      const args = [
        '@',
        'launch',
        '--type=window',
        `--location=${location}`,
        `--title=${description.slice(0, 60)}`,
        `--cwd=${attachDir}`,
        '--keep-focus',
        '--',
        ...shellArgs,
      ];

      log('[kitty] spawnPane: executing', { kitten, args });

      const proc = crossSpawn([kitten, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: this.kittyEnv(),
      });

      const exitCode = await proc.exited;
      const stdout = await proc.stdout();
      const stderr = await proc.stderr();

      // Kitty prints the integer window id on stdout (last non-empty line)
      const lines = stdout
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const windowId = lines.length > 0 ? lines[lines.length - 1] : '';

      log('[kitty] spawnPane: result', {
        exitCode,
        windowId,
        stderr: stderr.trim(),
      });

      if (exitCode === 0 && windowId) {
        log('[kitty] spawnPane: SUCCESS', { windowId });
        return { success: true, paneId: windowId };
      }

      return { success: false };
    } catch (err) {
      log('[kitty] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!this.isInsideSession()) {
      log(
        '[kitty] closePane: OpenCode is not running inside a kitty session; ' +
          'cannot target a kitty instance',
      );
      return false;
    }
    if (!this.hasListenOn()) {
      log(
        '[kitty] closePane: KITTY_LISTEN_ON is not set; cannot target kitty. ' +
          'Add `listen_on` to kitty.conf and restart kitty.',
      );
      return false;
    }
    const kitten = await this.getBinary();
    return await gracefulClosePane(kitten, paneId, {
      ctrlC: ['@', 'send-key', '--match', `id:${paneId}`, 'ctrl+c'],
      close: ['@', 'close-window', '--match', `id:${paneId}`],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
      env: this.kittyEnv(),
    });
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    void mainPaneSize; // kitty uses layout bias, not main pane size
    if (!this.isInsideSession()) {
      log(
        '[kitty] applyLayout: OpenCode is not running inside a kitty session; ' +
          'cannot target a kitty instance',
      );
      return;
    }
    if (!this.hasListenOn()) {
      log(
        '[kitty] applyLayout: KITTY_LISTEN_ON is not set; cannot target kitty. ' +
          'Add `listen_on` to kitty.conf and restart kitty.',
      );
      return;
    }
    this.storedLayout = layout;
    const { kittyLayout } = getKittyLayoutConfig(layout);
    await this.ensureLayout(kittyLayout);
  }

  private async runKitty(kitten: string, args: string[]): Promise<number> {
    const proc = crossSpawn([kitten, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.kittyEnv(),
    });
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);

    if (exitCode !== 0) {
      log('[kitty] command failed', {
        command: args[1],
        args: [kitten, ...args],
        exitCode,
        stderr: stderr.trim(),
      });
    }

    return exitCode;
  }

  private async ensureLayout(kittyLayout: string): Promise<void> {
    // Skip if this layout is already applied (avoids redundant global switches).
    // Tracking the applied layout (not a boolean) lets applyLayout switch to a
    // different layout even after panes have spawned.
    if (this.appliedLayout === kittyLayout) return;
    const kitten = await this.getBinary();
    if (!kitten) return;
    try {
      const exitCode = await this.runKitty(kitten, [
        '@',
        'goto-layout',
        kittyLayout,
      ]);
      // Only record on success so a transient failure can retry.
      if (exitCode === 0) this.appliedLayout = kittyLayout;
    } catch (err) {
      log('[kitty] ensureLayout: exception', { error: String(err) });
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  /**
   * Build the env for `kitten @` invocations. When kitty's `listen_on` socket
   * is configured, kitty sets `KITTY_LISTEN_ON` in its child processes (which
   * includes OpenCode). We pass that env through so remote control goes via the
   * socket instead of the controlling terminal (required for the plugin's
   * detached subagent processes). When the var is absent we return undefined
   * and `kitten @` falls back to the tty path.
   */
  private kittyEnv(): Record<string, string | undefined> | undefined {
    const listenOn = process.env.KITTY_LISTEN_ON;
    if (!listenOn) return undefined;
    return { ...process.env, KITTY_LISTEN_ON: listenOn };
  }
}

/**
 * Map plugin layout to kitty layout and launch location.
 *
 * Each plugin layout maps to the closest kitty built-in layout
 * (tall/fat/grid/horizontal/vertical). kitty has no per-window layout, so the
 * chosen layout is applied globally to the active tab. `--location=after` is
 * used for spawning since the layout engine places new windows.
 */
function getKittyLayoutConfig(layout: MultiplexerLayout): {
  kittyLayout: string;
  location: string;
} {
  switch (layout) {
    case 'main-vertical':
      // tall = full-height main pane on left, side panes stacked on right
      // after = place new window after active window (stacked vertically)
      return { kittyLayout: 'tall', location: 'after' };
    case 'main-horizontal':
      // fat = full-width main pane on top, side panes tiled below
      // after = place new window after active window (tiled horizontally)
      return { kittyLayout: 'fat', location: 'after' };
    case 'tiled':
      // grid = all windows in a balanced grid, same size
      return { kittyLayout: 'grid', location: 'after' };
    case 'even-horizontal':
      // horizontal = all windows side-by-side, equal width
      return { kittyLayout: 'horizontal', location: 'after' };
    case 'even-vertical':
      // vertical = all windows stacked, equal height
      return { kittyLayout: 'vertical', location: 'after' };
    default: {
      // Exhaustiveness check: a new MultiplexerLayout value must be added
      // above, otherwise this assignment fails to type-check.
      const _exhaustive: never = layout;
      return _exhaustive;
    }
  }
}
