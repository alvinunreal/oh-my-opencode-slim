import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(value)}\n`);
}

export function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
}

export function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 256;
}

export function extractResumeSlug(interviewId: string): string {
  if (interviewId.startsWith('recovered-')) {
    return interviewId.replace('recovered-', '');
  }
  const parts = interviewId.split('-');
  return parts.slice(2).join('-') || interviewId;
}

const MAX_BODY_SIZE = 64 * 1024; // 64KB

/**
 * Read and parse JSON body from an HTTP request with size limit.
 * Destroys the request if the body exceeds MAX_BODY_SIZE.
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_SIZE) {
      request.destroy();
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}
