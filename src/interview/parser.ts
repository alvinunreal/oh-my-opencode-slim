import type {
  InterviewAssistantState,
  InterviewMessage,
  InterviewQuestion,
} from './types';

const INTERVIEW_BLOCK_REGEX =
  /<interview_state>\s*([\s\S]*?)\s*<\/interview_state>/i;

function normalizeQuestion(
  value: Record<string, unknown>,
  index: number,
): InterviewQuestion | null {
  const question =
    typeof value.question === 'string' ? value.question.trim() : '';
  if (!question) {
    return null;
  }

  const options = Array.isArray(value.options)
    ? value.options
        .filter((option): option is string => typeof option === 'string')
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    id:
      typeof value.id === 'string' && value.id.trim().length > 0
        ? value.id.trim()
        : `q-${index + 1}`,
    question,
    options,
    suggested:
      typeof value.suggested === 'string' && value.suggested.trim().length > 0
        ? value.suggested.trim()
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
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    const summary =
      typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const title =
      typeof parsed.title === 'string' && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : undefined;
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .filter(
            (value): value is Record<string, unknown> =>
              typeof value === 'object' && value !== null,
          )
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.info?.role !== 'assistant') {
      continue;
    }

    const parsed = parseAssistantState(flattenMessage(message), maxQuestions);
    if (parsed.state) {
      return {
        state: parsed.state,
      };
    }

    return {
      state: null,
      latestAssistantError: parsed.error ?? 'Missing <interview_state> block',
    };
  }

  return {
    state: null,
  };
}
