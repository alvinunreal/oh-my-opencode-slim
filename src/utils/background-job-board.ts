import {
  DEFAULT_MAX_SESSIONS_PER_AGENT,
  DEFAULT_READ_CONTEXT_MAX_FILES,
  DEFAULT_READ_CONTEXT_MIN_LINES,
  formatSystemReminder,
} from '../config/constants';
import type { BackgroundJobStore } from './background-job-store';
import { parseTaskStatusOutput, type TaskOutputState } from './task';

export interface ContextFile {
  path: string;
  lineCount: number;
  lineNumbers?: number[];
  lastReadAt: number;
}

export type BackgroundJobState = TaskOutputState | 'reconciled';

export interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: BackgroundJobState;
  timedOut: boolean;
  recoverableAfterLiveBusy: boolean;
  statusUncertain: boolean;
  cancellationRequested: boolean;
  terminalUnreconciled: boolean;
  launchedAt: number;
  lastLaunchedAt: number;
  updatedAt: number;
  lastLiveBusyAt?: number;
  completedAt?: number;
  resultSummary?: string;
  lastStatusError?: string;
  alias: string;
  lastUsedAt: number;
  terminalState?: TaskOutputState;
  contextFiles: ContextFile[];
  totalErrors?: number;
  timeoutCount?: number;
  lastErrorAt?: number;
}

export interface BackgroundJobBoardOptions {
  maxReusablePerAgent?: number;
  readContextMinLines?: number;
  readContextMaxFiles?: number;
}

export interface BackgroundJobLaunchInput {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description?: string;
  objective?: string;
  now?: number;
}

export interface BackgroundJobStatusInput {
  taskID: string;
  state: TaskOutputState;
  timedOut?: boolean;
  statusUncertain?: boolean;
  resultSummary?: string;
  lastStatusError?: string;
  now?: number;
}

type TerminalStateListener = (taskID: string) => void;

const TERMINAL_STATES = new Set<BackgroundJobState>([
  'completed',
  'error',
  'cancelled',
]);

const AGENT_PREFIX: Record<string, string> = {
  council: 'cou',
  designer: 'des',
  explorer: 'exp',
  fixer: 'fix',
  librarian: 'lib',
  observer: 'obs',
  oracle: 'ora',
};

export class BackgroundJobBoard implements BackgroundJobStore {
  private readonly jobs = new Map<string, BackgroundJobRecord>();
  private readonly counters = new Map<string, number>();
  private terminalStateListeners: TerminalStateListener[] = [];

  private readonly maxReusablePerAgent: number;
  private readonly readContextMinLines: number;
  private readonly readContextMaxFiles: number;

  constructor(options: BackgroundJobBoardOptions = {}) {
    this.maxReusablePerAgent =
      options.maxReusablePerAgent ?? DEFAULT_MAX_SESSIONS_PER_AGENT;
    this.readContextMinLines =
      options.readContextMinLines ?? DEFAULT_READ_CONTEXT_MIN_LINES;
    this.readContextMaxFiles =
      options.readContextMaxFiles ?? DEFAULT_READ_CONTEXT_MAX_FILES;
  }

  addTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners.push(listener);
  }

  removeTerminalStateListener(listener: TerminalStateListener): void {
    this.terminalStateListeners = this.terminalStateListeners.filter(
      (entry) => entry !== listener,
    );
  }

  setTerminalStateListener(listener?: TerminalStateListener): void {
    this.terminalStateListeners = listener ? [listener] : [];
  }

  private notifyTerminalStateListeners(taskID: string): void {
    for (const listener of this.terminalStateListeners) {
      listener(taskID);
    }
  }

  registerLaunch(input: BackgroundJobLaunchInput): BackgroundJobRecord {
    const now = input.now ?? Date.now();
    const existing = this.jobs.get(input.taskID);

    if (existing) {
      const updated = {
        ...existing,
        agent: input.agent || existing.agent,
        description: input.description || existing.description,
        objective: input.objective ?? existing.objective,
        state: 'running',
        timedOut: false,
        recoverableAfterLiveBusy: false,
        statusUncertain: false,
        cancellationRequested: false,
        terminalUnreconciled: false,
        completedAt: undefined,
        resultSummary: undefined,
        lastStatusError: undefined,
        terminalState: undefined,
        lastLaunchedAt: now,
        lastLiveBusyAt: now,
        lastUsedAt: now,
        updatedAt: now,
        totalErrors: existing.totalErrors ?? 0,
        timeoutCount: existing.timeoutCount ?? 0,
      } satisfies BackgroundJobRecord;
      this.jobs.set(input.taskID, updated);
      return updated;
    }

    const record: BackgroundJobRecord = {
      taskID: input.taskID,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      description: input.description || `background ${input.agent} task`,
      objective: input.objective,
      state: 'running',
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: false,
      terminalUnreconciled: false,
      launchedAt: now,
      lastLaunchedAt: now,
      lastLiveBusyAt: now,
      lastUsedAt: now,
      updatedAt: now,
      alias: this.nextAlias(input.parentSessionID, input.agent),
      contextFiles: [],
      totalErrors: 0,
      timeoutCount: 0,
    };

    this.jobs.set(input.taskID, record);
    return record;
  }

  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (!existing) return undefined;

    // Guard: stale status updates cannot reopen already terminal jobs.
    if (
      existing.state === 'reconciled' ||
      (existing.state === 'cancelled' && input.state !== 'cancelled') ||
      (TERMINAL_STATES.has(existing.state) && input.state === 'running')
    ) {
      return existing;
    }

    const now = input.now ?? Date.now();
    const terminal = TERMINAL_STATES.has(input.state);
    const notifyTerminal = terminal && !TERMINAL_STATES.has(existing.state);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: input.state,
      timedOut: input.timedOut ?? false,
      recoverableAfterLiveBusy:
        input.state !== 'running'
          ? false
          : input.timedOut === true
            ? false
            : existing.recoverableAfterLiveBusy,
      statusUncertain: input.statusUncertain ?? false,
      terminalUnreconciled: terminal ? true : existing.terminalUnreconciled,
      updatedAt: now,
      completedAt: terminal
        ? (existing.completedAt ?? now)
        : existing.completedAt,
      terminalState: terminal ? input.state : existing.terminalState,
      resultSummary: input.resultSummary ?? existing.resultSummary,
      lastStatusError: input.lastStatusError,
    };

    if (input.state === 'completed') {
      updated.timeoutCount = 0;
    }
    if (input.state === 'error') {
      updated.totalErrors = (existing.totalErrors ?? 0) + 1;
      updated.lastErrorAt = updated.updatedAt;
    }
    if (input.timedOut && input.state !== 'completed') {
      updated.timeoutCount = (existing.timeoutCount ?? 0) + 1;
    }

    this.jobs.set(input.taskID, updated);
    this.trimReusable(input.taskID);
    if (notifyTerminal) this.notifyTerminalStateListeners(input.taskID);
    return updated;
  }

  updateFromStatusOutput(output: string): BackgroundJobRecord | undefined {
    const status = parseTaskStatusOutput(output);
    if (!status) return undefined;

    return this.updateStatus({
      taskID: status.taskID,
      state: status.state,
      timedOut: status.timedOut,
      resultSummary: status.result,
    });
  }

  markRunningFromLiveSession(
    taskID: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;

    const isStaleTerminal =
      TERMINAL_STATES.has(existing.state) || existing.state === 'reconciled';
    if (isStaleTerminal) {
      const updated: BackgroundJobRecord = {
        ...existing,
        lastLiveBusyAt: now,
      };
      this.jobs.set(taskID, updated);
      return updated;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      updatedAt: now,
      lastLiveBusyAt: now,
      timedOut: false,
      recoverableAfterLiveBusy:
        existing.recoverableAfterLiveBusy || existing.timedOut,
      statusUncertain: false,
    };

    this.jobs.set(taskID, updated);
    return updated;
  }

  markReconciled(
    taskID: string,
    now = Date.now(),
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (
      !existing.terminalUnreconciled &&
      !TERMINAL_STATES.has(existing.state)
    ) {
      return undefined;
    }

    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'reconciled',
      terminalUnreconciled: false,
      statusUncertain: false,
      updatedAt: now,
      lastUsedAt: now,
      terminalState: existing.terminalState ?? terminalStateOf(existing.state),
    };

    this.jobs.set(taskID, updated);
    this.trimReusable(taskID);
    return updated;
  }

  markCancelled(
    taskID: string,
    reason?: string,
    now = Date.now(),
    options: { force?: boolean } = {},
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(taskID);
    if (!existing) return undefined;
    if (!options.force) {
      if (existing.state === 'reconciled') return existing;
      if (TERMINAL_STATES.has(existing.state)) return existing;
    }

    const notifyTerminal =
      !TERMINAL_STATES.has(existing.state) && existing.state !== 'reconciled';
    const summary = normalizeCancelReason(reason);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: 'cancelled',
      timedOut: false,
      recoverableAfterLiveBusy: false,
      statusUncertain: false,
      cancellationRequested: true,
      terminalUnreconciled: true,
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
      terminalState: 'cancelled',
      resultSummary: summary,
      lastStatusError: undefined,
    };

    this.jobs.set(taskID, updated);
    if (notifyTerminal) this.notifyTerminalStateListeners(taskID);
    return updated;
  }

  get(taskID: string): BackgroundJobRecord | undefined {
    return this.jobs.get(taskID);
  }

  field<K extends keyof BackgroundJobRecord>(
    taskID: string,
    key: K,
  ): BackgroundJobRecord[K] | undefined {
    return this.get(taskID)?.[key];
  }

  isRunning(taskID: string): boolean {
    const job = this.get(taskID);
    return job?.state === 'running';
  }

  isTerminalUnreconciled(taskID: string): boolean {
    const job = this.get(taskID);
    return !!job?.terminalUnreconciled;
  }

  getResultSummary(taskID: string): string | undefined {
    return this.field(taskID, 'resultSummary');
  }

  getLastLiveBusyAt(taskID: string): number | undefined {
    return this.field(taskID, 'lastLiveBusyAt');
  }

  getParentSessionID(taskID: string): string | undefined {
    return this.field(taskID, 'parentSessionID');
  }

  getState(taskID: string): BackgroundJobState | undefined {
    return this.field(taskID, 'state');
  }

  resolve(
    parentSessionID: string,
    taskIDOrAlias: string,
  ): BackgroundJobRecord | undefined {
    const value = taskIDOrAlias.trim();
    return this.list(parentSessionID).find(
      (job) => job.taskID === value || job.alias === value,
    );
  }

  resolveReusable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    const job = this.resolve(parentSessionID, taskIDOrAlias);
    if (!job || !isReusable(job)) return undefined;
    if (agent && job.agent !== agent) return undefined;
    return job;
  }

  resolveRecoverable(
    parentSessionID: string,
    taskIDOrAlias: string,
    agent?: string,
  ): BackgroundJobRecord | undefined {
    const job = this.resolve(parentSessionID, taskIDOrAlias);
    if (!job) return undefined;
    if (agent && job.agent !== agent) return undefined;
    if (job.state !== 'running' || !job.recoverableAfterLiveBusy) {
      return undefined;
    }
    return job;
  }

  markUsed(parentSessionID: string, key: string, now = Date.now()): void {
    const job = this.resolve(parentSessionID, key);
    if (!job) return;
    this.jobs.set(job.taskID, { ...job, lastUsedAt: now, updatedAt: now });
  }

  taskIDs(): Set<string> {
    return new Set(this.jobs.keys());
  }

  addContext(taskID: string, files: ContextFile[]): void {
    if (files.length === 0) return;
    const job = this.jobs.get(taskID);
    if (!job) return;
    const existing = new Map(job.contextFiles.map((file) => [file.path, file]));
    for (const file of files) {
      const previous = existing.get(file.path);
      if (previous) {
        existing.set(file.path, {
          ...previous,
          lineCount: Math.max(previous.lineCount, file.lineCount),
          lastReadAt: Math.max(previous.lastReadAt, file.lastReadAt),
        });
      } else {
        existing.set(file.path, { ...file });
      }
    }
    const contextFiles = [...existing.values()]
      .filter((file) => file.lineCount >= this.readContextMinLines)
      .sort(
        (a, b) =>
          b.lineCount - a.lineCount ||
          b.lastReadAt - a.lastReadAt ||
          a.path.localeCompare(b.path),
      )
      .slice(0, this.readContextMaxFiles + 1);
    this.jobs.set(taskID, { ...job, contextFiles });
  }

  list(parentSessionID?: string): BackgroundJobRecord[] {
    const jobs = [...this.jobs.values()];
    const filtered = parentSessionID
      ? jobs.filter((job) => job.parentSessionID === parentSessionID)
      : jobs;

    return filtered.sort((a, b) => a.launchedAt - b.launchedAt);
  }

  hasRunning(parentSessionID: string): boolean {
    return this.list(parentSessionID).some((job) => job.state === 'running');
  }

  hasTerminalUnreconciled(parentSessionID: string): boolean {
    return this.list(parentSessionID).some((job) => job.terminalUnreconciled);
  }

  hasConvergenceSignals(taskID: string, threshold = 3): boolean {
    const job = this.jobs.get(taskID);
    if (!job) return false;
    const errors = job.totalErrors ?? 0;
    const timeouts = job.timeoutCount ?? 0;
    return errors >= threshold || timeouts >= threshold;
  }

  formatForPrompt(parentSessionID: string, _now?: number): string | undefined {
    const active = this.list(parentSessionID).filter(
      (job) => job.state === 'running' || job.terminalUnreconciled,
    );
    const reusable = this.list(parentSessionID).filter(isReusable);

    if (active.length === 0 && reusable.length === 0) return undefined;

    return formatSystemReminder(
      [
        '### Background Job Board',
        'SENTINEL: background-job-board-v2',
        'Do not poll running jobs. Wait for hook-driven completion, or use cancel_task only for explicit cancellation. Reconcile terminal jobs before final response.',
        'Completed or reconciled sessions are reusable by alias for the same specialist/context.',
        'Timed-out running sessions are recoverable by alias for safe resume after a live busy signal.',
        'Cancelled or errored sessions are not reusable.',
        '',
        '#### Active / Unreconciled',
        ...(active.length > 0 ? active.map(formatJob) : ['- none']),
        '',
        '#### Reusable Sessions',
        ...(reusable.length > 0
          ? reusable.map((job) => this.formatReusableJob(job))
          : ['- none']),
      ].join('\n'),
    );
  }

  clearParent(parentSessionID: string): void {
    for (const job of this.list(parentSessionID)) {
      this.jobs.delete(job.taskID);
    }
  }

  drop(taskID: string): void {
    this.jobs.delete(taskID);
  }

  // ── Lifecycle policy (board = no policy, always close) ───────────

  deferIfRunning(_sessionId: string): boolean {
    return false; // ponytail: safe default - don't close
  }

  retryDeferredClose(_sessionId: string): boolean {
    return false; // Nothing deferred at board level
  }

  clearDeferredClose(_sessionId: string): void {
    // No-op at board level
  }

  private trimReusable(taskID: string): void {
    const job = this.jobs.get(taskID);
    if (!job || !isReusable(job)) return;
    const reusable = this.list(job.parentSessionID)
      .filter(
        (candidate) => candidate.agent === job.agent && isReusable(candidate),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const stale of reusable.slice(this.maxReusablePerAgent)) {
      this.jobs.delete(stale.taskID);
    }
  }

  private formatReusableJob(job: BackgroundJobRecord): string {
    const terminal = job.terminalState ?? terminalStateOf(job.state);
    const reconciliation = job.terminalUnreconciled
      ? 'unreconciled'
      : 'reconciled';
    const lines = [
      `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / ${promptSafe(terminal ?? job.state)}, ${reconciliation}`,
      `  Objective: ${promptSafe(job.objective || job.description)}`,
    ];
    const context = formatContextFiles(
      job.contextFiles,
      this.readContextMaxFiles,
    );
    if (context) lines.push(`  Context read by ${job.alias}: ${context}`);
    return lines.join('\n');
  }

  private nextAlias(parentSessionID: string, agent: string): string {
    const prefix = AGENT_PREFIX[agent] ?? (agent.slice(0, 3) || 'job');
    const key = `${parentSessionID}:${prefix}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);

    return `${prefix}-${next}`;
  }
}

export function deriveTaskSessionLabel(input: {
  description?: string;
  prompt?: string;
  agentType: string;
}): string {
  const preferred = normalizeWhitespace(input.description ?? '');
  if (preferred) return preferred.slice(0, 48);
  const firstPromptLine = (input.prompt ?? '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find(Boolean);
  return firstPromptLine
    ? firstPromptLine.slice(0, 48)
    : `recent ${input.agentType} task`;
}

function isReusable(job: BackgroundJobRecord): boolean {
  const terminal = job.terminalState ?? terminalStateOf(job.state);
  return terminal === 'completed' && !job.terminalUnreconciled;
}

function terminalStateOf(
  state: BackgroundJobState,
): TaskOutputState | undefined {
  return state === 'completed' || state === 'error' || state === 'cancelled'
    ? state
    : undefined;
}

function formatContextFiles(files: ContextFile[], maxFiles: number): string {
  if (maxFiles === 0) return '';
  const shown = files.slice(0, maxFiles);
  const rest = files.length - shown.length;
  const rendered = shown.map(
    (file) => `${promptSafe(file.path)} (${file.lineCount} lines)`,
  );
  return `${rendered.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatJob(job: BackgroundJobRecord): string {
  const isResume = job.lastLaunchedAt !== job.launchedAt;
  // Exclude wall-clock age labels so prompts remain stable between job-state transitions for cache reuse.
  const state =
    job.state === 'running' && isResume ? 'running [resumed]' : job.state;
  const status = job.terminalUnreconciled
    ? `${job.state}, unreconciled`
    : job.statusUncertain
      ? `${job.state}, status uncertain`
      : job.timedOut
        ? `${job.state}, timed out`
        : state;
  const lines = [
    `- ${promptSafe(job.alias)} / ${promptSafe(job.taskID)} / ${promptSafe(job.agent)} / ${promptSafe(status)}`,
    `  Objective: ${promptSafe(job.objective || job.description)}`,
  ];

  if (job.resultSummary && job.terminalUnreconciled) {
    lines.push(`  Result: ${promptSafe(job.resultSummary)}`);
  } else if (job.lastStatusError && job.statusUncertain) {
    lines.push(`  Status: ${promptSafe(job.lastStatusError)}`);
  }

  return lines.join('\n');
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}

function promptSafe(value: string): string {
  return singleLine(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeCancelReason(reason?: string): string {
  const normalized = reason?.replace(/\s+/g, ' ').trim();
  return normalized ? `cancelled: ${normalized}` : 'cancelled';
}
