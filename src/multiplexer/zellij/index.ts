/**
 * Zellij multiplexer implementation
 *
 * Creates panes for sub-agent sessions in Zellij, from inside the client
 * process that displays the parent OpenCode session.
 *
 * The parent pane and tab are resolved from `ZELLIJ_PANE_ID` via
 * `list-panes --json`. Zellij 0.45+ can open unfocused viewers. For
 * main-vertical it splits a specific pane by setting the CLI process's
 * `ZELLIJ_PANE_ID`; other placements still use `new-pane --tab-id`.
 *
 * Multi-instance hardening: every zellij invocation is explicitly addressed
 * with `--session <ZELLIJ_SESSION_NAME>` (placed before `action`), so a
 * machine running several zellij sessions cannot route commands to the wrong
 * one. When the client environment cannot resolve the anchor
 * (`ZELLIJ_PANE_ID` or `ZELLIJ_SESSION_NAME` missing, or the parent lookup
 * failing), no create command is issued and the spawn fails with `not_found`.
 *
 * Version gate: `isAvailable()` parses `zellij --version` and rejects
 * releases older than 0.44.1, whose CLI lacks `new-pane --tab-id` — still
 * required to anchor the create to the parent pane's tab — and whose
 * `list-panes --json --tab --all` output does not carry the stable `tab_id`
 * the anchor lookup depends on.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildViewCommand,
  closePaneCommand,
  findBinary,
  gracefulClosePane,
  markViewerCommand,
  viewerNeedsPaneCwd,
  withParentEnvPassword,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';

interface ZellijPaneInfo {
  id: number;
  is_plugin: boolean;
  tab_id?: number;
  /** Pane title (`--all` field); carries the FR-8 metadata when ours. */
  title?: string;
  is_floating: boolean;
  is_suppressed: boolean;
  is_collapsed: boolean;
  exited: boolean;
  pane_x: number;
  pane_y: number;
  pane_columns: number;
  pane_rows: number;
}

type ZellijPaneDirection = 'right' | 'down';
type ZellijPaneTarget = { tabId: string } | { paneId: number };

/**
 * One structured diagnostic per process for the viewer-secret bridge gate:
 * the gate fails closed on hosts where the password cannot be injected
 * without exposing it in command text or argv.
 */
let viewerSecretGateLogged = false;

function logViewerSecretGateFailure(reason: string): void {
  if (viewerSecretGateLogged) return;
  viewerSecretGateLogged = true;
  log('[zellij] spawnPane: viewer password bridge unavailable', {
    stage: 'viewer-secret',
    reason,
    platform: process.platform,
  });
}

export class ZellijMultiplexer implements Multiplexer {
  readonly type = 'zellij' as const;

  private binaryPath: string | null = null;
  private availabilityPromise: Promise<boolean> | null = null;
  private parentTabId: string | null = null;
  private parentTabResolved = false;
  private readonly parentPaneId = process.env.ZELLIJ_PANE_ID;
  private readonly sessionName = process.env.ZELLIJ_SESSION_NAME;
  private readonly paneDirection: ZellijPaneDirection | null;
  private readonly mainPaneSize: number;
  private supportsNoFocus = false;
  private requiresFloatingLayerCheck = false;
  private readonly mainVerticalPaneIds = new Set<number>();
  private mainVerticalMutex = Promise.resolve();

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.paneDirection = getPaneDirection(layout);
    this.mainPaneSize = mainPaneSize;
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
    const version = binaryPath ? await this.readVersion(binaryPath) : null;
    if (binaryPath && version && isSupportedZellijVersion(version)) {
      this.binaryPath = binaryPath;
      this.supportsNoFocus = version.major > 0 || version.minor >= 45;
      this.requiresFloatingLayerCheck =
        version.major === 0 && version.minor === 45;
      return true;
    }
    this.binaryPath = null;
    return false;
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
    options?: PaneSpawnOptions,
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
        options,
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
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // v2 remote hosts: the viewer must authenticate with
    // OPENCODE_PASSWORD. Zellij's `new-pane` has no env flag, so the pane
    // script reads the secret from this process's own /proc environ
    // (`withParentEnvPassword`). That bridge is Linux-only: anywhere else no
    // pane is created rather than exposing the secret.
    const needsSecretBridge =
      options?.viewerFlavor === 'v2-remote' &&
      options.viewerPassword !== undefined;
    if (needsSecretBridge && process.platform !== 'linux') {
      logViewerSecretGateFailure('password-bridge-requires-linux');
      return { success: false, error: 'unavailable' };
    }

