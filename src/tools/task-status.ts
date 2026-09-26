import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { listChildInputWaits } from '../hooks/task-session-manager/child-input-wait';
import type { BackgroundJobStore } from '../utils/background-job-store';
import { SESSION_ID_PATTERN } from '../utils/session';
import { getRuntimeSessionStatusSnapshot } from '../utils/session-runtime-status';
import type { TaskActivityTracker } from './task-activity';
import type { TaskControlIdentityIndex } from './task-control-recovery';
import {
  createTaskControlRecovery,
  type TaskControlRecovery,
} from './task-control-recovery';
import { observationFromSnapshot, summarizeTaskStatus } from './task-policy';

const z = tool.schema;
const ACTIVE_STATES = new Set(['busy', 'running', 'retry']);

export function createTaskStatusTool(options: {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  activityTracker?: TaskActivityTracker;
  now?: () => number;
  statusTimeoutMs?: number;
  identityIndex?: TaskControlIdentityIndex;
  recovery?: TaskControlRecovery;
}): Record<'task_status', ToolDefinition> {
  const recovery =
    options.recovery ??
    createTaskControlRecovery({
      input: options.input,
      backgroundJobBoard: options.backgroundJobBoard,
      identityIndex: options.identityIndex,
    });
  const task_status = tool({
    description:
      'Read the current status of a tracked child task without resuming, prompting, or changing it. Accepts its task ID or parent-scoped alias.',
    args: {
      task_id: z.string().describe('Tracked task ID or parent-scoped alias'),
    },
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = args.task_id.trim();
      if (!requested) throw new Error('task_status requires task_id');

      const target = await recovery.resolve(parentSessionID, requested);
      if (target.kind === 'unknown')
        throw new Error(`Unknown task ID or alias: ${requested}`);
      if (target.kind === 'orphan')
        return renderRecoveredOrphanStatus(target, requested);
      if (target.kind === 'recovered') {
        const classification = target.classification;
        const now = options.now?.() ?? Date.now();
        const state =
          classification.kind === 'live'
            ? classification.evidence.status
            : classification.kind === 'stopped'
              ? 'stopped'
              : classification.kind === 'reusable'
                ? classification.evidence.state
                : 'uncertain';
        const lines = [
          `Task ${target.job.alias} (${target.job.taskID})`,
          `state: ${state}`,
          'recovered: true',
          `agent: ${target.job.agent}`,
          `last_activity_at: ${new Date(now).toISOString()}`,
        ];
        if (classification.kind === 'live') {
          lines.push(
            '',
            '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
          );
        }
        return lines.join('\n');
      }

      const job = target.job;

      // Bounded live read: a failed, malformed, or timed-out host status
      // response surfaces as explicit uncertainty instead of a confident
      // board-state fallback.
      const snapshot = await getRuntimeSessionStatusSnapshot(options.input, {
        timeoutMs: options.statusTimeoutMs,
      });
      const observation = observationFromSnapshot(snapshot, job.taskID);
      const now = options.now?.() ?? Date.now();
      const lastActivityAt =
        options.activityTracker?.lastActivityAt(job.taskID) ??
        job.lastLiveBusyAt ??
        job.runStartedAt;
      const report = summarizeTaskStatus(job, observation, lastActivityAt, now);

      const details = [
        `Task ${job.alias} (${job.taskID})`,
        `state: ${report.state}${report.uncertain ? ' (unconfirmed)' : ''}`,
        `agent: ${job.agent}`,
        `last_activity_at: ${new Date(lastActivityAt).toISOString()}`,
        `idle_for_seconds: ${report.idleSeconds}`,
        `possibly_stuck: ${report.possiblyStuck}`,
      ];
      const waits = listChildInputWaits(job.taskID);
      const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
      // A child parked on an open question/permission moves no tokens and
      // never finishes on its own: surface the block explicitly so the
      // parent handles it instead of waiting it out. On pinned v2 hosts,
      // questions are Form requests; the plugin context exposes observation
      // but no supported form-reply API, so do not promise task_reply can
      // unblock them.
      for (const wait of waits) {
        details.push(`waiting_input: true (${wait.kind} ${wait.requestID})`);
        details.push(
          `pending_${wait.kind}: ${formatPendingInput(wait.kind, wait.requestID, wait.questions, wait.permission, wait.patterns)}`,
        );
        details.push(inputWaitGuidance(wait.kind, hostFlavor));
      }
      if (report.uncertain) {
        details.push('status_uncertain: true');
        if (report.lastStatusError) {
          details.push(`last_status_error: ${report.lastStatusError}`);
        }
      }
      if (!report.uncertain && ACTIVE_STATES.has(report.state)) {
        details.push('');
        details.push(
          '[guidance]: The task is still running. Work on non-overlapping tasks, or conclude your response now to await the completion event.',
        );
      }
      if (waits.length > 0) {
        details.push('');
        details.push(
          '[guidance]: The task is waiting for input and cannot proceed until the pending request is handled. See the request-specific guidance above.',
        );
      }
      return details.join('\n');
    },
  });

  return { task_status };
}

