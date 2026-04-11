import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import type { InterviewAnswer, InterviewState } from './types';
import { renderInterviewPage } from './ui';

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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(value)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
}

export function createInterviewServer(deps: {
  getState: (interviewId: string) => Promise<InterviewState>;
  submitAnswers: (
    interviewId: string,
    answers: InterviewAnswer[],
  ) => Promise<void>;
}): {
  ensureStarted: () => Promise<string>;
} {
  let baseUrl: string | null = null;
  let startPromise: Promise<string> | null = null;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (request.method === 'GET' && pathname.startsWith('/interview/')) {
      sendHtml(
        response,
        renderInterviewPage(pathname.split('/').pop() ?? 'unknown'),
      );
      return;
    }

    const stateMatch = pathname.match(/^\/api\/interviews\/([^/]+)\/state$/);
    if (request.method === 'GET' && stateMatch) {
      try {
        const state = await deps.getState(stateMatch[1]);
        sendJson(response, 200, state);
      } catch (error) {
        sendJson(response, 404, {
          error: error instanceof Error ? error.message : 'Interview not found',
        });
      }
      return;
    }

    const answersMatch = pathname.match(
      /^\/api\/interviews\/([^/]+)\/answers$/,
    );
    if (request.method === 'POST' && answersMatch) {
      try {
        const body = parseAnswersPayload(await readJsonBody(request));
        await deps.submitAnswers(answersMatch[1], body.answers);
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

      server.on('error', (error) => {
        startPromise = null;
        reject(error);
      });

      server.listen(0, '127.0.0.1', () => {
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
  };
}
