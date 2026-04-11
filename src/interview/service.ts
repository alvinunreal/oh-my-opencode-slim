import { spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig } from '../config';
import {
  createInternalAgentTextPart,
  hasInternalInitiatorMarker,
  log,
} from '../utils';
import { buildFallbackState, findLatestAssistantState } from './parser';
import {
  buildAnswerPrompt,
  buildKickoffPrompt,
  buildResumePrompt,
} from './prompts';
import type {
  InterviewAnswer,
  InterviewMessage,
  InterviewQuestion,
  InterviewRecord,
  InterviewState,
} from './types';

const COMMAND_NAME = 'interview';
const DEFAULT_MAX_QUESTIONS = 2;
const DEFAULT_OUTPUT_FOLDER = 'interview';
const DEFAULT_AUTO_OPEN_BROWSER = true;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Open a URL in the default browser.
 * Supports macOS, Linux, and Windows. Failures are logged but not thrown.
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux and other Unix-like systems
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (error) => {
      log('[interview] failed to open browser:', { error: error.message, url });
    });
    child.unref();
  } catch (error) {
    log('[interview] failed to spawn browser opener:', {
      error: error instanceof Error ? error.message : String(error),
      url,
    });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOutputFolder(outputFolder: string): string {
  const normalized = outputFolder.trim().replace(/^\/+|\/+$/g, '');
  return normalized || DEFAULT_OUTPUT_FOLDER;
}

function createInterviewDirectoryPath(
  directory: string,
  outputFolder: string,
): string {
  return path.join(directory, normalizeOutputFolder(outputFolder));
}

function createInterviewFilePath(
  directory: string,
  outputFolder: string,
  idea: string,
): string {
  const fileName = `${slugify(idea) || 'interview'}.md`;
  return path.join(
    createInterviewDirectoryPath(directory, outputFolder),
    fileName,
  );
}

function relativeInterviewPath(directory: string, filePath: string): string {
  return path.relative(directory, filePath) || path.basename(filePath);
}

function extractHistorySection(document: string): string {
  const marker = '## Q&A history\n\n';
  const index = document.indexOf(marker);
  return index >= 0 ? document.slice(index + marker.length).trim() : '';
}

function extractSummarySection(document: string): string {
  const marker = '## Current spec\n\n';
  const historyMarker = '\n\n## Q&A history';
  const start = document.indexOf(marker);
  if (start < 0) {
    return '';
  }
  const summaryStart = start + marker.length;
  const summaryEnd = document.indexOf(historyMarker, summaryStart);
  return document
    .slice(summaryStart, summaryEnd >= 0 ? summaryEnd : undefined)
    .trim();
}

function extractTitle(document: string): string {
  const match = document.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? '';
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
  const summary = extractSummarySection(existing);
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
  const nextHistory = [history === 'No answers yet.' ? '' : history, appended]
    .filter(Boolean)
    .join('\n\n');
  await fs.writeFile(
    record.markdownPath,
    buildInterviewDocument(record.idea, summary, nextHistory),
    'utf8',
  );
}

function resolveExistingInterviewPath(
  directory: string,
  outputFolder: string,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const outputDir = createInterviewDirectoryPath(directory, outputFolder);
  const candidates = new Set<string>();

  if (path.isAbsolute(trimmed)) {
    candidates.add(trimmed);
  } else {
    candidates.add(path.resolve(directory, trimmed));
    candidates.add(path.join(outputDir, trimmed));
    if (!trimmed.endsWith('.md')) {
      candidates.add(path.join(outputDir, `${trimmed}.md`));
    }
  }

  for (const candidate of candidates) {
    if (path.extname(candidate) !== '.md') {
      continue;
    }
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function createInterviewService(
  ctx: PluginInput,
  config?: InterviewConfig,
  deps?: {
    openBrowser?: (url: string) => void;
  },
): {
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
  const maxQuestions = config?.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const outputFolder = normalizeOutputFolder(
    config?.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
  );
  const autoOpenBrowser = config?.autoOpenBrowser ?? DEFAULT_AUTO_OPEN_BROWSER;
  const browserOpener = deps?.openBrowser ?? openBrowser;
  const activeInterviewIds = new Map<string, string>();
  const interviewsById = new Map<string, InterviewRecord>();
  const sessionBusy = new Map<string, boolean>();
  const browserOpened = new Set<string>(); // Track interviews that have opened browser
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

  function maybeOpenBrowser(interviewId: string, url: string): void {
    if (!autoOpenBrowser) {
      return;
    }
    if (browserOpened.has(interviewId)) {
      return;
    }
    browserOpened.add(interviewId);
    browserOpener(url);
  }

  async function maybeRenameWithTitle(
    interview: InterviewRecord,
    assistantTitle: string | undefined,
  ): Promise<void> {
    if (!assistantTitle) {
      return;
    }
    const newSlug = slugify(assistantTitle);
    if (!newSlug) {
      return;
    }

    const currentFileName = path.basename(interview.markdownPath, '.md');
    // If already matches (or user-provided idea matches), skip
    if (currentFileName === newSlug) {
      return;
    }

    const dir = path.dirname(interview.markdownPath);
    const newPath = path.join(dir, `${newSlug}.md`);

    // Don't overwrite existing files
    try {
      await fs.access(newPath);
      // File exists, don't rename
      return;
    } catch {
      // File doesn't exist, safe to rename
    }

    try {
      await fs.rename(interview.markdownPath, newPath);
      interview.markdownPath = newPath;
      log('[interview] renamed file with assistant title:', {
        from: currentFileName,
        to: newSlug,
      });
    } catch (error) {
      log('[interview] failed to rename file:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      markdownPath: createInterviewFilePath(ctx.directory, outputFolder, idea),
      createdAt: nowIso(),
      status: 'active',
      baseMessageCount: messages.length,
    };

    await ensureInterviewFile(record);
    activeInterviewIds.set(sessionID, record.id);
    interviewsById.set(record.id, record);
    return record;
  }

  async function resumeInterview(
    sessionID: string,
    markdownPath: string,
  ): Promise<InterviewRecord> {
    const activeId = activeInterviewIds.get(sessionID);
    if (activeId) {
      const active = interviewsById.get(activeId);
      if (active && active.status === 'active') {
        if (active.markdownPath === markdownPath) {
          return active;
        }

        active.status = 'abandoned';
      }
    }

    const document = await fs.readFile(markdownPath, 'utf8');
    const messages = await loadMessages(sessionID);
    const title = extractTitle(document);
    const record: InterviewRecord = {
      id: `${Date.now()}-${slugify(path.basename(markdownPath, '.md')) || 'interview'}`,
      sessionID,
      idea: title || path.basename(markdownPath, '.md'),
      markdownPath,
      createdAt: nowIso(),
      status: 'active',
      baseMessageCount: messages.length,
    };

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
    const parsed = findLatestAssistantState(interviewMessages, maxQuestions);
    const existingDocument = await readInterviewDocument(interview);
    const fallbackState = buildFallbackState(interviewMessages);
    const state = parsed.state ?? {
      ...fallbackState,
      summary: extractSummarySection(existingDocument) || fallbackState.summary,
    };

    // Rename file if assistant provided a title (and file hasn't been renamed yet)
    await maybeRenameWithTitle(interview, state.title);

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

    // Auto-open browser on initial creation (not on every poll/refresh)
    maybeOpenBrowser(interview.id, url);

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

    // Acquire busy lock immediately before any async operations to prevent race
    sessionBusy.set(interview.sessionID, true);
    let promptSent = false;

    try {
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
        throw new Error(
          'Answers do not match the current interview questions.',
        );
      }

      await appendInterviewAnswers(interview, state.questions, answers);
      const prompt = buildAnswerPrompt(answers, state.questions, maxQuestions);

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
          `The interview UI was reopened for the current session. If your latest interview turn already contains unanswered questions, do not repeat them. Otherwise continue the interview with up to ${maxQuestions} clarifying questions and include the structured <interview_state> block.`,
        ),
      );
      return;
    }

    const resumePath = resolveExistingInterviewPath(
      ctx.directory,
      outputFolder,
      idea,
    );
    if (resumePath) {
      const interview = await resumeInterview(input.sessionID, resumePath);
      const document = await fs.readFile(interview.markdownPath, 'utf8');
      await notifyInterviewUrl(input.sessionID, interview);
      output.parts.push(
        createInternalAgentTextPart(buildResumePrompt(document, maxQuestions)),
      );
      return;
    }

    const interview = await createInterview(input.sessionID, idea);
    await notifyInterviewUrl(input.sessionID, interview);
    output.parts.push(
      createInternalAgentTextPart(buildKickoffPrompt(idea, maxQuestions)),
    );
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
