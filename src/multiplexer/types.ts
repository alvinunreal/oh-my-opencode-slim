/**
 * Multiplexer abstraction layer
 *
 * Provides a unified interface for terminal multiplexers (tmux, zellij, etc.)
 * to spawn and manage panes for background task visualization.
 */

import type { MultiplexerConfig, MultiplexerLayout } from '../config/schema';

export interface PaneResult {
  success: boolean;
  paneId?: string;
}

/**
 * Core multiplexer interface
 * Implementations: TmuxMultiplexer, ZellijMultiplexer
 */
export interface Multiplexer {
  readonly type: 'tmux' | 'zellij';

  /**
   * Check if the multiplexer binary is available on the system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Check if currently running inside a multiplexer session
   */
  isInsideSession(): boolean;

  /**
   * Spawn a new pane running the given command
   * @param sessionId - The OpenCode session ID to attach to
   * @param description - Human-readable description for the pane
   * @param serverUrl - The OpenCode server URL to attach to
   * @param directory - The project directory to attach from
   */
  spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult>;

  /**
   * Close a pane by its ID
   * @param paneId - The pane ID returned by spawnPane
   * @returns true if successfully closed
   */
  closePane(paneId: string): Promise<boolean>;

  /**
   * Apply layout to rebalance panes
   * @param layout - The layout type to apply
   * @param mainPaneSize - Percentage for main pane (for main-* layouts)
   */
  applyLayout(layout: MultiplexerLayout, mainPaneSize: number): Promise<void>;
}

/**
 * Factory function type for creating multiplexer instances
 */
export type MultiplexerFactory = (config: MultiplexerConfig) => Multiplexer;

/**
 * Server health check utility (shared across implementations)
 */
export async function isServerRunning(
  serverUrl: string,
  timeoutMs = 3000,
  maxAttempts = 2,
): Promise<boolean> {
  const healthUrl = new URL('/health', serverUrl).toString();

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

    if (response?.ok) {
      return true;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return false;
}
