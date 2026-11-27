/**
 * Superlogical Rex multiplexer adapter.
 *
 * Every child is split beside the explicitly identified parent block. Rex's
 * CLI owns the request timeout, the split never takes focus, and the returned
 * block id is the only handle this instance will close. The client lifecycle
 * continues to own admission, memoization, and pane tracking.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { isRecord } from '../../utils/guards';
import { log } from '../../utils/logger';
import {
  buildShellLaunchArgs,
  buildViewCommand,
  findBinary,
  markViewerCommand,
} from '../shared';
import type { Multiplexer, PaneResult, PaneSpawnOptions } from '../types';

const REX_TIMEOUT = '5s';

export interface RexContext {
  session: string;
  block: string;
}

/** Rex auto-admission and spawn require both client-local anchor values. */
export function resolveRexContext(
  env: Record<string, string | undefined>,
): RexContext | null {
  const session = env.REX_SESSION?.trim();
  const block = env.REX_BLOCK?.trim();
  return session && block ? { session, block } : null;
}

interface SplitResult {
  anchor: string;
  blocks: string[];
}

export class RexMultiplexer implements Multiplexer {
  readonly type = 'rex' as const;

  private binaryPath: string | null = null;
  private binaryPromise: Promise<string | null> | null = null;
  private readonly layout: MultiplexerLayout;
  private readonly mainPaneSize: number;
  /** Only block IDs created by this adapter instance may be closed. */
  private readonly ownedBlocks = new Map<string, string>();

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.layout = layout;
    this.mainPaneSize = mainPaneSize;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.getBinary()) !== null;
  }

  isInsideSession(): boolean {
    return resolveRexContext(process.env) !== null;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult> {
    if (process.platform === 'win32') {
      log('[rex] spawnPane: Windows hosts are unsupported; no pane');
      return { success: false, error: 'unavailable' };
    }

    const context = resolveRexContext(process.env);
    if (!context) {
      log('[rex] spawnPane: REX_SESSION and REX_BLOCK are required');
      return { success: false, error: 'not_found' };
    }

    // Rex has no safe way to inject a viewer password into the spawned shell.
    // Refuse before mutating the user's layout rather than expose credentials.
    const viewerFlavor = options?.viewerFlavor ?? 'v1';
    if (
      (viewerFlavor === 'v2-remote' && options?.viewerPassword !== undefined) ||
      (viewerFlavor === 'v1' &&
        process.env.OPENCODE_SERVER_PASSWORD !== undefined)
    ) {
      log('[rex] spawnPane: viewer credential transport is unsupported');
      return { success: false, error: 'unavailable' };
    }

    const rex = await this.getBinary();
    if (!rex) {
      log('[rex] spawnPane: rex binary not found');
      return { success: false, error: 'unavailable' };
    }

    const command = markViewerCommand(
      buildViewCommand(sessionId, serverUrl, directory, options),
    );
    const [direction, ratio] = splitLayout(this.layout, this.mainPaneSize);
    let dispatched = false;
    try {
      const proc = crossSpawn(
        [
          rex,
          '--autostart=false',
          '--timeout',
          REX_TIMEOUT,
          'split',
          '--session',
          context.session,
          '--block',
          context.block,
          '--split',
          direction,
          '--ratio',
          String(ratio),
          '--cwd',
          directory,
          '--label',
          description,
          '--focus=false',
          '--json',
          '--shell=none',
          '--',
          ...buildShellLaunchArgs(command),
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      dispatched = true;
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        proc.stdout(),
      ]);
      if (exitCode !== 0) {
        log('[rex] spawnPane: split command failed', { exitCode });
        return { success: false, error: 'hard', creationUncertain: true };
      }

      const split = parseSplitResult(stdout);
      if (!split || split.anchor !== context.block) {
        log('[rex] spawnPane: invalid split response');
        return { success: false, error: 'hard', creationUncertain: true };
      }
      const paneId = split.blocks.find((block) => block !== context.block);
      if (!paneId || this.ownedBlocks.has(paneId)) {
        log('[rex] spawnPane: split response has no new block');
        return { success: false, error: 'hard', creationUncertain: true };
      }

      this.ownedBlocks.set(paneId, context.session);
      log('[rex] spawnPane: SUCCESS', { paneId });
      return { success: true, paneId };
    } catch (error) {
      // Do not retry a split: an interrupted command may already have mutated
      // the layout, and a blind retry could create an untracked second pane.
      log('[rex] spawnPane: split failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: 'hard',
        ...(dispatched ? { creationUncertain: true } : {}),
      };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId || paneId === 'unknown') return false;
    const session = this.ownedBlocks.get(paneId);
    if (!session) return false;

    const rex = await this.getBinary();
    if (!rex) return false;

    try {
      const proc = crossSpawn(
        [
          rex,
          '--autostart=false',
          '--timeout',
          REX_TIMEOUT,
          'block',
          'close',
          '--session',
          session,
          paneId,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log('[rex] closePane: close command failed; keeping block tracked', {
          paneId,
          exitCode,
        });
        return false;
      }
      this.ownedBlocks.delete(paneId);
      return true;
    } catch {
      return false;
    }
  }

  private async getBinary(): Promise<string | null> {
    if (this.binaryPath) return this.binaryPath;
    if (this.binaryPromise) return this.binaryPromise;
    this.binaryPromise = findBinary('rex')
      .then((binary) => {
        if (binary) this.binaryPath = binary;
        return binary;
      })
      .finally(() => {
        this.binaryPromise = null;
      });
    return this.binaryPromise;
  }
}

function parseSplitResult(stdout: string): SplitResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isRecord(parsed)) return null;
    const result = isRecord(parsed.result) ? parsed.result : parsed;
    const blocks = result.block_ids;
    if (!Array.isArray(blocks)) return null;
    const anchorKeys = ['anchor_id', 'anchor_block_id'].filter((key) =>
      Object.hasOwn(result, key),
    );
    if (anchorKeys.length === 0) return null;
    const anchors: string[] = [];
    for (const key of anchorKeys) {
      const anchor = result[key];
      if (
        typeof anchor !== 'string' ||
        anchor.length === 0 ||
        anchor.trim() !== anchor
      ) {
        return null;
      }
      anchors.push(anchor);
    }
    const anchor = anchors[0];
    if (!anchor || anchors.some((value) => value !== anchor)) return null;
    const blockIds: string[] = [];
    for (const block of blocks) {
      if (
        typeof block !== 'string' ||
        block.length === 0 ||
        block.trim() !== block
      ) {
        return null;
      }
      blockIds.push(block);
    }
    return {
      anchor,
      blocks: blockIds,
    };
  } catch {
    return null;
  }
}

function splitLayout(
  layout: MultiplexerLayout,
  mainPaneSize: number,
): ['right' | 'below', number] {
  switch (layout) {
    case 'main-vertical':
      return ['right', 100 - mainPaneSize];
    case 'main-horizontal':
      return ['below', 100 - mainPaneSize];
    case 'even-horizontal':
      return ['right', 50];
    case 'even-vertical':
      return ['below', 50];
    case 'tiled':
      return ['right', 50];
    default: {
      const _exhaustive: never = layout;
      return _exhaustive;
    }
  }
}
