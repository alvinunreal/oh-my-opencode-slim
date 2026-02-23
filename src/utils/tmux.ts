import { spawn } from 'bun';
import type { TmuxConfig, TmuxLayout } from '../config/schema';
import { log } from './logger';

let tmuxPath: string | null = null;
let tmuxChecked = false;

// Store config for reapplying layout on close
let storedConfig: TmuxConfig | null = null;

// Cache server availability check
let serverAvailable: boolean | null = null;
let serverCheckUrl: string | null = null;

/**
 * Check if the OpenCode HTTP server is actually running.
 * This is needed because ctx.serverUrl may return a fallback URL even when no server is running.
 */
async function isServerRunning(serverUrl: string): Promise<boolean> {
  // Use cached result if checking the same URL
  if (serverCheckUrl === serverUrl && serverAvailable === true) {
    return true;
  }

  const healthUrl = new URL('/health', serverUrl).toString();
  const timeoutMs = 3000;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response | null = null;
    try {
      response = await fetch(healthUrl, { signal: controller.signal }).catch(
        () => null,
      );
    } finally {
      clearTimeout(timeout);
    }

    const available = response?.ok ?? false;
    if (available) {
      serverCheckUrl = serverUrl;
      serverAvailable = true;
      log('[tmux] isServerRunning: checked', { serverUrl, available, attempt });
      return true;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  log('[tmux] isServerRunning: checked', { serverUrl, available: false });
  return false;
}

/**
 * Reset the server availability cache (useful when server might have started)
 */
export function resetServerCheck(): void {
  serverAvailable = null;
  serverCheckUrl = null;
}

/**
 * Find tmux binary path
 */
async function findTmuxPath(): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';

  try {
    const proc = spawn([cmd, 'tmux'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log("[tmux] findTmuxPath: 'which tmux' failed", { exitCode });
      return null;
    }

    const stdout = await new Response(proc.stdout).text();
    const path = stdout.trim().split('\n')[0];
    if (!path) {
      log('[tmux] findTmuxPath: no path in output');
      return null;
    }

    // Verify it works
    const verifyProc = spawn([path, '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const verifyExit = await verifyProc.exited;
    if (verifyExit !== 0) {
      log('[tmux] findTmuxPath: tmux -V failed', { path, verifyExit });
      return null;
    }

    log('[tmux] findTmuxPath: found tmux', { path });
    return path;
  } catch (err) {
    log('[tmux] findTmuxPath: exception', { error: String(err) });
    return null;
  }
}

/**
 * Get cached tmux path, initializing if needed
 */
export async function getTmuxPath(): Promise<string | null> {
  if (tmuxChecked) {
    return tmuxPath;
  }

  tmuxPath = await findTmuxPath();
  tmuxChecked = true;
  log('[tmux] getTmuxPath: initialized', { tmuxPath });
  return tmuxPath;
}

/**
 * Check if we're running inside tmux
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Apply a tmux layout to the current window
 */
async function applyLayout(
  tmux: string,
  layout: TmuxLayout,
  mainPaneSize: number,
): Promise<void> {
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

export interface SpawnPaneResult {
  success: boolean;
  paneId?: string; // e.g., "%42"
}

/**
 * Spawn a new tmux pane running `opencode attach <serverUrl> --session <sessionId>`
 * This connects the new TUI to the existing server so it receives streaming updates.
 * After spawning, applies the configured layout to auto-rebalance all panes.
 * Returns the pane ID so it can be closed later.
 */
export async function spawnTmuxPane(
  sessionId: string,
  description: string,
  config: TmuxConfig,
  serverUrl: string,
): Promise<SpawnPaneResult> {
  log('[tmux] spawnTmuxPane called', {
    sessionId,
    description,
    config,
    serverUrl,
  });

  if (!config.enabled) {
    log('[tmux] spawnTmuxPane: config.enabled is false, skipping');
    return { success: false };
  }

  if (!isInsideTmux()) {
    log('[tmux] spawnTmuxPane: not inside tmux, skipping');
    return { success: false };
  }

  // Check if the OpenCode HTTP server is actually running
  // This is needed because serverUrl may be a fallback even when no server is running
  const serverRunning = await isServerRunning(serverUrl);
  if (!serverRunning) {
    const defaultPort = process.env.OPENCODE_PORT ?? '4096';
    log('[tmux] spawnTmuxPane: OpenCode server not running, skipping', {
      serverUrl,
      hint: `Start opencode with --port ${defaultPort}`,
    });
    return { success: false };
  }

  const tmux = await getTmuxPath();
  if (!tmux) {
    log('[tmux] spawnTmuxPane: tmux binary not found, skipping');
    return { success: false };
  }

  // Store config for use in closeTmuxPane
  storedConfig = config;

  try {
    // Use `opencode attach <url> --session <id>` to connect to the existing server
    // This ensures the TUI receives streaming updates from the same server handling the prompt
    const opencodeCmd = `opencode attach ${serverUrl} --session ${sessionId}`;

    // Simple split - layout will handle positioning
    // Use -h for horizontal split (new pane to the right) as default
    const args = [
      'split-window',
      '-h',
      '-d', // Don't switch focus to new pane
      '-P', // Print pane info
      '-F',
      '#{pane_id}', // Format: just the pane ID
      opencodeCmd,
    ];

    log('[tmux] spawnTmuxPane: executing', { tmux, args, opencodeCmd });

    const proc = spawn([tmux, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const paneId = stdout.trim(); // e.g., "%42"

    log('[tmux] spawnTmuxPane: split result', {
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

      // Apply layout to auto-rebalance all panes
      const layout = config.layout ?? 'main-vertical';
      const mainPaneSize = config.main_pane_size ?? 60;
      await applyLayout(tmux, layout, mainPaneSize);

      log('[tmux] spawnTmuxPane: SUCCESS, pane created and layout applied', {
        paneId,
        layout,
      });
      return { success: true, paneId };
    }

    return { success: false };
  } catch (err) {
    log('[tmux] spawnTmuxPane: exception', { error: String(err) });
    return { success: false };
  }
}

/**
 * Close a tmux pane by its ID and reapply layout to rebalance remaining panes
 */
export async function closeTmuxPane(paneId: string): Promise<boolean> {
  log('[tmux] closeTmuxPane called', { paneId });

  if (!paneId) {
    log('[tmux] closeTmuxPane: no paneId provided');
    return false;
  }

  const tmux = await getTmuxPath();
  if (!tmux) {
    log('[tmux] closeTmuxPane: tmux binary not found');
    return false;
  }

  try {
    // Send Ctrl+C for graceful shutdown first
    log('[tmux] closeTmuxPane: sending Ctrl+C for graceful shutdown', {
      paneId,
    });
    const ctrlCProc = spawn([tmux, 'send-keys', '-t', paneId, 'C-c'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await ctrlCProc.exited;

    // Wait for graceful shutdown
    await new Promise((r) => setTimeout(r, 250));

    log('[tmux] closeTmuxPane: killing pane', { paneId });
    const proc = spawn([tmux, 'kill-pane', '-t', paneId], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    log('[tmux] closeTmuxPane: result', { exitCode, stderr: stderr.trim() });

    if (exitCode === 0) {
      log('[tmux] closeTmuxPane: SUCCESS, pane closed', { paneId });

      // Reapply layout to rebalance remaining panes
      if (storedConfig) {
        const layout = storedConfig.layout ?? 'main-vertical';
        const mainPaneSize = storedConfig.main_pane_size ?? 60;
        await applyLayout(tmux, layout, mainPaneSize);
        log('[tmux] closeTmuxPane: layout reapplied', { layout });
      }

      return true;
    }

    // Pane might already be closed (user closed it manually, or process exited)
    log('[tmux] closeTmuxPane: failed (pane may already be closed)', {
      paneId,
    });
    return false;
  } catch (err) {
    log('[tmux] closeTmuxPane: exception', { error: String(err) });
    return false;
  }
}

/**
 * Start background check for tmux availability
 */
export function startTmuxCheck(): void {
  if (!tmuxChecked) {
    getTmuxPath().catch(() => {});
  }
}
