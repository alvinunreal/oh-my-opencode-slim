/**
 * Zellij multiplexer implementation
 *
 * Creates panes for sub-agent sessions in Zellij.
 *
 * Requires Zellij >= 0.44.1: `isAvailable()` parses `zellij --version` and
 * rejects older releases whose CLI lacks the stable pane-id targeting used
 * here (`rename-pane <name> -p <paneId>`, `write-chars <chars> -p <paneId>`,
 * `list-panes --json --tab --all` with stable `tab_id`, and
 * `new-pane --tab-id` for cross-tab targeting; `--tab-id` only exists in
 * 0.44.1+). No `focus-pane` or `current-tab-info` calls are made — the former
 * is invalid CLI syntax and the latter is client-bound and fails from pane
 * child processes.
 *
 * The default mode creates a dedicated "opencode-agents" tab:
 * - First sub-agent uses the default pane from new-tab
 * - Subsequent sub-agents create new panes
 * - User stays in their original tab (resolved from the parent pane's
 *   ZELLIJ_PANE_ID via list-panes)
 *
 * The optional "current-tab" mode creates panes in the tab containing the
 * parent OpenCode pane instead.
 */

import type { MultiplexerLayout, ZellijPaneMode } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import {
  buildOpencodeAttachCommand,
  findBinary,
  gracefulClosePane,
  quoteShellArg,
} from '../shared';
import type { Multiplexer, PaneResult } from '../types';

interface ZellijTabInfo {
  position: number;
  name: string;
  active: boolean;
  tab_id: number;
}

interface ZellijPaneInfo {
  id: number;
  is_plugin: boolean;
  tab_id?: number;
}

type ZellijPaneDirection = 'right' | 'down';

export class ZellijMultiplexer implements Multiplexer {
  readonly type = 'zellij' as const;

