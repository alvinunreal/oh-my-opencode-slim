import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import { extractResumeSlug, readJsonBody, sendHtml, sendJson } from './helpers';
import type {
  InterviewAnswer,
  InterviewFileItem,
  InterviewListItem,
  InterviewState,
} from './types';
import { renderDashboardPage, renderInterviewPage } from './ui';

function getSubmissionStatus(error: unknown): number {
  if (error instanceof SyntaxError) {
    return 400;
  }

  const message = error instanceof Error ? error.message : '';
  if (message === 'Interview not found') {
    return 404;
  }
  if (message.includes('busy')) {
    return 409;
  }
  if (
    message.includes('waiting for a valid agent update') ||
    message.includes('There are no active interview questions') ||
    message.includes('Answer every active interview question') ||
    message.includes('Answers do not match') ||
    message.includes('Request body too large') ||
    message.includes('Invalid answers payload') ||
    message.includes('no longer active')
  ) {
    return 400;
  }

  return 500;
}

function parseAnswersPayload(value: unknown): { answers: InterviewAnswer[] } {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid answers payload.');
  }
  const answersRaw = (value as { answers?: unknown }).answers;
  if (!Array.isArray(answersRaw)) {
    throw new Error('Invalid answers payload.');
  }

  return {
    answers: answersRaw.map((answer) => {
      if (!answer || typeof answer !== 'object') {
        throw new Error('Invalid answers payload.');
      }
      const record = answer as { questionId?: unknown; answer?: unknown };
      if (
        typeof record.questionId !== 'string' ||
        typeof record.answer !== 'string'
      ) {
        throw new Error('Invalid answers payload.');
      }
      return {
        questionId: record.questionId.trim(),
        answer: record.answer.trim(),
      };
    }),
  };
}

export function createInterviewServer(deps: {
  getState: (interviewId: string) => Promise<InterviewState>;
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
  outputFolder: string;
  port: number;
}): {
  ensureStarted: () => Promise<string>;
  close: () => void;
} {
  let baseUrl: string | null = null;
  let startPromise: Promise<string> | null = null;
  let activeServer: Server | null = null;

  async function loadDashboardData() {
    const interviews = deps.listInterviews().map((item) => {
      const resumeSlug = extractResumeSlug(item.id);
      return {
        ...item,
        url: `/interview/${item.id}`,
        mode: 'active',
        resumeSlug,
      };
    });
    const files = await deps.listInterviewFiles();
    return { interviews, files };
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }
    const pathname = url.pathname;

    // Dashboard: root page listing all interviews
    if (request.method === 'GET' && pathname === '/') {
      try {
        const { interviews, files } = await loadDashboardData();
        sendHtml(
          response,
          renderDashboardPage(interviews, files, deps.outputFolder),
        );
      } catch {
        sendJson(response, 500, { error: 'Failed to load interviews' });
      }
      return;
    }

    // API: list all interviews as JSON
    if (request.method === 'GET' && pathname === '/api/interviews') {
      try {
        const { interviews, files } = await loadDashboardData();
        sendJson(response, 200, { active: interviews, files });
      } catch {
        sendJson(response, 500, { error: 'Failed to load interviews' });
      }
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/interview/')) {
      const rawId = decodeURIComponent(pathname.split('/').pop() ?? 'unknown');
      sendHtml(response, renderInterviewPage(rawId, extractResumeSlug(rawId)));
      return;
    }

    const stateMatch = pathname.match(/^\/api\/interviews\/([^/]+)\/state$/);
    if (request.method === 'GET' && stateMatch) {
      try {
        const state = await deps.getState(decodeURIComponent(stateMatch[1]));
        sendJson(response, 200, state);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Interview not found';
        const status = message === 'Interview not found' ? 404 : 500;
        sendJson(response, status, { error: message });
      }
      return;
    }

    // CSRF note: This endpoint intentionally sends no CORS headers.
    // The browser's same-origin policy blocks cross-origin POST with
    // Content-Type: application/json (it triggers a preflight, which
    // 404s here). Do NOT add Access-Control-Allow-Origin without also
    // adding an Origin check or CSRF token.
    const answersMatch = pathname.match(
      /^\/api\/interviews\/([^/]+)\/answers$/,
    );
    if (request.method === 'POST' && answersMatch) {
      try {
        const body = parseAnswersPayload(await readJsonBody(request));
        await deps.submitAnswers(
          decodeURIComponent(answersMatch[1]),
          body.answers,
        );
        sendJson(response, 200, {
          ok: true,
          message: 'Answers submitted to the OpenCode session.',
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to submit answers.';
        const status = getSubmissionStatus(error);
        sendJson(response, status, {
          ok: false,
          message,
        });
      }
      return;
    }

    // Nudge: ask more questions or confirm complete
    const nudgeMatch = pathname.match(/^\/api\/interviews\/([^/]+)\/nudge$/);
    if (request.method === 'POST' && nudgeMatch) {
      try {
        const body = (await readJsonBody(request)) as {
          action?: string;
        };
        if (
          body.action !== 'more-questions' &&
          body.action !== 'confirm-complete'
        ) {
          sendJson(response, 400, {
            error: 'action must be "more-questions" or "confirm-complete"',
          });
          return;
        }
        await deps.handleNudgeAction(
          decodeURIComponent(nudgeMatch[1]),
          body.action,
        );
        sendJson(response, 200, { ok: true, message: 'Nudge sent.' });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to nudge.';
        const status = message === 'Interview not found' ? 404 : 500;
        sendJson(response, status, { ok: false, message });
      }
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  }

  async function ensureStarted(): Promise<string> {
    if (baseUrl) {
      return baseUrl;
    }

    if (startPromise) {
      return startPromise;
    }

    startPromise = new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        handle(request, response).catch((error) => {
          sendJson(response, 500, {
            error:
              error instanceof Error ? error.message : 'Internal server error',
          });
        });
      });
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;

      activeServer = server;

      server.on('error', (error: NodeJS.ErrnoException) => {
        server.close();
        activeServer = null;
        startPromise = null;
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Interview server port ${deps.port} is already in use. Choose a different port or set port to 0 for an OS-assigned port.`,
            ),
          );
        } else {
          reject(error);
        }
      });

      server.listen(deps.port, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          startPromise = null;
          reject(new Error('Failed to start interview server'));
          return;
        }

        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve(baseUrl);
      });
    });

    return startPromise;
  }

  return {
    ensureStarted,
    close: () => {
      if (activeServer) {
        activeServer.closeAllConnections();
        activeServer.close();
        activeServer = null;
      }
      baseUrl = null;
      startPromise = null;
    },
  };
}
