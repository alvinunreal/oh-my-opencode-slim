import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRole } from './config';
import type { DelegateResult } from './types';

const LOG_DIR = join(import.meta.dir, 'logs');
const METRICS_FILE = join(LOG_DIR, 'metrics.jsonl');

interface TaskMetrics {
  timestamp: number;
  userRequest: string;
  isTrivial: boolean;
  delegateCount: number;
  delegates: Array<{
    role: AgentRole;
    threadId: string;
    tokenCount: number;
    packetSize: number;
  }>;
  orchestratorTokens: number;
  totalDelegateTokens: number;
  packetRejections: number;
  pointerResolutions: number;
  isolationViolations: number;
  duration: number;
}

let currentTask: Partial<TaskMetrics> | null = null;
let taskStartTime = 0;

async function ensureLogDir(): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
  } catch {
    // Directory exists
  }
}

export function startTaskTracking(userRequest: string): void {
  taskStartTime = Date.now();
  currentTask = {
    timestamp: taskStartTime,
    userRequest,
    delegates: [],
    packetRejections: 0,
    pointerResolutions: 0,
    isolationViolations: 0,
  };
}

export function recordDelegateResult(result: DelegateResult): void {
  if (!currentTask) return;

  currentTask.delegates = currentTask.delegates ?? [];
  currentTask.delegates.push({
    role: result.role,
    threadId: result.threadId,
    tokenCount: result.tokenCount,
    packetSize: result.packet.charCount,
  });
}

export function recordPacketRejection(): void {
  if (!currentTask) return;
  currentTask.packetRejections = (currentTask.packetRejections ?? 0) + 1;
}

export function recordPointerResolution(): void {
  if (!currentTask) return;
  currentTask.pointerResolutions = (currentTask.pointerResolutions ?? 0) + 1;
}

export function recordIsolationViolation(): void {
  if (!currentTask) return;
  currentTask.isolationViolations = (currentTask.isolationViolations ?? 0) + 1;
}

export function setTaskClassification(isTrivial: boolean): void {
  if (!currentTask) return;
  currentTask.isTrivial = isTrivial;
}

export function setOrchestratorTokens(tokens: number): void {
  if (!currentTask) return;
  currentTask.orchestratorTokens = tokens;
}

export async function finalizeTaskTracking(): Promise<TaskMetrics | null> {
  if (!currentTask) return null;

  const metrics: TaskMetrics = {
    timestamp: currentTask.timestamp ?? Date.now(),
    userRequest: currentTask.userRequest ?? '',
    isTrivial: currentTask.isTrivial ?? false,
    delegateCount: currentTask.delegates?.length ?? 0,
    delegates: currentTask.delegates ?? [],
    orchestratorTokens: currentTask.orchestratorTokens ?? 0,
    totalDelegateTokens:
      currentTask.delegates?.reduce((sum, d) => sum + d.tokenCount, 0) ?? 0,
    packetRejections: currentTask.packetRejections ?? 0,
    pointerResolutions: currentTask.pointerResolutions ?? 0,
    isolationViolations: currentTask.isolationViolations ?? 0,
    duration: Date.now() - taskStartTime,
  };

  await ensureLogDir();
  await appendFile(METRICS_FILE, `${JSON.stringify(metrics)}\n`);

  currentTask = null;

  return metrics;
}

export function getAlerts(metrics: TaskMetrics): string[] {
  const alerts: string[] = [];

  if (metrics.orchestratorTokens > 50_000) {
    alerts.push(
      `High orchestrator token usage: ${metrics.orchestratorTokens} (target: <50K)`,
    );
  }

  const rejectionRate =
    metrics.delegateCount > 0
      ? metrics.packetRejections / metrics.delegateCount
      : 0;
  if (rejectionRate > 0.1) {
    alerts.push(
      `High packet rejection rate: ${(rejectionRate * 100).toFixed(1)}% (target: <10%)`,
    );
  }

  const resolutionRate =
    metrics.delegateCount > 0
      ? metrics.pointerResolutions / metrics.delegateCount
      : 0;
  if (resolutionRate > 0.2) {
    alerts.push(
      `High pointer resolution rate: ${(resolutionRate * 100).toFixed(1)}% (target: <20%)`,
    );
  }

  if (metrics.isolationViolations > 0) {
    alerts.push(
      `CRITICAL: ${metrics.isolationViolations} isolation violations detected`,
    );
  }

  return alerts;
}
