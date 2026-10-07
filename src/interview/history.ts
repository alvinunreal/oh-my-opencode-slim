import {
  locateInterviewStateBlocks,
  parseInterviewStateJson,
  replaceInterviewStateBlocks,
} from './parser';

export const INTERVIEW_SUMMARY_STUB =
  'Previous spec omitted. The current spec is on disk.';

const INTERVIEW_SUBMIT_TOOL = 'interview_submit_state';

type TextPart = { text: string };

type HistoryPart = {
  type?: string;
  text?: string;
  tool?: unknown;
  toolName?: unknown;
  state?: unknown;
  input?: unknown;
};

type HistoryMessage = {
  info?: { role?: string };
  parts?: HistoryPart[];
};

type BlockLocation = {
  part: TextPart;
  start: number;
  end: number;
  json: string;
};

function collectBlocks(part: TextPart): BlockLocation[] {
  return locateInterviewStateBlocks(part.text).map((block) => ({
    part,
    start: block.start,
    end: block.end,
    json: block.json,
  }));
}

function stubBlock(json: string): string {
  const parsed = parseInterviewStateJson(json);
  if (!parsed) return json;
  if (typeof parsed.summary === 'string') {
    parsed.summary = INTERVIEW_SUMMARY_STUB;
  }
  return `<interview_state>\n${JSON.stringify(parsed)}\n</interview_state>`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isInterviewSubmitPart(part: HistoryPart): boolean {
  return (
    (part.type === 'tool' && part.tool === INTERVIEW_SUBMIT_TOOL) ||
    ((part.type === 'tool-call' || part.type === 'tool-result') &&
      part.toolName === INTERVIEW_SUBMIT_TOOL)
  );
}

function toolArgs(part: HistoryPart): Record<string, unknown> | null {
  const toolState = asRecord(part.state);
  const input = toolState ? asRecord(toolState.input) : asRecord(part.input);
  return input ? (asRecord(input.state) ?? input) : null;
}

/**
 * Stub the `summary` and `patch` of an older `interview_submit_state` call.
 * `patch` is removed rather than blanked so a second pass finds nothing to
 * strip, keeping the transform idempotent. The title and questions are small
 * and stay intact.
 */
function stubToolState(part: HistoryPart): HistoryPart {
  const toolState = asRecord(part.state);
  const input = toolState ? asRecord(toolState.input) : null;
  const args = toolArgs(part);
  if (!args) {
    return part;
  }
  const nextArgs = { ...args };
  if (typeof nextArgs.summary === 'string') {
    nextArgs.summary = INTERVIEW_SUMMARY_STUB;
  }
  if ('patch' in nextArgs) {
    delete nextArgs.patch;
  }
  return {
    ...part,
    ...(toolState && input
      ? { state: { ...toolState, input: { ...input, state: nextArgs } } }
      : {
          input:
            asRecord(part.input)?.state !== undefined
              ? { ...asRecord(part.input), state: nextArgs }
              : nextArgs,
        }),
  };
}

function isFullSpecificationSummary(summary: unknown): boolean {
  return (
    typeof summary === 'string' &&
    (/^#{1,6} /m.test(summary) || summary.includes('\n'))
  );
}

function isFullSpec(json: string): boolean {
  const parsed = parseInterviewStateJson(json);
  return (
    parsed !== null &&
    (!('patch' in parsed) || parsed.patch === '') &&
    parsed.summary !== INTERVIEW_SUMMARY_STUB &&
    isFullSpecificationSummary(parsed.summary)
  );
}

function isFullTool(part: HistoryPart): boolean {
  const args = toolArgs(part);
  return (
    args !== null &&
    (!('patch' in args) || args.patch === '') &&
    args.summary !== INTERVIEW_SUMMARY_STUB &&
    isFullSpecificationSummary(args.summary)
  );
}

/**
 * Stub only the kickoff's full specification. Later turns carry status and
 * patches and remain unchanged so the rewrite happens once per interview.
 */
export function collapseInterviewHistory(messages: HistoryMessage[]): void {
  const events: Array<BlockLocation | HistoryPart> = [];

  for (const message of messages) {
    if (message.info?.role !== 'assistant') {
      continue;
    }
    for (const part of message.parts ?? []) {
      if (
        typeof part.text === 'string' &&
        part.text.includes('<interview_state')
      ) {
        const blocks = collectBlocks(part as TextPart);
        events.push(...blocks);
      }
      if (isInterviewSubmitPart(part)) {
        events.push(part);
      }
    }
  }

  const textToStub = new Map<TextPart, Set<string>>();
  const toolsToStub = new Set<HistoryPart>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const later = events
      .slice(index + 1)
      .some((candidate) =>
        'part' in candidate ? true : isInterviewSubmitPart(candidate),
      );
    if (!later) continue;
    if ('part' in event) {
      if (!isFullSpec(event.json)) continue;
      const keys = textToStub.get(event.part) ?? new Set<string>();
      keys.add(`${event.start}:${event.end}`);
      textToStub.set(event.part, keys);
    } else if (isFullTool(event)) {
      toolsToStub.add(event);
    }
  }

  for (const [part, keys] of textToStub) {
    const replacement = replaceInterviewStateBlocks(part.text, (block) =>
      keys.has(`${block.start}:${block.end}`)
        ? stubBlock(block.json)
        : part.text.slice(block.start, block.end),
    );
    for (const message of messages) {
      const parts = message.parts ?? [];
      const index = parts.indexOf(part);
      if (index >= 0) {
        parts[index] = { ...part, text: replacement };
        break;
      }
    }
  }
  for (const part of toolsToStub) {
    for (const message of messages) {
      const parts = message.parts ?? [];
      const index = parts.indexOf(part);
      if (index >= 0) {
        parts[index] = stubToolState(part);
        break;
      }
    }
  }
}
