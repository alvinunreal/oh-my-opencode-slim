import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig } from '../config';
import {
  createInternalAgentTextPart,
  hasInternalInitiatorMarker,
  log,
} from '../utils';
import { parseModelReference } from '../utils/session';
import {
  appendInterviewAnswers,
  createInterviewDirectoryPath,
  createInterviewFilePath,
  DEFAULT_OUTPUT_FOLDER,
  ensureInterviewFile,
  extractSummarySection,
  extractTitle,
  normalizeOutputFolder,
  readInterviewDocument,
  relativeInterviewPath,
  resolveExistingInterviewPath,
  rewriteInterviewDocument,
  slugify,
} from './document';
import { buildFallbackState, findLatestAssistantState } from './parser';
import {
  buildAnswerPrompt,
  buildKickoffPrompt,
  buildResumePrompt,
} from './prompts';
import type {
  InterviewAnswer,
  InterviewFileItem,
  InterviewListItem,
  InterviewMessage,
  InterviewRecord,
  InterviewState,
} from './types';

const COMMAND_NAME = 'interview';
const DEFAULT_MAX_QUESTIONS = 2;

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value !== '0' && value.toLowerCase() !== 'false';
}

function isAutomatedRuntime(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === 'test' ||
    isTruthyEnvFlag(env.CI) ||
    isTruthyEnvFlag(env.BUN_TEST) ||
    isTruthyEnvFlag(env.VITEST) ||
    env.JEST_WORKER_ID !== undefined
  );
}

