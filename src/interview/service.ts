import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig } from '../config';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
  log,
} from '../utils';
import { parseModelReference } from '../utils/session';
import {
  appendInterviewAnswers,
  claimInterviewDocument,
  createInterviewDirectoryPath,
  createInterviewFilePath,
  DEFAULT_OUTPUT_FOLDER,
  ensureInterviewFile,
  extractSpecOutline,
  extractSummarySection,
  extractTitle,
  hashInterviewState,
  InterviewDocumentOwnershipError,
  InterviewPatchApplyError,
  markInterviewDocumentComplete,
  markInterviewDocumentIncomplete,
  normalizeOutputFolder,
  parseFrontmatter,
  parseSpecBlocks,
  readInterviewDocument,
  relativeInterviewPath,
  resolveExistingInterviewPath,
  rewriteInterviewDocument,
  rewriteInterviewDocumentWithFinalSpec,
  withInterviewDocumentLock,
} from './document';
import {
  buildFallbackState,
  findLatestAssistantState,
  flattenMessage,
  hasInterviewStateBlock,
  locateInterviewStateBlocks,
  normalizeAssistantState,
  parseAssistantState,
  replaceInterviewStateBlocks,
} from './parser';
import {
  buildAnswerPrompt,
  buildBlockCommentPrompt,
  buildChatPrompt,
  buildImplementMissingPrompt,
  buildImplementPatchFailurePrompt,
  buildImplementPrompt,
  buildImplementRefusalPrompt,
  buildKickoffPrompt,
  buildNudgePrompt,
  buildPatchMissingRepairPrompt,
  buildPatchRepairPrompt,
  buildResumePrompt,
  type SpecPromptContext,
} from './prompts';
import {
  createV1InterviewSessionRuntime,
  type InterviewSessionRuntime,
} from './runtime';
import type {
  InterviewAnswer,
  InterviewAssistantState,
  InterviewFileItem,
  InterviewListItem,
  InterviewMessage,
  InterviewRecord,
  InterviewState,
} from './types';

const COMMAND_NAME = 'interview';
const IMPLEMENT_COMMAND = 'implement';
const DEFAULT_MAX_QUESTIONS = 2;

function resolveMode(input: {
  abandoned: boolean;
  completed: boolean;
  stateFromText: boolean;
  questionCount: number;
  busy: boolean;
  parseError?: string;
  hasMessages: boolean;
  pendingAnswers: boolean;
}): InterviewState['mode'] {
  if (input.abandoned) return 'abandoned';
  if (input.parseError) return 'error';
  if (input.pendingAnswers) return 'awaiting-agent';
  if (input.busy) return 'awaiting-agent';
  if (input.completed || (input.stateFromText && input.questionCount === 0)) {
    return 'completed';
  }
  if (input.questionCount > 0) return 'awaiting-user';
  if (!input.stateFromText && input.hasMessages) return 'completed';
  return 'awaiting-agent';
}

/**
 * Cap on retained abandoned interview records. Abandoned interviews are kept
 * briefly so a still-open browser tab can render their final state, but
 * without a bound the `interviewsById` and `browserOpened` collections grow
 * for the life of a long-running session/dashboard process.
 */
