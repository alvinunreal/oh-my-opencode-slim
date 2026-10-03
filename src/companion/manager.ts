import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type ConfigLoadWarningKind, loadPluginConfig } from '../config/loader';
import type { CompanionConfig } from '../config/schema';
import {
  clearProjectPresetOnDisk,
  getPresetSelectionState,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import { log } from '../utils/logger';

// Only one companion `process.on('exit')` listener should be live per process.
// The plugin function can re-run (config.update() → Instance.dispose()),
// constructing fresh CompanionManager instances; without deduping, every
// re-init would leak another exit listener. Track live managers separately so
// replacing the listener never drops cleanup for detached companion children.
// Module-level state survives re-inits because the module itself is not
// re-evaluated.
let activeExitListener: (() => void) | null = null;
const activeManagers = new Set<CompanionManager>();
const MAX_PRESET_REQUESTS = 64;
const PRESET_REFRESH_EVERY_TICKS = 4;
const HARD_PRESET_REFRESH_WARNING_KINDS: ReadonlySet<ConfigLoadWarningKind> =
  new Set(['invalid-json', 'invalid-schema', 'read-error']);

interface CompanionPresetState {
  /** Backward-compatible effective view for older Companion binaries. */
  current?: string;
  available: string[];
  effective?: string;
  project?: string;
  global?: string;
  project_available?: string[];
  global_available?: string[];
  message?: string;
  last_request_id?: string;
  result_ok?: boolean;
  last_scope?: CompanionPresetScope;
}

type CompanionPresetScope = 'effective' | 'project' | 'global';

interface CompanionPresetRequest {
  request_id: string;
  session_id: string;
  scope?: CompanionPresetScope;
  preset?: string;
  inherit?: boolean;
}

interface CompanionSession {
  session_id: string;
  cwd: string;
  active_agents: string[];
  status: string;
  pid: number;
  config?: CompanionState['config'];
  preset?: CompanionPresetState;
}

interface CompanionState {
  version: 1;
  sessions: CompanionSession[];
  window_positions?: Record<string, { x: number; y: number }>;
  preset_requests?: CompanionPresetRequest[];
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

function pidFilePath(): string {
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
    'companion.pid',
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePidFile(raw: string): number | null {
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

function acquirePidFileLock(file: string): (() => void) | null {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, 'owner'), String(process.pid));
      return () => {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch (err) {
          log('[companion] lock release failed', String(err));
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (pidFileLockHasLiveOwner(lock)) return null;
      log('[companion] removing stale PID file lock for dead process');
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return null;
}

function acquirePidFileLockWithRetry(
  file: string,
  attempts: number,
): (() => void) | null {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const release = acquirePidFileLock(file);
    if (release) return release;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

function pidFileLockHasLiveOwner(lock: string): boolean {
  try {
    const owner = parsePidFile(readFileSync(path.join(lock, 'owner'), 'utf8'));
    if (owner !== null) return isProcessAlive(owner);
  } catch (err) {
    log('[companion] lock owner check failed', String(err));
    try {
      return Date.now() - statSync(lock).mtimeMs < 5000;
    } catch (err) {
      log('[companion] lock owner check failed', String(err));
    }
  }
  return false;
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
  } catch (err) {
    log('[companion] state load failed', String(err));
  }
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
        } catch (err) {
          log('[companion] lock release failed', String(err));
        }
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
  private wasSpawner = false;
  private spawnedCompanionPid: number | null = null;
  private presetPoller: NodeJS.Timeout | null = null;
  private presetRefreshTick = 0;
  private effectivePreset: string | undefined;
  private projectPreset: string | undefined;
  private globalPreset: string | undefined;
  private projectAvailablePresets: string[] = [];
  private globalAvailablePresets: string[] = [];
  private presetMessage: string | undefined;
  private presetLastRequestId: string | undefined;
  private presetResultOk: boolean | undefined;
  private presetLastScope: CompanionPresetScope | undefined;

  constructor(sessionId: string, cwd: string, config?: CompanionConfig) {
    this.id = sessionId;
    this.cwd = cwd;
    this.config = config;
  }

  private refreshPresetState(): boolean {
    let hardWarning = false;
    loadPluginConfig(this.cwd, {
      silent: true,
      onWarning: (warning) => {
        if (HARD_PRESET_REFRESH_WARNING_KINDS.has(warning.kind)) {
          hardWarning = true;
        }
      },
    });
    if (hardWarning) return false;

    const next = getPresetSelectionState(this.cwd);
    const projectCatalogChanged =
      this.projectAvailablePresets.length !== next.projectAvailable.length ||
      this.projectAvailablePresets.some(
        (name, index) => name !== next.projectAvailable[index],
      );
    const globalCatalogChanged =
      this.globalAvailablePresets.length !== next.globalAvailable.length ||
      this.globalAvailablePresets.some(
        (name, index) => name !== next.globalAvailable[index],
      );
    const changed =
      this.effectivePreset !== next.effective ||
      this.projectPreset !== next.project ||
      this.globalPreset !== next.global ||
      projectCatalogChanged ||
      globalCatalogChanged;

    if (!changed) return false;
    this.effectivePreset = next.effective;
    this.projectPreset = next.project;
    this.globalPreset = next.global;
    this.projectAvailablePresets = next.projectAvailable;
    this.globalAvailablePresets = next.globalAvailable;
    return true;
  }

  private pollPresetState(): void {
    if (this.config?.enabled !== true) return;
    if (this.consumePresetRequest()) {
      this.presetRefreshTick = 0;
      return;
    }

    this.presetRefreshTick += 1;
    if (this.presetRefreshTick < PRESET_REFRESH_EVERY_TICKS) return;
    this.presetRefreshTick = 0;

    if (this.refreshPresetState()) {
      // An external /preset or manual config edit supersedes feedback from an
      // older Companion request.
      this.presetMessage = undefined;
      // Keep the last request id long enough for the native Companion to
      // observe completion even if an external edit races this refresh.
      this.presetResultOk = undefined;
      this.flush();
    }
  }

  private startPresetPoller(): void {
    if (this.presetPoller) return;
    this.presetPoller = setInterval(() => this.pollPresetState(), 250);
    this.presetPoller.unref();
  }

  private consumePresetRequest(): boolean {
    if (this.config?.enabled !== true) return false;
    const request = readState().preset_requests?.find(
      (candidate) => candidate.session_id === this.id,
    );
    if (!request) return false;

    const config = loadPluginConfig(this.cwd, { silent: true });
    const scope: CompanionPresetScope =
      request.scope === 'global'
        ? 'global'
        : request.scope === 'project'
          ? 'project'
          : 'effective';
    const result =
      scope === 'project' && request.inherit === true
        ? clearProjectPresetOnDisk(this.cwd)
        : typeof request.preset === 'string' && request.preset.trim()
          ? switchPresetOnDisk(this.cwd, request.preset, config, { scope })
          : {
              ok: false,
              presetName: '',
              message: 'Preset request is missing a preset name.',
              summary: [],
            };
    this.refreshPresetState();
    this.presetMessage = result.message;
    this.presetLastRequestId = request.request_id;
    this.presetResultOk = result.ok;
    this.presetLastScope = scope;

    writeState((state) => {
      state.preset_requests = (state.preset_requests ?? []).filter(
        (candidate) => candidate.request_id !== request.request_id,
      );
      if (state.preset_requests.length === 0) {
        delete state.preset_requests;
      } else if (state.preset_requests.length > MAX_PRESET_REQUESTS) {
        // Defense-in-depth for state written by an older/custom binary. The
        // native writer refuses to exceed this bound.
        state.preset_requests = state.preset_requests.slice(
          -MAX_PRESET_REQUESTS,
        );
      }
    });
    this.flush();
    return true;
  }

  onLoad(): void {
    if (this.config?.enabled !== true) {
      CompanionManager.disposeActiveManagers(this.id);
      try {
        if (!existsSync(stateFilePath())) return;
        writeState((state) => {
          state.sessions = state.sessions.filter(
            (s) => s.session_id !== this.id,
          );
        });
      } catch (err) {
        log('[companion] status update failed', String(err));
      }
      return;
    }
    this.registerActiveManager();
    this.refreshPresetState();
    this.flush();
    this.startPresetPoller();
    this.spawnIfAvailable();
  }

  /**
   * Register this manager behind a single process `exit` listener. Re-inits for
   * the same OpenCode session dispose the superseded manager immediately so its
   * detached child does not survive until process exit.
   */
  private registerActiveManager(): void {
    for (const manager of [...activeManagers]) {
      if (manager !== this && manager.id === this.id) {
        manager.onExit();
      }
    }

    activeManagers.add(this);
    if (!activeExitListener) {
      activeExitListener = () => CompanionManager.disposeActiveManagers();
      process.on('exit', activeExitListener);
    }
  }

  private static disposeActiveManagers(sessionId?: string): void {
    for (const manager of [...activeManagers]) {
      if (sessionId && manager.id !== sessionId) continue;
      manager.onExit();
    }
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
      // Accept busy sessions even without a known agent name — Herdr
      // subagents (spawned via opencode attach) often lack the agent
      // field, and dropping the event leaves them shown as idle.
      this.busyAgentSessions.set(sessionId, agent ?? sessionId);
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
    if (this.presetPoller) {
      clearInterval(this.presetPoller);
      this.presetPoller = null;
    }
    activeManagers.delete(this);
    if (activeManagers.size === 0 && activeExitListener) {
      try {
        process.removeListener('exit', activeExitListener);
      } catch (err) {
        log('[companion] exit listener removal failed', String(err));
      }
      activeExitListener = null;
    }
    if (this.config?.enabled !== true) return;
    writeState((state) => {
      state.sessions = state.sessions.filter((s) => s.session_id !== this.id);
      state.preset_requests = (state.preset_requests ?? []).filter(
        (request) => request.session_id !== this.id,
      );
      if (state.preset_requests.length === 0) delete state.preset_requests;
    });
    if (this.wasSpawner && this.removeOwnedPidFileIfNoSessionsRemain()) {
      if (this.companionProcess) {
        try {
          this.companionProcess.kill();
        } catch (err) {
          log('[companion] kill failed', String(err));
        }
      }
    }
    this.companionProcess = null;
  }

  private removeOwnedPidFileIfNoSessionsRemain(): boolean {
    if (this.spawnedCompanionPid == null) return true;
    const file = pidFilePath();
    const release = acquirePidFileLockWithRetry(file, 80);
    if (!release) {
      log('[companion] PID file lock busy during exit; leaving guard intact');
      return false;
    }
    try {
      if (readState().sessions.length > 0) return false;
      if (!existsSync(file)) return true;
      const parsed = parsePidFile(readFileSync(file, 'utf8'));
      if (parsed === this.spawnedCompanionPid) {
        rmSync(file, { force: true });
      }
      return true;
    } catch {
      return false;
    } finally {
      release();
    }
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
        preset: {
          current: this.effectivePreset,
          available: this.projectAvailablePresets,
          effective: this.effectivePreset,
          project: this.projectPreset,
          global: this.globalPreset,
          project_available: this.projectAvailablePresets,
          global_available: this.globalAvailablePresets,
          message: this.presetMessage,
          last_request_id: this.presetLastRequestId,
          result_ok: this.presetResultOk,
          last_scope: this.presetLastScope,
        },
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
    const pidFile = pidFilePath();
    let releasePidFileLock: (() => void) | null = null;
    try {
      releasePidFileLock = acquirePidFileLockWithRetry(pidFile, 80);
      if (releasePidFileLock === null) {
        log('[companion] another instance already running, skipping spawn');
        return;
      }
    } catch (err) {
      log('[companion] PID file lock failed', String(err));
      return;
    }
    let spawnedChild: ChildProcess | null = null;
    try {
      if (existsSync(pidFile)) {
        const existingPid = parsePidFile(readFileSync(pidFile, 'utf8'));
        if (existingPid !== null && isProcessAlive(existingPid)) {
          log('[companion] another instance already running, skipping spawn');
          return;
        }
        log('[companion] removing stale PID file for dead process');
        rmSync(pidFile, { force: true });
      }
      const bin = resolveCompanionBinaryPath(this.config);
      if (!bin) {
        const expected = this.config.binaryPath?.trim() || defaultBinaryPath();
        log(
          `[companion] enabled but companion binary not found at expected path: ${expected}. Please install/download the companion binary separately.`,
        );
        return;
      }
      const child = spawn(bin, [], {
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          OH_MY_OPENCODE_SLIM_COMPANION_SESSION_ID: this.id,
          ...(this.config.debug === true
            ? { OH_MY_OPENCODE_SLIM_COMPANION_DEBUG: '1' }
            : {}),
        },
        stdio: 'ignore',
      });
      spawnedChild = child;
      child.once('error', (err) => {
        log('[companion] spawn failed', String(err));
      });
      this.companionProcess = child;
      child.unref();
      if (child.pid == null) {
        log('[companion] spawn returned without a child PID, skipping guard');
        return;
      }
      writeFileSync(pidFile, String(child.pid));
      this.wasSpawner = true;
      this.spawnedCompanionPid = child.pid;
      log(
        '[companion] spawned',
        JSON.stringify({
          bin,
          sessionId: this.id,
          debug: this.config.debug === true,
        }),
      );
    } catch (err) {
      if (spawnedChild && !this.wasSpawner) {
        try {
          spawnedChild.kill();
        } catch (killErr) {
          log('[companion] spawn failed', String(killErr));
        }
      }
      log('[companion] spawn guard failed', String(err));
    } finally {
      releasePidFileLock?.();
    }
  }
}
