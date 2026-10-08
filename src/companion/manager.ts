import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { type ConfigLoadWarningKind, loadPluginConfig } from '../config/loader';
import type { CompanionConfig } from '../config/schema';
import {
  clearProjectPresetOnDisk,
  getPresetSelectionState,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import { log } from '../utils/logger';
import {
  acquirePidFileLock,
  acquirePidFileLockWithRetry,
  isProcessAlive,
  parsePidFile,
} from '../utils/pid-file-lock';

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
const STATE_PUBLISH_RETRY_MS = 250;
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

interface CompanionAgentDetail {
  session_id: string;
  agent: string;
  model?: string;
  variant?: string;
}

interface CompanionSession {
  session_id: string;
  cwd: string;
  active_agents: string[];
  active_agent_details?: CompanionAgentDetail[];
  status: string;
  attention_seq?: number;
  attention_request_id?: string;
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

function pruneDeadSessions(state: CompanionState): void {
  state.sessions = state.sessions.filter(
    (session) =>
      !Number.isInteger(session.pid) ||
      session.pid === process.pid ||
      isProcessAlive(session.pid),
  );
  if (!state.preset_requests?.length) return;

  const liveSessionIds = new Set(
    state.sessions.map((session) => session.session_id),
  );
  state.preset_requests = state.preset_requests.filter((request) =>
    liveSessionIds.has(request.session_id),
  );
  if (state.preset_requests.length === 0) delete state.preset_requests;
}

function writeState(mutator: (state: CompanionState) => void): boolean {
  const file = stateFilePath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // Never age-steal a state lock from a live writer. Recovery is based on
    // the PID/token owner record; this prevents a paused writer from losing
    // ownership and committing over a successor.
    const release = acquirePidFileLock(file);
    if (!release) return false;
    try {
      const state = readState();
      pruneDeadSessions(state);
      mutator(state);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      if (!release.isOwned()) {
        rmSync(tmp, { force: true });
        log('[companion] state lock ownership changed before commit');
        return false;
      }
      renameSync(tmp, file);
      return true;
    } finally {
      release();
    }
  } catch (err) {
    log('[companion] write failed', String(err));
    return false;
  }
}

export function companionSessionIdForDirectory(directory: string): string {
  const normalized = path.resolve(directory).replace(/[\\/]+$/, '');
  const identity =
    process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const digest = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 12);
  return `proc_${process.pid}_${digest}`;
}

