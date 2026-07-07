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
 * Environment detection: Herdr injects `HERDR_ENV=1` and `HERDR_PANE_ID`
 * into every pane it manages.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import { buildOpencodeAttachCommand, findBinary } from '../shared';
import type { Multiplexer, PaneResult } from '../types';

type HerdrPaneDirection = 'right' | 'down';

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
  private readonly parentPaneId = process.env.HERDR_PANE_ID;
  private readonly layout: MultiplexerLayout;
  private readonly paneDirection: HerdrPaneDirection;
  private agentAreaPaneId: string | null = null;
  private lastSplitPaneId: string | null = null;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    // Herdr does not support exact main pane sizing like tmux.
    // Layout config is mapped to pane split direction.
    void mainPaneSize;
    this.layout = layout;
    this.paneDirection = getPaneDirection(layout);
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await findBinary('herdr');
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!(process.env.HERDR_ENV || process.env.HERDR_PANE_ID);
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const herdr = await this.getBinary();
    if (!herdr) {
      log('[herdr] spawnPane: herdr binary not found');
      return { success: false };
    }

    try {
      // Determine split target and direction based on layout + agent area state
      let target: string[] = [];
      let direction: HerdrPaneDirection = 'right';
      let wasFirstChild = false;

      if (this.layout === 'main-vertical' && this.agentAreaPaneId) {
        target = [this.agentAreaPaneId];
        direction = 'down';
        const agentSplit = await this.runSplit(
          target,
          direction,
          directory,
        );
        if (!agentSplit) {
          log('[herdr] agent area split failed, falling back to parent', {
            agentAreaPaneId: this.agentAreaPaneId,
          });
          this.agentAreaPaneId = null;
        }
      }

      if (!this.agentAreaPaneId) {
        // First child OR fallback after stale agent area
        target = this.targetPaneArg();
        direction = this.paneDirection;
        wasFirstChild = true;
      }

      let paneId: string | null = null;
      if (wasFirstChild) {
        paneId = await this.runSplit(target, direction, directory);
      } else {
        // agent area split already ran; use its result
        paneId = this.lastSplitPaneId;
      }

      if (!paneId) {
        log('[herdr] spawnPane: could not parse pane_id from output');
        return { success: false };
      }

      // 2. Rename the pane for visibility
      await crossSpawn(
        [herdr, 'pane', 'rename', paneId, description.slice(0, 30)],
        { stdout: 'ignore', stderr: 'ignore' },
      ).exited;

      // 3. Run opencode attach in the new pane
      const opencodeCmd = buildOpencodeAttachCommand(
        sessionId,
        serverUrl,
        directory,
      );

      const runProc = crossSpawn([herdr, 'pane', 'run', paneId, opencodeCmd], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const runExitCode = await runProc.exited;
      if (runExitCode !== 0) {
        const runStderr = await runProc.stderr();
        log('[herdr] spawnPane: run failed', {
          exitCode: runExitCode,
          stderr: runStderr.trim(),
        });
        return { success: false };
      }

      if (wasFirstChild && this.layout === 'main-vertical') {
        this.agentAreaPaneId = paneId;
      }

      log('[herdr] spawnPane: SUCCESS', { paneId });
      return { success: true, paneId };
    } catch (err) {
      log('[herdr] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId || paneId === 'unknown') return true;

    if (paneId === this.agentAreaPaneId) {
      this.agentAreaPaneId = null;
    }

    const herdr = await this.getBinary();
    if (!herdr) {
      log('[herdr] closePane: herdr binary not found');
      return false;
    }

    try {
      // Send Ctrl+C for graceful shutdown
      log('[herdr] closePane: sending Ctrl+C', { paneId });
      await crossSpawn([herdr, 'pane', 'send-keys', paneId, 'ctrl+c'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      // Wait for graceful shutdown
      await new Promise((r) => setTimeout(r, 250));

      // Close the pane
      log('[herdr] closePane: closing pane', { paneId });
      const proc = crossSpawn([herdr, 'pane', 'close', paneId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stderr = await proc.stderr();

      log('[herdr] closePane: result', { exitCode, stderr: stderr.trim() });

      if (exitCode === 0 || exitCode === 1) {
        return true;
      }

      // Pane might already be closed
      log('[herdr] closePane: failed (pane may already be closed)', {
        paneId,
      });
      return false;
    } catch (err) {
      log('[herdr] closePane: exception', { error: String(err) });
      return false;
    }
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // ponytail: herdr has no rebalancing API; clear agent area so a layout
    // switch starts fresh from the parent pane.
    this.agentAreaPaneId = null;
  }

  private async runSplit(
    target: string[],
    direction: HerdrPaneDirection,
    directory: string,
  ): Promise<string | null> {
    const herdr = await this.getBinary();
    if (!herdr) return null;

    const splitArgs = [
      herdr,
      'pane',
      'split',
      ...target,
      '--direction',
      direction,
      '--cwd',
      directory,
      '--no-focus',
    ];

    log('[herdr] spawnPane: splitting pane', { args: splitArgs });

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
      return null;
    }

    const paneId = parsePaneId(splitStdout);
    this.lastSplitPaneId = paneId;
    return paneId;
  }

  private targetPaneArg(): string[] {
    return this.parentPaneId ? [this.parentPaneId] : ['--current'];
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
