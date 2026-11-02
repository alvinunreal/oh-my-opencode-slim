/**
 * Herdr multiplexer implementation
 *
 * Splits panes for sub-agent sessions in Herdr.
 *
 * Herdr is an agent-aware terminal multiplexer (workspaces → tabs → panes).
 * Pane IDs use the format `w<workspace>:p<pane>`. The CLI outputs
 * newline-delimited JSON; `pane split` returns a `pane_info` result whose
 * `pane.pane_id` field is the new pane's ID.
 *
 * Environment detection: Herdr injects `HERDR_PANE_ID` into every pane it
 * manages; it is the client's anchor and is required for any pane command.
 *
 * Windows: the pane shell is PowerShell, so the viewer command position
 * carries the call operator.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  buildViewCommand,
  findBinary,
  gracefulClosePane,
  normalizePathForShell,
  PANE_VIEWER_ENV,
  type PaneShell,
  redactViewerSecretArgs,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';
import {
  type EqualizeAgentPanesOptions,
  equalizeAgentPanes,
} from './layout-equalize';

type HerdrPaneDirection = 'right' | 'down';
export type LayoutEqualizer = (
  opts: EqualizeAgentPanesOptions,
) => Promise<boolean>;

export interface HerdrMultiplexerOptions {
  /** Injectable equalizer (tests). Defaults to the real socket client. */
  equalizer?: LayoutEqualizer;
  /** Gates equalization and the main-boundary re-assert. Defaults to true. */
  equalizePanes?: boolean;
}

interface HerdrCliResponse {
  result?: {
    type?: string;
    pane?: { pane_id?: string };
  };
  error?: { code?: string; message?: string };
}

export class HerdrMultiplexer implements Multiplexer {
  readonly type = 'herdr' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private layout: MultiplexerLayout;
  private paneDirection: HerdrPaneDirection;
  private stackDirection: HerdrPaneDirection;
  private mainPaneSize: number;
  private agentAreaPaneId: string | null = null;
  private mainPaneId: string | null = null;
  private agentPaneIds = new Set<string>();
  private equalize: LayoutEqualizer;
  private equalizePanes: boolean;
  // Latch: herdr builds without `pane split --ratio` must keep creating panes.
  private ratioSupported = true;
  private loggedMissingEqualizeEnv = false;
  // ponytail: serialize spawnPane to prevent concurrent races on agentAreaPaneId
  private spawnMutex: Promise<unknown> = Promise.resolve();
  // Serializes equalization passes so a close cannot race a spawn.
  private equalizeMutex: Promise<unknown> = Promise.resolve();

