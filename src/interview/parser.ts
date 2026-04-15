import type {
  InterviewAssistantState,
  InterviewMessage,
  InterviewQuestion,
} from './types';
import { RawInterviewStateSchema, RawQuestionSchema } from './types';

const INTERVIEW_BLOCK_REGEX =
  /<interview_state>\s*([\s\S]*?)\s*<\/interview_state>/i;

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

export function parseAssistantState(
  text: string,
  maxQuestions = 2,
): {
  state: InterviewAssistantState | null;
  error?: string;
} {
  const match = text.match(INTERVIEW_BLOCK_REGEX);
  if (!match) {
    return { state: null };
  }

  try {
    const raw = JSON.parse(match[1]);
    // Validate raw LLM output with Zod before processing
    const parsed = RawInterviewStateSchema.parse(raw) as Record<
      string,
      unknown
    >;
    const summary =
      typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
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

    return {
      state: {
        summary,
        title,
        questions,
      },
    };
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