    const viewerCommand = markViewerCommand(
      buildViewCommand(sessionId, serverUrl, directory, options),
      '/bin/sh',
    );
    const opencodeCmd = needsSecretBridge
      ? withParentEnvPassword(viewerCommand)
      : viewerCommand;
    // The name doubles as the pane title; the description is the FR-8
    // metadata (owner pid + child session id) and must survive intact.
    const paneName = description.replace(/"/g, '\\"');
    // v2 mini omits the directory, so the pane pins the child session's
    // project directory itself (`new-pane --cwd`; the adapter already gates
    // on MIN_ZELLIJ_VERSION, which supports the flag).
    const miniCwdArgs = viewerNeedsPaneCwd(options) ? ['--cwd', directory] : [];
    const viewerArgs = [
      '--name',
      paneName,
      '--close-on-exit',
      ...miniCwdArgs,
      '--',
      'sh',
      '-lc',
      opencodeCmd,
    ];

    if (this.supportsNoFocus && this.paneDirection === 'right') {
      // Serialize only the placement that depends on live ownership/geometry.
      const previous = this.mainVerticalMutex;
      let release!: () => void;
      this.mainVerticalMutex = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await this.createMainVerticalPane(zellij, viewerArgs);
      } finally {
        release();
      }
    }

    const targetTabId = await this.getParentTabId(zellij);

    // The parent tab is the anchor: without it there is no same-tab target,
    // so no pane is created rather than falling back to the focused tab.
    if (!targetTabId) return { success: false, error: 'not_found' };

