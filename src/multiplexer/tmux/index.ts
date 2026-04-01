/**
 * Tmux multiplexer implementation
 */

import { spawn } from 'bun';
import type { MultiplexerLayout } from '../../config/schema';
import { log } from '../../utils/logger';
import type { Multiplexer, PaneResult } from '../types';

export class TmuxMultiplexer implements Multiplexer {
  readonly type = 'tmux' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private storedLayout: MultiplexerLayout;
  private storedMainPaneSize: number;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasChecked) {
      return this.binaryPath !== null;
    }

    this.binaryPath = await this.findBinary();
    this.hasChecked = true;
    return this.binaryPath !== null;
  }

  isInsideSession(): boolean {
    return !!process.env.TMUX;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
  ): Promise<PaneResult> {
    const tmux = await this.getBinary();
    if (!tmux) {
      log('[tmux] spawnPane: tmux binary not found');
      return { success: false };
    }

    try {
      // Build the attach command
      const opencodeCmd = `opencode attach ${serverUrl} --session ${sessionId}`;

      // tmux split-window -h -d -P -F '#{pane_id}' <cmd>
      const args = [
        'split-window',
        '-h', // Horizontal split (pane to the right)
        '-d', // Don't switch focus
        '-P', // Print pane info
        '-F',
        '#{pane_id}', // Format: just the pane ID
        opencodeCmd,
      ];

      log('[tmux] spawnPane: executing', { tmux, args });

      const proc = spawn([tmux, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const paneId = stdout.trim();

      log('[tmux] spawnPane: result', {
        exitCode,
        paneId,
        stderr: stderr.trim(),
      });

      if (exitCode === 0 && paneId) {
        // Rename the pane for visibility
        const renameProc = spawn(
          [tmux, 'select-pane', '-t', paneId, '-T', description.slice(0, 30)],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        await renameProc.exited;

        // Apply layout
        await this.applyLayout(this.storedLayout, this.storedMainPaneSize);

        log('[tmux] spawnPane: SUCCESS', { paneId });
        return { success: true, paneId };
      }

      return { success: false };
    } catch (err) {
      log('[tmux] spawnPane: exception', { error: String(err) });
      return { success: false };
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId) {
      log('[tmux] closePane: no paneId provided');
      return false;
    }

    const tmux = await this.getBinary();
    if (!tmux) {
      log('[tmux] closePane: tmux binary not found');
      return false;
    }

    try {
      // Send Ctrl+C for graceful shutdown
      log('[tmux] closePane: sending Ctrl+C', { paneId });
      const ctrlCProc = spawn([tmux, 'send-keys', '-t', paneId, 'C-c'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await ctrlCProc.exited;

      // Wait for graceful shutdown
      await new Promise((r) => setTimeout(r, 250));

      // Kill the pane
      log('[tmux] closePane: killing pane', { paneId });
      const proc = spawn([tmux, 'kill-pane', '-t', paneId], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      log('[tmux] closePane: result', { exitCode, stderr: stderr.trim() });

      if (exitCode === 0) {
        // Reapply layout to rebalance
        await this.applyLayout(this.storedLayout, this.storedMainPaneSize);
        return true;
      }

      // Pane might already be closed
      log('[tmux] closePane: failed (pane may already be closed)', { paneId });
      return false;
    } catch (err) {
      log('[tmux] closePane: exception', { error: String(err) });
      return false;
    }
  }

  async applyLayout(
    layout: MultiplexerLayout,
    mainPaneSize: number,
  ): Promise<void> {
    const tmux = await this.getBinary();
    if (!tmux) return;

    // Store for later use
    this.storedLayout = layout;
    this.storedMainPaneSize = mainPaneSize;

    try {
      // Apply the layout
      const layoutProc = spawn([tmux, 'select-layout', layout], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await layoutProc.exited;

      // For main-* layouts, set the main pane size
      if (layout === 'main-horizontal' || layout === 'main-vertical') {
        const sizeOption =
          layout === 'main-horizontal' ? 'main-pane-height' : 'main-pane-width';

        const sizeProc = spawn(
          [tmux, 'set-window-option', sizeOption, `${mainPaneSize}%`],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        await sizeProc.exited;

        // Reapply layout to use the new size
        const reapplyProc = spawn([tmux, 'select-layout', layout], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await reapplyProc.exited;
      }

      log('[tmux] applyLayout: applied', { layout, mainPaneSize });
    } catch (err) {
      log('[tmux] applyLayout: exception', { error: String(err) });
    }
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  private async findBinary(): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';

    try {
      const proc = spawn([cmd, 'tmux'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log("[tmux] findBinary: 'which tmux' failed", { exitCode });
        return null;
      }

      const stdout = await new Response(proc.stdout).text();
      const path = stdout.trim().split('\n')[0];
      if (!path) {
        log('[tmux] findBinary: no path in output');
        return null;
      }

      // Verify it works
      const verifyProc = spawn([path, '-V'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const verifyExit = await verifyProc.exited;
      if (verifyExit !== 0) {
        log('[tmux] findBinary: tmux -V failed', { path, verifyExit });
        return null;
      }

      log('[tmux] findBinary: found', { path });
      return path;
    } catch (err) {
      log('[tmux] findBinary: exception', { error: String(err) });
      return null;
    }
  }
}
