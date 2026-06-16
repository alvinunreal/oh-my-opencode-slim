import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompanionConfig } from '../config/schema';
import { log } from '../utils/logger';

interface CompanionSession {
  session_id: string;
  cwd: string;
  active_agents: string[];
  status: string;
  pid: number;
  config?: CompanionState['config'];
}

interface CompanionState {
  version: 1;
  sessions: CompanionSession[];
  window_positions?: Record<string, { x: number; y: number }>;
  config?: {
    enabled: boolean;
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    size: 'small' | 'medium' | 'large';
    gifPack: 'default';
    loopStyle: 'classic' | 'smooth';
    speed: number;
    debug: boolean;
  };
}

export function stateFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), '.local', 'share');
  return path.join(
    base,
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    'companion-state.json',
  );
}

function defaultBinaryPath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), '.local', 'share');
  const binaryName =
    os.platform() === 'win32'
      ? 'oh-my-opencode-slim-companion.exe'
      : 'oh-my-opencode-slim-companion';
  return path.join(
    base,
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    'bin',
    binaryName,
  );
}

export function resolveCompanionBinaryPath(
  config?: CompanionConfig,
): string | null {
  const configured = config?.binaryPath?.trim();
  const bin = configured || defaultBinaryPath();
  return existsSync(bin) ? bin : null;
}

function readState(): CompanionState {
  try {
    const raw = readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CompanionState>;
    if (parsed?.version === 1 && Array.isArray(parsed.sessions)) {
      return parsed as CompanionState;
    }
  } catch {}
  return { version: 1, sessions: [] };
}

function writeState(mutator: (state: CompanionState) => void): void {
  const file = stateFilePath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const release = acquireStateLock(file);
    try {
      const state = readState();
      mutator(state);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
    } finally {
      release();
    }
  } catch (err) {
    log('[companion] write failed', String(err));
  }
}

