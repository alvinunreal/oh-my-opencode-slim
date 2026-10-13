import type {
  InterviewAssistantState,
  InterviewMessage,
  InterviewQuestion,
} from './types';
import { RawInterviewStateSchema, RawQuestionSchema } from './types';

const OPEN_TAG = '<interview_state>';
const CLOSE_TAG = '</interview_state>';

export interface InterviewStateBlock {
  start: number;
  end: number;
  json: string;
}

export function replaceInterviewStateBlocks(
  text: string,
  replace: (block: InterviewStateBlock) => string,
): string {
  const blocks = locateInterviewStateBlocks(text);
  return [...blocks]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, block) =>
        result.slice(0, block.start) + replace(block) + result.slice(block.end),
      text,
    );
}

export function hasInterviewStateBlock(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(OPEN_TAG) && lower.includes(CLOSE_TAG);
}

/**
 * Every block whose body parses. A preface that merely mentions the opening
 * tag is skipped, so the mention does not swallow the real block that follows.
 */
export function locateInterviewStateBlocks(
  text: string,
): InterviewStateBlock[] {
  const lower = text.toLowerCase();
  const blocks: InterviewStateBlock[] = [];
  let cursor = 0;
  while (cursor < lower.length) {
    const start = lower.indexOf(OPEN_TAG, cursor);
    if (start < 0) {
      break;
    }
    const contentStart = start + OPEN_TAG.length;
    let closeSearch = contentStart;
    let matched = false;
    while (closeSearch < lower.length) {
      const close = lower.indexOf(CLOSE_TAG, closeSearch);
      if (close < 0) {
        break;
      }
      const json = text.slice(contentStart, close).trim();
      if (parseInterviewStateJson(json)) {
        blocks.push({
          start,
          end: close + CLOSE_TAG.length,
          json,
        });
        cursor = close + CLOSE_TAG.length;
        matched = true;
        break;
      }
      closeSearch = close + 1;
    }
    if (!matched) {
      cursor = contentStart;
    }
  }
  return blocks;
}

function normalizeQuestion(
  value: unknown,
  index: number,
): InterviewQuestion | null {
  // Validate raw question object with Zod
  const result = RawQuestionSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const question =
    typeof result.data.question === 'string' ? result.data.question.trim() : '';
  if (!question) {
    return null;
  }

  const options = Array.isArray(result.data.options)
    ? result.data.options
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    id:
      typeof result.data.id === 'string' && result.data.id.trim().length > 0
        ? result.data.id.trim()
        : `q-${index + 1}`,
    question,
    options,
    suggested:
      typeof result.data.suggested === 'string' &&
      result.data.suggested.trim().length > 0
        ? result.data.suggested.trim()
        : undefined,
  };
}

export function parseInterviewStateJson(
  json: string,
): Record<string, unknown> | null {
  let rawJson = json.trim();
  try {
    JSON.parse(rawJson);
  } catch {
    rawJson = repairJsonNewlines(rawJson);
  }
  try {
    const raw = JSON.parse(rawJson);
    const parsed = RawInterviewStateSchema.parse(raw);
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function repairJsonNewlines(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === '\\') {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else {
        result += char;
      }
    } else {
      if (char === '"') {
        inString = true;
      }
      result += char;
    }
  }
  return result;
}

export function flattenMessage(message: InterviewMessage): string {
  return (message.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n')
    .trim();
}

export function buildFallbackState(
  messages: InterviewMessage[],
): InterviewAssistantState {
  const answerCount = messages.filter(
    (message) => message.info?.role === 'user',
  ).length;

  return {
    summary:
      answerCount > 0
        ? 'Interview in progress.'
        : 'Waiting for the first interview response.',
    questions: [],
  };
}

/**
 * Normalize a raw parsed state object into the canonical assistant state.
 * Shared by the text parser and the `interview_submit_state` tool path so
 * both produce identical state for equivalent input.
 */
export function normalizeAssistantState(
  parsed: Record<string, unknown>,
  maxQuestions = 2,
): InterviewAssistantState {
  const summary =
    typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const patch = typeof parsed.patch === 'string' ? parsed.patch : undefined;
  const title =
    typeof parsed.title === 'string' && parsed.title.trim().length > 0
      ? parsed.title.trim()
      : undefined;
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
        .map((value, index) => normalizeQuestion(value, index))
        .filter((value): value is InterviewQuestion => value !== null)
        .slice(0, maxQuestions)
    : [];

  return { summary, patch, title, questions };
}

export function parseAssistantState(
  text: string,
  maxQuestions = 2,
): {
  state: InterviewAssistantState | null;
  error?: string;
} {
  const blocks = locateInterviewStateBlocks(text);
  const parsed = parseInterviewStateJson(blocks[blocks.length - 1]?.json ?? '');
  if (!parsed) {
    const lower = text.toLowerCase();
    if (lower.includes(OPEN_TAG) && lower.includes(CLOSE_TAG)) {
      return {
        state: null,
        error: 'Failed to parse interview state',
      };
    }
    return { state: null };
  }

  try {
    return { state: normalizeAssistantState(parsed, maxQuestions) };
  } catch (error) {
    return {
      state: null,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to parse interview state',
    };
  }
}

export function findLatestAssistantState(
  messages: InterviewMessage[],
  maxQuestions = 2,
): {
  state: InterviewAssistantState | null;
  latestAssistantError?: string;
} {
  let latestAssistantError: string | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.info?.role !== 'assistant') {
      continue;
    }

    const parsed = parseAssistantState(flattenMessage(message), maxQuestions);
    if (parsed.state) {
      return {
        state: parsed.state,
        latestAssistantError,
      };
    }

    if (!latestAssistantError) {
      latestAssistantError = parsed.error ?? 'Missing <interview_state> block';
    }
  }

  return {
    state: null,
    latestAssistantError,
  };
}
