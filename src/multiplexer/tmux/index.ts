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

export class TmuxMultiplexer implements Multiplexer {
  readonly type = 'tmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private supportsSplitEnv = false;
  private supportsPaneOptions = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;
  /** Panes created by this instance (creation order), mapped to their anchor. */
  private paneTargets = new Map<string, string>();

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
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
        opencodeCmd,
        viewerSecretArgs,
        // v2 mini commands omit the directory, so the split pins the child
        // session's project directory itself.
        viewerNeedsPaneCwd(options) ? ['-c', directory] : [],
      );
      const paneId = result.stdout.trim();

      if (result.exitCode !== 0 || !PANE_ID.test(paneId)) {
        log('[tmux] spawnPane: result', {
          command: opencodeCmd,
          exitCode: result.exitCode,
          paneId,
          stderr: redact(result.stderr.trim()),
          anchor,
          socket,
        });
      }

      if (PANE_ID.test(paneId)) {
        // FR-8 metadata and title in one invocation. The description must
        // survive intact, so it is never truncated. Pane user options need
        // tmux 3.0a; older servers keep the title fallback.
        this.paneTargets.set(paneId, anchor);
        try {
          await this.runTmux(tmux, socket, [
            'select-pane',
            '-t',
            paneId,
            '-T',
            description,
            ...(this.supportsPaneOptions
              ? [';', 'set-option', '-p', '-t', paneId, '@omosc', description]
              : []),
          ]);
        } catch (err) {
          log('[tmux] spawnPane: metadata exception', {
            error: redact(String(err)),
          });
        }

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
    // Layout scope: only windows this instance split into are rebalanced.
    const anchor = this.paneTargets.get(paneId);
    const layout = anchor
      ? ['select-layout', '-t', anchor, this.storedLayout]
      : [];
    let alreadyClosed = false;
    const closed = await gracefulClosePane(tmux, paneId, {
      ctrlC: ['-S', socket, 'send-keys', '-t', paneId, 'C-c'],
      // Kill and rebalance in one invocation: each pane is resized once.
      close: [
        '-S',
        socket,
        'kill-pane',
        '-t',
        paneId,
        ...(anchor ? [';', ...layout] : []),
      ],
      // tmux stops at the first failing command and names the missing target.
      isAlreadyClosed: (stderr) => {
        const error = stderr.trim();
        alreadyClosed = error === `can't find pane: ${paneId}`;
        return (
          alreadyClosed ||
          error === 'no current target' ||
          (anchor !== undefined && error === `can't find pane: ${anchor}`)
        );
      },
    });
    if (closed) {
      this.paneTargets.delete(paneId);
      // The pane was already gone, so the chained layout never ran.
      if (anchor && alreadyClosed && tmux) {
        try {
          await this.runTmux(tmux, socket, layout);
        } catch (err) {
          log('[tmux] closePane: layout exception', { error: String(err) });
        }
      }
    }
    return closed;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;

    const socket = this.resolveSocket();
    const anchor = this.resolveAnchor();
    const tmux = await this.getBinary();
    if (!socket || !anchor || !tmux) {
      log('[tmux] applyLayout: no tmux target resolved; skipping', {
        hasSocket: !!socket,
        hasAnchor: !!anchor,
      });
      return;
    }
    try {
      await this.runTmux(tmux, socket, this.layoutArgs(anchor));
    } catch (err) {
      log('[tmux] applyLayout: exception', { error: String(err) });
    }
  }

  async applySpawnLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    if (
      layout !== this.storedLayout ||
      mainPaneSize !== this.storedMainPaneSize
    )
      await this.applyLayout(layout, mainPaneSize);
  }

  /**
   * The configured layout as one command sequence. tmux runs a sequence in
   * one pass and resizes each pane once for its final geometry. The leading
   * `select-layout` still applies when the size option is rejected.
   */
  private layoutArgs(target: string): string[] {
    const layout = this.storedLayout;
    const select = ['select-layout', '-t', target, layout];
    if (!isMainLayout(layout)) return select;
    const option =
      layout === 'main-horizontal' ? 'main-pane-height' : 'main-pane-width';
    return [
      ...select,
      ';',
      'set-window-option',
      '-t',
      target,
      option,
      `${this.storedMainPaneSize}%`,
      ';',
      ...select,
    ];
  }

  /**
   * The pane that follows `anchor` in its window. Splitting it with `-b`
   * inserts the new pane at the same position as splitting the anchor, but
   * leaves the anchor's size untouched.
   */
  private async paneAfter(
    tmux: string,
    socket: string,
    anchor: string,
  ): Promise<string | undefined> {
    const proc = crossSpawn(
      [tmux, '-S', socket, 'list-panes', '-t', anchor, '-F', '#{pane_id}'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout] = await Promise.all([proc.exited, proc.stdout()]);
    if (exitCode !== 0) return undefined;
    const panes = stdout.split('\n');
    const index = panes.indexOf(anchor);
    const next = index === -1 ? undefined : panes[index + 1];
    return next && PANE_ID.test(next) ? next : undefined;
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

  /**
   * Splits and rebalances in one invocation. Main layouts stack each new
   * pane before the newest child (same order as splitting the anchor), so
   * the parent pane keeps its size; a gone child falls back to the anchor.
   */
  private async splitPane(
    tmux: string,
    socket: string,
    anchor: string,
    opencodeCmd: string,
    viewerSecretArgs: string[] = [],
    miniCwdArgs: string[] = [],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const layout = this.storedLayout;
    const stackOn = isMainLayout(layout)
      ? await this.paneAfter(tmux, socket, anchor)
      : undefined;
    const run = async (target: string | undefined) => {
      const args = [
        '-S',
        socket,
        'split-window',
        ...(target
          ? [getStackDirection(layout), '-b']
          : [getSplitDirection(layout)]),
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        ...this.targetArgs(target ?? anchor),
        ...viewerSecretArgs,
        ...miniCwdArgs,
        opencodeCmd,
        ';',
        ...this.layoutArgs(anchor),
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
    };
    const result = await run(stackOn);
    // A neighbour can disappear between list-panes and split-window.
    return !PANE_ID.test(result.stdout.trim()) &&
      stackOn &&
      result.stderr.trim() === `can't find pane: ${stackOn}`
      ? run(undefined)
      : result;
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
const PANE_ID = /^%\d+$/;

function isMainLayout(layout: MultiplexerLayout): boolean {
  return layout === 'main-horizontal' || layout === 'main-vertical';
}

/** Direction that stacks children inside the agent area of a main layout. */
function getStackDirection(layout: MultiplexerLayout): '-h' | '-v' {
  return layout === 'main-horizontal' ? '-h' : '-v';
}

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
