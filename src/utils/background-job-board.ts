import { parseTaskStatusOutput, type TaskOutputState } from './task';

export type BackgroundJobState = TaskOutputState | 'reconciled';

export interface BackgroundJobRecord {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description: string;
  objective?: string;
  state: BackgroundJobState;
  timedOut: boolean;
  terminalUnreconciled: boolean;
  launchedAt: number;
  lastLaunchedAt: number;
  updatedAt: number;
  completedAt?: number;
  resultSummary?: string;
  alias: string;
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
  resultSummary?: string;
  now?: number;
}

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
  verifier: 'ver',
  librarian: 'lib',
  observer: 'obs',
  oracle: 'ora',
};

export class BackgroundJobBoard {
  private readonly jobs = new Map<string, BackgroundJobRecord>();
  private readonly counters = new Map<string, number>();

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
        terminalUnreconciled: false,
        completedAt: undefined,
        resultSummary: undefined,
        lastLaunchedAt: now,
        updatedAt: now,
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
      terminalUnreconciled: false,
      launchedAt: now,
      lastLaunchedAt: now,
      updatedAt: now,
      alias: this.nextAlias(input.parentSessionID, input.agent),
    };

    this.jobs.set(input.taskID, record);
    return record;
  }

  updateStatus(
    input: BackgroundJobStatusInput,
  ): BackgroundJobRecord | undefined {
    const existing = this.jobs.get(input.taskID);
    if (!existing) return undefined;

    // Guard: stale status updates cannot reopen already reconciled jobs
    if (existing.state === 'reconciled') {
      return existing;
    }

    const now = input.now ?? Date.now();
    const terminal = TERMINAL_STATES.has(input.state);
    const updated: BackgroundJobRecord = {
      ...existing,
      state: input.state,
      timedOut: input.timedOut ?? false,
      terminalUnreconciled: terminal ? true : existing.terminalUnreconciled,
      updatedAt: now,
      completedAt: terminal
        ? (existing.completedAt ?? now)
        : existing.completedAt,
      resultSummary: input.resultSummary ?? existing.resultSummary,
    };

    this.jobs.set(input.taskID, updated);
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
      updatedAt: now,
    };

    this.jobs.set(taskID, updated);
    return updated;
  }

  get(taskID: string): BackgroundJobRecord | undefined {
    return this.jobs.get(taskID);
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

  formatForPrompt(
    parentSessionID: string,
    now = Date.now(),
  ): string | undefined {
    const jobs = this.list(parentSessionID).filter(
      (job) => job.state === 'running' || job.terminalUnreconciled,
    );

    if (jobs.length === 0) return undefined;

    return [
      '### Background Job Board',
      'Use task_status before consuming running jobs. Reconcile terminal jobs before final response.',
      '',
      ...jobs.map((job) => formatJob(job, now)),
    ].join('\n');
  }

  clearParent(parentSessionID: string): void {
    for (const job of this.list(parentSessionID)) {
      this.jobs.delete(job.taskID);
    }
  }

  drop(taskID: string): void {
    this.jobs.delete(taskID);
  }

  private nextAlias(parentSessionID: string, agent: string): string {
    const prefix = AGENT_PREFIX[agent] ?? (agent.slice(0, 3) || 'job');
    const key = `${parentSessionID}:${prefix}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);

    return `${prefix}-${next}`;
  }
}

function formatJob(job: BackgroundJobRecord, now = Date.now()): string {
  const ageMs = now - job.lastLaunchedAt;
  const isResume = job.lastLaunchedAt !== job.launchedAt;
  const ageLabel =
    job.state === 'running' && ageMs < 30_000
      ? ` [${isResume ? 'resumed' : 'just launched'}, ${Math.floor(ageMs / 1000)}s ago]`
      : '';
  const status = job.terminalUnreconciled
    ? `${job.state}, unreconciled`
    : job.timedOut
      ? `${job.state}, timed out`
      : `${job.state}${ageLabel}`;
  const lines = [
    `- ${job.alias} / ${job.taskID} / ${job.agent} / ${status}`,
    `  Objective: ${job.objective || job.description}`,
  ];

  if (job.resultSummary && job.terminalUnreconciled) {
    lines.push(`  Result: ${singleLine(job.resultSummary)}`);
  }

  return lines.join('\n');
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}
