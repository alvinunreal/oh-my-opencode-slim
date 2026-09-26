import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundJobIdentity } from '../utils/background-job-identity-index';
import type { BackgroundJobStore } from '../utils/background-job-store';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
  runtimeObservationFromSnapshot,
} from '../utils/background-job-terminal-gate';
import {
  classifyTerminalEvidence,
  fetchChildTranscript,
  responseError,
} from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import { SESSION_ID_PATTERN } from '../utils/session';
import {
  getRuntimeSessionStatusSnapshot,
  type RuntimeSessionStatusSnapshot,
  runtimeSessionStatus,
} from '../utils/session-runtime-status';
import { parseTaskStatusOutput } from '../utils/task';

interface TaskResultToolOptions {
  input: PluginInput;
  backgroundJobBoard: BackgroundJobStore;
  terminalGate?: BackgroundJobTerminalGate;
  identityIndex?: {
    lookup(
      parentSessionID: string,
      key: string,
    ): BackgroundJobIdentity | undefined;
  };
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nativeDelegationAgent(
  response: unknown,
  taskID: string,
): string | undefined {
  if (
    !isRecord(response) ||
    !Array.isArray(response.data) ||
    response.data.some(
      (message) =>
        !isRecord(message) ||
        !isRecord(message.info) ||
        !Array.isArray(message.parts),
    )
  )
    return;
  let agent: string | undefined;
  for (const message of response.data) {
    if (message.info.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (
        !isRecord(part) ||
        part.type !== 'tool' ||
        (part.tool !== 'task' &&
          part.name !== 'task' &&
          part.tool !== 'subagent' &&
          part.name !== 'subagent') ||
        !isRecord(part.state)
      )
        continue;
      const state = part.state;
      const content = state.content;
      const output =
        typeof state.output === 'string'
          ? state.output
          : Array.isArray(content) &&
              content.length === 1 &&
              isRecord(content[0]) &&
              content[0].type === 'text' &&
              typeof content[0].text === 'string'
            ? content[0].text
            : undefined;
      if (
        output === undefined ||
        parseTaskStatusOutput(output)?.taskID !== taskID
      )
        continue;
      const input = state.input;
      const candidate = isRecord(input)
        ? (input.subagent_type ?? input.agent)
        : undefined;
      if (
        state.status !== 'completed' ||
        !isRecord(input) ||
        input.background !== true ||
        typeof candidate !== 'string' ||
        (input.subagent_type !== undefined &&
          input.agent !== undefined &&
          input.subagent_type !== input.agent)
      )
        return;
      if (!candidate || (agent && agent !== candidate)) return;
      agent = candidate;
    }
  }
  return agent;
}

function verifiedSession(
  response: unknown,
  requested: string,
  identity: BackgroundJobIdentity,
): Record<string, unknown> {
  if (responseError(response) !== undefined)
    throw new Error(`Task ${requested} could not be verified by session.get`);
  const session = isRecord(response) ? response.data : undefined;
  if (
    !isRecord(session) ||
    session.id !== identity.taskID ||
    session.parentID !== identity.parentSessionID ||
    (session.agent !== undefined && session.agent !== identity.agent) ||
    (session.directory !== undefined &&
      session.directory !== identity.directory) ||
    (session.location !== undefined &&
      (!isRecord(session.location) ||
        session.location.directory !== identity.directory))
  )
    throw new Error(`Task ${requested} does not match its stored identity`);
  return session;
}

interface FinalTurn {
  userID?: string;
  assistantID?: string;
  startedAt: number;
  completedAt: number;
  text: string;
}

function finalTurn(response: unknown): FinalTurn | undefined {
  if (
    !isRecord(response) ||
    !Array.isArray(response.data) ||
    response.data.some(
      (message) =>
        !isRecord(message) ||
        !isRecord(message.info) ||
        !Array.isArray(message.parts),
    )
  )
    return;
  const messages = response.data;
  const lastUser = messages.findLastIndex(
    (message) => message.info.role === 'user',
  );
  if (lastUser < 0) return;
  const user = messages[lastUser].info;
  const startedAt = isRecord(user.time) ? user.time.created : undefined;
  if (!validTime(startedAt)) return;
  let last = messages.length - 1;
  while (last > lastUser && messages[last].info.role === 'system') last--;
  const final = messages[last]?.info;
  const completedAt = isRecord(final?.time) ? final.time.completed : undefined;
  if (
    last <= lastUser ||
    final?.role !== 'assistant' ||
    final.finish !== 'stop' ||
    !validTime(completedAt) ||
    completedAt < startedAt ||
    messages.slice(lastUser + 1, last).some((message) => {
      const info = message.info;
      return (
        info.role === 'user' ||
        (info.role === 'assistant' &&
          (info.error != null ||
            info.finish !== 'stop' ||
            !validTime(isRecord(info.time) ? info.time.completed : undefined)))
      );
    })
  )
    return;
  const evidence = classifyTerminalEvidence(response, {
    runStartedAt: startedAt,
  });
  if (evidence.verdict !== 'completed') return;
  return {
    userID: typeof user.id === 'string' ? user.id : undefined,
    assistantID: typeof final.id === 'string' ? final.id : undefined,
    startedAt,
    completedAt,
    text: evidence.text,
  };
}

async function recoverOrphanResult(
  options: TaskResultToolOptions,
  identity: BackgroundJobIdentity,
  requested: string,
  indexed: boolean,
  tracked?: ReturnType<BackgroundJobStore['resolve']>,
): Promise<string> {
  const { taskID, parentSessionID, agent, directory } = identity;
  const client = getClient(options.input);
  if (typeof client.session.get !== 'function')
    throw new Error(`Task ${requested} cannot be verified on this host`);
  const sessionRequest = {
    path: { id: taskID },
    query: { directory },
  };
  const session = verifiedSession(
    await client.session.get(sessionRequest),
    requested,
    identity,
  );

  const hasStatus = typeof client.session.status === 'function';
  const statusReadStartedAt = Date.now();
  const snapshot = hasStatus
    ? await getRuntimeSessionStatusSnapshot(options.input)
    : undefined;
  const status = snapshot && runtimeSessionStatus(snapshot, taskID);
  if (status === 'busy' || status === 'retry')
    return pending(taskID, false, status, false);
  if (
    hasStatus &&
    (!snapshot || snapshot.error || snapshot.malformedSessionIDs.has(taskID))
  )
    return pending(taskID, true, undefined, false);

  const final = finalTurn(
    await fetchChildTranscript(client, taskID, directory),
  );
  if (!final) return pending(taskID, true, undefined, false);

  const time = isRecord(session.time) ? session.time : undefined;
  if (session.outcome !== undefined && session.outcome !== 'succeeded')
    return pending(taskID, true, undefined, false);
  if (!hasStatus) {
    // updated is not a terminal transition: it can advance during a new run
    // while the previous succeeded outcome remains on the session.
    if (
      session.outcome !== 'succeeded' ||
      !validTime(time?.created) ||
      !validTime(time.idle) ||
      time.created > final.startedAt ||
      time.idle <= final.completedAt ||
      time.idle <= final.startedAt ||
      time.idle > Date.now()
    )
      return pending(taskID, true, undefined, false);
  } else if (final.completedAt > statusReadStartedAt)
    return pending(taskID, true, undefined, false);
  if (indexed) {
    const fresh = options.identityIndex?.lookup(parentSessionID, requested);
    if (
      !fresh ||
      fresh.taskID !== taskID ||
      fresh.agent !== agent ||
      fresh.alias !== identity.alias ||
      fresh.directory !== directory ||
      fresh.parentSessionID !== parentSessionID
    )
      throw new Error(`Task ${requested} changed identity during retrieval`);
  }
  if (hasStatus) {
    const after = await getRuntimeSessionStatusSnapshot(options.input);
    const afterStatus = runtimeSessionStatus(after, taskID);
    if (
      after.error ||
      after.malformedSessionIDs.has(taskID) ||
      afterStatus === 'busy' ||
      afterStatus === 'retry'
    )
      return pending(taskID, true, undefined, false);
  } else {
    // v2 has no live status endpoint. Bracket the transcript with two host
    // reads and recheck the latest admission after the second host read.
    const after = verifiedSession(
      await client.session.get(sessionRequest),
      requested,
      identity,
    );
    const afterTime = isRecord(after.time) ? after.time : undefined;
    if (
      after.outcome !== session.outcome ||
      afterTime?.created !== time?.created ||
      afterTime?.idle !== time?.idle ||
      afterTime?.updated !== time?.updated
    )
      return pending(taskID, true, undefined, false);
    const latest = finalTurn(
      await fetchChildTranscript(client, taskID, directory),
    );
    if (
      !final.userID ||
      !final.assistantID ||
      !latest?.userID ||
      !latest.assistantID ||
      latest.userID !== final.userID ||
      latest.assistantID !== final.assistantID ||
      latest.startedAt !== final.startedAt ||
      latest.completedAt !== final.completedAt ||
      latest.text !== final.text
    )
      return pending(taskID, true, undefined, false);
  }
  if (tracked) {
    const current = options.backgroundJobBoard.resolve(
      parentSessionID,
      requested,
    );
    if (
      current?.state !== 'running' ||
      current.generation !== tracked.generation ||
      current.terminalRevision !== tracked.terminalRevision ||
      current.activityRevision !== tracked.activityRevision
    )
      throw new Error(`Task ${requested} changed generation during retrieval`);
  }
  return final.text;
}

function pending(
  taskID: string,
  uncertain: boolean,
  status?: 'busy' | 'idle' | 'retry',
  tracked = true,
): string {
  if (status === 'idle')
    return [
      `task_id: ${taskID}`,
      'state: pending',
      'message: Task is quiescent; wait for terminal reconciliation before retrieving its result.',
      'next: retry task_result after the terminal notification',
    ].join('\n');
  return [
    `task_id: ${taskID}`,
    uncertain
      ? 'state: running (unconfirmed)'
      : `state: ${status === 'retry' ? 'retry' : 'running'}`,
    uncertain
      ? 'message: Live task status is uncertain; no definitive running state is available.'
      : 'message: Task is still running. Wait for its terminal result.',
    `next: ${!tracked ? 'retry task_result after the task finishes' : uncertain ? 'retry task_result or use task_status to inspect the task' : 'use task_status to inspect the task'}`,
  ].join('\n');
}

export function createTaskResultTool(
  options: TaskResultToolOptions,
): Record<string, ToolDefinition> {
  const gate =
    options.terminalGate ??
    createBackgroundJobTerminalGate({
      backgroundJobBoard: options.backgroundJobBoard,
      input: options.input,
    });
  return {
    task_result: tool({
      description: `Retrieve the final text already produced by a specialist task, or inspect its active state without resuming or re-running it.

Use this when the user asks to see a prior task's full result, or before retrying work whose completed output may already answer the request. If the task is still running, this returns a status message; only a completed task returns its final text. Accepts either the native task_id/session ID or the parent-scoped alias shown in the Background Job Board. This tool is read-only and never sends a new prompt to the specialist.`,
      args: {
        task_id: tool.schema
          .string()
          .describe('Task ID or Background Job Board alias'),
      },
      async execute(args, toolContext) {
        const parentSessionID = toolContext?.sessionID;
        if (!parentSessionID) throw new Error('task_result requires sessionID');
        const requested = args.task_id.trim();
        if (!requested) throw new Error('task_result requires task_id');
        const board = options.backgroundJobBoard;
        const tracked = board.resolve(parentSessionID, requested);
        const identity =
          tracked && tracked.state !== 'running'
            ? undefined
            : options.identityIndex?.lookup(parentSessionID, requested);
        if (
          identity &&
          (identity.parentSessionID !== parentSessionID ||
            identity.directory !== options.input.directory ||
            !identity.agent ||
            (identity.taskID !== requested && identity.alias !== requested) ||
            (tracked && tracked.taskID !== identity.taskID))
        )
          throw new Error(
            `Task ${requested} does not match its stored identity`,
          );
        const taskID = tracked?.taskID ?? identity?.taskID ?? requested;
        if (!SESSION_ID_PATTERN.test(taskID))
          throw new Error(`Unknown task ID or alias: ${requested}`);
        if (!tracked && !identity) {
          const parent = await fetchChildTranscript(
            getClient(options.input),
            parentSessionID,
            options.input.directory,
          );
          if (
            !isRecord(parent) ||
            !Array.isArray(parent.data) ||
            parent.data.some(
              (message) =>
                !isRecord(message) ||
                !isRecord(message.info) ||
                (message.info.sessionID !== undefined &&
                  message.info.sessionID !== parentSessionID),
            )
          )
            throw new Error(`Unknown task ID or alias: ${requested}`);
          const agent = nativeDelegationAgent(parent, taskID);
          if (!agent) throw new Error(`Unknown task ID or alias: ${requested}`);
          return recoverOrphanResult(
            options,
            {
              taskID,
              parentSessionID,
              agent,
              directory: options.input.directory,
              alias: taskID,
            },
            requested,
            false,
          );
        }
        if (identity && (!tracked || tracked.state === 'running'))
          return recoverOrphanResult(
            options,
            identity,
            requested,
            true,
            tracked,
          );

        // Inspect every retained state BEFORE rejection, acknowledgement or text
        // retrieval. Busy retracts even a consumed or timed-out publication.
        let snapshot: RuntimeSessionStatusSnapshot | undefined;
        if (
          tracked &&
          typeof getClient(options.input).session?.status === 'function'
        ) {
          const observation = gate.capture(tracked);
          if (observation) {
            snapshot = await getRuntimeSessionStatusSnapshot(options.input);
            gate.observe(
              observation,
              runtimeObservationFromSnapshot(
                snapshot,
                taskID,
                observation.readStartedAt,
              ),
            );
          }
        }
        const result = tracked ? await gate.reconcile(tracked) : undefined;
        const current = board.resolve(parentSessionID, requested);
        if (
          tracked &&
          (!current ||
            current.generation !== tracked.generation ||
            result?.kind === 'stale')
        ) {
          throw new Error(
            `Task ${requested} changed generation while its result was being retrieved`,
          );
        }
        if (current?.state === 'running')
          return pending(
            taskID,
            current.statusUncertain,
            snapshot && runtimeSessionStatus(snapshot, taskID),
          );

        const token = current ? gate.capture(current) : undefined;
        const client = getClient(options.input);
        if (typeof client.session.get === 'function') {
          const response = await client.session.get({
            path: { id: taskID },
            query: { directory: options.input.directory },
          });
          if (response.data?.parentID !== parentSessionID)
            throw new Error(
              `Task ${requested} does not belong to this session`,
            );
        } else if (!current)
          throw new Error(
            `Task ${requested} is not tracked by this session and cannot be verified`,
          );

        if (current) {
          const latest = board.get(taskID);
          const after = gate.capture(current);
          if (
            latest?.generation !== current.generation ||
            latest.terminalRevision !== current.terminalRevision ||
            after?.activityRevision !== token?.activityRevision ||
            after?.attemptRevision !== token?.attemptRevision ||
            after?.episode !== token?.episode
          ) {
            throw new Error(
              `Task ${requested} changed generation or publication while its result was being retrieved; wait for its current terminal result instead of retrieving it.`,
            );
          }
          const state =
            current.state === 'reconciled'
              ? current.terminalState
              : current.state;
          if (state === 'completed' && result?.kind !== 'committed')
            return pending(taskID, true);
          board.markUsed(parentSessionID, taskID);
          if (state === 'error')
            throw new Error(
              `Task ${requested} ended in error: ${current.lastStatusError ?? current.resultSummary ?? 'no error details available'}`,
            );
          if (state === 'cancelled')
            throw new Error(
              `Task ${requested} was cancelled: ${current.resultSummary?.replace(/^cancelled:\s*/i, '') ?? 'cancelled'}`,
            );
          if (state !== 'completed' || !current.resultSummary?.trim())
            throw new Error(
              `Task ${requested} has no confirmed completed result`,
            );
          return current.resultSummary;
        }

        snapshot = await getRuntimeSessionStatusSnapshot(options.input);
        const status = runtimeSessionStatus(snapshot, taskID);
        if (status === 'busy' || status === 'retry')
          return pending(taskID, false, status, false);
        if (snapshot.error || snapshot.malformedSessionIDs.has(taskID))
          return pending(taskID, true, undefined, false);
        const response = await fetchChildTranscript(
          client,
          taskID,
          options.input.directory,
        );
        const evidence = classifyTerminalEvidence(response);
        if (evidence.verdict !== 'completed')
          throw new Error(
            `Task ${requested} shows no terminal evidence of completion; refusing to present partial output as its final result`,
          );
        return evidence.text;
      },
    }),
  };
}
