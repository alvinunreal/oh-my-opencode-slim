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
import {
  buildOpencodeAttachCommand,
  findBinary,
  gracefulClosePane,
  normalizePathForShell,
} from '../shared';
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
  private layout: MultiplexerLayout;
  private paneDirection: HerdrPaneDirection;
  private agentAreaPaneId: string | null = null;

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
      // Normalize Windows backslashes→/ so sh -lc (MSYS2) doesn't
      // corrupt --cwd (issue #568).
      const attachDir = normalizePathForShell(directory);

      let paneId: string | null = null;
      let lastRawOutput = '';

      if (this.layout === 'main-vertical' && this.agentAreaPaneId) {
        const result = await this.runSplit(
          [this.agentAreaPaneId],
          'down',
          attachDir,
        );
        paneId = result.paneId;
        if (!paneId) {
          log('[herdr] agent area split failed, falling back to parent', {
            agentAreaPaneId: this.agentAreaPaneId,
          });
          this.agentAreaPaneId = null;
        }
      }

      if (!this.agentAreaPaneId) {
        const result = await this.runSplit(
          this.targetPaneArg(),
          this.paneDirection,
          attachDir,
        );
        paneId = result.paneId;
        lastRawOutput = result.rawOutput;
      }

      if (!paneId) {
        log('[herdr] spawnPane: could not parse pane_id from output', {
          stdout: lastRawOutput,
        });
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
        attachDir,
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
        // ponytail: split succeeded but attach failed; close the orphaned pane
        // so it does not linger in the agent column. Session manager gets no
        // paneId on failure, so we must clean it up here.
        try {
          await this.closePane(paneId);
        } catch (closeErr) {
          log('[herdr] spawnPane: failed to close orphaned pane', {
            paneId,
            error: String(closeErr),
          });
        }
        return { success: false };
      }

      // 4. Track agent area pane ID only after successful attach
      if (this.layout === 'main-vertical' && !this.agentAreaPaneId) {
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
    const herdr = await this.getBinary();
    const closed = await gracefulClosePane(herdr, paneId, {
      ctrlC: ['pane', 'send-keys', paneId, 'ctrl+c'],
      close: ['pane', 'close', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
    if (closed && paneId === this.agentAreaPaneId) {
      this.agentAreaPaneId = null;
    }
    return closed;
  }

  async applyLayout(
    layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // ponytail: herdr has no rebalancing API; clear agent area so a layout
    // switch starts fresh from the parent pane.
    this.agentAreaPaneId = null;
    this.layout = layout;
    this.paneDirection = getPaneDirection(layout);
  }

  private async runSplit(
    target: string[],
    direction: HerdrPaneDirection,
    directory: string,
  ): Promise<{ paneId: string | null; rawOutput: string }> {
    const herdr = await this.getBinary();
    if (!herdr) return { paneId: null, rawOutput: '' };

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
      return { paneId: null, rawOutput: splitStdout.trim() };
    }

    return { paneId: parsePaneId(splitStdout), rawOutput: splitStdout.trim() };
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
