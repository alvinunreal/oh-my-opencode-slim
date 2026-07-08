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
  private readonly paneDirection: HerdrPaneDirection;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    // Herdr does not support exact main pane sizing like tmux.
    // Layout config is mapped to pane split direction.
    void mainPaneSize;
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
      // 1. Split the parent pane to create a new one
      const splitArgs = [
        herdr,
        'pane',
        'split',
        ...this.targetPaneArg(),
        '--direction',
        this.paneDirection,
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
        return { success: false };
      }

      // Parse JSON response to extract pane_id
      const paneId = parsePaneId(splitStdout);
      if (!paneId) {
        log('[herdr] spawnPane: could not parse pane_id from output', {
          stdout: splitStdout.trim(),
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
        directory,
      );

      log('[herdr] spawnPane: running attach command', {
        paneId,
        command: opencodeCmd,
      });

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

      log('[herdr] spawnPane: SUCCESS', { paneId });
      return { success: true, paneId };
    } catch (err) {
      log('[herdr] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    const herdr = await this.getBinary();
    return gracefulClosePane(herdr, paneId, {
      ctrlC: ['pane', 'send-keys', paneId, 'ctrl+c'],
      close: ['pane', 'close', paneId],
      acceptExitCode1: true,
      emptyPaneReturnsTrue: true,
    });
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // No-op for herdr. Herdr does not support tmux-like exact main pane
    // sizing/rebalancing; layout is applied to future pane creation by
    // mapping configured layouts to pane split directions.
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
