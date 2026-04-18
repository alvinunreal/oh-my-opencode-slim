/**
 * Zellij multiplexer implementation
 *
 * Creates a dedicated "opencode-agents" tab for all sub-agent panes.
 * - First sub-agent uses the default pane from new-tab
 * - Subsequent sub-agents create new panes
 * - User stays in their original tab
 */

import type { MultiplexerLayout } from '../../config/schema';
import { crossSpawn } from '../../utils/compat';
import type { Multiplexer, PaneResult } from '../types';

interface ZellijTabInfo {
  position: number;
  name: string;
  active: boolean;
  tab_id: number;
}

export class ZellijMultiplexer implements Multiplexer {
  readonly type = 'zellij' as const;

  private binaryPath: string | null = null;
  private hasChecked = false;
  private agentTabId: string | null = null;
  private firstPaneId: string | null = null;
  private firstPaneUsed = false;

  constructor(layout: MultiplexerLayout = 'main-vertical', mainPaneSize = 60) {
    // Note: Zellij does NOT support layout configuration like tmux.
    // These params are accepted for API consistency but are no-ops.
    // Zellij uses its own native layout algorithm for pane arrangement.
    void layout;
    void mainPaneSize;
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
    return !!process.env.ZELLIJ;
  }

  async spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
  ): Promise<PaneResult> {
    const zellij = await this.getBinary();
    if (!zellij) return { success: false };

    try {
      // Ensure agent tab exists on first call
      if (!this.agentTabId) {
        const result = await this.ensureAgentTab(zellij);
        if (!result) return { success: false };
        this.agentTabId = result.tabId;
        this.firstPaneId = result.firstPaneId;
      }

      // Use the default pane from new-tab for the first sub-agent
      if (!this.firstPaneUsed && this.firstPaneId) {
        const success = await this.runInPane(
          zellij,
          this.firstPaneId,
          sessionId,
          serverUrl,
          directory,
          description,
        );
        if (success) {
          this.firstPaneUsed = true;
          return { success: true, paneId: this.firstPaneId };
        }
        // fall through to createPaneInAgentTab on failure
      }

      // Create additional pane
      return await this.createPaneInAgentTab(
        zellij,
        sessionId,
        serverUrl,
        directory,
        description,
      );
    } catch {
      return { success: false };
    }
  }

  private async createPaneInAgentTab(
    zellij: string,
    sessionId: string,
    serverUrl: string,
    directory: string,
    description: string,
  ): Promise<PaneResult> {
    const opencodeCmd = buildOpencodeAttachCommand(
      sessionId,
      serverUrl,
      directory,
    );
    const paneName = description.slice(0, 30).replace(/"/g, '\\"');

    const currentTabId = await this.getCurrentTabId(zellij);
    const inAgentTab = currentTabId === this.agentTabId;

    if (inAgentTab) {
      // Already in agent tab, create pane directly
      const args = [
        'action',
        'new-pane',
        '--name',
        paneName,
        '--close-on-exit',
        '--',
        'sh',
        '-lc',
        opencodeCmd,
      ];

      const proc = crossSpawn([zellij, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      const stdout = await proc.stdout();
      const paneId = stdout.trim();

      // Accept success if exit code is 0 and we got a valid pane ID
      if (exitCode === 0 && paneId?.startsWith('terminal_')) {
        return { success: true, paneId };
      }
      return { success: false };
    }

    if (!this.agentTabId) {
      return { success: false };
    }

    // Get current tab before switching
    const originalTab = await this.getCurrentTabId(zellij);

    // Switch to agent tab
    await crossSpawn([zellij, 'action', 'go-to-tab-by-id', this.agentTabId], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;

    // Create pane
    const args = [
      'action',
      'new-pane',
      '--name',
      paneName,
      '--close-on-exit',
      '--',
      'sh',
      '-lc',
      opencodeCmd,
    ];

    const proc = crossSpawn([zellij, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stdout = await proc.stdout();
    const paneId = stdout.trim();

    // Switch back to original tab
    if (originalTab) {
      await crossSpawn(
        [zellij, 'action', 'go-to-tab-by-id', String(originalTab)],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ).exited;
    }

    // Accept success if exit code is 0 and we got a valid pane ID
    if (exitCode === 0 && paneId?.startsWith('terminal_')) {
      return { success: true, paneId };
    }
    return { success: false };
  }

  private async runInPane(
    zellij: string,
    paneId: string,
    sessionId: string,
    serverUrl: string,
    directory: string,
    description: string,
  ): Promise<boolean> {
    try {
      const opencodeCmd = buildOpencodeAttachCommand(
        sessionId,
        serverUrl,
        directory,
      );

      await crossSpawn([zellij, 'action', 'focus-pane', '--pane-id', paneId], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      await crossSpawn(
        [zellij, 'action', 'rename-pane', '--name', description.slice(0, 30)],
        { stdout: 'ignore', stderr: 'ignore' },
      ).exited;

      await crossSpawn(
        [zellij, 'action', 'write-chars', buildShellLaunchCommand(opencodeCmd)],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ).exited;

      await crossSpawn([zellij, 'action', 'write-chars', '\n'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      return true;
    } catch {
      return false;
    }
  }

  private async ensureAgentTab(
    zellij: string,
  ): Promise<{ tabId: string; firstPaneId: string } | null> {
    try {
      // Try to find existing tab
      const existingTab = await this.findTabByName(zellij, 'opencode-agents');
      if (existingTab) {
        const firstPane = await this.getFirstPaneInTab(
          zellij,
          existingTab.tabId,
        );
        return {
          tabId: existingTab.tabId,
          firstPaneId: firstPane || 'terminal_0',
        };
      }

      // Get panes before creating tab
      const beforePanes = await this.listPanes(zellij);

      // Create new tab
      const createProc = crossSpawn(
        [zellij, 'action', 'new-tab', '--name', 'opencode-agents'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const createExit = await createProc.exited;
      if (createExit !== 0) return null;

      // Get the new tab info
      const newTab = await this.findTabByName(zellij, 'opencode-agents');
      if (!newTab) return null;

      // Get the new pane
      const afterPanes = await this.listPanes(zellij);
      const newPane = afterPanes.find((p) => !beforePanes.includes(p));

      return { tabId: newTab.tabId, firstPaneId: newPane || 'terminal_0' };
    } catch {
      return null;
    }
  }

  private async getFirstPaneInTab(
    zellij: string,
    tabId: string,
  ): Promise<string | null> {
    const originalTab = await this.getCurrentTabId(zellij);
    await crossSpawn([zellij, 'action', 'go-to-tab-by-id', tabId], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;

    const panes = await this.listPanes(zellij);

    // Restore original tab
    if (originalTab) {
      await crossSpawn(
        [zellij, 'action', 'go-to-tab-by-id', String(originalTab)],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ).exited;
    }

    return panes[0] || null;
  }

  private async findTabByName(
    zellij: string,
    name: string,
  ): Promise<{ tabId: string; name: string } | null> {
    try {
      const proc = crossSpawn([zellij, 'action', 'list-tabs', '--json'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) return this.findTabByNameText(zellij, name);

      const stdout = await proc.stdout();

      try {
        const tabs: ZellijTabInfo[] = JSON.parse(stdout);
        for (const tab of tabs) {
          if (tab.name === name) {
            return { tabId: String(tab.tab_id), name: tab.name };
          }
        }
      } catch {
        return this.findTabByNameText(zellij, name);
      }
      return null;
    } catch {
      return null;
    }
  }

  private async findTabByNameText(
    zellij: string,
    name: string,
  ): Promise<{ tabId: string; name: string } | null> {
    try {
      const proc = crossSpawn([zellij, 'action', 'list-tabs'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;

      const stdout = await proc.stdout();
      const lines = stdout.split('\n');

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[2] === name) {
          return { tabId: parts[0], name: parts[2] };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async getCurrentTabId(zellij: string): Promise<string | null> {
    try {
      const proc = crossSpawn(
        [zellij, 'action', 'current-tab-info', '--json'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );

      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;

      const stdout = await proc.stdout();
      try {
        const info = JSON.parse(stdout);
        return String(info.tab_id);
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  private async listPanes(zellij: string): Promise<string[]> {
    try {
      const proc = crossSpawn([zellij, 'action', 'list-panes'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) return [];

      const stdout = await proc.stdout();
      return stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((id) => id?.startsWith('terminal_'));
    } catch {
      return [];
    }
  }

  async closePane(paneId: string): Promise<boolean> {
    if (!paneId || paneId === 'unknown') return true;

    const zellij = await this.getBinary();
    if (!zellij) return false;

    try {
      // Send Ctrl+C for graceful shutdown
      await crossSpawn(
        [zellij, 'action', 'write', '--pane-id', paneId, '\u0003'],
        {
          stdout: 'ignore',
          stderr: 'ignore',
        },
      ).exited;

      await new Promise((r) => setTimeout(r, 250));

      // Close the pane
      const proc = crossSpawn(
        [zellij, 'action', 'close-pane', '--pane-id', paneId],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const exitCode = await proc.exited;
      return exitCode === 0 || exitCode === 1;
    } catch {
      return false;
    }
  }

  async applyLayout(
    _layout: MultiplexerLayout,
    _mainPaneSize: number,
  ): Promise<void> {
    // No-op for zellij - zellij uses its own native layout algorithm.
    // Unlike tmux, zellij does not support programmatic layout control.
  }

  private async getBinary(): Promise<string | null> {
    await this.isAvailable();
    return this.binaryPath;
  }

  private async findBinary(): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const proc = crossSpawn([cmd, 'zellij'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if ((await proc.exited) !== 0) return null;
      const stdout = await proc.stdout();
      return stdout.trim().split('\n')[0] || null;
    } catch {
      return null;
    }
  }
}

function buildOpencodeAttachCommand(
  sessionId: string,
  serverUrl: string,
  directory: string,
): string {
  return [
    'opencode',
    'attach',
    quoteShellArg(serverUrl),
    '--session',
    quoteShellArg(sessionId),
    '--dir',
    quoteShellArg(directory),
  ].join(' ');
}

function buildShellLaunchCommand(command: string): string {
  return ['sh', '-lc', quoteShellArg(command)].join(' ');
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
