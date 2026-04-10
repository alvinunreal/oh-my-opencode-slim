import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  createInternalAgentTextPart,
  hasInternalInitiatorMarker,
  log,
} from '../utils';
import { buildFallbackState, findLatestAssistantState } from './parser';
import { buildAnswerPrompt, buildKickoffPrompt } from './prompts';
import type {
  InterviewAnswer,
  InterviewMessage,
  InterviewQuestion,
  InterviewRecord,
  InterviewState,
} from './types';

const COMMAND_NAME = 'interview';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createInterviewDirectoryPath(directory: string): string {
  return path.join(directory, 'interview');
}

function createInterviewFilePath(directory: string, idea: string): string {
  const fileName = `${Date.now()}-${slugify(idea) || 'interview'}.md`;
  return path.join(createInterviewDirectoryPath(directory), fileName);
}

function relativeInterviewPath(directory: string, filePath: string): string {
  return path.relative(directory, filePath) || path.basename(filePath);
}

function extractHistorySection(document: string): string {
  const marker = '## Q&A history\n\n';
  const index = document.indexOf(marker);
  return index >= 0 ? document.slice(index + marker.length).trim() : '';
}

function buildInterviewDocument(
  idea: string,
  summary: string,
  history: string,
): string {
  const normalizedSummary = summary.trim() || 'Waiting for interview answers.';
  const normalizedHistory = history.trim() || 'No answers yet.';

  return [
    `# ${idea}`,
    '',
    '## Current spec',
    '',
    normalizedSummary,
    '',
    '## Q&A history',
    '',
    normalizedHistory,
    '',
  ].join('\n');
}

async function ensureInterviewFile(record: InterviewRecord): Promise<void> {
  await fs.mkdir(path.dirname(record.markdownPath), { recursive: true });
  try {
    await fs.access(record.markdownPath);
  } catch {
    await fs.writeFile(
      record.markdownPath,
      buildInterviewDocument(record.idea, '', ''),
      'utf8',
    );
  }
}

async function readInterviewDocument(record: InterviewRecord): Promise<string> {
  await ensureInterviewFile(record);
  return fs.readFile(record.markdownPath, 'utf8');
}

async function rewriteInterviewDocument(
  record: InterviewRecord,
  summary: string,
): Promise<string> {
  const existing = await readInterviewDocument(record);
  const history = extractHistorySection(existing);
  const next = buildInterviewDocument(record.idea, summary, history);
  await fs.writeFile(record.markdownPath, next, 'utf8');
  return next;
}

async function appendInterviewAnswers(
  record: InterviewRecord,
  questions: InterviewQuestion[],
  answers: InterviewAnswer[],
): Promise<void> {
  const existing = await readInterviewDocument(record);
  const history = extractHistorySection(existing);
  const questionMap = new Map(
    questions.map((question) => [question.id, question]),
  );
  const appended = answers
    .map((answer) => {
      const question = questionMap.get(answer.questionId);
      return question
        ? `Q: ${question.question}\nA: ${answer.answer.trim()}`
        : null;
    })
    .filter((value): value is string => value !== null)
    .join('\n\n');
  const nextHistory = [history, appended].filter(Boolean).join('\n\n');
  await fs.writeFile(
    record.markdownPath,
    buildInterviewDocument(record.idea, '', nextHistory),
    'utf8',
  );
}

