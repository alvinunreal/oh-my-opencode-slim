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
 * Atomic task-output header: identity and state come from the host's
 * opening (XML wrapper tag or textual marker) alone — result content can
 * quote foreign task markup but never supplies attribution.
 */
interface TaskOutputHeader {
  taskID?: string;
  state?: TaskOutputState;
}

/** The native v2 background launch sentence: host-authored, no child text. */
const NATIVE_BACKGROUND_LAUNCH =
  /^\s*The subagent is working in the background \(sessionID:\s*([^\s)]+)\)/i;

/** True when `output` opens with the native v2 background launch sentence. */
export function isNativeBackgroundLaunchOutput(output: string): boolean {
  return NATIVE_BACKGROUND_LAUNCH.test(output);
}

/**
 * Tokenize an opening tag into its attributes, walking complete
 * name="value" pairs: values are consumed whole between their own quote
 * delimiters, so text inside one attribute's value can never pose as
 * another attribute. A duplicated name invalidates the whole header.
 */
function parseTagAttributes(tag: string): Map<string, string> | undefined {
  const attrs = new Map<string, string>();
  let i = 1; // skip '<'
  while (i < tag.length && /[^\s/>=]/.test(tag[i] as string)) i += 1;
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i] as string)) i += 1;
    if (i >= tag.length || tag[i] === '>') break;
    const nameStart = i;
    while (i < tag.length && /[^\s=/>]/.test(tag[i] as string)) i += 1;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < tag.length && /\s/.test(tag[i] as string)) i += 1;
    if (tag[i] !== '=') continue;
    i += 1;
    while (i < tag.length && /\s/.test(tag[i] as string)) i += 1;
    const quote = tag[i] === '"' || tag[i] === "'" ? tag[i] : undefined;
    if (quote) i += 1;
    const valueStart = i;
    while (
      i < tag.length &&
      (quote ? tag[i] !== quote : /[^\s>]/.test(tag[i] as string))
    ) {
      i += 1;
    }
    const value = tag.slice(valueStart, i);
    if (quote) i += 1;
    if (attrs.has(name)) return undefined;
    attrs.set(name, value);
  }
  return attrs;
}

export function parseTaskOutputHeader(output: string): TaskOutputHeader {
  // XML wrapper: the output opens with the host's wrapper tag. The tag
  // closes at the first `>` OUTSIDE quoted values; once an XML opening is
  // detected, any scan failure (inner '<', unterminated quote, exhausted
  // input) rejects the header outright — never fall back to textual
  // formats on the body.
  const start = /^\s*</.exec(output);
  if (start) {
    let end = start[0].length;
    let quote: string | undefined;
    for (; end < output.length; end += 1) {
      const ch = output[end] as string;
      if (quote) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      else if (ch === '<') return {};
    }
    if (end === output.length) return {};
    const tag = output.slice(start[0].length - 1, end + 1);
    const kind = /^<(task|subagent)\b/i.exec(tag)?.[1]?.toLowerCase();
    if (kind) {
      const attrs = parseTagAttributes(tag);
      if (!attrs) return {};
      const identity = attrs.get(kind === 'subagent' ? 'sessionid' : 'id');
      const rawState = attrs.get('state');
      return {
        taskID: identity || undefined,
        state:
          rawState && /^(running|completed|error|cancelled)$/i.test(rawState)
            ? (rawState.toLowerCase() as TaskOutputState)
            : undefined,
      };
    }
  }
  const failed =
    /^\s*Subagent (failed|cancelled) \(sessionID:\s*([^\s)]+)\)/i.exec(output);
  if (failed)
    return {
      taskID: failed[2],
      state: (failed[1].toLowerCase() === 'failed'
        ? 'error'
        : 'cancelled') as TaskOutputState,
    };
  const working = NATIVE_BACKGROUND_LAUNCH.exec(output);
  if (working) return { taskID: working[1], state: 'running' };
  // Textual header: key/value lines in the header region (before
  // `<task_result>`/`<task_error>`), never inside the result body. Accepts
  // the v1 `task_id:` key and the v2 `sessionID:` key.
  const header = getTaskHeader(output);
  const parsed: TaskOutputHeader = {};
  for (const line of header.split(/\r?\n/)) {
    const trimmed = line.trim();
    const idMatch = /^(?:task_id|sessionID):\s*([^\s()]+)(?:\s*\(.*)?$/i.exec(
      trimmed,
    );
    if (idMatch) parsed.taskID ??= idMatch[1];
    const stateMatch =
      /^state:\s*(running|completed|error|cancelled)\s*$/i.exec(trimmed);
    if (stateMatch)
      parsed.state ??= stateMatch[1].toLowerCase() as TaskOutputState;
  }
  parsed.taskID ??= /\(sessionID:\s*([^\s)]+)\)/.exec(header)?.[1];
  return parsed;
}