function inputWaitGuidance(
  kind: 'question' | 'permission',
  hostFlavor: unknown,
): string {
  if (kind === 'question' && hostFlavor === 'v2') {
    return '[guidance]: This is an OpenCode v2 form request. The pinned v2 plugin context can observe it but exposes no supported form-reply API, so task_reply cannot answer it. Answer/cancel it in the host UI if available; otherwise leave the child waiting or cancel the task.';
  }
  return '[guidance]: Use task_reply with this request ID to answer or reject this pending request.';
}

function formatPendingInput(
  kind: 'question' | 'permission',
  requestID: string,
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
  }>,
  permission?: string,
  patterns?: string[],
): string {
  if (kind === 'permission') {
    const patternText =
      patterns && patterns.length > 0
        ? ` patterns: ${patterns.join(', ')}`
        : '';
    return `${requestID} permission: ${permission ?? 'unknown'}${patternText}`;
  }
  if (!questions || questions.length === 0) return requestID;
  const rendered = questions
    .map((entry) => {
      const options =
        entry.options.length > 0
          ? ` [${entry.options.map((option) => option.label).join(' / ')}]`
          : '';
      const header = entry.header ? `${entry.header}: ` : '';
      return `${header}${entry.question}${options}`;
    })
    .join('; ');
  return `${requestID} ${rendered}`;
}

function renderRecoveredOrphanStatus(
  target: Extract<
    Awaited<ReturnType<TaskControlRecovery['resolve']>>,
    { kind: 'orphan' }
  >,
  requested: string,
): string {
  const taskID = target.taskID ?? requested;
  const state =
    target.classification.kind === 'live'
      ? target.classification.evidence.status
      : target.classification.kind === 'stopped'
        ? 'stopped'
        : target.classification.kind === 'reusable'
          ? target.classification.evidence.state
          : target.classification.kind === 'missing'
            ? 'missing'
            : 'uncertain';
  if (isReadOnlyVerifiedExactOrphan(target, requested)) {
    return [
      `Task ${requested} (${taskID})`,
      `state: ${state}`,
      'recovered: true',
      'read_only: true',
      'control_operations: blocked',
      ...(target.classification.agent
        ? [`agent: ${target.classification.agent}`]
        : []),
    ].join('\n');
  }
  return [
    `Task ${requested} (${taskID})`,
    `state: ${state}`,
    'recovered: false',
    `recovery_pending: ${target.reason}`,
  ].join('\n');
}

function isReadOnlyVerifiedExactOrphan(
  target: Extract<
    Awaited<ReturnType<TaskControlRecovery['resolve']>>,
    { kind: 'orphan' }
  >,
  requested: string,
): boolean {
  return (
    SESSION_ID_PATTERN.test(requested) &&
    target.taskID === requested &&
    target.classification.taskID === requested &&
    (target.classification.kind === 'live' ||
      target.classification.kind === 'stopped' ||
      target.classification.kind === 'reusable') &&
    target.reason ===
      'verified host evidence exists, but the durable identity index is unavailable for safe adoption'
  );
}