  constructor(
    layout: MultiplexerLayout = 'main-vertical',
    mainPaneSize = 60,
    options: HerdrMultiplexerOptions = {},
  ) {
    this.layout = layout;
    this.paneDirection = getPaneDirection(layout);
    this.stackDirection = getStackDirection(layout);
    this.mainPaneSize = mainPaneSize;
    this.equalize = options.equalizer ?? equalizeAgentPanes;
    this.equalizePanes = options.equalizePanes ?? true;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    const configuredBinaryPath = process.env.HERDR_BIN_PATH;
    this.binaryPath =
      configuredBinaryPath && configuredBinaryPath.length > 0
        ? configuredBinaryPath
        : await findBinary('herdr');
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.HERDR_PANE_ID;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    // ponytail: serialize concurrent spawns to prevent races on agentAreaPaneId
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
    // The parent pane is required: without HERDR_PANE_ID the anchor is
    // unknowable, so no herdr command may be issued (no `--current` fallback).
    const parentPaneId = process.env.HERDR_PANE_ID?.trim();
    if (!parentPaneId) {
      log('[herdr] spawnPane: HERDR_PANE_ID is not set; cannot resolve target');
      return { success: false, error: 'not_found' };
    }

    const herdr = await this.getBinary();
    if (!herdr) {
      log('[herdr] spawnPane: herdr binary not found');
      return { success: false, error: 'unavailable' };
    }

    try {
      // Normalize Windows backslashes→/ so sh -lc (MSYS2) doesn't
      // corrupt --cwd (issue #568).
      const attachDir = normalizePathForShell(directory);

      // v2 remote hosts: the viewer must authenticate with
      // OPENCODE_PASSWORD. Inject it at split time through herdr's native
      // `--env` mechanism so it never reaches the `pane run` command text
      // (which herdr types into the pane's shell).
      const viewerSecretArgs = [
        '--env',
        `${PANE_VIEWER_ENV}=1`,
        ...(options?.viewerFlavor === 'v2-remote' &&
        options.viewerPassword !== undefined
          ? ['--env', `OPENCODE_PASSWORD=${options.viewerPassword}`]
          : []),
      ];

      let paneId: string | null = null;
      let lastRawOutput = '';
      let fellBackToParent = false;

      if (this.isMainLayout() && this.agentAreaPaneId) {
        let result = await this.runSplit(
          this.agentAreaPaneId,
          this.stackDirection,
          attachDir,
          false,
          viewerSecretArgs,
        );
        if (!result.paneId) {
          // One retry absorbs transient herdr failures before giving up on
          // the agent area.
          result = await this.runSplit(
            this.agentAreaPaneId,
            this.stackDirection,
            attachDir,
            false,
            viewerSecretArgs,
          );
        }
        paneId = result.paneId;
        if (!paneId) {
          log('[herdr] agent area split failed, falling back to parent', {
            agentAreaPaneId: this.agentAreaPaneId,
          });
          this.agentAreaPaneId = null;
          fellBackToParent = true;
        }
      }

      // A split from the parent creates the agent area, so only this split is
      // sized by main_pane_size; siblings inside the area keep herdr's 50/50
      // default. even-*/tiled never create an agent area, so they carry none.
      // The fallback path never sizes: the previous agent area still occupies
      // space, so sizing again would shrink the main pane twice.
      const sized =
        this.isMainLayout() &&
        this.agentAreaPaneId == null &&
        !fellBackToParent;
      if (!paneId) {
        let result = await this.runSplit(
          parentPaneId,
          this.paneDirection,
          attachDir,
          sized,
          viewerSecretArgs,
        );
        // Herdr builds without `pane split --ratio` reject the unknown flag
        // outright. Retry once unsized and latch, so pane creation keeps
        // working (the main pane then keeps herdr's 50/50).
        if (!result.paneId && sized && this.ratioSupported) {
          // Only a genuine flag rejection means this herdr lacks support;
          // an unrelated failure (transient, pane too small) must not disable
          // sizing for the rest of the process.
          const rejectsRatioFlag =
            result.stderr.includes('--ratio') &&
            /unexpected|unknown|unrecogni[sz]ed|invalid/i.test(result.stderr);
          if (rejectsRatioFlag) {
            this.ratioSupported = false;
            log('[herdr] herdr rejects pane split --ratio; sizing disabled', {
              mainPaneSize: this.mainPaneSize,
              stderr: result.stderr,
            });
          } else {
            log('[herdr] sized split failed; retrying without --ratio', {
              mainPaneSize: this.mainPaneSize,
              stderr: result.stderr,
            });
          }
          result = await this.runSplit(
            parentPaneId,
            this.paneDirection,
            attachDir,
            false,
            viewerSecretArgs,
          );
        }
        paneId = result.paneId;
        lastRawOutput = result.rawOutput;
        if (paneId) {
          this.mainPaneId = parentPaneId;
        }
      }

      if (!paneId) {
        log('[herdr] spawnPane: could not parse pane_id from output', {
          stdout: lastRawOutput,
        });
        return { success: false, error: 'hard' };
      }

      // 2. Rename the pane for visibility. `pane rename` writes the `label`
      // field (evidence 1.4); the description is the FR-8 metadata and must
      // survive intact, so it is never truncated.
      await crossSpawn([herdr, 'pane', 'rename', paneId, description], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      // 3. Run opencode attach in the new pane. `pane run` types the text into
      //    the pane's own shell.
      //    shortcut: a non-PowerShell `default_shell` is not covered, upgrade
      //    when herdr exposes the pane's shell.
      const shell: PaneShell =
        process.platform === 'win32' ? 'powershell' : 'posix';
      const opencodeCmd = buildViewCommand(sessionId, serverUrl, attachDir, {
        ...options,
        shell,
      });

      const runProc = crossSpawn([herdr, 'pane', 'run', paneId, opencodeCmd], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const runExitCode = await runProc.exited;
      if (runExitCode !== 0) {
        const runStderr = await runProc.stderr();
        const runStdout = await runProc.stdout();
        log('[herdr] spawnPane: run failed', {
          command: opencodeCmd,
          exitCode: runExitCode,
          stdout: runStdout.trim(),
          stderr: runStderr.trim(),
        });
        // ponytail: split succeeded but attach failed; close the orphaned pane
        // so it does not linger in the agent area. Session manager gets no
        // paneId on failure, so we must clean it up here.
        try {
          // Already inside the spawn mutex: use the unlocked variant.
          await this.closePaneInner(paneId);
        } catch (closeErr) {
          log('[herdr] spawnPane: failed to close orphaned pane', {
            paneId,
            error: String(closeErr),
          });
        }
        return { success: false, error: 'hard' };
      }

      // 4. Track agent area pane ID only after successful attach
      if (this.isMainLayout() && !this.agentAreaPaneId) {
        this.agentAreaPaneId = paneId;
      }
      this.agentPaneIds.add(paneId);

      // 5. Even out the agent area only; the main pane keeps its share.
      await this.equalizeAgentArea();

      log('[herdr] spawnPane: SUCCESS', { paneId });
      return { success: true, paneId };
    } catch (err) {
      log('[herdr] spawnPane: exception', { error: String(err) });
      return { success: false, error: 'hard' };
    }
  }

  /**
   * FR-8 sweep capability: every pane herdr knows about, with its `label`
   * (the field `pane rename` writes). Titles that are not plugin metadata are
   * ignored by the sweep.
   */
  async listPanesWithTitles(): Promise<
    Array<{ paneId: string; title: string }>
  > {
    const herdr = await this.getBinary();
    if (!herdr) return [];

    try {
      const proc = crossSpawn([herdr, 'pane', 'list'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        proc.stdout(),
      ]);
      if (exitCode !== 0) return [];

      const panes: Array<{ paneId: string; title: string }> = [];
      for (const line of stdout.split('\n')) {
        const candidate = line.trim();
        if (!candidate) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue; // progress/diagnostic line
        }
        const result = isRecord(parsed) ? parsed.result : undefined;
        const entries =
          isRecord(result) && Array.isArray(result.panes) ? result.panes : [];
        for (const entry of entries) {
          if (!isRecord(entry)) continue;
          const paneId = entry.pane_id;
          if (typeof paneId !== 'string' || paneId.length === 0) continue;
          panes.push({
            paneId,
            title: typeof entry.label === 'string' ? entry.label : '',
          });
        }
      }
      return panes;
    } catch {
      return [];
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    // Serialize with spawn: a close must not collapse a branch between another
    // pass's export and its path-based ratio writes.
    const prev = this.spawnMutex;
    let release!: () => void;
    this.spawnMutex = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await this.closePaneInner(paneId);
    } finally {
      release();
    }
  }

  private async closePaneInner(paneId: string): Promise<boolean> {
    const herdr = await this.getBinary();
    const closed = await gracefulClosePane(herdr, paneId, {
      ctrlC: ['pane', 'send-keys', paneId, 'ctrl+c'],
      close: ['pane', 'close', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
    if (!closed) return false;

    if (paneId === this.agentAreaPaneId) {
      this.agentAreaPaneId = null;
    }
    // Only panes this client spawned live in this set; a sweep-closed
    // leftover must not trigger a rebalance of somebody else's layout.
    const wasAgentPane = this.agentPaneIds.delete(paneId);
    if (wasAgentPane) {
      await this.equalizeAgentArea();
    }
    return true;
  }

  private isMainLayout(): boolean {
    return this.layout === 'main-vertical' || this.layout === 'main-horizontal';
  }

  private async runSplit(
    target: string,
    direction: HerdrPaneDirection,
    directory: string,
    sized: boolean,
    viewerSecretArgs: string[] = [],
  ): Promise<{ paneId: string | null; rawOutput: string; stderr: string }> {
    const herdr = await this.getBinary();
    if (!herdr) return { paneId: null, rawOutput: '', stderr: '' };

    const splitArgs = [
      herdr,
      'pane',
      'split',
      target,
      '--direction',
      direction,
      '--cwd',
      directory,
      '--no-focus',
      ...(sized && this.ratioSupported
        ? ['--ratio', String(agentPaneRatio(this.mainPaneSize))]
        : []),
      ...viewerSecretArgs,
    ];

    log('[herdr] spawnPane: splitting pane', {
      args: redactViewerSecretArgs(splitArgs),
    });

    const splitProc = crossSpawn(splitArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const splitExitCode = await splitProc.exited;
    const splitStdout = await splitProc.stdout();
    const splitStderr = await splitProc.stderr();

    if (splitExitCode !== 0) {
      log('[herdr] spawnPane: split failed', {
        exitCode: splitExitCode,
        stderr: splitStderr.trim(),
      });
      return {
        paneId: null,
        rawOutput: splitStdout.trim(),
        stderr: splitStderr.trim(),
      };
    }

    return {
      paneId: parsePaneId(splitStdout),
      rawOutput: splitStdout.trim(),
      stderr: '',
    };
  }

  /**
   * Best-effort re-equalization of the agent panes. It never changes the
   * spawn/close result: missing context is skipped silently and any failure
   * is logged only. `multiplexer.equalize_panes: false` disables the step
   * before any environment or socket access.
   */
  private async equalizeAgentArea(): Promise<void> {
    // even-*/tiled have no agent area and no main_pane_size share, so
    // correcting them would turn their even split into an 80/20 one.
    if (!this.equalizePanes || !this.isMainLayout()) return;

    const mainPaneId = this.mainPaneId;
    const tabId = process.env.HERDR_TAB_ID?.trim();
    const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
    if (!mainPaneId || !tabId || !socketPath) {
      if (!this.loggedMissingEqualizeEnv) {
        this.loggedMissingEqualizeEnv = true;
        log('[herdr] equalization skipped: herdr pane environment missing', {
          hasMainPaneId: mainPaneId !== null,
          hasTabId: Boolean(tabId),
          hasSocketPath: Boolean(socketPath),
        });
      }
      return;
    }

    // A close-time pass must not interleave with a spawn-time pass: each
    // computes paths from its own export, so a later write could apply stale
    // ratios.
    const prev = this.equalizeMutex;
    let release!: () => void;
    this.equalizeMutex = new Promise<void>((r) => (release = r));
    await prev;

    try {
      await this.equalize({
        socketPath,
        tabId,
        mainPaneId,
        mainPaneShare: this.mainPaneSize / 100,
        agentPaneIds: this.agentPaneIds,
        onPanesSeen: (paneIds) => {
          for (const id of this.agentPaneIds) {
            if (!paneIds.has(id)) this.agentPaneIds.delete(id);
          }
        },
      });
    } catch (error) {
      log('[herdr] equalizeAgentPanes: unexpected failure', {
        error: String(error),
      });
    } finally {
      release();
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }
}

/**
 * Parse the pane_id from a herdr CLI JSON response.
 *
 * Herdr outputs newline-delimited JSON like:
 * {"id":"cli:pane:split","result":{"type":"pane_info","pane":{"pane_id":"w1:p2",...}}}
 */
function parsePaneId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const response = JSON.parse(candidate) as HerdrCliResponse;
      const paneId = response.result?.pane?.pane_id;
      if (paneId) return paneId;
    } catch {
      // Not a JSON line (e.g. progress/diagnostic); skip and keep scanning.
    }
  }

  log('[herdr] parsePaneId: no pane_id found in output', { stdout: trimmed });
  return null;
}

function getPaneDirection(layout: MultiplexerLayout): HerdrPaneDirection {
  switch (layout) {
    case 'main-horizontal':
    case 'even-vertical':
      return 'down';
    case 'main-vertical':
    case 'even-horizontal':
    case 'tiled':
      return 'right';
  }
}

/**
 * Direction later children stack inside the agent area. Only the `main-*`
 * layouts create one: below for `main-vertical`, to the right for
 * `main-horizontal` (mirroring the WezTerm agent row).
 */
function getStackDirection(layout: MultiplexerLayout): HerdrPaneDirection {
  return layout === 'main-vertical' ? 'down' : 'right';
}

/**
 * Herdr's `--ratio` is the fraction RETAINED BY THE ANCHOR pane: splitting an
 * anchor with `--ratio 0.8` leaves the anchor at 80% and gives the new pane
 * the remaining 20% (verified against herdr 0.2.x `pane layout` geometry).
 * `main_pane_size` describes that anchor (the main pane), so it maps directly.
 * Clamped to 0.2–0.8 so a hand-edited config can never make either side
 * unusable.
 */
function agentPaneRatio(mainPaneSize: number): number {
  return Math.max(0.2, Math.min(0.8, mainPaneSize / 100));
}
