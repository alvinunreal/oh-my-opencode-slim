/**
 * Tmux multiplexer implementation
 *
 * Runs entirely in the client process and addresses the tmux server the
 * client itself lives in:
 * - detection is pane-scoped (`TMUX_PANE`),
 * - every control-plane command is explicitly addressed with
 *   `-S <socket>` taken from the first segment of `TMUX`,
 * - the anchor pane is re-resolved from the environment at spawn time,
 * - split direction follows the configured layout,
 * - layout/close only touch panes this instance created.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildViewCommand,
  findBinary,
  gracefulClosePane,
  PANE_VIEWER_ENV,
  redactViewerSecretArgs,
  viewerNeedsPaneCwd,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';

const TMUX_LAYOUT_DEBOUNCE_MS = 150;

/** Scheduling seam; tests inject a deterministic timer harness. */
interface LayoutTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}

const REAL_TIMERS: LayoutTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class TmuxMultiplexer implements Multiplexer {
  readonly type = 'tmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private supportsSplitEnv = false;
  private supportsPaneOptions = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;
  private layoutTimers = new Map<string, unknown>();
  /** Panes created by this instance, mapped to the anchor they were split from. */
  private paneTargets = new Map<string, string>();

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    mainPaneSize = 60,
    private readonly timers: LayoutTimers = REAL_TIMERS,
  ) {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await findBinary('tmux', {
      verify: true,
      onVerified: (version) => {
        const match = /^tmux\s+(\d+)\.(\d+)([a-z]?)/i.exec(version);
        if (!match) return;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        this.supportsSplitEnv = major >= 3;
        this.supportsPaneOptions =
          major > 3 || (major === 3 && (minor > 0 || !!match[3]));
      },
    });
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.TMUX_PANE;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // Multi-instance hardening: resolve the server socket and the anchor from
    // this client's own environment at spawn time. When either is missing the
    // target is unknowable, so no tmux command may be issued.
    const socket = this.resolveSocket();
    if (!socket) {
      log('[tmux] spawnPane: TMUX is not set; cannot address a tmux server');
      return { success: false, error: 'not_found' };
    }
    const anchor = this.resolveAnchor();
    if (!anchor) {
      log('[tmux] spawnPane: TMUX_PANE is not set; cannot resolve the anchor');
      return { success: false, error: 'not_found' };
    }

    const tmux = await this.getBinary();
    if (!tmux) {
      log('[tmux] spawnPane: tmux binary not found');
      return { success: false, error: 'unavailable' };
    }

    const v1Credentials =
      (options?.viewerFlavor ?? 'v1') === 'v1'
        ? [
            process.env.OPENCODE_SERVER_PASSWORD,
            process.env.OPENCODE_SERVER_USERNAME,
          ]
        : [];
    const secrets = [...v1Credentials, options?.viewerPassword].filter(
      (value): value is string => !!value,
    );
    const redact = (text: string): string =>
      secrets.reduce(
        (result, secret) => result.replaceAll(secret, '<redacted>'),
        text,
      );
    try {
      const opencodeCmd = `env OPENCODE_DISABLE_TERMINAL_TITLE=1 ${PANE_VIEWER_ENV}=1 ${buildViewCommand(
        sessionId,
        serverUrl,
        directory,
        options,
      )}`;

      // v2 remote hosts: the viewer must authenticate with
      // OPENCODE_PASSWORD. Inject it as a spawn-time tmux environment entry
      // (`-e`), never through the shell command text.
      const viewerSecretArgs =
        options?.viewerFlavor === 'v2-remote' &&
        options.viewerPassword !== undefined
          ? ['-e', `OPENCODE_PASSWORD=${options.viewerPassword}`]
          : (this.supportsSplitEnv ? v1Credentials : []).flatMap(
              (value, index) =>
                value === undefined
                  ? []
                  : [
                      '-e',
                      `${index === 0 ? 'OPENCODE_SERVER_PASSWORD' : 'OPENCODE_SERVER_USERNAME'}=${value}`,
                    ],
            );

      const result = await this.splitPane(
        tmux,
        socket,
        anchor,
        this.storedLayout,
        opencodeCmd,
        viewerSecretArgs,
        // v2 mini commands omit the directory, so the split pins the child
        // session's project directory itself.
        viewerNeedsPaneCwd(options) ? ['-c', directory] : [],
      );
      const paneId = result.stdout.trim();

      log('[tmux] spawnPane: result', {
        command: opencodeCmd,
        exitCode: result.exitCode,
        paneId,
        stderr: redact(result.stderr.trim()),
        anchor,
        socket,
      });

      if (result.exitCode === 0 && paneId) {
        // Rename the pane for visibility. The description is the FR-8
        // metadata (owner pid + child session id) and must survive intact,
        // so it is never truncated here.
        const renameProc = crossSpawn(
          [tmux, '-S', socket, 'select-pane', '-t', paneId, '-T', description],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        await renameProc.exited;

        // Pane user options require tmux 3.0a; older servers keep the title fallback.
        if (this.supportsPaneOptions) {
          try {
            const metadataProc = crossSpawn(
              [
                tmux,
                '-S',
                socket,
                'set-option',
                '-p',
                '-t',
                paneId,
                '@omosc',
                description,
              ],
              { stdout: 'ignore', stderr: 'ignore' },
            );
            await metadataProc.exited;
          } catch {
            // The pane still exists even when its metadata option cannot be set.
          }
        }

        // Rebalance panes after bursts of child sessions settle.
        this.paneTargets.set(paneId, anchor);
        this.scheduleLayout(anchor);

        log('[tmux] spawnPane: SUCCESS', { paneId });
        return { success: true, paneId };
      }

      return { success: false, error: 'hard' };
    } catch (err) {
      log('[tmux] spawnPane: exception', { error: redact(String(err)) });
      return { success: false, error: 'hard' };
    }
  }

  /**
   * FR-8 sweep capability: every pane on this client's tmux server with its
   * title. Read-only; titles that are not plugin metadata are simply skipped
   * by the sweep. Returns an empty list when the client environment cannot
   * address a tmux server (no command is issued).
   */
  async listPanesWithTitles(): Promise<
    Array<{ paneId: string; title: string }>
  > {
    const socket = this.resolveSocket();
    if (!socket) return [];
    const tmux = await this.getBinary();
    if (!tmux) return [];

    try {
      const proc = crossSpawn(
        [
          tmux,
          '-S',
          socket,
          'list-panes',
          '-a',
          '-F',
          this.supportsPaneOptions
            ? '#{pane_id}|#{?@omosc,#{@omosc},#{pane_title}}'
            : '#{pane_id}|#{pane_title}',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        proc.stdout(),
      ]);
      if (exitCode !== 0) return [];

      const panes: Array<{ paneId: string; title: string }> = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const separator = trimmed.indexOf('|');
        if (separator <= 0) continue;
        panes.push({
          paneId: trimmed.slice(0, separator),
          title: trimmed.slice(separator + 1),
        });
      }
      return panes;
    } catch {
      return [];
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    const socket = this.resolveSocket();
    if (!socket) {
      // Fail closed without an explicit server address: a socket-less tmux
      // call would hit whichever server happens to be the default.
      log('[tmux] closePane: TMUX is not set; cannot address a tmux server', {
        paneId,
      });
      return false;
    }

    const tmux = await this.getBinary();
    const closed = await gracefulClosePane(tmux, paneId, {
      ctrlC: ['-S', socket, 'send-keys', '-t', paneId, 'C-c'],
      close: ['-S', socket, 'kill-pane', '-t', paneId],
      // Only a missing target proves the pane is gone; transport errors also exit 1.
      isAlreadyClosed: (stderr) =>
        stderr.trim() === `can't find pane: ${paneId}`,
    });
    if (closed) {
      const anchor = this.paneTargets.get(paneId);
      this.paneTargets.delete(paneId);
      // Layout scope: only windows this instance split into are rebalanced.
      if (anchor) this.scheduleLayout(anchor);
    }
    return closed;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    for (const timer of this.layoutTimers.values())
      this.timers.clearTimeout(timer);
    this.layoutTimers.clear();
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;

    const socket = this.resolveSocket();
    const anchor = this.resolveAnchor();
    if (!socket || !anchor) {
      log('[tmux] applyLayout: no tmux target resolved; skipping', {
        hasSocket: !!socket,
        hasAnchor: !!anchor,
      });
      return;
    }

    await this.applyLayoutNow(layout, mainPaneSize, socket, anchor);
  }

  async applySpawnLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    if (
      layout === this.storedLayout &&
      mainPaneSize === this.storedMainPaneSize
    )
      return;
    await this.applyLayout(layout, mainPaneSize);
  }

  private scheduleLayout(targetPane: string): void {
    const pending = this.layoutTimers.get(targetPane);
    if (pending) this.timers.clearTimeout(pending);

    const timer = this.timers.setTimeout(() => {
      this.layoutTimers.delete(targetPane);
      const socket = this.resolveSocket();
      if (!socket) return;
      void this.applyLayoutNow(
        this.storedLayout,
        this.storedMainPaneSize,
        socket,
        targetPane,
      );
    }, TMUX_LAYOUT_DEBOUNCE_MS);
    this.layoutTimers.set(targetPane, timer);
    (timer as { unref?: () => void }).unref?.();
  }

  private async applyLayoutNow(
    layout: MultiplexerLayout,
    mainPaneSize: number,
    socket: string,
    targetPane: string,
  ): Promise<void> {
    const tmux = await this.getBinary();
    if (!tmux) return;

    try {
      // Apply the layout
      const layoutResult = await this.runTmux(tmux, socket, [
        'select-layout',
        ...this.targetArgs(targetPane),
        layout,
      ]);
      if (layoutResult !== 0) return;

      // For main-* layouts, set the main pane size
      if (layout === 'main-horizontal' || layout === 'main-vertical') {
        const sizeOption =
          layout === 'main-horizontal' ? 'main-pane-height' : 'main-pane-width';

        const sizeResult = await this.runTmux(tmux, socket, [
          'set-window-option',
          ...this.targetArgs(targetPane),
          sizeOption,
          `${mainPaneSize}%`,
        ]);
        if (sizeResult !== 0) return;

        // Reapply layout to use the new size
        const reapplyResult = await this.runTmux(tmux, socket, [
          'select-layout',
          ...this.targetArgs(targetPane),
          layout,
        ]);
        if (reapplyResult !== 0) return;
      }

      log('[tmux] applyLayout: applied', { layout, mainPaneSize });
    } catch (err) {
      log('[tmux] applyLayout: exception', { error: String(err) });
    }
  }

  private async runTmux(
    tmux: string,
    socket: string,
    args: string[],
  ): Promise<number> {
    const proc = crossSpawn([tmux, '-S', socket, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);

    if (exitCode !== 0) {
      log('[tmux] command failed', {
        command: args[0],
        args: redactViewerSecretArgs([tmux, '-S', socket, ...args]),
        exitCode,
        stderr: stderr.trim(),
      });
    }

    return exitCode;
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  private async splitPane(
    tmux: string,
    socket: string,
    targetPane: string,
    layout: MultiplexerLayout,
    opencodeCmd: string,
    viewerSecretArgs: string[] = [],
    miniCwdArgs: string[] = [],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const args = [
      '-S',
      socket,
      'split-window',
      getSplitDirection(layout),
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      ...this.targetArgs(targetPane),
      ...viewerSecretArgs,
      ...miniCwdArgs,
      opencodeCmd,
    ];
    log('[tmux] spawnPane: executing', {
      tmux,
      args: redactViewerSecretArgs(args),
    });

    const proc = crossSpawn([tmux, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout(),
      proc.stderr(),
    ]);
    return { exitCode, stdout, stderr };
  }

  private targetArgs(targetPane: string): string[] {
    return ['-t', targetPane];
  }

  /**
   * Socket path of the tmux server this client is attached to: the first
   * segment of `TMUX` (`<socket>,<pid>,<session>`). Explicit `-S` addressing
   * removes the default-socket ambiguity when several servers run on one host.
   */
  private resolveSocket(): string | null {
    const tmuxEnv = process.env.TMUX;
    if (!tmuxEnv) return null;
    const socket = tmuxEnv.split(',')[0]?.trim();
    return socket ? socket : null;
  }

  /** The pane this client currently displays the parent session in. */
  private resolveAnchor(): string | null {
    const pane = process.env.TMUX_PANE?.trim();
    return pane ? pane : null;
  }
}

/**
 * Split direction implied by the configured layout.
 *
 * `-h` splits side by side (new pane to the right), `-v` splits top/bottom
 * (new pane below). `select-layout` re-tiles afterwards, so this only fixes
 * the initial placement of each new pane.
 */
function getSplitDirection(layout: MultiplexerLayout): '-h' | '-v' {
  switch (layout) {
    case 'main-horizontal':
    case 'even-vertical':
      return '-v';
    case 'main-vertical':
    case 'even-horizontal':
    case 'tiled':
      return '-h';
  }
}