  private binaryPath: string | null = null;
  private availabilityPromise: Promise<boolean> | null = null;
  private agentTabId: string | null = null;
  private firstPaneId: string | null = null;
  private firstPaneUsed = false;
  private parentTabId: string | null = null;
  private parentTabResolved = false;
  private readonly parentPaneId = process.env.ZELLIJ_PANE_ID;
  private readonly paneDirection: ZellijPaneDirection | null;
  /**
   * Serializes pane-creation sequences that may switch Zellij tabs or move
   * client focus (new-tab, go-to-tab-by-id, new-pane). Concurrent spawns are
   * chained so a cross-tab create cannot race another create's focus restore.
   * Read-only queries (list-panes/list-tabs) never go through this queue.
   */
  private paneOpsChain: Promise<void> = Promise.resolve();

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    mainPaneSize = 60,
    private readonly paneMode: ZellijPaneMode = 'agent-tab',
  ) {
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
   * stable pane-id targeting that only exists in Zellij >= 0.44.1; older
   * releases (or unparsable version output) make the backend unavailable.
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
    return !!process.env.ZELLIJ;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    // The tab/focus-mutating creation sequence is queued so concurrent
    // spawnPane calls cannot interleave (e.g. a cross-tab new-pane racing
    // another create's focus restore). Binary discovery and availability
    // probing happen inside the unlocked body too, which is fine: they are
    // cached after the first call.
    const run = this.paneOpsChain.then(() =>
      this.spawnPaneUnlocked(sessionId, description, serverUrl, directory),
    );
    this.paneOpsChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async spawnPaneUnlocked(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const zellij = await this.getBinary();
    if (!zellij) return { success: false };

    try {
      if (this.paneMode === 'current-tab') {
        return await this.createPaneInCurrentTab(
          zellij,
          sessionId,
          serverUrl,
          directory,
          description,
        );
      }

      // Ensure agent tab exists on first call
      if (!this.agentTabId) {
        const result = await this.ensureAgentTab(zellij);
        if (!result) return { success: false };
        this.agentTabId = result.tabId;
        this.firstPaneId = result.firstPaneId;
      }

      // Use the default pane from new-tab for the first sub-agent
      if (!this.firstPaneUsed && this.firstPaneId) {
        const success = await this.runInPane(
          zellij,
          this.firstPaneId,
          sessionId,
          serverUrl,
          directory,
          description,
        );
        if (success) {
          this.firstPaneUsed = true;
          return { success: true, paneId: this.firstPaneId };
        }
        // Reuse failed — don't keep retrying a known-bad pane
        this.firstPaneUsed = true;
        // fall through to createPaneInAgentTab on failure
      }

      // Create additional pane
      return await this.createPaneInAgentTab(
        zellij,
        sessionId,
        serverUrl,
        directory,
        description,
      );
    } catch {
      return { success: false };
    }
  }

  private async createPaneInCurrentTab(
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
    const paneName = description.slice(0, 30).replace(/"/g, '\\"');
    const targetTabId = await this.getParentTabId(zellij);

    return this.runNewPaneWithFallback(zellij, paneName, opencodeCmd, {
      tabIdArgs: this.tabIdArgs(targetTabId),
    });
  }

  /**
   * Run `new-pane`, retrying once without the direction hint on failure.
   *
   * Zellij silently drops a `--direction` split once a tab is crowded (exit
   * code 0 but no `terminal_*` id on stdout), so a failed directed create is
   * retried without `--direction`, which lets Zellij place the pane in the
   * largest free space. The retry keeps `--name`, `--close-on-exit`, and the
   * command part — only the direction hint is dropped. Two failures (or one
   * failure with no direction configured) report `{ success: false }`.
   */
  private async runNewPaneWithFallback(
    zellij: string,
    paneName: string,
    opencodeCmd: string,
    opts: { tabIdArgs: string[] },
  ): Promise<PaneResult> {
    const direction = this.directionArgs();
    const runOnce = async (directionArgs: string[]): Promise<PaneResult> => {
      const args = [
        'action',
        'new-pane',
        ...opts.tabIdArgs,
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
      log('[zellij] new-pane failed', {
        command: opencodeCmd,
        exitCode,
        stdout: stdout.trim(),
        stderr: (await proc.stderr()).trim(),
      });
      return { success: false };
    };

    const first = await runOnce(direction);
    if (first.success) return first;
    // Retry only when a direction was actually applied; an undirected create
    // already uses Zellij's free-space placement and would just repeat.
    if (direction.length === 0) return first;
    return runOnce([]);
  }

  private async createPaneInAgentTab(
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
    const paneName = description.slice(0, 30).replace(/"/g, '\\"');

    const parentTabId = await this.getParentTabId(zellij);
    const inAgentTab = parentTabId === this.agentTabId;

    if (inAgentTab) {
      // Already in agent tab, create pane directly
      return this.runNewPaneWithFallback(zellij, paneName, opencodeCmd, {
        tabIdArgs: [],
      });
    }

    if (!this.agentTabId) {
      return { success: false };
    }

    // Switch to agent tab
    await crossSpawn([zellij, 'action', 'go-to-tab-by-id', this.agentTabId], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;

    // Create pane
    const result = await this.runNewPaneWithFallback(
      zellij,
      paneName,
      opencodeCmd,
      { tabIdArgs: [] },
    );

    // Switch back to the parent tab (the tab containing the OpenCode pane
    // that spawned the sub-agent, resolved via ZELLIJ_PANE_ID). If the parent
    // tab could not be located, leave focus in the agent tab rather than
    // guessing.
    if (parentTabId) {
      await crossSpawn(
        [zellij, 'action', 'go-to-tab-by-id', String(parentTabId)],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ).exited;
    }

    return result;
  }

  private async runInPane(
    zellij: string,
    paneId: string,
    sessionId: string,
    serverUrl: string,
    directory: string,
    description: string,
  ): Promise<boolean> {
    try {
      const opencodeCmd = buildOpencodeAttachCommand(
        sessionId,
        serverUrl,
        directory,
      );

      // Rename is best-effort cosmetics: a rename failure must not mask a
      // failing attach write, so its exit code is intentionally ignored.
      const renameProc = crossSpawn(
        [
          zellij,
          'action',
          'rename-pane',
          description.slice(0, 30),
          '-p',
          paneId,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      await renameProc.exited;

      const writeCmdProc = crossSpawn(
        [
          zellij,
          'action',
          'write-chars',
          buildShellLaunchCommand(opencodeCmd),
          '-p',
          paneId,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if ((await writeCmdProc.exited) !== 0) return false;

      const writeNewlineProc = crossSpawn(
        [zellij, 'action', 'write-chars', '\n', '-p', paneId],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if ((await writeNewlineProc.exited) !== 0) return false;

      return true;
    } catch {
      return false;
    }
  }

  private async ensureAgentTab(
    zellij: string,
  ): Promise<{ tabId: string; firstPaneId: string | null } | null> {
    try {
      // Try to find existing tab
      const existingTab = await this.findTabByName(zellij, 'opencode-agents');
      if (existingTab) {
        const firstPane = await this.getFirstPaneInTab(
          zellij,
          existingTab.tabId,
        );
        return {
          tabId: existingTab.tabId,
          firstPaneId: firstPane,
        };
      }

      // Create new tab
      const createProc = crossSpawn(
        [zellij, 'action', 'new-tab', '--name', 'opencode-agents'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const createExit = await createProc.exited;
      if (createExit !== 0) return null;

      // Get the new tab info
      const newTab = await this.findTabByName(zellij, 'opencode-agents');
      if (!newTab) return null;

      // Get the default pane in the new tab
      const firstPane = await this.getFirstPaneInTab(zellij, newTab.tabId);

      // `new-tab` moves the attached client's focus to the new tab. Restore
      // the parent tab (resolved via ZELLIJ_PANE_ID) so the user stays where
      // they were, mirroring the restore done after pane creation. If the
      // parent tab cannot be located, leave focus in the agent tab rather
      // than guessing.
      const parentTabId = await this.getParentTabId(zellij);
      if (parentTabId) {
        await crossSpawn(
          [zellij, 'action', 'go-to-tab-by-id', String(parentTabId)],
          {
            stdout: 'ignore',
            stderr: 'ignore',
          },
        ).exited;
      }

      return { tabId: newTab.tabId, firstPaneId: firstPane };
    } catch {
      return null;
    }
  }

  private async listPanesJson(
    zellij: string,
  ): Promise<ZellijPaneInfo[] | null> {
    try {
      const proc = crossSpawn(
        [zellij, 'action', 'list-panes', '--json', '--tab', '--all'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if ((await proc.exited) !== 0) return null;
      const stdout = await proc.stdout();
      return JSON.parse(stdout) as ZellijPaneInfo[];
    } catch {
      return null;
    }
  }

  private async getFirstPaneInTab(
    zellij: string,
    tabId: string,
  ): Promise<string | null> {
    try {
      const panes = await this.listPanesJson(zellij);
      if (!panes) return null;
      const pane = panes.find(
        (candidate) =>
          !candidate.is_plugin && candidate.tab_id === Number(tabId),
      );
      return pane ? `terminal_${pane.id}` : null;
    } catch {
      return null;
    }
  }

  private async findTabByName(
    zellij: string,
    name: string,
  ): Promise<{ tabId: string; name: string } | null> {
    try {
      const proc = crossSpawn([zellij, 'action', 'list-tabs', '--json'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) return this.findTabByNameText(zellij, name);

      const stdout = await proc.stdout();

      try {
        const tabs: ZellijTabInfo[] = JSON.parse(stdout);
        for (const tab of tabs) {
          if (tab.name === name) {
            return { tabId: String(tab.tab_id), name: tab.name };
          }
        }
      } catch {
        return this.findTabByNameText(zellij, name);
      }
      return null;
    } catch {
      return null;
    }
  }

  private async findTabByNameText(
    zellij: string,
    name: string,
  ): Promise<{ tabId: string; name: string } | null> {
    try {
      const proc = crossSpawn([zellij, 'action', 'list-tabs'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;

      const stdout = await proc.stdout();
      const lines = stdout.split('\n');

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[2] === name) {
          return { tabId: parts[0], name: parts[2] };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    const zellij = await this.getBinary();
    return gracefulClosePane(zellij, paneId, {
      ctrlC: ['action', 'write', '--pane-id', paneId, '\u0003'],
      close: ['action', 'close-pane', '--pane-id', paneId],
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

  private tabIdArgs(tabId: string | null): string[] {
    return tabId ? ['--tab-id', tabId] : [];
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
 * Oldest Zellij release with the stable pane-id targeting this adapter relies
 * on (`rename-pane <name> -p <paneId>`, `write-chars <chars> -p <paneId>`,
 * `list-panes --json --tab --all` with stable `tab_id`, and
 * `new-pane --tab-id` for cross-tab creation, which only exists in 0.44.1+).
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

function buildShellLaunchCommand(command: string): string {
  return ['sh', '-lc', quoteShellArg(command)].join(' ');
}