    const target = { tabId: targetTabId };
    const first = await this.runNewPane(
      zellij,
      target,
      viewerArgs,
      this.paneDirection,
    );
    // Native placement for other layouts and legacy Zellij: a crowded tab
    // may silently drop a directed split, so retry once without the hint.
    if (first.success || !this.paneDirection) return first;
    return this.runNewPane(zellij, target, viewerArgs);
  }

  private async createMainVerticalPane(
    zellij: string,
    viewerArgs: string[],
  ): Promise<PaneResult> {
    const panes = await this.listPanesJson(zellij);
    const parentId = normalizePaneId(this.parentPaneId ?? '');
    const parent = panes?.find(
      (pane) => isLiveTile(pane) && String(pane.id) === parentId,
    );
    if (!panes || parent?.tab_id === undefined) {
      return { success: false, error: 'not_found' };
    }

    const terminals = panes.filter((pane) => !pane.is_plugin && !pane.exited);
    for (const id of this.mainVerticalPaneIds) {
      if (!terminals.some((pane) => pane.id === id)) {
        this.mainVerticalPaneIds.delete(id);
      }
    }
    // Split the tallest owned tile in the right column, not the last pane
    // blindly: that pane may have closed, moved or become too short.
    const stackOn = terminals
      .filter(
        (pane) =>
          this.mainVerticalPaneIds.has(pane.id) && isRightTile(parent, pane),
      )
      .sort((a, b) => b.pane_rows - a.pane_rows)[0];
    if (!stackOn && this.mainVerticalPaneIds.size > 0) {
      return { success: false, error: 'invalid_state' };
    }
    // Zellij 0.45 can start an unlisted PTY when the floating layer is
    // visible, before it rejects this tiled split. Only create with proof
    // that the parent tab's floating layer is hidden.
    if (
      this.requiresFloatingLayerCheck &&
      !(await this.isFloatingLayerHidden(zellij, parent.tab_id))
    ) {
      return { success: false, error: 'invalid_state' };
    }

    const result = await this.runNewPane(
      zellij,
      { paneId: (stackOn ?? parent).id },
      viewerArgs,
      stackOn ? 'down' : 'right',
    );
    if (!result.success || !result.paneId) return result;
    const childId = Number(normalizePaneId(result.paneId));
    if (panes.some((pane) => !pane.is_plugin && pane.id === childId)) {
      return { success: false, error: 'hard' };
    }
    this.mainVerticalPaneIds.add(childId);
    if (!stackOn) {
      // Sizing is best-effort after creation; the caller still needs the
      // pane handle for the normal viewer lifecycle if resizing fails.
      await this.sizeMainPane(zellij, parent, childId).catch(
        (error: unknown) => {
          log('[zellij] spawnPane: resize failed', { error });
        },
      );
    }

    // A successful CLI action can report a pane that never appears or put
    // it in a native stack. Do not confuse a failed read with either case.
    const readPlacement = async (): Promise<
      'unknown' | 'absent' | 'exited' | 'misplaced' | 'live'
    > => {
      const current = await this.listPanesJson(zellij);
      if (!current) return 'unknown';
      const child = current.find(
        (pane) => !pane.is_plugin && pane.id === childId,
      );
      if (!child) return 'absent';
      if (child.exited) return 'exited';
      const main = current.find(
        (pane) => !pane.is_plugin && !pane.exited && pane.id === parent.id,
      );
      return main &&
        main.pane_columns > 0 &&
        child.pane_columns > 0 &&
        !isRightTile(main, child)
        ? 'misplaced'
        : 'live';
    };
    const observePlacement = async () => {
      let previous: 'absent' | 'misplaced' | undefined;
      for (let i = 0; i < 3; i++) {
        const placement = await readPlacement();
        if (placement !== 'absent' && placement !== 'misplaced')
          return placement;
        if (placement === previous) return placement;
        previous = placement;
      }
      return 'unknown';
    };
    let placement = await observePlacement();
    const misplaced = placement === 'misplaced';
    let closeSucceeded = false;
    if (misplaced) {
      // Only close a listed viewer; Zellij 0.45 cannot reap unlisted PTYs
      // this way. Require exit 0 since exit 1 can mean transport failure.
      closeSucceeded = await closePaneCommand(zellij, {
        close: [
          ...this.sessionArgs(),
          'action',
          'close-pane',
          '--pane-id',
          result.paneId,
        ],
      });
      placement = await observePlacement();
    }
    if (placement === 'absent' || placement === 'exited') {
      this.mainVerticalPaneIds.delete(childId);
      return {
        success: false,
        error: misplaced ? 'invalid_state' : 'hard',
        ...(placement === 'absent' && !closeSucceeded
          ? { creationUncertain: true }
          : {}),
      };
    }
    if (misplaced) {
      // Keep the handle for the normal pane lifecycle to close later.
      log('[zellij] spawnPane: misplaced viewer rollback not confirmed', {
        paneId: result.paneId,
      });
    }
    return result;
  }

  private async sizeMainPane(
    zellij: string,
    original: ZellijPaneInfo,
    childId: number,
  ): Promise<void> {
    const rightEdge = original.pane_x + original.pane_columns;
    const desired = (original.pane_columns * this.mainPaneSize) / 100;
    const readWidth = async (): Promise<number | null> => {
      const panes = await this.listPanesJson(zellij);
      const parent = panes?.find(
        (pane) => pane.id === original.id && isLiveTile(pane),
      );
      const child = panes?.find(
        (pane) => pane.id === childId && isLiveTile(pane),
      );
      // Only resize the boundary we just created, never a replacement pane
      // or a different boundary after a manual close or rearrangement.
      if (
        !parent ||
        !child ||
        parent.tab_id !== original.tab_id ||
        parent.pane_x !== original.pane_x ||
        parent.pane_y !== original.pane_y ||
        parent.pane_rows !== original.pane_rows ||
        !isRightTile(parent, child) ||
        child.pane_rows !== parent.pane_rows ||
        child.pane_x + child.pane_columns !== rightEdge
      ) {
        return null;
      }
      return parent.pane_columns;
    };

    const resize = async (growMain: boolean): Promise<boolean> => {
      // Grow the narrower side into the shared boundary; `decrease` can
      // change the layout to a stack instead of moving that boundary.
      const proc = crossSpawn(
        [
          zellij,
          ...this.sessionArgs(),
          'action',
          'resize',
          '--pane-id',
          `terminal_${growMain ? original.id : childId}`,
          'increase',
          growMain ? 'right' : 'left',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const exitCode = await proc.exited;
      if (exitCode === 0) return true;
      log('[zellij] spawnPane: resize failed', {
        exitCode,
        stderr: (await proc.stderr()).trim(),
      });
      return false;
    };

    let width = (await readWidth()) ?? (await readWidth());
    // Zellij moves the boundary in steps (normally five percentage points).
    // Stop at a no-op or after crossing the desired width, undoing the last
    // step only if the previous width was closer (or equally close).
    for (let i = 0; width !== null && width !== desired && i < 20; i++) {
      const growMain = width < desired;
      if (!(await resize(growMain))) return;
      let next = await readWidth();
      if (next === null || next === width) next = await readWidth();
      if (next === null || (growMain ? next <= width : next >= width)) return;
      if (growMain ? next >= desired : next <= desired) {
        if (
          Math.abs(next - desired) >= Math.abs(width - desired) &&
          (await resize(!growMain)) &&
          (await readWidth()) !== width &&
          (await readWidth()) !== width
        ) {
          log(
            '[zellij] spawnPane: resize restore did not reach previous width',
            {
              paneId: original.id,
              width,
            },
          );
        }
        return;
      }
      width = next;
    }
  }

  private async runNewPane(
    zellij: string,
    target: ZellijPaneTarget,
    viewerArgs: string[],
    direction: ZellijPaneDirection | null = null,
  ): Promise<PaneResult> {
    const args = [
      ...this.sessionArgs(),
      'action',
      'new-pane',
      ...('tabId' in target ? ['--tab-id', target.tabId] : []),
      ...(this.supportsNoFocus ? ['--no-focus'] : []),
      ...(direction ? ['--direction', direction] : []),
      ...viewerArgs,
    ];
    const proc = crossSpawn([zellij, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      // --tab-id takes precedence over the pane environment anchor;
      // --pane-id on new-pane would replace the pane rather than split it.
      env:
        'paneId' in target
          ? { ...process.env, ZELLIJ_PANE_ID: String(target.paneId) }
          : undefined,
    });

    const exitCode = await proc.exited;
    const paneId = (await proc.stdout()).trim();
    if (exitCode === 0 && /^terminal_\d+$/.test(paneId)) {
      return { success: true, paneId };
    }
    log('[zellij] spawnPane: new-pane failed', {
      command: viewerArgs.at(-1),
      exitCode,
      stdout: paneId,
      stderr: (await proc.stderr()).trim(),
    });
    return { success: false, error: 'hard' };
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
      const panes = JSON.parse(stdout) as ZellijPaneInfo[];
      return Array.isArray(panes) ? panes : null;
    } catch {
      return null;
    }
  }

  private async isFloatingLayerHidden(
    zellij: string,
    tabId: number,
  ): Promise<boolean> {
    try {
      const proc = crossSpawn(
        [
          zellij,
          ...this.sessionArgs(),
          'action',
          'list-tabs',
          '--json',
          '--state',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if ((await proc.exited) !== 0) return false;
      const tabs = JSON.parse(await proc.stdout()) as Array<{
        tab_id: number;
        are_floating_panes_visible?: boolean;
      }>;
      return (
        Array.isArray(tabs) &&
        tabs.find((tab) => tab.tab_id === tabId)?.are_floating_panes_visible ===
          false
      );
    } catch {
      return false;
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

function isLiveTile(pane: ZellijPaneInfo): boolean {
  return (
    !pane.is_plugin &&
    !pane.is_floating &&
    !pane.is_suppressed &&
    !pane.is_collapsed &&
    !pane.exited &&
    pane.pane_columns > 0 &&
    pane.pane_rows > 0
  );
}

function isRightTile(parent: ZellijPaneInfo, pane: ZellijPaneInfo): boolean {
  return (
    isLiveTile(pane) &&
    pane.tab_id === parent.tab_id &&
    pane.pane_x === parent.pane_x + parent.pane_columns &&
    pane.pane_y >= parent.pane_y &&
    pane.pane_y + pane.pane_rows <= parent.pane_y + parent.pane_rows
  );
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