export function createInterviewService(ctx: PluginInput): {
  setBaseUrlResolver: (resolver: () => Promise<string>) => void;
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  getInterviewState: (interviewId: string) => Promise<InterviewState>;
  submitAnswers: (
    interviewId: string,
    answers: InterviewAnswer[],
  ) => Promise<void>;
} {
  const activeInterviewIds = new Map<string, string>();
  const interviewsById = new Map<string, InterviewRecord>();
  const sessionBusy = new Map<string, boolean>();
  let resolveBaseUrl: (() => Promise<string>) | null = null;

  function setBaseUrlResolver(resolver: () => Promise<string>): void {
    resolveBaseUrl = resolver;
  }

  async function ensureServer(): Promise<string> {
    if (!resolveBaseUrl) {
      throw new Error('Interview server is not attached');
    }
    return resolveBaseUrl();
  }

  async function loadMessages(sessionID: string): Promise<InterviewMessage[]> {
    const result = await ctx.client.session.messages({
      path: { id: sessionID },
    });
    return result.data as InterviewMessage[];
  }

  function isUserVisibleMessage(message: InterviewMessage): boolean {
    return !(message.parts ?? []).some((part) =>
      hasInternalInitiatorMarker(part),
    );
  }

  function getInterviewById(interviewId: string): InterviewRecord | null {
    return interviewsById.get(interviewId) ?? null;
  }

  async function createInterview(
    sessionID: string,
    idea: string,
  ): Promise<InterviewRecord> {
    const normalizedIdea = idea.trim();
    const activeId = activeInterviewIds.get(sessionID);
    if (activeId) {
      const active = interviewsById.get(activeId);
      if (active && active.status === 'active') {
        if (active.idea === normalizedIdea) {
          return active;
        }

        active.status = 'abandoned';
      }
    }

    const messages = await loadMessages(sessionID);
    const record: InterviewRecord = {
      id: `${Date.now()}-${slugify(idea) || 'interview'}`,
      sessionID,
      idea: normalizedIdea,
      markdownPath: createInterviewFilePath(ctx.directory, idea),
      createdAt: nowIso(),
      status: 'active',
      baseMessageCount: messages.length,
    };

    await ensureInterviewFile(record);
    activeInterviewIds.set(sessionID, record.id);
    interviewsById.set(record.id, record);
    return record;
  }

  async function syncInterview(
    interview: InterviewRecord,
  ): Promise<InterviewState> {
    const allMessages = await loadMessages(interview.sessionID);
    const interviewMessages = allMessages
      .slice(interview.baseMessageCount)
      .filter(isUserVisibleMessage);
    const parsed = findLatestAssistantState(interviewMessages);
    const state = parsed.state ?? buildFallbackState(interviewMessages);
    const document = await rewriteInterviewDocument(interview, state.summary);

    return {
      interview,
      url: `${await ensureServer()}/interview/${interview.id}`,
      markdownPath: relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      ),
      mode:
        interview.status === 'abandoned'
          ? 'abandoned'
          : parsed.latestAssistantError
            ? 'error'
            : sessionBusy.get(interview.sessionID) === true
              ? 'awaiting-agent'
              : state.questions.length > 0
                ? 'awaiting-user'
                : 'awaiting-agent',
      lastParseError: parsed.latestAssistantError,
      isBusy: sessionBusy.get(interview.sessionID) === true,
      summary: state.summary,
      questions: state.questions,
      document,
    };
  }

  async function notifyInterviewUrl(
    sessionID: string,
    interview: InterviewRecord,
  ): Promise<void> {
    const baseUrl = await ensureServer();
    const url = `${baseUrl}/interview/${interview.id}`;
    await ctx.client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            text: [
              '⎔ Interview UI ready',
              '',
              `Open: ${url}`,
              `Document: ${relativeInterviewPath(ctx.directory, interview.markdownPath)}`,
              '',
              '[system status: continue without acknowledging this notification]',
            ].join('\n'),
          },
        ],
      },
    });
  }

  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Start an interview and write a live markdown spec',
        description:
          'Open a localhost interview UI linked to the current OpenCode session',
      };
    }
  }

  async function getInterviewState(
    interviewId: string,
  ): Promise<InterviewState> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    return syncInterview(interview);
  }

  async function submitAnswers(
    interviewId: string,
    answers: InterviewAnswer[],
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    if (sessionBusy.get(interview.sessionID) === true) {
      throw new Error(
        'Interview session is busy. Wait for the current response.',
      );
    }

    const state = await getInterviewState(interviewId);
    if (state.mode === 'error') {
      throw new Error('Interview is waiting for a valid agent update.');
    }

    const activeQuestionIds = new Set(
      state.questions.map((question) => question.id),
    );
    if (activeQuestionIds.size === 0) {
      throw new Error('There are no active interview questions to answer.');
    }
    if (answers.length !== activeQuestionIds.size) {
      throw new Error(
        'Answer every active interview question before submitting.',
      );
    }
    const invalidAnswer = answers.find(
      (answer) =>
        !activeQuestionIds.has(answer.questionId) || !answer.answer.trim(),
    );
    if (invalidAnswer) {
      throw new Error('Answers do not match the current interview questions.');
    }

    await appendInterviewAnswers(interview, state.questions, answers);
    const prompt = buildAnswerPrompt(answers, state.questions);
    sessionBusy.set(interview.sessionID, true);

    let promptSent = false;
    try {
      await ctx.client.session.prompt({
        path: { id: interview.sessionID },
        body: {
          parts: [createInternalAgentTextPart(prompt)],
        },
      });
      promptSent = true;
    } finally {
      if (!promptSent) {
        sessionBusy.set(interview.sessionID, false);
      }
    }
  }

  async function handleCommandExecuteBefore(
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command !== COMMAND_NAME) {
      return;
    }

    const idea = input.arguments.trim();
    output.parts.length = 0;

    if (!idea) {
      const activeId = activeInterviewIds.get(input.sessionID);
      const interview = activeId ? interviewsById.get(activeId) : null;
      if (!interview || interview.status !== 'active') {
        output.parts.push(
          createInternalAgentTextPart(
            'The user ran /interview without an idea. Ask them for the product idea in one sentence.',
          ),
        );
        return;
      }

      await notifyInterviewUrl(input.sessionID, interview);
      output.parts.push(
        createInternalAgentTextPart(
          'The interview UI was reopened for the current session. If your latest interview turn already contains unanswered questions, do not repeat them. Otherwise continue the interview with exactly 2 clarifying questions and include the structured <interview_state> block.',
        ),
      );
      return;
    }

    const interview = await createInterview(input.sessionID, idea);
    await notifyInterviewUrl(input.sessionID, interview);
    output.parts.push(createInternalAgentTextPart(buildKickoffPrompt(idea)));
  }

  async function handleEvent(input: {
    event: { type: string; properties?: Record<string, unknown> };
  }): Promise<void> {
    const { event } = input;
    const properties = event.properties ?? {};

    if (event.type === 'session.status') {
      const sessionID = properties.sessionID as string | undefined;
      const status = properties.status as { type?: string } | undefined;
      if (sessionID) {
        sessionBusy.set(sessionID, status?.type === 'busy');
      }
      return;
    }

    if (event.type === 'session.deleted') {
      const deletedSessionId =
        ((properties.info as { id?: string } | undefined)?.id ??
          (properties.sessionID as string | undefined)) ||
        null;
      if (!deletedSessionId) {
        return;
      }

      sessionBusy.delete(deletedSessionId);
      const interviewId = activeInterviewIds.get(deletedSessionId);
      if (!interviewId) {
        return;
      }

      const interview = interviewsById.get(interviewId);
      if (!interview) {
        return;
      }

      interview.status = 'abandoned';
      activeInterviewIds.delete(deletedSessionId);
      log('[interview] session deleted, interview marked abandoned', {
        sessionID: deletedSessionId,
        interviewId,
      });
    }
  }

  return {
    setBaseUrlResolver,
    registerCommand,
    handleCommandExecuteBefore,
    handleEvent,
    getInterviewState,
    submitAnswers,
  };
}
