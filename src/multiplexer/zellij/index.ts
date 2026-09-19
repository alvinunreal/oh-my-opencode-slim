/**
 * Zellij multiplexer implementation
 *
 * Creates panes for sub-agent sessions in Zellij, from inside the client
 * process that displays the parent OpenCode session.
 *
 * Anchoring (same tab, single behavior):
 * - Detection is `ZELLIJ_PANE_ID` (the parent pane the client runs in).
 * - The parent tab is resolved from that pane id via `list-panes --json`
 *   (`current-tab-info` is deliberately not used: it is client-bound and
 *   fails from pane child processes).
 * - The child pane is created with `new-pane --tab-id <parentTab>
 *   --direction <dir>`, so it always splits the parent pane's tab. The
 *   adapter never creates a dedicated tab, never switches tabs, and never
 *   saves/restores focus: child panes live in the same tab as the parent
 *   pane, unconditionally.
 *
 * Multi-instance hardening: every zellij invocation is explicitly addressed
 * with `--session <ZELLIJ_SESSION_NAME>` (placed before `action`), so a
 * machine running several zellij sessions cannot route commands to the wrong
 * one. When the client environment cannot resolve the anchor
 * (`ZELLIJ_PANE_ID` or `ZELLIJ_SESSION_NAME` missing, or the parent tab
 * lookup failing), no zellij command is issued and the spawn fails with
 * `not_found`.
 *
 * Version gate: `isAvailable()` parses `zellij --version` and rejects
 * releases older than 0.44.1, whose CLI lacks `new-pane --tab-id` — still
 * required to anchor the create to the parent pane's tab — and whose
 * `list-panes --json --tab --all` output does not carry the stable `tab_id`
 * the anchor lookup depends on.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import {
  buildOpencodeAttachCommand,
  findBinary,
  gracefulClosePane,
} from '../shared';
import type { Multiplexer, PaneResult } from '../types';

interface ZellijPaneInfo {
  id: number;
  is_plugin: boolean;
  tab_id?: number;
  /** Pane title (`--all` field); carries the FR-8 metadata when ours. */
  title?: string;
}

type ZellijPaneDirection = 'right' | 'down';

export class ZellijMultiplexer implements Multiplexer {
  readonly type = 'zellij' as const;