export function parseTaskIdFromTaskOutput(output: string): string | undefined {
  return parseTaskOutputHeader(output).taskID;
}

export function parseTaskLaunchOutput(
  output: string,
): TaskLaunchOutput | undefined {
  const { taskID, state } = parseTaskOutputHeader(output);
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
  const { taskID, state } = parseTaskOutputHeader(output);
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
  return parseTaskOutputHeader(output).state;
}

export function findTaskErrorNotice(text: string, tag: 'task' | 'subagent') {
  const blocks = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  for (const [block] of text.matchAll(blocks)) {
    const status = parseTaskStatusOutput(block);
    if (status?.state === 'error') return { block, taskID: status.taskID };
  }
  return undefined;
}

/** Diagnostic applied when a terminal `completed` report carries no text. */
export const COMPLETED_WITHOUT_TEXT_DIAGNOSTIC =
  'Task ended without a public text result; completion is not confirmed';

export interface GuardedTaskStatus<
  S extends TaskOutputState = TaskOutputState,
> {
  state: S | 'error';
  resultSummary?: string;
  lastStatusError?: string;
}

export function guardCompletedStatusText<S extends TaskOutputState>(
  state: S,
  result: string | undefined,
  existingResultSummary: string | undefined,
): GuardedTaskStatus<S> {
  if (
    state === 'completed' &&
    !result?.trim() &&
    !existingResultSummary?.trim()
  ) {
    return {
      state: 'error',
      resultSummary: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
      lastStatusError: COMPLETED_WITHOUT_TEXT_DIAGNOSTIC,
    };
  }
  return { state, resultSummary: result };
}

export function parseTaskResultFromOutput(output: string): string | undefined {
  // Require matching open/close tags via backreference
  const match = /<task_(result|error)>\s*([\s\S]*?)\s*<\/task_\1>/m.exec(
    output,
  );
  const result = match?.[2]?.trim();
  if (result) return result;

  // v2 `subagent` wraps its final text directly inside the tag. The
  // opening tag is scanned quote-aware — same boundary rule as the header
  // parser — so a quoted `>` inside an attribute (description="a > b")
  // cannot truncate the tag and leak into the result text.
  const tagStart = output.indexOf('<subagent');
  if (tagStart !== -1) {
    let quote: string | undefined;
    let tagEnd = -1;
    for (let i = tagStart + 1; i < output.length; i += 1) {
      const ch = output[i] as string;
      if (quote) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') {
        tagEnd = i;
        break;
      }
    }
    const close = tagEnd === -1 ? -1 : output.indexOf('</subagent>', tagEnd);
    if (close !== -1) {
      const subagentResult = output.slice(tagEnd + 1, close).trim();
      if (subagentResult) return subagentResult;
    }
  }

  return undefined;
}

function getTaskHeader(output: string): string {
  const resultIndex = output.search(/<task_(?:result|error)>/);
  if (resultIndex === -1) return output;
  return output.slice(0, resultIndex);
}