export function normalizeCompanionSessionStatus(
  eventType: string,
  status?: string,
): 'busy' | 'idle' | undefined {
  if (eventType === 'session.idle' || eventType === 'session.error') {
    return 'idle';
  }
  if (eventType !== 'session.status') return undefined;
  if (status === 'busy' || status === 'retry') return 'busy';
  if (
    status === 'idle' ||
    status === 'completed' ||
    status === 'stopped' ||
    status === 'error' ||
    status === 'failed'
  ) {
    return 'idle';
  }
  return undefined;
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
  private readonly sessionDetails = new Map<
    string,
    { model?: string; variant?: string }
  >();
  private orchestratorSessionId: string | undefined;
  private orchestratorBusy = false;
  private attentionSeq = 0;
  private lastAttentionRequestId: string | undefined;
  private readonly config?: CompanionConfig;
  private companionProcess: ChildProcess | null = null;
  private spawnChecked = false;
  private wasSpawner = false;
  private spawnedCompanionPid: number | null = null;
  private presetPoller: NodeJS.Timeout | null = null;
  private publishRetryTimer: NodeJS.Timeout | null = null;
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
  private readonly appliedPresetRequestIds = new Set<string>();

  constructor(
    sessionId: string,
    cwd: string,
    config?: CompanionConfig,
    private readonly hostFlavor?: string,
  ) {
    this.id = sessionId;
    this.cwd = cwd;
    this.config = config;
  }

  private restoreAttentionState(): void {
    const previous = readState().sessions.find(
      (session) => session.session_id === this.id,
    );
    const previousSeq = previous?.attention_seq;
    if (
      typeof previousSeq === 'number' &&
      Number.isSafeInteger(previousSeq) &&
      previousSeq >= 0
    ) {
      this.attentionSeq = Math.max(this.attentionSeq, previousSeq);
    }
    if (typeof previous?.attention_request_id === 'string') {
      this.lastAttentionRequestId = previous.attention_request_id;
    }
  }

  private refreshPresetState(): boolean {
    let hardWarning = false;
    loadPluginConfig(this.cwd, {
      hostFlavor: this.hostFlavor,
      silent: true,
      onWarning: (warning) => {
        if (HARD_PRESET_REFRESH_WARNING_KINDS.has(warning.kind)) {
          hardWarning = true;
        }
      },
    });
    if (hardWarning) return false;

    const next = getPresetSelectionState(this.cwd, this.hostFlavor);
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

  private schedulePublishRetry(): void {
    if (this.publishRetryTimer || this.config?.enabled !== true) return;
    log('[companion] state publish deferred; retrying', {
      sessionId: this.id,
    });
    this.publishRetryTimer = setTimeout(() => {
      this.publishRetryTimer = null;
      if (!activeManagers.has(this)) return;
      this.publishAndSpawn();
    }, STATE_PUBLISH_RETRY_MS);
    this.publishRetryTimer.unref();
  }

  private publishAndSpawn(): void {
    if (!this.flush()) {
      this.schedulePublishRetry();
      return;
    }
    if (this.spawnChecked) return;
    this.spawnChecked = true;
    this.spawnIfAvailable();
  }

  private acknowledgePresetRequest(requestId: string): boolean {
    const acknowledged = writeState((state) => {
      state.preset_requests = (state.preset_requests ?? []).filter(
        (candidate) => candidate.request_id !== requestId,
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
    if (acknowledged) {
      this.appliedPresetRequestIds.delete(requestId);
    }
    return acknowledged;
  }

  private restorePresetRequestFence(): void {
    const previous = readState().sessions.find(
      (session) => session.session_id === this.id,
    );
    const requestId = previous?.preset?.last_request_id;
    if (typeof requestId === 'string' && requestId.length > 0) {
      this.presetLastRequestId = requestId;
      this.appliedPresetRequestIds.add(requestId);
    }
  }

  private consumePresetRequest(): boolean {
    if (this.config?.enabled !== true) return false;
    const request = readState().preset_requests?.find(
      (candidate) => candidate.session_id === this.id,
    );
    if (!request) return false;

    if (
      this.appliedPresetRequestIds.has(request.request_id) ||
      this.presetLastRequestId === request.request_id
    ) {
      // The side effect already ran. A stale queue entry can remain only
      // because acknowledgement persistence failed; retry removal without
      // applying the preset mutation again.
      this.acknowledgePresetRequest(request.request_id);
      return true;
    }

    const config = loadPluginConfig(this.cwd, {
      silent: true,
      hostFlavor: this.hostFlavor,
    });
    const scope: CompanionPresetScope =
      request.scope === 'global'
        ? 'global'
        : request.scope === 'project'
          ? 'project'
          : 'effective';
    const result =
      scope === 'project' && request.inherit === true
        ? clearProjectPresetOnDisk(this.cwd, this.hostFlavor)
        : typeof request.preset === 'string' && request.preset.trim()
          ? switchPresetOnDisk(this.cwd, request.preset, config, {
              scope,
              hostFlavor: this.hostFlavor,
            })
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
    this.appliedPresetRequestIds.add(request.request_id);

    this.acknowledgePresetRequest(request.request_id);
    // Even if acknowledgement removal failed, publish the completion fence.
    // A later poll (or restart that recovered last_request_id) can then retry
    // acknowledgement without repeating the config side effect.
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
    this.restorePresetRequestFence();
    // Re-initialization may replace a live manager for the same host session.
    // Recover the generation/request fence before disposing the old manager so
    // the native (session_id, attention_seq) key cannot be reused.
    this.restoreAttentionState();
    this.registerActiveManager();
    this.refreshPresetState();
    this.startPresetPoller();
    this.publishAndSpawn();
  }

  /**
   * Register this manager behind a single process `exit` listener. Re-inits for
   * the same OpenCode session dispose the superseded manager immediately so its
   * detached child does not survive until process exit.
   */
  private registerActiveManager(): void {
    for (const manager of [...activeManagers]) {
      if (manager === this || manager.id !== this.id) continue;

      if (manager.wasSpawner && !this.wasSpawner) {
        this.companionProcess = manager.companionProcess;
        this.spawnChecked = true;
        this.wasSpawner = true;
        this.spawnedCompanionPid = manager.spawnedCompanionPid;
        manager.companionProcess = null;
        manager.wasSpawner = false;
        manager.spawnedCompanionPid = null;
      }
      manager.disposeForReplacement();
    }

    activeManagers.add(this);
    if (!activeExitListener) {
      activeExitListener = () => CompanionManager.disposeActiveManagers();
      process.on('exit', activeExitListener);
    }
  }

  private disposeForReplacement(): void {
    if (this.presetPoller) {
      clearInterval(this.presetPoller);
      this.presetPoller = null;
    }
    if (this.publishRetryTimer) {
      clearTimeout(this.publishRetryTimer);
      this.publishRetryTimer = null;
    }
    activeManagers.delete(this);
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
    /** True when the background job for this session already finished. */
    jobFinished?: boolean;
  }): void {
    if (this.config?.enabled !== true) return;
    const { sessionId, agent, status, jobFinished } = input;
    if (!sessionId || (status !== 'busy' && status !== 'idle')) return;

    if (agent === 'orchestrator') {
      this.orchestratorSessionId = sessionId;
      this.orchestratorBusy = status === 'busy';
      // A pending input request is cleared only by its explicit reply/reject
      // event, not by ordinary lifecycle noise from the same session.
      if (this.status !== 'waiting-input') {
        this.status = status;
      }
      this.flush();
      return;
    }

    if (status === 'busy') {
      // A busy event that trails a finished job would never be followed by
      // an idle one, leaving the specialist stuck on screen.
      if (jobFinished) return;
      // Accept busy sessions even without a known agent name — Herdr
      // subagents (spawned via opencode attach) often lack the agent
      // field, and dropping the event leaves them shown as idle. Fall back
      // to the generic busy name, never the raw session ID, which would
      // reach the companion as an unrenderable agent name.
      this.busyAgentSessions.set(sessionId, agent ?? 'orchestrator');
    } else {
      // Remove by session even when the agent name is unknown, so a
      // finished specialist can never get stuck on screen.
      this.busyAgentSessions.delete(sessionId);
      this.sessionDetails.delete(sessionId);
    }
    this.flush();
  }

  onSessionModelChanged(input: {
    sessionId?: string;
    model?: string;
    variant?: string;
    variantObserved?: boolean;
  }): void {
    if (this.config?.enabled !== true) return;
    const { sessionId, model, variant, variantObserved = false } = input;
    if (!sessionId || (!model && !variant)) return;

    const previous = this.sessionDetails.get(sessionId);
    const nextModel = model ?? previous?.model;
    // A model change without an observed live variant must clear the previous
    // variant. For the same model, a model-only telemetry update preserves the
    // exact variant captured earlier from chat.message.
    const nextVariant = variantObserved
      ? variant
      : (variant ??
        (model && previous?.model && model !== previous.model
          ? undefined
          : previous?.variant));
    if (previous?.model === nextModel && previous?.variant === nextVariant) {
      return;
    }

    this.sessionDetails.set(sessionId, {
      ...(nextModel ? { model: nextModel } : {}),
      ...(nextVariant ? { variant: nextVariant } : {}),
    });
    if (
      this.busyAgentSessions.has(sessionId) ||
      this.orchestratorSessionId === sessionId
    ) {
      this.flush();
    }
  }

  onSessionDeleted(sessionId: string | undefined): void {
    if (this.config?.enabled !== true) return;
    if (!sessionId) return;
    const removed = this.busyAgentSessions.delete(sessionId);
    this.sessionDetails.delete(sessionId);
    const wasOrchestrator = this.orchestratorSessionId === sessionId;
    if (wasOrchestrator) {
      this.orchestratorSessionId = undefined;
      this.orchestratorBusy = false;
    }
    if (removed || wasOrchestrator) {
      this.flush();
    }
  }

  onWaitingInput(requestId?: string): void {
    if (this.config?.enabled !== true) return;
    // v2 permission asks are delivered raw + synthesized with the same request
    // id. Advance only for a genuinely new request so additive bridge delivery
    // cannot produce duplicate native notifications.
    const isNewRequest =
      requestId !== undefined
        ? requestId !== this.lastAttentionRequestId
        : this.status !== 'waiting-input';
    if (isNewRequest) {
      this.attentionSeq += 1;
    }
    if (requestId !== undefined) {
      this.lastAttentionRequestId = requestId;
    }
    // Waiting input is project-level UI state, not proof that the requesting
    // session is the orchestrator. Keep orchestrator identity untouched.
    this.status = 'waiting-input';
    this.flush();
  }

  onInputResolved(): void {
    if (this.config?.enabled !== true) return;
    this.status =
      this.busyAgentSessions.size > 0 || this.orchestratorBusy
        ? 'busy'
        : 'idle';
    this.flush();
  }

  onExit(): void {
    if (this.presetPoller) {
      clearInterval(this.presetPoller);
      this.presetPoller = null;
    }
    if (this.publishRetryTimer) {
      clearTimeout(this.publishRetryTimer);
      this.publishRetryTimer = null;
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

  private detailFor(sessionId: string, agent: string): CompanionAgentDetail {
    const detail = this.sessionDetails.get(sessionId);
    return {
      session_id: sessionId,
      agent,
      ...(detail?.model ? { model: detail.model } : {}),
      ...(detail?.variant ? { variant: detail.variant } : {}),
    };
  }

  private activeAgentDetails(): CompanionAgentDetail[] {
    const details = [...this.busyAgentSessions.entries()]
      .slice(0, 9)
      .map(([sessionId, agent]) => this.detailFor(sessionId, agent));
    if (details.length > 0) return details;

    if (this.status === 'busy' && this.orchestratorSessionId) {
      return [this.detailFor(this.orchestratorSessionId, 'orchestrator')];
    }

    return [];
  }

  /** One entry per running agent instance (two fixers → two cells). */
  private activeAgents(): string[] {
    const agents = Array.from(this.busyAgentSessions.values());
    if (agents.length > 0) return agents.slice(0, 9);
    if (this.status === 'waiting-input') return ['input'];
    if (this.status === 'busy') return ['orchestrator'];
    return ['intro'];
  }

  private flush(): boolean {
    if (this.config?.enabled !== true) return false;
    try {
      const entry: CompanionSession = {
        session_id: this.id,
        cwd: this.cwd,
        active_agents: this.activeAgents(),
        active_agent_details: this.activeAgentDetails(),
        status: this.status,
        attention_seq: this.attentionSeq,
        attention_request_id: this.lastAttentionRequestId,
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
      const written = writeState((state) => {
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
      if (!written) this.schedulePublishRetry();
      return written;
    } catch (err) {
      log('[companion] flush failed', String(err));
      this.schedulePublishRetry();
      return false;
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