function shouldAutoOpenBrowser(
  config: InterviewConfig | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const requested = config?.autoOpenBrowser ?? true;
  return requested && !isAutomatedRuntime(env);
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

export function createInterviewService(
  ctx: PluginInput,
  config?: InterviewConfig,
  deps?: {
    openBrowser?: (url: string) => void;
    env?: NodeJS.ProcessEnv;
  },
): {
  setBaseUrlResolver: (resolver: () => Promise<string>) => void;
  setStatePushCallback: (
    callback: (interviewId: string, state: InterviewState) => void,
  ) => void;
  setOnInterviewCreated: (
    callback: (interview: InterviewRecord) => void,
  ) => void;
  getActiveInterviewId: (sessionID: string) => string | null;
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  getInterviewState: (interviewId: string) => Promise<InterviewState>;
  listInterviewFiles: () => Promise<InterviewFileItem[]>;
  listInterviews: () => InterviewListItem[];
  submitAnswers: (
    interviewId: string,
    answers: InterviewAnswer[],
  ) => Promise<void>;
  handleNudgeAction: (
    interviewId: string,
    action: 'more-questions' | 'confirm-complete',
  ) => Promise<void>;
} {
  const maxQuestions = config?.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const outputFolder = normalizeOutputFolder(
    config?.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
  );
  const autoOpenBrowser = shouldAutoOpenBrowser(
    config,
    deps?.env ?? process.env,
  );
  const browserOpener = deps?.openBrowser ?? openBrowser;
  const activeInterviewIds = new Map<string, string>();
  const interviewsById = new Map<string, InterviewRecord>();
  const sessionBusy = new Map<string, boolean>();
  const sessionModel = new Map<string, string>();
  const browserOpened = new Set<string>(); // Track interviews that have opened browser
  let resolveBaseUrl: (() => Promise<string>) | null = null;
  let onStateChange:
    | ((interviewId: string, state: InterviewState) => void)
    | null = null;
  let onInterviewCreated: ((interview: InterviewRecord) => void) | null = null;
  let idCounter = 0;

  function setBaseUrlResolver(resolver: () => Promise<string>): void {
    resolveBaseUrl = resolver;
  }

  function setStatePushCallback(
    callback: (interviewId: string, state: InterviewState) => void,
  ): void {
    onStateChange = callback;
  }

  function setOnInterviewCreated(
    callback: (interview: InterviewRecord) => void,
  ): void {
    onInterviewCreated = callback;
  }

  function getActiveInterviewId(sessionID: string): string | null {
    return activeInterviewIds.get(sessionID) ?? null;
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
      id: `${Date.now()}-${++idCounter}-${slugify(idea) || 'interview'}`,
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
    fileCache = null;

    if (onInterviewCreated) {
      onInterviewCreated(record);
    }
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
      id: `${Date.now()}-${++idCounter}-${slugify(path.basename(markdownPath, '.md')) || 'interview'}`,
      sessionID,
      idea: title || path.basename(markdownPath, '.md'),
      markdownPath,
      createdAt: nowIso(),
      status: 'active',
      baseMessageCount: messages.length,
    };

    activeInterviewIds.set(sessionID, record.id);
    interviewsById.set(record.id, record);
    fileCache = null;

    if (onInterviewCreated) {
      onInterviewCreated(record);
    }
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

    const interviewState: InterviewState = {
      interview,
      url: `${await ensureServer()}/interview/${interview.id}`,
      markdownPath: relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      ),
      mode:
        interview.status === 'abandoned'
          ? 'abandoned'
          : parsed.state && state.questions.length === 0
            ? 'completed'
            : sessionBusy.get(interview.sessionID) === true
              ? 'awaiting-agent'
              : state.questions.length > 0
                ? 'awaiting-user'
                : parsed.latestAssistantError
                  ? 'error'
                  : 'awaiting-agent',
      lastParseError: parsed.latestAssistantError,
      isBusy: sessionBusy.get(interview.sessionID) === true,
      summary: state.summary,
      questions: state.questions,
      document,
    };

    // Push state to dashboard if callback is set (dashboard mode)
    if (onStateChange) {
      onStateChange(interview.id, interviewState);
    }

    return interviewState;
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

  function listInterviews(): InterviewListItem[] {
    const result: InterviewListItem[] = [];
    for (const interview of interviewsById.values()) {
      if (interview.status !== 'active') continue;
      result.push({
        id: interview.id,
        idea: interview.idea,
        status: interview.status,
        createdAt: interview.createdAt,
      });
    }
    return result.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
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

      // Use promptAsync for non-blocking — returns immediately, LLM
      // processes in background. State push updates dashboard when done.
      const model = sessionModel.get(interview.sessionID);
      await ctx.client.session.promptAsync({
        path: { id: interview.sessionID },
        body: {
          parts: [createInternalAgentTextPart(prompt)],
          ...(model ? { model: parseModelReference(model) ?? undefined } : {}),
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

    if (event.type === 'message.updated') {
      const info = properties as
        | {
            info?: {
              sessionID?: string;
              providerID?: string;
              modelID?: string;
            };
          }
        | undefined;
      const sessionID = info?.info?.sessionID;
      const providerID = info?.info?.providerID;
      const modelID = info?.info?.modelID;
      if (sessionID && providerID && modelID) {
        sessionModel.set(sessionID, `${providerID}/${modelID}`);
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
      sessionModel.delete(deletedSessionId);
      const interviewId = activeInterviewIds.get(deletedSessionId);
      if (!interviewId) {
        return;
      }

      const interview = interviewsById.get(interviewId);
      if (!interview) {
        return;
      }

      interview.status = 'abandoned';
      fileCache = null;
      activeInterviewIds.delete(deletedSessionId);
      log('[interview] session deleted, interview marked abandoned', {
        sessionID: deletedSessionId,
        interviewId,
      });
    }
  }

  let fileCache: { items: InterviewFileItem[]; at: number } | null = null;
  const FILE_CACHE_TTL = 10_000;

  async function listInterviewFiles(): Promise<InterviewFileItem[]> {
    if (fileCache && Date.now() - fileCache.at < FILE_CACHE_TTL) {
      return fileCache.items;
    }

    const outputDir = createInterviewDirectoryPath(ctx.directory, outputFolder);
    const activePaths = new Set(
      [...interviewsById.values()]
        .filter((i) => i.status === 'active')
        .map((i) => path.resolve(i.markdownPath)),
    );

    let entries: string[];
    try {
      entries = await fs.readdir(outputDir);
    } catch {
      return [];
    }

    const items: InterviewFileItem[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const fullPath = path.join(outputDir, entry);
      if (activePaths.has(path.resolve(fullPath))) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch {
        continue;
      }

      const title = extractTitle(content) || entry.replace(/\.md$/, '');
      const summary = extractSummarySection(content) || '';
      const baseName = entry.replace(/\.md$/, '');

      items.push({
        fileName: entry,
        resumeCommand: `/interview ${baseName}`,
        title,
        summary:
          summary.length > 120 ? `${summary.slice(0, 120)}\u2026` : summary,
      });
    }

    const sorted = items.sort((a, b) => a.title.localeCompare(b.title));
    fileCache = { items: sorted, at: Date.now() };
    return sorted;
  }

  async function handleNudgeAction(
    interviewId: string,
    action: 'more-questions' | 'confirm-complete',
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

    sessionBusy.set(interview.sessionID, true);
    let promptSent = false;

    try {
      const state = await getInterviewState(interviewId);

      let prompt: string;
      if (action === 'more-questions') {
        prompt = [
          `The user reviewed the completed interview spec and wants you to continue.`,
          ``,
          `Current spec summary: ${state.summary}`,
          ``,
          `Ask up to ${maxQuestions} new clarifying questions about aspects that are still unclear or underspecified.`,
          `Include the structured <interview_state> block with new questions.`,
        ].join('\n');
      } else {
        prompt = [
          `The user confirmed the interview spec is complete.`,
          ``,
          `Current spec summary: ${state.summary}`,
          ``,
          `Produce a final, polished version of the full spec document.`,
          `Do NOT include any <interview_state> block — just output the final spec as clean markdown.`,
          `The spec should be comprehensive, well-structured, and ready for implementation.`,
        ].join('\n');
      }

      const model = sessionModel.get(interview.sessionID);
      await ctx.client.session.promptAsync({
        path: { id: interview.sessionID },
        body: {
          parts: [createInternalAgentTextPart(prompt)],
          ...(model ? { model: parseModelReference(model) ?? undefined } : {}),
        },
      });
      promptSent = true;
    } finally {
      if (!promptSent) {
        sessionBusy.set(interview.sessionID, false);
      }
    }
  }

  return {
    setBaseUrlResolver,
    setStatePushCallback,
    setOnInterviewCreated,
    getActiveInterviewId,
    registerCommand,
    handleCommandExecuteBefore,
    handleEvent,
    getInterviewState,
    listInterviewFiles,
    listInterviews,
    submitAnswers,
    handleNudgeAction,
  };
}