function acquireStateLock(file: string): () => void {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      mkdirSync(lock);
      return () => {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {}
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw new Error('timed out waiting for companion state lock');
}

/**
 * Tracks live agent activity per session and mirrors it to the companion
 * state file. Source of truth is OpenCode's session.status events: every
 * spawned specialist (foreground or background) runs in its own session,
 * which reports busy/idle independently. Tool-call lifecycles are NOT used
 * because background Task launches return immediately while the agent keeps
 * running in its child session.
 */
export class CompanionManager {
  private readonly id: string;
  private readonly cwd: string;
  private status = 'idle';
  /** sessionId → agent name, for sessions currently busy. */
  private readonly busyAgentSessions = new Map<string, string>();
  private readonly config?: CompanionConfig;
  private companionProcess: ChildProcess | null = null;

  constructor(sessionId: string, cwd: string, config?: CompanionConfig) {
    this.id = sessionId;
    this.cwd = cwd;
    this.config = config;
  }

  onLoad(): void {
    if (this.config?.enabled !== true) {
      try {
        if (!existsSync(stateFilePath())) return;
        writeState((state) => {
          state.sessions = state.sessions.filter(
            (s) => s.session_id !== this.id,
          );
        });
      } catch {}
      return;
    }
    process.on('exit', () => this.onExit());
    this.flush();
    this.spawnIfAvailable();
  }

  /**
   * Feed every session.status event here, with the agent name resolved
   * from sessionAgentMap. Orchestrator sessions drive overall status;
   * specialist sessions drive the per-agent GIF grid.
   */
  onSessionStatus(input: {
    sessionId?: string;
    agent?: string;
    status?: string;
  }): void {
    if (this.config?.enabled !== true) return;
    const { sessionId, agent, status } = input;
    if (!sessionId || (status !== 'busy' && status !== 'idle')) return;

    if (agent === 'orchestrator') {
      // Orchestrator going idle does NOT clear specialists: with background
      // orchestration it idles while dispatched agents are still running.
      // Specialists are removed only by their own idle/deleted events.
      this.status = status;
      this.flush();
      return;
    }

    if (status === 'busy') {
      if (!agent) return;
      this.busyAgentSessions.set(sessionId, agent);
    } else {
      // Remove by session even when the agent name is unknown, so a
      // finished specialist can never get stuck on screen.
      this.busyAgentSessions.delete(sessionId);
    }
    this.flush();
  }

  onSessionDeleted(sessionId: string | undefined): void {
    if (this.config?.enabled !== true) return;
    if (!sessionId) return;
    if (this.busyAgentSessions.delete(sessionId)) {
      this.flush();
    }
  }

  onWaitingInput(): void {
    if (this.config?.enabled !== true) return;
    this.status = 'waiting-input';
    this.flush();
  }

  onInputResolved(): void {
    if (this.config?.enabled !== true) return;
    this.status = this.busyAgentSessions.size > 0 ? 'busy' : 'idle';
    this.flush();
  }

  onExit(): void {
    if (this.config?.enabled !== true) return;
    if (this.companionProcess) {
      try {
        this.companionProcess.kill();
      } catch {}
      this.companionProcess = null;
    }
    writeState((state) => {
      state.sessions = state.sessions.filter((s) => s.session_id !== this.id);
    });
  }

  /** One entry per running agent instance (two fixers → two cells). */
  private activeAgents(): string[] {
    const agents = Array.from(this.busyAgentSessions.values());
    if (agents.length > 0) return agents.slice(0, 9);
    if (this.status === 'waiting-input') return ['input'];
    if (this.status === 'busy') return ['orchestrator'];
    return ['intro'];
  }

  private flush(): void {
    if (this.config?.enabled !== true) return;
    try {
      const entry: CompanionSession = {
        session_id: this.id,
        cwd: this.cwd,
        active_agents: this.activeAgents(),
        status: this.status,
        pid: process.pid,
        config: this.config
          ? {
              enabled: this.config.enabled ?? false,
              position: this.config.position ?? 'bottom-right',
              size: this.config.size ?? 'medium',
              gifPack: this.config.gifPack ?? 'default',
              loopStyle: this.config.loopStyle ?? 'classic',
              speed: this.config.speed ?? 1,
              debug: this.config.debug ?? false,
            }
          : undefined,
      };
      writeState((state) => {
        const idx = state.sessions.findIndex((s) => s.session_id === this.id);
        if (idx >= 0) {
          state.sessions[idx] = entry;
        } else {
          state.sessions.push(entry);
        }
        if (this.config) {
          state.config = {
            enabled: this.config.enabled ?? false,
            position: this.config.position ?? 'bottom-right',
            size: this.config.size ?? 'medium',
            gifPack: this.config.gifPack ?? 'default',
            loopStyle: this.config.loopStyle ?? 'classic',
            speed: this.config.speed ?? 1,
            debug: this.config.debug ?? false,
          };
        }
      });
    } catch (err) {
      log('[companion] flush failed', String(err));
    }
  }

  private spawnIfAvailable(): void {
    if (this.config?.enabled !== true) return;
    const bin = resolveCompanionBinaryPath(this.config);
    if (!bin) {
      const expected = this.config.binaryPath?.trim() || defaultBinaryPath();
      log(
        `[companion] enabled but companion binary not found at expected path: ${expected}. Please install/download the companion binary separately.`,
      );
      return;
    }
    try {
      const child = spawn(bin, [], {
        detached: true,
        env: {
          ...process.env,
          OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID: this.id,
          ...(this.config.debug === true
            ? { OH_MY_OPENCODE_SLIM_COMPANION_DEBUG: '1' }
            : {}),
        },
        stdio: 'ignore',
      });
      this.companionProcess = child;
      child.unref();
      log(
        '[companion] spawned',
        JSON.stringify({
          bin,
          sessionId: this.id,
          debug: this.config.debug === true,
        }),
      );
    } catch (err) {
      log('[companion] spawn failed', String(err));
    }
  }
}
