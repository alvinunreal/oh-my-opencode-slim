/**
 * Parse Task tool output to recover a session/task ID for resumption.
 */

export type TaskOutputState = 'running' | 'completed' | 'error' | 'cancelled';

export interface TaskLaunchOutput {
  taskID: string;
  state: 'running';
  result?: string;
}

export interface TaskStatusOutput {
  taskID: string;
  state: TaskOutputState;
  timedOut: boolean;
  result?: string;
}

/**
 * Static, deterministic placeholder for a still-running background task tool
 * result. Keyed only on the task ID so re-rendering across consecutive
 * requests produces byte-identical output regardless of any live progress the
 * runtime may stream into the tool part's `state.output`. Keeping running
 * results byte-stable prevents provider prompt-cache invalidation mid-history
 * while a background lane is active.
 */
export function renderRunningTaskPlaceholder(taskID: string): string {
  return [
    `<task id="${taskID}" state="running">`,
    '<summary>Background task running</summary>',
    '<task_result>',
    'The task is working in the background. You will be notified automatically when it finishes.',
    '</task_result>',
    '</task>',
  ].join('\n');
}

/**
 * Render a terminal task tool output from a background job board record.
 * Used to reconcile a false-cancelled foreground task part (opencode marked
 * it "error" because the FG-fallback abort poisoned the awaited BackgroundJob)
 * once the board later records the real model-2 outcome (#595).
 *
 * Mirrors opencode task.ts `renderOutput` shape so the orchestrator's history
 * reads as a normal terminal result. Content is the board's resultSummary
 * (the authoritative outcome the board captured); full model-2 text is not
 * recoverable from the orphan runLoop, but the board truth is what matters.
 */
export function renderTaskTerminalFromBoard(input: {
  taskID: string;
  state: 'completed' | 'error';
  description: string;
  resultSummary?: string;
}): string {
  const { taskID, state, description, resultSummary } = input;
  const tag = state === 'error' ? 'task_error' : 'task_result';
  const summary =
    state === 'completed'
      ? `Background task completed: ${description}`
      : `Background task failed: ${description}`;
  const body = resultSummary ?? (state === 'completed' ? 'Task completed.' : 'Task failed.');
  return [
    `<task id="${taskID}" state="${state}">`,
    `<summary>${summary}</summary>`,
    `<${tag}>`,
    body,
    `</${tag}>`,
    '</task>',
  ].join('\n');
}

export function parseTaskIdFromTaskOutput(output: string): string | undefined {
  const xmlMatch = /<task\s+[^>]*\bid=["']([^"']+)["'][^>]*>/i.exec(output);
  if (xmlMatch) return xmlMatch[1];

  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const match = /^task_id:\s*([^\s()]+)(?:\s*\(.*)?$/.exec(trimmed);

    if (!match) {
      continue;
    }

    return match[1];
  }

  return undefined;
}

export function parseTaskLaunchOutput(
  output: string,
): TaskLaunchOutput | undefined {
  const taskID = parseTaskIdFromTaskOutput(output);
  const state = parseTaskStateFromOutput(output);

  if (!taskID || state !== 'running') return undefined;

  return {
    taskID,
    state,
    result: parseTaskResultFromOutput(output),
  };
}

export function parseTaskStatusOutput(
  output: string,
): TaskStatusOutput | undefined {
  const taskID = parseTaskIdFromTaskOutput(output);
  const state = parseTaskStateFromOutput(output);

  if (!taskID || !state) return undefined;

  return {
    taskID,
    state,
    timedOut: state === 'running' && /Timed out after \d+ms/i.test(output),
    result: parseTaskResultFromOutput(output),
  };
}

export function parseTaskStateFromOutput(
  output: string,
): TaskOutputState | undefined {
  const xmlMatch =
    /<task\s+[^>]*\bstate=["'](running|completed|error|cancelled)["'][^>]*>/i.exec(
      output,
    );
  if (xmlMatch) return xmlMatch[1].toLowerCase() as TaskOutputState;

  for (const line of getTaskHeader(output).split(/\r?\n/)) {
    const match = /^state:\s*(running|completed|error|cancelled)\s*$/i.exec(
      line.trim(),
    );

    if (match) return match[1].toLowerCase() as TaskOutputState;
  }

  return undefined;
}

export function parseTaskResultFromOutput(output: string): string | undefined {
  // Require matching open/close tags via backreference
  const match = /<task_(result|error)>\s*([\s\S]*?)\s*<\/task_\1>/m.exec(
    output,
  );
  const result = match?.[2]?.trim();

  return result || undefined;
}

function getTaskHeader(output: string): string {
  const resultIndex = output.search(/<task_(?:result|error)>/);
  if (resultIndex === -1) return output;
  return output.slice(0, resultIndex);
}
