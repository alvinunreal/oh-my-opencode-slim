import { spawn } from "bun";
import { log } from "../shared/logger";
import type { TmuxConfig, TmuxLayout } from "../config/schema";
import { sleep } from "./polling";

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

  const healthUrl = new URL("/health", serverUrl).toString();
  const timeoutMs = 3000;
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response | null = null;
    try {
      response = await fetch(healthUrl, { signal: controller.signal }).catch(() => null);
    } finally {
      clearTimeout(timeout);
    }

    const available = response?.ok ?? false;
    if (available) {
      serverCheckUrl = serverUrl;
      serverAvailable = true;
      log("[tmux] health-check: success", { serverUrl, available, attempt });
      return true;
    }

    if (attempt < maxAttempts) {
      await sleep(250);
    }
  }

  log("[tmux] health-check: failed", { serverUrl, available: false });
  return false;
}

/**
 * Reset the server availability cache (useful when server might have started)
 */
/**
 * Resets the server availability cache.
 */
export function resetServerCheck(): void {
  serverAvailable = null;
  serverCheckUrl = null;
}

/**
 * Find tmux binary path
 */
async function findTmuxPath(): Promise<string | null> {
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "where" : "which";

  try {
    const proc = spawn([cmd, "tmux"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log("[tmux] find: 'which tmux' failed", { exitCode });
      return null;
    }

    const stdout = await new Response(proc.stdout).text();
    const path = stdout.trim().split("\n")[0];
    if (!path) {
      log("[tmux] find: no path in output");
      return null;
    }

    // Verify it works
    const verifyProc = spawn([path, "-V"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const verifyExit = await verifyProc.exited;
    if (verifyExit !== 0) {
      log("[tmux] find: tmux -V failed", { path, verifyExit });
      return null;
    }

    log("[tmux] find: found tmux", { path });
    return path;
  } catch (err) {
    log("[tmux] find: exception", { error: err instanceof Error ? err.message : String(err) });
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
  log("[tmux] init: initialized", { tmuxPath });
  return tmuxPath;
}

/**
 * Check if we're running inside tmux
 */
/**
 * Checks if the current process is running inside a tmux session.
 * @returns True if running inside tmux, false otherwise.
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Apply a tmux layout to the current window
 */
async function applyLayout(tmux: string, layout: TmuxLayout, mainPaneSize: number): Promise<void> {
  try {
    // Apply the layout
    const layoutProc = spawn([tmux, "select-layout", layout], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await layoutProc.exited;

    // For main-* layouts, set the main pane size
    if (layout === "main-horizontal" || layout === "main-vertical") {
      const sizeOption = layout === "main-horizontal" 
        ? "main-pane-height" 
        : "main-pane-width";
      
      const sizeProc = spawn([tmux, "set-window-option", sizeOption, `${mainPaneSize}%`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await sizeProc.exited;

      // Reapply layout to use the new size
      const reapplyProc = spawn([tmux, "select-layout", layout], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await reapplyProc.exited;
    }

    log("[tmux] apply-layout: applied", { layout, mainPaneSize });
  } catch (err) {
    log("[tmux] apply-layout: exception", { error: err instanceof Error ? err.message : String(err) });
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
  serverUrl: string
): Promise<SpawnPaneResult> {
  log("[tmux] spawn: start", { sessionId, description, config, serverUrl });

  if (!config.enabled) {
    log("[tmux] spawn: disabled in config");
    return { success: false };
  }

  if (!isInsideTmux()) {
    log("[tmux] spawn: not inside tmux");
    return { success: false };
  }

  // Check if the OpenCode HTTP server is actually running
  // This is needed because serverUrl may be a fallback even when no server is running
  const serverRunning = await isServerRunning(serverUrl);
  if (!serverRunning) {
    log("[tmux] spawn: server not running", {
      serverUrl,
      hint: "Start opencode with --port 4096"
    });
    return { success: false };
  }

  const tmux = await getTmuxPath();
  if (!tmux) {
    log("[tmux] spawn: binary not found");
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
      "split-window",
      "-h",
      "-d", // Don't switch focus to new pane
      "-P", // Print pane info
      "-F", "#{pane_id}", // Format: just the pane ID
      opencodeCmd,
    ];

    log("[tmux] spawn: executing", { tmux, args, opencodeCmd });

    const proc = spawn([tmux, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const paneId = stdout.trim(); // e.g., "%42"

    log("[tmux] spawn: result", { exitCode, paneId, stderr: stderr.trim() });

    if (exitCode === 0 && paneId) {
      // Rename the pane for visibility
      const renameProc = spawn(
        [tmux, "select-pane", "-t", paneId, "-T", description.slice(0, 30)],
        { stdout: "ignore", stderr: "ignore" }
      );
      await renameProc.exited;

      // Apply layout to auto-rebalance all panes
      const layout = config.layout ?? "main-vertical";
      const mainPaneSize = config.main_pane_size ?? 60;
      await applyLayout(tmux, layout, mainPaneSize);

      log("[tmux] spawn: success", { paneId, layout });
      return { success: true, paneId };
    }

    return { success: false };
  } catch (err) {
    log("[tmux] spawn: exception", { error: err instanceof Error ? err.message : String(err) });
    return { success: false };
  }
}

/**
 * Close a tmux pane by its ID and reapply layout to rebalance remaining panes
 */
export async function closeTmuxPane(paneId: string): Promise<boolean> {
  log("[tmux] close: start", { paneId });

  if (!paneId) {
    log("[tmux] close: no paneId provided");
    return false;
  }

  const tmux = await getTmuxPath();
  if (!tmux) {
    log("[tmux] close: binary not found");
    return false;
  }

  try {
    const proc = spawn([tmux, "kill-pane", "-t", paneId], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    log("[tmux] close: result", { exitCode, stderr: stderr.trim() });

    if (exitCode === 0) {
      log("[tmux] close: success", { paneId });

      // Reapply layout to rebalance remaining panes
      if (storedConfig) {
        const layout = storedConfig.layout ?? "main-vertical";
        const mainPaneSize = storedConfig.main_pane_size ?? 60;
        await applyLayout(tmux, layout, mainPaneSize);
        log("[tmux] close: layout reapplied", { layout });
      }

      return true;
    }

    // Pane might already be closed (user closed it manually, or process exited)
    log("[tmux] close: failed (pane may already be closed)", { paneId });
    return false;
  } catch (err) {
    log("[tmux] close: exception", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Start background check for tmux availability
 */
/**
 * Starts a background check for tmux availability by looking for the binary path.
 */
export function startTmuxCheck(): void {
  if (!tmuxChecked) {
    getTmuxPath().catch(() => {});
  }
}