  private binaryPath: string | null = null;
  private availabilityPromise: Promise<boolean> | null = null;
  private parentTabId: string | null = null;
  private parentTabResolved = false;
  private readonly parentPaneId = process.env.ZELLIJ_PANE_ID;
  private readonly sessionName = process.env.ZELLIJ_SESSION_NAME;
  private readonly paneDirection: ZellijPaneDirection | null;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    // Note: Zellij does not support exact main pane sizing like tmux.
    // Layout config is mapped to pane creation directions where possible.
    void mainPaneSize;
    this.paneDirection = getPaneDirection(layout);
  }

  async isAvailable(): Promise<boolean> {
    // Cache the in-flight probe itself, not just the result: if availability
    // is checked while the first probe is still running (e.g. an early
    // sub-agent event racing the plugin's own startup check), the caller
    // awaits the same promise instead of seeing hasChecked=true with
    // binaryPath still null and wrongly concluding the backend is absent.
    if (this.availabilityPromise) {
      return this.availabilityPromise;
    }
    this.availabilityPromise = this.probeAvailability();
    return this.availabilityPromise;
  }

  /**
   * Resolve the zellij binary and gate on its version. Runs at most once per
   * adapter instance (the promise is cached by isAvailable).
   */
  private async probeAvailability(): Promise<boolean> {
    const binaryPath = await findBinary('zellij');
    if (binaryPath && (await this.hasSupportedVersion(binaryPath))) {
      this.binaryPath = binaryPath;
      return true;
    }
    this.binaryPath = null;
    return false;
  }

  /**
   * Parse and gate on the installed Zellij version. The adapter relies on
   * `new-pane --tab-id` for same-tab anchoring and on the stable `tab_id`
   * field of `list-panes --json --tab --all`; both only exist in Zellij
   * >= 0.44.1. Older releases (or unparsable version output) make the backend
   * unavailable.
   */
  private async hasSupportedVersion(path: string): Promise<boolean> {
    const version = await this.readVersion(path);
    return version !== null && isSupportedZellijVersion(version);
  }

  private async readVersion(path: string): Promise<ZellijVersion | null> {
    try {
      const proc = crossSpawn([path, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if ((await proc.exited) !== 0) return null;
      return parseZellijVersion(await proc.stdout());
    } catch {
      return null;
    }
  }

  isInsideSession(): boolean {
    return !!process.env.ZELLIJ_PANE_ID;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    // Fail closed without issuing any zellij command when the client
    // environment cannot resolve the anchor: the session to address or the
    // parent pane whose tab the child pane must split.
    if (!this.sessionName || !this.parentPaneId) {
      return { success: false, error: 'not_found' };
    }

    const zellij = await this.getBinary();
    if (!zellij) return { success: false, error: 'unavailable' };

    try {
      return await this.createPaneInParentTab(
        zellij,
        sessionId,
        serverUrl,
        directory,
        description,
      );
    } catch {
      return { success: false, error: 'hard' };
    }
  }

  private async createPaneInParentTab(
    zellij: string,
    sessionId: string,
    serverUrl: string,
    directory: string,
    description: string,
  ): Promise<PaneResult> {
    const opencodeCmd = buildOpencodeAttachCommand(
      sessionId,
      serverUrl,
      directory,
    );
    // The name doubles as the pane title; the description is the FR-8
    // metadata (owner pid + child session id) and must survive intact.
    const paneName = description.replace(/"/g, '\\"');
    const targetTabId = await this.getParentTabId(zellij);

    // The parent tab is the anchor: without it there is no same-tab target,
    // so no pane is created rather than falling back to the focused tab.
    if (!targetTabId) return { success: false, error: 'not_found' };

    return this.runNewPaneWithFallback(
      zellij,
      paneName,
      opencodeCmd,
      targetTabId,
    );
  }

  /**
   * Run `new-pane` in the parent tab, retrying once without the direction
   * hint on failure.
   *
   * Zellij silently drops a `--direction` split once a tab is crowded (exit
   * code 0 but no `terminal_*` id on stdout), so a failed directed create is
   * retried without `--direction`, which lets Zellij place the pane in the
   * largest free space of the target tab. The retry keeps `--session`,
   * `--tab-id`, `--name`, `--close-on-exit`, and the command part — only the
   * direction hint is dropped. Two failures (or one failure with no direction
   * configured) report `{ success: false, error: 'hard' }`.
   */
  private async runNewPaneWithFallback(
    zellij: string,
    paneName: string,
    opencodeCmd: string,
    targetTabId: string,
  ): Promise<PaneResult> {
    const direction = this.directionArgs();
    const runOnce = async (directionArgs: string[]): Promise<PaneResult> => {
      const args = [
        ...this.sessionArgs(),
        'action',
        'new-pane',
        '--tab-id',
        targetTabId,
        ...directionArgs,
        '--name',
        paneName,
        '--close-on-exit',
        '--',
        'sh',
        '-lc',
        opencodeCmd,
      ];

      const proc = crossSpawn([zellij, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stdout = await proc.stdout();
      const paneId = stdout.trim();

      // Accept success if exit code is 0 and we got a valid pane ID
      if (exitCode === 0 && paneId?.startsWith('terminal_')) {
        return { success: true, paneId };
      }
      return { success: false, error: 'hard' };
    };

    const first = await runOnce(direction);
    if (first.success) return first;
    // Retry only when a direction was actually applied; an undirected create
    // already uses Zellij's free-space placement and would just repeat.
    if (direction.length === 0) return first;
    return runOnce([]);
  }

  private async listPanesJson(
    zellij: string,
  ): Promise<ZellijPaneInfo[] | null> {
    const sessionArgs = this.sessionArgs();
    // Never address zellij without an explicit session.
    if (sessionArgs.length === 0) return null;

    try {
      const proc = crossSpawn(
        [
          zellij,
          ...sessionArgs,
          'action',
          'list-panes',
          '--json',
          '--tab',
          '--all',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if ((await proc.exited) !== 0) return null;
      const stdout = await proc.stdout();
      return JSON.parse(stdout) as ZellijPaneInfo[];
    } catch {
      return null;
    }
  }

  /**
   * FR-8 sweep capability: terminal panes of this client's zellij session
   * with their titles. Plugin panes are skipped; titles that are not plugin
   * metadata are ignored by the sweep. Returns an empty list when no session
   * can be addressed (no command is issued).
   */
  async listPanesWithTitles(): Promise<
    Array<{ paneId: string; title: string }>
  > {
    const zellij = await this.getBinary();
    if (!zellij) return [];

    const panes = await this.listPanesJson(zellij);
    if (!panes) return [];

    const result: Array<{ paneId: string; title: string }> = [];
    for (const pane of panes) {
      if (pane.is_plugin) continue;
      result.push({
        paneId: `terminal_${pane.id}`,
        title: typeof pane.title === 'string' ? pane.title : '',
      });
    }
    return result;
  }

  async closePane(paneId: string): Promise<boolean> {
    // Fail closed without a session to address: a session-less zellij call
    // would hit whichever session happens to be default.
    if (!this.sessionName) return false;

    const zellij = await this.getBinary();
    return gracefulClosePane(zellij, paneId, {
      ctrlC: [
        ...this.sessionArgs(),
        'action',
        'write',
        '--pane-id',
        paneId,
        '\u0003',
      ],
      close: [
        ...this.sessionArgs(),
        'action',
        'close-pane',
        '--pane-id',
        paneId,
      ],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // No-op for zellij after panes are spawned. Zellij does not support tmux-like
    // exact main pane sizing/rebalancing; layout is applied to future pane
    // creation by mapping configured layouts to pane directions.
  }

  private directionArgs(): string[] {
    return this.paneDirection ? ['--direction', this.paneDirection] : [];
  }

  /**
   * `--session <name>` prefix for every zellij invocation. Empty only in
   * paths that already fail closed before running a command.
   */
  private sessionArgs(): string[] {
    return this.sessionName ? ['--session', this.sessionName] : [];
  }

  private async getParentTabId(zellij: string): Promise<string | null> {
    if (this.parentTabResolved) return this.parentTabId;
    if (!this.parentPaneId) return null;

    const tabId = await this.findTabIdForPane(zellij, this.parentPaneId);
    // Cache only a successful lookup. A failed query is not cached so a
    // transient list-panes failure (e.g. early in the session) is retried on
    // the next spawn instead of being permanently treated as "no parent tab".
    // `current-tab-info` is deliberately not used: it is client-bound and
    // fails from pane child processes.
    if (tabId !== null) {
      this.parentTabId = tabId;
      this.parentTabResolved = true;
    }
    return tabId;
  }

  private async findTabIdForPane(
    zellij: string,
    paneId: string,
  ): Promise<string | null> {
    try {
      const panes = await this.listPanesJson(zellij);
      if (!panes) return null;
      const normalizedPaneId = normalizePaneId(paneId);
      const pane = panes.find(
        (candidate) =>
          !candidate.is_plugin && String(candidate.id) === normalizedPaneId,
      );
      return pane?.tab_id === undefined ? null : String(pane.tab_id);
    } catch {
      return null;
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }
}

function normalizePaneId(paneId: string): string {
  return paneId.replace(/^terminal_/, '');
}

interface ZellijVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Oldest Zellij release the adapter accepts. `new-pane --tab-id` — still used
 * to anchor the child pane to the parent pane's tab — only exists in 0.44.1+;
 * the gate also covers the stable `list-panes --json --tab --all` shape
 * (`tab_id`) the anchor lookup depends on.
 */
const MIN_ZELLIJ_VERSION: ZellijVersion = { major: 0, minor: 44, patch: 1 };

function parseZellijVersion(output: string): ZellijVersion | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function isSupportedZellijVersion(version: ZellijVersion): boolean {
  const min = MIN_ZELLIJ_VERSION;
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

function getPaneDirection(
  layout: MultiplexerLayout,
): ZellijPaneDirection | null {
  switch (layout) {
    case 'main-vertical':
      return 'right';
    case 'main-horizontal':
      return 'down';
    case 'even-horizontal':
    case 'even-vertical':
    case 'tiled':
      return null;
  }
}
