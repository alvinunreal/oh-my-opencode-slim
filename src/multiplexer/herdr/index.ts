/**
 * Herdr multiplexer implementation
 *
 * Manages child-agent panes via herdr's JSON-RPC Unix socket API.
 * Follows the same lifecycle pattern as the tmux backend: split, attach
 * opencode, wait for completion, graceful close.
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import { log } from '../../utils/logger';
import type { Multiplexer, PaneResult } from '../types';
import { HerdrSocketClient, isHerdrError } from './client';

const LAYOUT_DEBOUNCE_MS = 150;

export class HerdrMultiplexer implements Multiplexer {
  readonly type = 'herdr' as const;

  private client = new HerdrSocketClient();
  private binaryPath: string | null = null;
  private hasChecked = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;
  private layoutTimer?: ReturnType<typeof setTimeout>;
  private layoutGeneration = 0;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;
  }

  // -----------------------------------------------------------------------
  // Availability & session detection
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await this.findBinary();
    this.hasChecked = true;

    if (!this.binaryPath) {
      return false;
    }

    // Also verify the socket is reachable
    const pingOk = await this.client.ping();
    if (!pingOk) {
      log('[herdr] isAvailable: binary found but socket ping failed');
      this.binaryPath = null;
      return false;
    }

    return true;
  }

  isInsideSession(): boolean {
    return process.env.HERDR_ENV === '1';
  }

  // -----------------------------------------------------------------------
  // Pane lifecycle
  // -----------------------------------------------------------------------

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    if (!this.isInsideSession()) {
      log('[herdr] spawnPane: not inside a herdr session');
      return { success: false };
    }

    if (!(await this.isAvailable())) {
      log('[herdr] spawnPane: herdr not available');
      return { success: false };
    }

    try {
      // 1. Determine which pane to split from
      const splitSource = await this.findSplitSource();
      if (!splitSource) {
        log('[herdr] spawnPane: no split source available');
        return { success: false };
      }
      log('[herdr] spawnPane: splitting from pane', { splitSource });

      // 2. Determine split direction
      const isFirstAgent = splitSource === process.env.HERDR_PANE_ID;
      const splitDir = this.splitDirectionForLayout(this.storedLayout);
      const actualDir = isFirstAgent
        ? splitDir
        : this.perpendicularDirection(splitDir);

      // CRITICAL: pane.split ignores pane_id for workspace/tab targeting —
      // it splits whatever workspace is currently focused. We MUST pass
      // workspace_id and tab_id explicitly so spawns always land next to the
      // OpenCode session regardless of what the user has focused.
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      const tabId = process.env.HERDR_TAB_ID;
      if (!workspaceId || !tabId) {
        log('[herdr] spawnPane: HERDR_WORKSPACE_ID or HERDR_TAB_ID not set', {
          workspaceId,
          tabId,
        });
        return { success: false };
      }

      // Spawn ratio: first agent takes (100-mainPaneSize)% of axis to minimise
      // jarring relayout; subsequent agents split the agent column equally.
      const splitRatio = isFirstAgent
        ? (100 - this.storedMainPaneSize) / 100
        : 0.5;

      const split = await this.client.call('pane.split', {
        pane_id: splitSource,
        workspace_id: workspaceId,
        tab_id: tabId,
        direction: actualDir,
        ratio: splitRatio,
        cwd: directory,
        label: description.slice(0, 30),
      });

      const splitResult = split as { pane: { pane_id: string } };
      const paneId = splitResult?.pane?.pane_id;

      if (!paneId) {
        log('[herdr] spawnPane: split succeeded but no pane_id in response', {
          split,
        });
        return { success: false };
      }

      log('[herdr] spawnPane: pane split', { paneId });

      // 2. Wait for the shell to be ready (empirically required ~400ms)
      await new Promise((r) => setTimeout(r, 400));

      // 3. Build the opencode attach command (mirrors tmux pattern)
      const quotedDirectory = quoteShellArg(directory);
      const quotedUrl = quoteShellArg(serverUrl);
      const quotedSessionId = quoteShellArg(sessionId);

      const opencodeCmd = [
        'opencode',
        'attach',
        quotedUrl,
        '--session',
        quotedSessionId,
        '--dir',
        quotedDirectory,
      ].join(' ');

      // 4. Send the command (trailing \n executes it)
      await this.client.call('pane.send_text', {
        pane_id: paneId,
        text: `${opencodeCmd}\n`,
      });

      log('[herdr] spawnPane: SUCCESS', { paneId });
      // Rebalance panes after bursts of child sessions settle.
      this.scheduleLayout();
      return { success: true, paneId };
    } catch (err) {
      log('[herdr] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId) {
      log('[herdr] closePane: no paneId provided');
      return false;
    }

    try {
      // 1. Send Ctrl+C for graceful shutdown
      try {
        log('[herdr] closePane: sending Ctrl+C', { paneId });
        await this.client.call('pane.send_keys', {
          pane_id: paneId,
          keys: ['ctrl+c'],
        });
      } catch (sendErr) {
        log('[herdr] closePane: send_keys failed (pane may already be gone)', {
          error: String(sendErr),
        });
        // Continue — the pane may already be closed
      }

      // 2. Wait for graceful shutdown (matches tmux 250ms window)
      await new Promise((r) => setTimeout(r, 250));

      // 3. Close the pane
      log('[herdr] closePane: closing pane', { paneId });
      await this.client.call('pane.close', { pane_id: paneId });

      log('[herdr] closePane: SUCCESS', { paneId });
      // Rebalance panes after bursts of child sessions settle.
      this.scheduleLayout();
      return true;
    } catch (err) {
      if (isHerdrError(err, 'pane_not_found')) {
        log('[herdr] closePane: pane already closed', { paneId });
        // Rebalance — a pane was removed even if already gone.
        this.scheduleLayout();
        return true;
      }

      log('[herdr] closePane: exception', { error: String(err) });
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Layout
  // -----------------------------------------------------------------------

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = undefined;
    }

    this.layoutGeneration++;
    await this.applyLayoutNow(layout, mainPaneSize);
  }

  private scheduleLayout(): void {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);

    const gen = ++this.layoutGeneration;
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = undefined;
      if (this.layoutGeneration === gen) {
        void this.applyLayoutNow(this.storedLayout, this.storedMainPaneSize);
      }
    }, LAYOUT_DEBOUNCE_MS);
    this.layoutTimer.unref?.();
  }

  /**
   * Map a MultiplexerLayout to the split direction spawnPane should use.
   *
   * Side-by-side layouts (main-vertical, even-horizontal) split RIGHT
   * so that pane.resize direction:left|right can adjust widths later.
   * Stacked layouts (main-horizontal, even-vertical, tiled) split DOWN
   * so that pane.resize direction:up|down can adjust heights later.
   */
  private splitDirectionForLayout(layout: MultiplexerLayout): 'right' | 'down' {
    if (layout === 'main-vertical' || layout === 'even-horizontal') {
      return 'right';
    }
    return 'down';
  }

  /**
   * Apply a layout by resizing panes in-place via pane.resize.
   *
   * spawnPane splits in the direction that matches the layout's axis
   * (RIGHT for width-axis layouts, DOWN for height-axis layouts),
   * so pane.resize can adjust panes along the correct axis.
   *
   * All 5 layouts have real implementations:
   *   main-vertical     — main pane takes mainPaneSize% width (left-right)
   *   main-horizontal   — main pane takes mainPaneSize% height (top-bottom)
   *   even-vertical     — all panes equal height
   *   even-horizontal   — all panes equal width
   *   tiled             — same as even-vertical (best approximation)
   */
  private async applyLayoutNow(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;

    try {
      // 1. Query current tab layout. MUST pass pane_id to scope to the
      // OpenCode workspace — pane.layout with no pane_id returns the
      // focused workspace, which may differ from the OpenCode session.
      const sourcePaneId = process.env.HERDR_PANE_ID;
      const layoutResp = await this.client.call(
        'pane.layout',
        sourcePaneId ? { pane_id: sourcePaneId } : {},
      );
      const currentLayout = (layoutResp as Record<string, unknown>)?.layout as
        | {
            area: { width: number; height: number };
            panes: Array<{
              pane_id: string;
              rect: {
                x: number;
                y: number;
                width: number;
                height: number;
              };
              focused: boolean;
            }>;
          }
        | undefined;

      if (!currentLayout?.panes?.length) {
        log('[herdr] applyLayoutNow: no panes in layout');
        return;
      }

      const panes = currentLayout.panes;
      const totalW = currentLayout.area.width;
      const totalH = currentLayout.area.height;

      // 2. Identify the main pane
      const mainPane = sourcePaneId
        ? panes.find((p) => p.pane_id === sourcePaneId)
        : (panes.find((p) => p.focused) ?? panes[0]);

      if (!mainPane) {
        log('[herdr] applyLayoutNow: could not identify main pane');
        return;
      }

      // Shared PaneRect for un-focused pane arrays in resize replies
      type PaneRect = {
        pane_id: string;
        rect: { x: number; y: number; width: number; height: number };
      };

      // 3. Apply layout-specific resize logic.
      //
      // pane.resize amount is a FLOAT RATIO (0..1) of the tab's axis,
      // NOT integer cells (confirmed against herdr docs + live probe).
      // mainPaneSize is already a percentage; convert directly to ratio
      // to avoid rounding errors from a percentage→cells→ratio round-trip.
      const targetRatio = mainPaneSize / 100; // e.g. 0.60
      const ratioThreshold = 0.005; // ~0.5% — skip if already close

      switch (layout) {
        // === WIDTH-AXIS layouts (split RIGHT, resize LEFT|RIGHT) ===

        case 'main-vertical': {
          const currentRatio = totalW > 0 ? mainPane.rect.width / totalW : 0;
          const deltaRatio = targetRatio - currentRatio;

          if (Math.abs(deltaRatio) < ratioThreshold) {
            log('[herdr] applyLayoutNow: main-vertical already at target', {
              targetRatio,
              currentRatio,
            });
            return;
          }

          const direction = deltaRatio > 0 ? 'right' : 'left';

          log('[herdr] applyLayoutNow: resizing main pane', {
            paneId: mainPane.pane_id,
            direction,
            amount: Math.abs(deltaRatio),
            targetRatio,
          });

          await this.client.call('pane.resize', {
            pane_id: mainPane.pane_id,
            direction,
            amount: Math.abs(deltaRatio),
          });

          log('[herdr] applyLayoutNow: main-vertical applied', {
            layout,
            mainPaneSize,
          });
          break;
        }

        case 'even-horizontal': {
          if (panes.length <= 1) {
            log('[herdr] applyLayoutNow: only one pane, nothing to balance');
            return;
          }

          const targetRatioPerPane = 1 / panes.length;

          // Sort panes left-to-right by x position
          let sorted: PaneRect[] = [...panes].sort(
            (a, b) => a.rect.x - b.rect.x,
          );

          for (let i = 0; i < sorted.length - 1; i++) {
            const pane = sorted[i];
            const currentRatio = totalW > 0 ? pane.rect.width / totalW : 0;
            const deltaRatio = targetRatioPerPane - currentRatio;
            if (Math.abs(deltaRatio) < ratioThreshold) continue;

            const resp = await this.client.call('pane.resize', {
              pane_id: pane.pane_id,
              direction: deltaRatio > 0 ? 'right' : 'left',
              amount: Math.abs(deltaRatio),
            });

            // Re-read panes from response for next iteration
            const respLayout = (resp as Record<string, unknown>)?.layout as
              | { panes: PaneRect[] }
              | undefined;
            if (respLayout?.panes) {
              sorted = [...respLayout.panes].sort(
                (a, b) => a.rect.x - b.rect.x,
              );
            }
          }

          log('[herdr] applyLayoutNow: even-horizontal applied', {
            layout,
            paneCount: panes.length,
          });
          break;
        }

        // === HEIGHT-AXIS layouts (split DOWN, resize UP|DOWN) ===

        case 'main-horizontal': {
          const currentRatio = totalH > 0 ? mainPane.rect.height / totalH : 0;
          const deltaRatio = targetRatio - currentRatio;

          if (Math.abs(deltaRatio) < ratioThreshold) {
            log('[herdr] applyLayoutNow: main-horizontal already at target', {
              targetRatio,
              currentRatio,
            });
            return;
          }

          const direction = deltaRatio > 0 ? 'down' : 'up';

          log('[herdr] applyLayoutNow: resizing main pane', {
            paneId: mainPane.pane_id,
            direction,
            amount: Math.abs(deltaRatio),
            targetRatio,
          });

          await this.client.call('pane.resize', {
            pane_id: mainPane.pane_id,
            direction,
            amount: Math.abs(deltaRatio),
          });

          log('[herdr] applyLayoutNow: main-horizontal applied', {
            layout,
            mainPaneSize,
          });
          break;
        }

        case 'even-vertical':
        case 'tiled': {
          if (panes.length <= 1) {
            log('[herdr] applyLayoutNow: only one pane, nothing to balance');
            return;
          }

          const targetRatioPerPane = 1 / panes.length;

          let sorted: PaneRect[] = [...panes].sort(
            (a, b) => a.rect.y - b.rect.y,
          );

          for (let i = 0; i < sorted.length - 1; i++) {
            const pane = sorted[i];
            const currentRatio = totalH > 0 ? pane.rect.height / totalH : 0;
            const deltaRatio = targetRatioPerPane - currentRatio;
            if (Math.abs(deltaRatio) < ratioThreshold) continue;

            const resp = await this.client.call('pane.resize', {
              pane_id: pane.pane_id,
              direction: deltaRatio > 0 ? 'down' : 'up',
              amount: Math.abs(deltaRatio),
            });

            const respLayout = (resp as Record<string, unknown>)?.layout as
              | { panes: PaneRect[] }
              | undefined;
            if (respLayout?.panes) {
              sorted = [...respLayout.panes].sort(
                (a, b) => a.rect.y - b.rect.y,
              );
            }
          }

          log('[herdr] applyLayoutNow: even-vertical applied', {
            layout,
            paneCount: panes.length,
          });
          break;
        }
      }
    } catch (err) {
      log('[herdr] applyLayoutNow: exception', { error: String(err) });
    }
  }

  /**
   * Return the perpendicular split direction.
   * Used so subsequent agents nest orthogonally to the root split.
   */
  private perpendicularDirection(dir: 'right' | 'down'): 'right' | 'down' {
    return dir === 'right' ? 'down' : 'right';
  }

  /**
   * Find the best pane to split from for the next agent spawn.
   *
   * Stateless approach — queries pane.list to discover existing agent panes
   * in the current tab, avoiding manual anchor tracking.
   *
   * Returns:
   *   - An existing agent pane ID if any exist (nest in perpendicular dir)
   *   - The main pane (HERDR_PANE_ID) if no other agents exist
   *   - null if HERDR_PANE_ID is not set (can't target anything)
   */
  private async findSplitSource(): Promise<string | null> {
    const mainPane = process.env.HERDR_PANE_ID;
    if (!mainPane) {
      log('[herdr] findSplitSource: HERDR_PANE_ID not set');
      return null;
    }

    try {
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      const tabId = process.env.HERDR_TAB_ID;
      if (!workspaceId || !tabId) {
        log(
          '[herdr] findSplitSource: HERDR_WORKSPACE_ID or HERDR_TAB_ID not set, splitting from main',
        );
        return mainPane;
      }

      const result = await this.client.call<{
        panes: Array<{ pane_id: string; tab_id: string }>;
      }>('pane.list', { workspace_id: workspaceId });

      const otherAgents = result.panes.filter(
        (p) => p.tab_id === tabId && p.pane_id !== mainPane,
      );

      if (otherAgents.length === 0) {
        return mainPane;
      }
      return otherAgents[0].pane_id;
    } catch (err) {
      log('[herdr] findSplitSource: error, falling back to main pane', {
        error: String(err),
      });
      return mainPane;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async findBinary(): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';

    try {
      const proc = crossSpawn([cmd, 'herdr'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log("[herdr] findBinary: 'which herdr' failed", { exitCode });
        return null;
      }

      const stdout = await proc.stdout();
      const path = stdout.trim().split('\n')[0];
      if (!path) {
        log('[herdr] findBinary: no path in output');
        return null;
      }

      // Verify it works
      const verifyProc = crossSpawn([path, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const verifyExit = await verifyProc.exited;
      if (verifyExit !== 0) {
        log('[herdr] findBinary: herdr --version failed', {
          path,
          verifyExit,
        });
        return null;
      }

      log('[herdr] findBinary: found', { path });
      return path;
    } catch (err) {
      log('[herdr] findBinary: exception', { error: String(err) });
      return null;
    }
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