export const MAX_RETAINED_ABANDONED = 50;

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
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
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
    runtime?: InterviewSessionRuntime;
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
  registerCommand: (
    config: Record<string, unknown>,
    enabled?: { interview?: boolean; implement?: boolean },
  ) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: {
      parts: Array<{
        type: string;
        text?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      }>;
    },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  getInterviewState: (interviewId: string) => Promise<InterviewState>;
  submitState: (
    sessionID: string,
    state: InterviewAssistantState,
    messageID?: string,
  ) => Promise<{ ok: boolean; message: string }>;
  notifyTurnStatus: (sessionID: string) => Promise<void>;
  completeInterviewText: (
    sessionID: string,
    text: string,
    messageID?: string,
  ) => Promise<string>;
  listInterviewFiles: () => Promise<InterviewFileItem[]>;
  listInterviews: () => InterviewListItem[];
  submitAnswers: (
    interviewId: string,
    answers: InterviewAnswer[],
  ) => Promise<void>;
  submitBlockComment: (
    interviewId: string,
    section: string,
    comment: string,
  ) => Promise<void>;
  submitChat: (interviewId: string, message: string) => Promise<void>;
  handleNudgeAction: (
    interviewId: string,
    action: 'more-questions' | 'confirm-complete',
  ) => Promise<void>;
} {
  const maxQuestions = config?.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const printState = config?.printState ?? false;
  const outputFolder = normalizeOutputFolder(
    config?.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
  );
  const autoOpenBrowser = shouldAutoOpenBrowser(
    config,
    deps?.env ?? process.env,
  );
  const browserOpener = deps?.openBrowser ?? openBrowser;
  const sessionRuntime = deps?.runtime ?? createV1InterviewSessionRuntime(ctx);
  const activeInterviewIds = new Map<string, string>();
  const interviewsById = new Map<string, InterviewRecord>();
  const activeSyncs = new Map<string, Promise<InterviewState>>();
  const sessionBusy = new Map<string, boolean>();
  const sessionModel = new Map<string, string>();
  const browserOpened = new Set<string>(); // Track interviews that have opened browser
  let resolveBaseUrl: (() => Promise<string>) | null = null;
  let onStateChange:
    | ((interviewId: string, state: InterviewState) => void)
    | null = null;
  let onInterviewCreated: ((interview: InterviewRecord) => void) | null = null;
  let abandonedOrderCounter = 0;
  const finalizationPending = new Set<string>();
  const finalizationReady = new Set<string>();
  type InterviewMemory = {
    lastAppliedState?: {
      state: InterviewAssistantState;
      hash: string;
      messageID?: string;
    };
    answeredQuestions?: Set<string>;
    pendingAnswers?: boolean;
    lastNotifiedHash?: string;
    patchRepairSent?: boolean;
    pendingPatchRepair?: {
      failedHunk: string;
      contextWindow: string;
    };
    pendingAnswerHistory?: Array<{
      questions: InterviewState['questions'];
      answers: InterviewAnswer[];
      activeQuestionIds: Set<string>;
    }>;
    answerHistoryRetry?: Promise<void>;
    answerHistoryError?: string;
    lastPatchError?: string;
    reportedPatchFailureHash?: string;
  };
  type TurnState = {
    pendingNotice?: { state: InterviewAssistantState; hash: string };
    noticeHandled?: boolean;
    errorNotified?: boolean;
    errorReason?: string;
    patchError?: boolean;
    toolApplied?: boolean;
    turnOpen?: boolean;
    toolMessageID?: string;
    serviceInitiated?: boolean;
    repairTurnStarted?: boolean;
    noticeInFlight?: Promise<void>;
  };
  const interviewMemory = new Map<string, InterviewMemory>();
  const turnState = new Map<string, TurnState>();
  const memoryFor = (id: string): InterviewMemory => {
    const memory = interviewMemory.get(id) ?? {};
    interviewMemory.set(id, memory);
    return memory;
  };
  const turnFor = (id: string): TurnState => {
    const state = turnState.get(id) ?? {};
    turnState.set(id, state);
    return state;
  };

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

  async function loadMessages(sessionID: string): Promise<InterviewMessage[]> {
    return sessionRuntime.messages(sessionID);
  }

  async function loadMessagesWithRetry(
    sessionID: string,
  ): Promise<InterviewMessage[]> {
    for (let i = 0; i < 8; i++) {
      const messages = await loadMessages(sessionID);
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last?.info?.role === 'assistant') {
          return messages;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return loadMessages(sessionID);
  }

  function isUserVisibleMessage(message: InterviewMessage): boolean {
    return !(message.parts ?? []).some((part) => isInternalInitiatorPart(part));
  }

  function getInterviewById(interviewId: string): InterviewRecord | null {
    return interviewsById.get(interviewId) ?? null;
  }

  function specContext(
    markdownPath: string,
    document: string,
  ): SpecPromptContext {
    return {
      relativePath: relativeInterviewPath(ctx.directory, markdownPath),
      title: extractTitle(document),
      outline: extractSpecOutline(extractSummarySection(document)),
    };
  }

  /**
   * Mark an interview abandoned and prune the oldest abandoned records so the
   * in-memory registry (and its browser-open tracking) stays bounded.
   */
  function abandonInterview(interview: InterviewRecord): void {
    if (interview.status !== 'abandoned') {
      interview.abandonedAt = nowIso();
      interview.abandonedOrder = ++abandonedOrderCounter;
    }
    interview.status = 'abandoned';
    interviewMemory.delete(interview.id);
    pruneAbandonedInterviews();
  }

  function bindInterview(record: InterviewRecord): void {
    activeInterviewIds.set(record.sessionID, record.id);
    interviewsById.set(record.id, record);
    fileCache = null;
    if (onInterviewCreated) {
      onInterviewCreated(record);
    }
  }

  function pruneAbandonedInterviews(): void {
    const abandoned = [...interviewsById.values()].filter(
      (record) => record.status === 'abandoned',
    );
    const overflow = abandoned.length - MAX_RETAINED_ABANDONED;
    if (overflow <= 0) return;
    abandoned
      .sort((a, b) => {
        const timeDelta =
          new Date(a.abandonedAt ?? a.createdAt).getTime() -
          new Date(b.abandonedAt ?? b.createdAt).getTime();
        if (timeDelta !== 0) return timeDelta;
        return (a.abandonedOrder ?? 0) - (b.abandonedOrder ?? 0);
      })
      .slice(0, overflow)
      .forEach((record) => {
        interviewsById.delete(record.id);
        interviewMemory.delete(record.id);
        finalizationPending.delete(record.id);
        finalizationReady.delete(record.id);
        browserOpened.delete(record.id);
      });
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
          if (active.completed) {
            await withInterviewDocumentLock(active.markdownPath, () =>
              markInterviewDocumentIncomplete(active),
            );
            active.completed = false;
          }
          return active;
        }

        abandonInterview(active);
      }
    }

    const messages = await loadMessages(sessionID);
    const uniqueId = randomUUID();
    const record: InterviewRecord = {
      id: uniqueId,
      sessionID,
      idea: normalizedIdea,
      markdownPath: createInterviewFilePath(
        ctx.directory,
        outputFolder,
        idea,
        uniqueId,
      ),
      createdAt: nowIso(),
      status: 'active',
      baseMessageCount: messages.length,
    };

    await withInterviewDocumentLock(record.markdownPath, () =>
      ensureInterviewFile(record),
    );
    bindInterview(record);
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
          if (active.completed) {
            await withInterviewDocumentLock(active.markdownPath, () =>
              markInterviewDocumentIncomplete(active),
            );
            active.completed = false;
          }
          return active;
        }

        abandonInterview(active);
      }
    }

    const messages = await loadMessages(sessionID);
    const document = await claimInterviewDocument(
      markdownPath,
      sessionID,
      messages.length,
    );
    const frontmatter = parseFrontmatter(document);
    const title = extractTitle(document);
    const record: InterviewRecord = {
      id: randomUUID(),
      sessionID,
      idea: title || path.basename(markdownPath, '.md'),
      markdownPath,
      createdAt: nowIso(),
      status: 'active',
      completed: frontmatter?.status === 'complete',
      baseMessageCount: messages.length,
    };

    if (record.completed) {
      await withInterviewDocumentLock(record.markdownPath, () =>
        markInterviewDocumentIncomplete(record),
      );
      record.completed = false;
    }

    bindInterview(record);
    return record;
  }

  function syncInterview(
    interview: InterviewRecord,
    retryMessages = true,
  ): Promise<InterviewState> {
    const existing = activeSyncs.get(interview.id);
    if (existing) {
      return existing;
    }

    const sync = performSyncInterview(interview, retryMessages).finally(() => {
      activeSyncs.delete(interview.id);
    });
    activeSyncs.set(interview.id, sync);
    return sync;
  }

  /**
   * Shared apply step: dedupe `state` against the document's
   * `consumedState` hash and rewrite the document. Used by the tool path,
   * the v1 `text.complete` fallback, and polling.
   */
  async function applyStateToDocument(
    interview: InterviewRecord,
    state: InterviewAssistantState,
  ): Promise<{
    document: string;
    patchError: InterviewPatchApplyError | null;
    applied: boolean;
    hash: string;
  }> {
    return withInterviewDocumentLock(interview.markdownPath, async () => {
      const existingDocument = await readInterviewDocument(interview);
      const turnHash = hashInterviewState(state);
      const consumed = parseFrontmatter(existingDocument)?.consumedState;
      if (consumed === turnHash) {
        return {
          document: existingDocument,
          patchError: null,
          applied: false,
          hash: turnHash,
        };
      }

      try {
        let document = await rewriteInterviewDocument(
          interview,
          state.summary,
          state.title,
          state.patch,
          turnHash,
        );
        if (
          state.questions.length > 0 &&
          parseFrontmatter(document)?.status === 'complete'
        ) {
          document = await markInterviewDocumentIncomplete(interview);
          interview.completed = false;
        }
        memoryFor(interview.id).patchRepairSent = false;
        delete memoryFor(interview.id).lastPatchError;
        delete memoryFor(interview.id).pendingPatchRepair;
        delete memoryFor(interview.id).reportedPatchFailureHash;
        return { document, patchError: null, applied: true, hash: turnHash };
      } catch (error) {
        if (!(error instanceof InterviewPatchApplyError)) {
          throw error;
        }
        return {
          document: existingDocument,
          patchError: error,
          applied: false,
          hash: turnHash,
        };
      }
    });
  }

  /** Record an accepted state so the turn-end notice and polling reflect it. */
  function markStateApplied(
    interview: InterviewRecord,
    state: InterviewAssistantState,
    hash: string,
    messageID?: string,
  ): void {
    const memory = memoryFor(interview.id);
    memory.lastAppliedState = { state, hash, messageID };
    // A fresh state supersedes any previously answered questions.
    delete memory.answeredQuestions;
    delete memory.pendingAnswers;
    const turn = turnFor(interview.sessionID);
    turn.pendingNotice = { state, hash };
    delete turn.noticeHandled;
    delete turn.errorNotified;
    delete turn.errorReason;
    delete turn.patchError;
  }

  function markTurnError(sessionID: string, reason: string): void {
    // First reason wins for a turn: a specific tool/parse failure must not be
    // overwritten by the generic missing-block fallback discovered on a later
    // turn-end sync.
    const turn = turnFor(sessionID);
    if (!turn.errorReason) {
      turn.errorReason = reason;
    }
  }

  function countPatchHunks(patch: string | undefined): number {
    if (!patch) {
      return 0;
    }
    const matches = patch.match(/^@@ /gm);
    return matches ? matches.length : 0;
  }

  function stripInterviewStateBlocks(text: string): string {
    return replaceInterviewStateBlocks(text, () => '').trim();
  }

  function resetTurnNoticeState(sessionID: string): void {
    const turn = turnFor(sessionID);
    delete turn.noticeHandled;
    delete turn.errorNotified;
    delete turn.errorReason;
    delete turn.toolApplied;
    delete turn.pendingNotice;
    delete turn.patchError;
  }

  async function retryPendingAnswerHistory(
    interview: InterviewRecord,
  ): Promise<void> {
    const memory = memoryFor(interview.id);
    if (memory.answerHistoryRetry) {
      await memory.answerHistoryRetry;
      return;
    }
    const pending = memory.pendingAnswerHistory;
    if (!pending?.length) return;

    const retry = (async () => {
      while (pending.length > 0) {
        const batch = pending[0];
        try {
          await withInterviewDocumentLock(interview.markdownPath, () =>
            appendInterviewAnswers(interview, batch.questions, batch.answers),
          );
          pending.shift();
        } catch (error) {
          memory.answerHistoryError =
            'Answers were sent, but saving their history failed. The history will be retried automatically.';
          log('[interview] failed to retry interview answers', {
            error: String(error),
          });
          return;
        }
      }

      delete memory.pendingAnswerHistory;
      delete memory.answerHistoryError;
    })();
    memory.answerHistoryRetry = retry;
    try {
      await retry;
    } finally {
      if (memory.answerHistoryRetry === retry) {
        delete memory.answerHistoryRetry;
      }
    }
  }

  function closeTurn(sessionID: string): void {
    const turn = turnFor(sessionID);
    turn.turnOpen = false;
    turn.serviceInitiated = false;
  }

  async function performSyncInterview(
    interview: InterviewRecord,
    retryMessages = true,
  ): Promise<InterviewState> {
    if (interview.status !== 'active') {
      const document = await readInterviewDocument(interview);
      return {
        interview,
        url: `${await ensureServer()}/interview/${interview.id}`,
        markdownPath: relativeInterviewPath(
          ctx.directory,
          interview.markdownPath,
        ),
        mode: 'abandoned',
        lastParseError: undefined,
        isBusy: false,
        summary: extractSummarySection(document),
        questions: [],
        document,
        blocks: parseSpecBlocks(document),
      };
    }
    const allMessages = retryMessages
      ? await loadMessagesWithRetry(interview.sessionID)
      : await loadMessages(interview.sessionID);
    const interviewMessages = allMessages
      .slice(interview.baseMessageCount)
      .filter(isUserVisibleMessage);
    const latestAssistant = [...interviewMessages]
      .reverse()
      .find((message) => message.info?.role === 'assistant');
    const latestAssistantText = latestAssistant
      ? flattenMessage(latestAssistant)
      : '';
    const latestAssistantId =
      typeof latestAssistant?.info?.id === 'string'
        ? latestAssistant.info.id
        : undefined;
    const isCleanFinalResponse =
      finalizationPending.has(interview.id) &&
      finalizationReady.has(interview.id) &&
      latestAssistantText.length > 0;
    const remembered = memoryFor(interview.id).lastAppliedState;
    const toolMessageID = turnFor(interview.sessionID).toolMessageID;
    // The assistant message the current state was applied for: the tool path
    // records it on submit, the v1 text fallback records it on apply.
    const appliedMessageID = remembered?.messageID ?? toolMessageID;
    const messageIndex = (id: string | undefined): number =>
      id === undefined
        ? -1
        : interviewMessages.findIndex((message) => message.info?.id === id);
    const appliedMessageIndex = messageIndex(appliedMessageID);
    const latestAssistantIndex = messageIndex(latestAssistantId);
    const toolMessageIndex = messageIndex(toolMessageID);

    // Assistant messages strictly newer than the applied one. When the applied
    // message cannot be located (v2 transcript retention, or a tool call with
    // no stored assistant message), every assistant message is a candidate so
    // a later malformed block still surfaces. A block printed in the applied
    // message itself or earlier is never re-applied.
    const newerAssistantMessages = interviewMessages.filter(
      (message, index) => {
        if (message.info?.role !== 'assistant') {
          return false;
        }
        if (appliedMessageID !== undefined && appliedMessageIndex >= 0) {
          return index > appliedMessageIndex;
        }
        return true;
      },
    );
    // "State-bearing" means the message carries a complete
    // <interview_state>...</interview_state> region at all, valid or
    // malformed (matching the parser's both-tags check). When none of the
    // newer messages does, the remembered state is still current and must not
    // read as a missing-block error.
    const hasNewerStateBearingText = newerAssistantMessages.some((message) => {
      return hasInterviewStateBlock(flattenMessage(message));
    });

    const parsed = isCleanFinalResponse
      ? { state: null, latestAssistantError: undefined }
      : findLatestAssistantState(newerAssistantMessages, maxQuestions);

    const rememberedForLatest =
      remembered && !hasNewerStateBearingText ? remembered : undefined;

    // The submit tool is authoritative for its assistant message and every
    // earlier one; a block printed in that message must never re-apply over
    // the tool state on a later poll.
    const latestIsToolMessageOrEarlier =
      toolMessageID !== undefined &&
      latestAssistantId !== undefined &&
      (toolMessageID === latestAssistantId ||
        (toolMessageIndex >= 0 &&
          latestAssistantIndex >= 0 &&
          latestAssistantIndex <= toolMessageIndex));
    const toolWins =
      latestIsToolMessageOrEarlier ||
      (turnFor(interview.sessionID).toolApplied === true &&
        rememberedForLatest !== undefined);
    const stateFromText = toolWins ? null : parsed.state;
    // The remembered state is only a fallback. Questions already answered in
    // the browser must not be re-offered once a later turn produced no new
    // state; answeredQuestions is cleared whenever a fresh state is applied.
    const answeredQuestionIds = memoryFor(interview.id).answeredQuestions;
    const answeredFilteredState =
      rememberedForLatest && answeredQuestionIds?.size
        ? {
            ...rememberedForLatest.state,
            questions: rememberedForLatest.state.questions.filter(
              (question) => !answeredQuestionIds.has(question.id),
            ),
          }
        : rememberedForLatest?.state;
    const answeredRememberedState =
      remembered && answeredQuestionIds?.size
        ? {
            ...remembered.state,
            questions: remembered.state.questions.filter(
              (question) => !answeredQuestionIds.has(question.id),
            ),
          }
        : remembered?.state;
    let patchError: InterviewPatchApplyError | null = null;
    let patchErrorHash: string | undefined;
    let patchFailureAlreadyReported = false;
    const latestAssistantError =
      stateFromText || rememberedForLatest || toolWins
        ? undefined
        : parsed.latestAssistantError;
    if (latestAssistantError) {
      markTurnError(interview.sessionID, latestAssistantError);
    }

    let document: string;

    if (isCleanFinalResponse) {
      document = await withInterviewDocumentLock(interview.markdownPath, () =>
        rewriteInterviewDocumentWithFinalSpec(interview, latestAssistantText),
      );
      finalizationPending.delete(interview.id);
      delete memoryFor(interview.id).lastAppliedState;
      delete turnFor(interview.sessionID).pendingNotice;
    } else if (stateFromText) {
      const outcome = await applyStateToDocument(interview, stateFromText);
      document = outcome.document;
      patchError = outcome.patchError;
      patchErrorHash = outcome.hash;
      if (patchError) {
        const memory = memoryFor(interview.id);
        const alreadyReported =
          memory.reportedPatchFailureHash === outcome.hash;
        patchFailureAlreadyReported = alreadyReported;
        memory.lastPatchError = patchError.message;
        if (!alreadyReported) {
          turnFor(interview.sessionID).patchError = true;
          memory.reportedPatchFailureHash = outcome.hash;
          markTurnError(interview.sessionID, patchError.message);
        }
      } else if (outcome.applied) {
        markStateApplied(
          interview,
          stateFromText,
          outcome.hash,
          latestAssistantId,
        );
      } else {
        if (latestAssistantId !== remembered?.messageID) {
          markStateApplied(
            interview,
            stateFromText,
            outcome.hash,
            latestAssistantId,
          );
        }
      }
    } else {
      document = await withInterviewDocumentLock(interview.markdownPath, () =>
        readInterviewDocument(interview),
      );
    }

    const fallbackState = buildFallbackState(interviewMessages);
    const effectivePatchError =
      patchError?.message ?? memoryFor(interview.id).lastPatchError;
    const effectiveState = effectivePatchError
      ? (answeredRememberedState ?? null)
      : (stateFromText ?? answeredFilteredState ?? null);
    const state = effectiveState ?? {
      ...fallbackState,
      summary: extractSummarySection(document) || fallbackState.summary,
    };
    const memory = memoryFor(interview.id);
    const repairExhausted =
      patchError !== null && memory.patchRepairSent === true;
    if (
      patchError &&
      !repairExhausted &&
      !patchFailureAlreadyReported &&
      memory.reportedPatchFailureHash === patchErrorHash
    ) {
      memory.pendingPatchRepair = {
        failedHunk: patchError.failedHunk,
        contextWindow: patchError.contextWindow,
      };
    }
    const blocks = parseSpecBlocks(document);

    const interviewState: InterviewState = {
      interview,
      url: `${await ensureServer()}/interview/${interview.id}`,
      markdownPath: relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      ),
      mode: resolveMode({
        abandoned: false,
        completed: interview.completed === true,
        stateFromText: stateFromText !== null && !effectivePatchError,
        questionCount: state.questions.length,
        busy: sessionBusy.get(interview.sessionID) === true,
        parseError:
          effectivePatchError ??
          latestAssistantError ??
          (memory.pendingAnswers
            ? turnFor(interview.sessionID).errorReason
            : undefined),
        hasMessages:
          allMessages.length > 0 &&
          sessionBusy.get(interview.sessionID) === false,
        pendingAnswers: memory.pendingAnswers === true,
      }),
      lastParseError: effectivePatchError
        ? 'The spec patch did not apply.'
        : (latestAssistantError ?? memory.answerHistoryError),
      isBusy: sessionBusy.get(interview.sessionID) === true,
      summary: state.summary,
      questions: state.questions,
      document,
      blocks,
    };

    // Push state to dashboard if callback is set (dashboard mode)
    if (onStateChange) {
      onStateChange(interview.id, interviewState);
    }

    return interviewState;
  }

  /**
   * Apply a state submitted through the `interview_submit_state` tool. Runs
   * the shared apply step without parsing message text.
   */
  async function submitState(
    sessionID: string,
    state: InterviewAssistantState,
    messageID?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const interviewId = activeInterviewIds.get(sessionID);
    const interview = interviewId ? interviewsById.get(interviewId) : undefined;
    if (!interview) {
      return {
        ok: false,
        message: '⎔ Interview state rejected: no active interview',
      };
    }

    const normalized = normalizeAssistantState(
      state as unknown as Record<string, unknown>,
      maxQuestions,
    );
    try {
      const outcome = await applyStateToDocument(interview, normalized);
      if (outcome.patchError) {
        const memory = memoryFor(interview.id);
        const alreadyReported =
          memory.reportedPatchFailureHash === outcome.hash;
        if (!alreadyReported) {
          turnFor(sessionID).patchError = true;
          markTurnError(sessionID, outcome.patchError.message);
          memory.reportedPatchFailureHash = outcome.hash;
        }
        memory.lastPatchError = outcome.patchError.message;
        if (memory.patchRepairSent !== true) {
          memory.pendingPatchRepair = {
            failedHunk: outcome.patchError.failedHunk,
            contextWindow: outcome.patchError.contextWindow,
          };
        }
        return {
          ok: false,
          message: `⎔ Interview state rejected: patch failed: ${outcome.patchError.message}. Submit a corrected patch in the next state.`,
        };
      }
      turnFor(sessionID).toolApplied = true;
      if (messageID) {
        turnFor(sessionID).toolMessageID = messageID;
      }
      markStateApplied(interview, normalized, outcome.hash, messageID);
      await retryPendingAnswerHistory(interview);
      const hunks = countPatchHunks(normalized.patch);
      const count = normalized.questions.length;
      const questionLabel = count === 1 ? 'question' : 'questions';
      const message =
        hunks > 0
          ? `Interview state applied (patch: ${hunks} hunk${hunks === 1 ? '' : 's'}, ${count} ${questionLabel}).`
          : `Interview state applied (${count} ${questionLabel}).`;
      return { ok: true, message };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      markTurnError(sessionID, reason);
      return {
        ok: false,
        message: `⎔ Interview state rejected: ${reason}`,
      };
    }
  }

  /**
   * Post the one status/error notice for the turn that just ended. Called on
   * busy→idle only, never on `session.next.text.ended`.
   * Concurrent calls (v1 fires `session.status idle` and `session.idle` back
   * to back) share one in-flight decision so exactly one notice is posted.
   */
  function notifyTurnStatus(sessionID: string): Promise<void> {
    const turn = turnFor(sessionID);
    const existing = turn.noticeInFlight;
    if (existing) {
      return existing;
    }
    const inFlight = performTurnNotice(sessionID).finally(() => {
      delete turn.noticeInFlight;
    });
    turn.noticeInFlight = inFlight;
    return inFlight;
  }

  async function performTurnNotice(sessionID: string): Promise<void> {
    const interviewId = activeInterviewIds.get(sessionID);
    if (!interviewId) {
      closeTurn(sessionID);
      return;
    }
    const interview = interviewsById.get(interviewId);
    if (!interview) {
      closeTurn(sessionID);
      return;
    }

    if (interview.completed || interview.status !== 'active') {
      closeTurn(sessionID);
      return;
    }

    // Apply any state still present in stored text (printState mode, a missed
    // text.complete hook, or the v2 fallback) before choosing the notice.
    // Non-retrying: the turn is over, so a missing assistant message is real.
    const turn = turnFor(sessionID);
    if (!turn.noticeHandled) {
      try {
        await syncInterview(interview, false);
      } catch (error) {
        log('[interview] turn-end sync failed', {
          interviewId: interview.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (memoryFor(interview.id).pendingAnswers && !turn.pendingNotice) {
      markTurnError(sessionID, 'answers were not applied to the spec');
    }

    const memory = memoryFor(interview.id);
    if (memory.patchRepairSent === true && !turn.repairTurnStarted) {
      return;
    }
    if (
      memory.patchRepairSent === true &&
      !turn.pendingNotice &&
      turn.repairTurnStarted
    ) {
      turn.errorReason =
        'automatic spec patch repair produced no accepted state';
      turn.serviceInitiated = true;
      delete turn.noticeHandled;
      delete memory.patchRepairSent;
      delete memory.pendingPatchRepair;
    } else if (memory.patchRepairSent === true && turn.pendingNotice) {
      delete turn.noticeHandled;
      delete turn.repairTurnStarted;
      delete memory.patchRepairSent;
    }

    if (turn.noticeHandled) {
      closeTurn(sessionID);
      return;
    }

    const pendingRepair = memoryFor(interview.id).pendingPatchRepair;
    if (pendingRepair && memoryFor(interview.id).patchRepairSent !== true) {
      const repairServiceInitiated = turn.serviceInitiated === true;
      delete turn.pendingNotice;
      delete turn.toolApplied;
      if (!repairServiceInitiated) {
        delete memoryFor(interview.id).pendingPatchRepair;
      } else {
        resetTurnNoticeState(sessionID);
        turn.noticeHandled = true;
        closeTurn(sessionID);
        const memory = memoryFor(interview.id);
        memory.patchRepairSent = true;
        delete memory.pendingPatchRepair;
        sessionBusy.set(sessionID, true);
        const repairTurn = turnFor(sessionID);
        repairTurn.serviceInitiated = true;
        repairTurn.turnOpen = false;
        repairTurn.repairTurnStarted = false;
        const model = sessionModel.get(sessionID);
        try {
          await sessionRuntime.continue(
            sessionID,
            pendingRepair.failedHunk || pendingRepair.contextWindow
              ? buildPatchRepairPrompt(
                  pendingRepair.failedHunk,
                  pendingRepair.contextWindow,
                  maxQuestions,
                  printState,
                )
              : buildPatchMissingRepairPrompt(maxQuestions, printState),
            model ? (parseModelReference(model) ?? undefined) : undefined,
          );
        } catch (error) {
          sessionBusy.set(sessionID, false);
          closeTurn(sessionID);
          delete turn.patchError;
          delete memory.patchRepairSent;
          const reason = error instanceof Error ? error.message : String(error);
          turn.errorReason = `spec patch repair failed to send: ${reason}`;
          try {
            const url = `${await ensureServer()}/interview/${interview.id}`;
            await sessionRuntime.notify(
              sessionID,
              `⎔ Interview update failed: ${turn.errorReason} · UI: ${url} [system status: continue without acknowledging this notification]`,
            );
          } catch {
            // The original send failure is already logged and is the useful error.
          }
          log('[interview] spec patch repair failed to send', {
            interviewId: interview.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    }

    let baseUrl: string;
    try {
      baseUrl = await ensureServer();
    } catch {
      return;
    }
    const url = `${baseUrl}/interview/${interview.id}`;

    const pending = turn.pendingNotice;
    if (pending) {
      delete turn.pendingNotice;
      turn.noticeHandled = true;
      delete turn.toolApplied;
      closeTurn(sessionID);
      if (memoryFor(interview.id).lastNotifiedHash === pending.hash) {
        return;
      }
      memoryFor(interview.id).lastNotifiedHash = pending.hash;
      const count = pending.state.questions.length;
      const questionLabel = count === 1 ? 'question' : 'questions';
      const docPath = relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      );
      await sessionRuntime.notify(
        sessionID,
        `⎔ Spec updated · ${count} ${questionLabel} · UI: ${url} · Doc: ${docPath} [system status: continue without acknowledging this notification]`,
      );
      return;
    }

    const serviceInitiated = turn.serviceInitiated === true;
    turn.noticeHandled = true;
    delete turn.toolApplied;
    closeTurn(sessionID);
    // Only a turn the interview service itself started (kickoff, answers,
    // block comment, chat, nudge, patch repair) may post the missing/failed
    // update notice. A plain user turn in an interview session stays silent.
    if (!serviceInitiated && !turn.patchError) {
      return;
    }
    if (turn.errorNotified) {
      return;
    }
    turn.errorNotified = true;
    const reason = turn.errorReason ?? 'missing <interview_state> block';
    await sessionRuntime.notify(
      sessionID,
      `⎔ Interview update failed: ${reason} · UI: ${url} [system status: continue without acknowledging this notification]`,
    );
  }

  /**
   * v1 `experimental.text.complete` fallback: capture a printed
   * `<interview_state>` block through the shared apply step, then strip it.
   * Malformed or failed states leave the text unchanged so the existing
   * error/retry path still runs. printState mode keeps the block.
   */
  async function completeInterviewText(
    sessionID: string,
    text: string,
    messageID?: string,
  ): Promise<string> {
    if (printState) {
      return text;
    }
    const interviewId = activeInterviewIds.get(sessionID);
    if (!interviewId) {
      return text;
    }
    const interview = interviewsById.get(interviewId);
    if (!interview) {
      return text;
    }
    if (locateInterviewStateBlocks(text).length === 0) {
      return text;
    }
    // The submit tool is authoritative for its assistant message: a block
    // printed in the same message (or re-polled later) must not overwrite the
    // tool state. The per-turn flag covers hosts without a message id.
    const turn = turnFor(sessionID);
    const toolMessageID = turn.toolMessageID;
    if (
      turn.toolApplied ||
      (toolMessageID !== undefined && messageID === toolMessageID)
    ) {
      return stripInterviewStateBlocks(text);
    }

    const parsed = parseAssistantState(text, maxQuestions);
    if (!parsed.state) {
      return text;
    }
    try {
      const outcome = await applyStateToDocument(interview, parsed.state);
      if (outcome.patchError) {
        turnFor(sessionID).patchError = true;
        markTurnError(sessionID, outcome.patchError.message);
        memoryFor(interview.id).lastPatchError = outcome.patchError.message;
        return text;
      }
      if (outcome.applied) {
        markStateApplied(interview, parsed.state, outcome.hash, messageID);
      } else {
        const remembered = memoryFor(interview.id).lastAppliedState;
        if (messageID !== remembered?.messageID) {
          markStateApplied(interview, parsed.state, outcome.hash, messageID);
        }
      }
      return stripInterviewStateBlocks(text);
    } catch (error) {
      markTurnError(
        sessionID,
        error instanceof Error ? error.message : String(error),
      );
      return text;
    }
  }

  async function notifyInterviewUrl(
    sessionID: string,
    interview: InterviewRecord,
  ): Promise<string> {
    const baseUrl = await ensureServer();
    const url = `${baseUrl}/interview/${interview.id}`;

    // Auto-open browser on initial creation (not on every poll/refresh)
    maybeOpenBrowser(interview.id, url);

    await sessionRuntime.notify(
      sessionID,
      [
        '⎔ Interview UI ready',
        '',
        `Open: ${url}`,
        `Document: ${relativeInterviewPath(ctx.directory, interview.markdownPath)}`,
        '',
        '[system status: continue without acknowledging this notification]',
      ].join('\n'),
    );
    return url;
  }

  function registerCommand(
    opencodeConfig: Record<string, unknown>,
    enabled?: { interview?: boolean; implement?: boolean },
  ): void {
    const interviewOn = enabled?.interview !== false;
    const implementOn = enabled?.implement !== false;
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!opencodeConfig.command) {
      opencodeConfig.command = {};
    }
    const commands = opencodeConfig.command as Record<string, unknown>;
    if (interviewOn && !configCommand?.[COMMAND_NAME]) {
      commands[COMMAND_NAME] = {
        template: 'Start an interview and write a live markdown spec',
        description:
          'Open a localhost interview UI linked to the current OpenCode session',
      };
    }
    if (implementOn && !configCommand?.[IMPLEMENT_COMMAND]) {
      commands[IMPLEMENT_COMMAND] = {
        template: 'Implement the completed interview spec',
        description: 'Read the completed interview markdown and implement it',
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

  async function runServiceTurn(
    interview: InterviewRecord,
    buildPrompt: (state: InterviewState) => Promise<string> | string,
  ): Promise<void> {
    const sessionID = interview.sessionID;
    if (sessionBusy.get(sessionID) === true) {
      throw new Error(
        'Interview session is busy. Wait for the current response.',
      );
    }
    sessionBusy.set(sessionID, true);
    const memory = memoryFor(interview.id);
    await retryPendingAnswerHistory(interview);
    memory.patchRepairSent = false;
    delete memory.pendingPatchRepair;
    let promptSent = false;
    let serviceInitiated = false;
    let reopenedCompletion = false;
    let reopenedConsumedState: string | undefined;
    try {
      const state = await getInterviewState(interview.id);
      if (state.mode === 'error') {
        if (!memory.lastPatchError && !memory.pendingAnswers) {
          throw new Error('Interview is waiting for a valid agent update.');
        }
      }
      const prompt = await buildPrompt(state);
      const promptWithPatchNote = memory.lastPatchError
        ? `${prompt}\n\nThe last spec patch failed: ${memory.lastPatchError}. Re-base the patch on the current spec before submitting the next state.`
        : prompt;
      const model = sessionModel.get(sessionID);
      turnFor(sessionID).serviceInitiated = true;
      serviceInitiated = true;
      if (interview.completed) {
        const beforeReopen = await readInterviewDocument(interview);
        reopenedConsumedState = parseFrontmatter(beforeReopen)?.consumedState;
        await withInterviewDocumentLock(interview.markdownPath, () =>
          markInterviewDocumentIncomplete(interview),
        );
        interview.completed = false;
        reopenedCompletion = true;
      }
      await sessionRuntime.continue(
        sessionID,
        promptWithPatchNote,
        model ? (parseModelReference(model) ?? undefined) : undefined,
      );
      promptSent = true;
    } finally {
      if (!promptSent) {
        sessionBusy.set(sessionID, false);
        if (serviceInitiated) {
          turnFor(sessionID).serviceInitiated = false;
        }
        if (reopenedCompletion) {
          try {
            await withInterviewDocumentLock(
              interview.markdownPath,
              async () => {
                const current = await readInterviewDocument(interview);
                const consumedState = parseFrontmatter(current)?.consumedState;
                if (consumedState !== reopenedConsumedState) return;
                await markInterviewDocumentComplete(interview);
                interview.completed = true;
              },
            );
          } catch (error) {
            log('[interview] failed to restore completed document', {
              error: String(error),
            });
          }
        }
      }
    }
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
    let pendingAnswerContext:
      | {
          activeQuestionIds: Set<string>;
          questions: InterviewState['questions'];
        }
      | undefined;
    let answersMarked = false;
    let previousPendingAnswers: boolean | undefined;
    let previousAnsweredQuestions: Set<string> | undefined;
    try {
      await runServiceTurn(interview, async (state) => {
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

        pendingAnswerContext = {
          activeQuestionIds,
          questions: state.questions,
        };
        const memory = memoryFor(interview.id);
        previousPendingAnswers = memory.pendingAnswers;
        previousAnsweredQuestions = memory.answeredQuestions;
        memory.answeredQuestions = activeQuestionIds;
        memory.pendingAnswers = true;
        answersMarked = true;
        const prompt = buildAnswerPrompt(
          answers,
          state.questions,
          maxQuestions,
          specContext(interview.markdownPath, state.document),
          printState,
        );

        return prompt;
      });
      const answerContext = pendingAnswerContext as {
        activeQuestionIds: Set<string>;
        questions: InterviewState['questions'];
      };
      const memory = memoryFor(interview.id);
      const pending = memory.pendingAnswerHistory ?? [];
      pending.push({
        questions: answerContext.questions,
        answers,
        activeQuestionIds: answerContext.activeQuestionIds,
      });
      memory.pendingAnswerHistory = pending;
      await retryPendingAnswerHistory(interview);
    } catch (error) {
      if (answersMarked) {
        const memory = memoryFor(interview.id);
        if (previousPendingAnswers === undefined) {
          delete memory.pendingAnswers;
        } else {
          memory.pendingAnswers = previousPendingAnswers;
        }
        if (previousAnsweredQuestions === undefined) {
          delete memory.answeredQuestions;
        } else {
          memory.answeredQuestions = previousAnsweredQuestions;
        }
      }
      throw error;
    }
  }

  async function handleCommandExecuteBefore(
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command === IMPLEMENT_COMMAND) {
      await handleImplement(input.sessionID, input.arguments, output);
      return;
    }
    if (input.command !== COMMAND_NAME) {
      return;
    }

    const idea = input.arguments.trim();
    output.parts.length = 0;

    if (!idea) {
      const activeId = activeInterviewIds.get(input.sessionID);
      const interview = activeId ? interviewsById.get(activeId) : null;
      if (interview?.status !== 'active') {
        output.parts.push(
          createInternalAgentTextPart(
            'The user ran /interview without an idea. Ask them for the product idea in one sentence.',
          ),
        );
        return;
      }

      if (interview.completed) {
        await withInterviewDocumentLock(interview.markdownPath, () =>
          markInterviewDocumentIncomplete(interview),
        );
        interview.completed = false;
      }
      await notifyInterviewUrl(input.sessionID, interview);
      turnFor(input.sessionID).serviceInitiated = true;
      const document = await readInterviewDocument(interview);
      const preface =
        'The interview UI was reopened for the current session. If your latest interview turn already contains unanswered questions, do not repeat them.';
      output.parts.push(
        createInternalAgentTextPart(
          `${preface}\n\n${buildResumePrompt(
            specContext(interview.markdownPath, document),
            maxQuestions,
            printState,
          )}`,
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
      let interview: InterviewRecord;
      try {
        interview = await resumeInterview(input.sessionID, resumePath);
      } catch (error) {
        if (error instanceof InterviewDocumentOwnershipError) {
          output.parts.push(
            createInternalAgentTextPart(
              'This interview document is already owned by another OpenCode session and cannot be resumed here.',
            ),
          );
          return;
        }
        throw error;
      }
      const document = await fs.readFile(interview.markdownPath, 'utf8');
      await notifyInterviewUrl(input.sessionID, interview);
      turnFor(input.sessionID).serviceInitiated = true;
      output.parts.push(
        createInternalAgentTextPart(
          buildResumePrompt(
            specContext(interview.markdownPath, document),
            maxQuestions,
            printState,
          ),
        ),
      );
      return;
    }

    const interview = await createInterview(input.sessionID, idea);
    const document = await fs.readFile(interview.markdownPath, 'utf8');
    const existingSummary = extractSummarySection(document).trim();
    const hasExistingSpec =
      existingSummary !== '' &&
      existingSummary !== 'Waiting for interview answers.';
    await notifyInterviewUrl(input.sessionID, interview);
    turnFor(input.sessionID).serviceInitiated = true;
    output.parts.push(
      createInternalAgentTextPart(
        hasExistingSpec
          ? buildResumePrompt(
              specContext(interview.markdownPath, document),
              maxQuestions,
              printState,
            )
          : buildKickoffPrompt(idea, maxQuestions, printState),
      ),
    );

    let sessionTitle = `Interview: ${idea}`;
    if (sessionTitle.length > 50) {
      sessionTitle = `${sessionTitle.slice(0, 49)}…`;
    }
    sessionRuntime.rename(input.sessionID, sessionTitle).catch(() => {});
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
        const isBusy = status?.type === 'busy';
        if (isBusy && activeInterviewIds.has(sessionID)) {
          // Open the turn only on the first busy after a handled idle. v1 can
          // emit busy once per loop step; resetting on every busy would wipe a
          // mid-turn tool submit. `sessionBusy` is deliberately not used as
          // the gate (submitAnswers sets it before the host emits busy).
          if (turnFor(sessionID).turnOpen !== true) {
            resetTurnNoticeState(sessionID);
            const interviewID = activeInterviewIds.get(sessionID);
            if (
              interviewID &&
              memoryFor(interviewID).patchRepairSent === true
            ) {
              turnFor(sessionID).repairTurnStarted = true;
            }
            turnFor(sessionID).turnOpen = true;
          }
        }
        sessionBusy.set(sessionID, isBusy);
        const interviewId = activeInterviewIds.get(sessionID);
        if (status?.type === 'idle') {
          const state = turnState.get(sessionID);
          if (state) state.turnOpen = false;
          if (interviewId) {
            if (finalizationPending.has(interviewId)) {
              finalizationReady.add(interviewId);
            }
            await notifyTurnStatus(sessionID);
          }
        }
      }
      return;
    }

    if (event.type === 'session.idle') {
      const sessionID =
        (properties.sessionID as string | undefined) ??
        (properties.info as { id?: string } | undefined)?.id ??
        undefined;
      if (sessionID) {
        sessionBusy.set(sessionID, false);
        const state = turnState.get(sessionID);
        if (state) state.turnOpen = false;
        const interviewId = activeInterviewIds.get(sessionID);
        if (interviewId && finalizationPending.has(interviewId)) {
          finalizationReady.add(interviewId);
        }
        if (interviewId) {
          await notifyTurnStatus(sessionID);
        }
      }
      return;
    }

    if (event.type === 'session.next.text.ended') {
      // Not a turn-end boundary: never post the notice here.
      const sessionID =
        (properties.sessionID as string | undefined) ??
        (properties.info as { id?: string } | undefined)?.id ??
        undefined;
      if (sessionID) {
        const interviewId = activeInterviewIds.get(sessionID);
        if (interviewId && finalizationPending.has(interviewId)) {
          finalizationReady.add(interviewId);
        }
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
      turnState.delete(deletedSessionId);
      const interviewId = activeInterviewIds.get(deletedSessionId);
      if (!interviewId) {
        return;
      }
      finalizationReady.delete(interviewId);
      finalizationPending.delete(interviewId);

      const interview = interviewsById.get(interviewId);
      if (!interview) {
        return;
      }

      abandonInterview(interview);
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

  async function submitBlockComment(
    interviewId: string,
    sectionTitle: string,
    comment: string,
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    await runServiceTurn(interview, async (state) => {
      const prompt = buildBlockCommentPrompt(
        sectionTitle,
        comment,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        printState,
      );

      return prompt;
    });
  }

  async function submitChat(
    interviewId: string,
    message: string,
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    await runServiceTurn(interview, async (state) => {
      const prompt = buildChatPrompt(
        message,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        printState,
      );

      return prompt;
    });
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
    if (action === 'confirm-complete') {
      const didComplete = await withInterviewDocumentLock(
        interview.markdownPath,
        async () => {
          const current = await readInterviewDocument(interview);
          if (parseFrontmatter(current)?.status === 'complete') return false;
          if (memoryFor(interview.id).pendingAnswers === true) {
            throw new Error(
              'Cannot complete while answers are awaiting incorporation.',
            );
          }
          await markInterviewDocumentComplete(interview);
          return true;
        },
      );
      interview.completed = true;
      if (!didComplete) return;
      const relativePath = relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      );
      await sessionRuntime.notify(
        interview.sessionID,
        `The spec is complete. Follow ${relativePath}.`,
      );
      await getInterviewState(interviewId);
      return;
    }

    await runServiceTurn(interview, async (state) => {
      const prompt = buildNudgePrompt(
        action,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        printState,
      );

      return prompt;
    });
  }

  async function newestCompleteSpec(): Promise<string | null> {
    const outputDir = createInterviewDirectoryPath(ctx.directory, outputFolder);
    let entries: string[];
    try {
      entries = await fs.readdir(outputDir);
    } catch {
      return null;
    }
    let best: { filePath: string; mtime: number } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(outputDir, entry);
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(filePath, 'utf8'),
          fs.stat(filePath),
        ]);
        if (parseFrontmatter(content)?.status !== 'complete') continue;
        if (!best || stat.mtimeMs > best.mtime) {
          best = { filePath, mtime: stat.mtimeMs };
        }
      } catch {}
    }
    return best?.filePath ?? null;
  }

  async function handleImplement(
    visibleSessionID: string,
    argument: string,
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    output.parts.length = 0;
    const requested = argument.trim();
    const activeId = activeInterviewIds.get(visibleSessionID);
    const activeInterview = activeId ? interviewsById.get(activeId) : undefined;
    const requestedPath = requested
      ? resolveExistingInterviewPath(ctx.directory, outputFolder, requested)
      : null;
    if (
      activeInterview &&
      memoryFor(activeInterview.id).pendingAnswers === true &&
      (!requested ||
        (requestedPath !== null &&
          path.resolve(requestedPath) ===
            path.resolve(activeInterview.markdownPath)))
    ) {
      output.parts.push(
        createInternalAgentTextPart(
          'The interview answers are still awaiting incorporation into the spec. Wait for the next interview state before implementing.',
        ),
      );
      return;
    }
    let markdownPath: string | null = null;
    if (requested) {
      markdownPath = resolveExistingInterviewPath(
        ctx.directory,
        outputFolder,
        requested,
      );
    } else {
      const activeId = activeInterviewIds.get(visibleSessionID);
      const active = activeId ? interviewsById.get(activeId) : undefined;
      markdownPath =
        active && active.status === 'active'
          ? active.markdownPath
          : await newestCompleteSpec();
    }
    if (!markdownPath) {
      output.parts.push(
        createInternalAgentTextPart(buildImplementMissingPrompt()),
      );
      return;
    }

    const selectedDocument = await fs.readFile(markdownPath, 'utf8');
    const active = [...interviewsById.values()].find(
      (record) =>
        record.status === 'active' &&
        path.resolve(record.markdownPath) === path.resolve(markdownPath),
    );
    if (active) {
      const state = await getInterviewState(active.id);
      const memory = memoryFor(active.id);
      if (
        state.mode === 'error' ||
        memory.lastPatchError ||
        memory.pendingPatchRepair ||
        memory.pendingAnswers
      ) {
        output.parts.push(
          createInternalAgentTextPart(buildImplementPatchFailurePrompt()),
        );
        return;
      }
    }
    if (
      requested &&
      parseFrontmatter(selectedDocument)?.status !== 'complete'
    ) {
      output.parts.push(
        createInternalAgentTextPart(buildImplementRefusalPrompt()),
      );
      return;
    }

    if (active && !active.completed) {
      const state = await getInterviewState(active.id);
      if (state.questions.length > 0) {
        output.parts.push(
          createInternalAgentTextPart(buildImplementRefusalPrompt()),
        );
        return;
      }
      const body = extractSummarySection(state.document);
      if (
        state.mode !== 'completed' ||
        !body ||
        body === 'Waiting for interview answers.'
      ) {
        output.parts.push(
          createInternalAgentTextPart(buildImplementMissingPrompt()),
        );
        return;
      }
    }

    output.parts.push(
      createInternalAgentTextPart(
        buildImplementPrompt(
          relativeInterviewPath(ctx.directory, markdownPath),
        ),
      ),
    );
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
    submitState,
    notifyTurnStatus,
    completeInterviewText,
    listInterviewFiles,
    listInterviews,
    submitAnswers,
    submitBlockComment,
    submitChat,
    handleNudgeAction,
  };
}
