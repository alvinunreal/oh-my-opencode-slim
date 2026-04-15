import { describe, expect, test } from 'bun:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  extractResumeSlug,
  isValidId,
  readJsonBody,
  sendHtml,
  sendJson,
} from './helpers';

describe('isValidId', () => {
  test('accepts alphanumeric IDs', () => {
    expect(isValidId('abc123')).toBe(true);
  });

  test('accepts hyphens and underscores', () => {
    expect(isValidId('my-interview_123')).toBe(true);
  });

  test('rejects empty string', () => {
    expect(isValidId('')).toBe(false);
  });

  test('rejects spaces', () => {
    expect(isValidId('has space')).toBe(false);
  });

  test('rejects special characters', () => {
    expect(isValidId('foo@bar!')).toBe(false);
  });

  test('rejects path traversal attempts', () => {
    expect(isValidId('../etc/passwd')).toBe(false);
  });

  test('rejects IDs over 256 chars', () => {
    expect(isValidId('a'.repeat(257))).toBe(false);
  });

  test('accepts IDs at exactly 256 chars', () => {
    expect(isValidId('a'.repeat(256))).toBe(true);
  });
});

describe('extractResumeSlug', () => {
  test('strips "recovered-" prefix', () => {
    expect(extractResumeSlug('recovered-my-interview')).toBe('my-interview');
  });

  test('strips prefix from recovered IDs with longer names', () => {
    expect(extractResumeSlug('recovered-task-manager')).toBe('task-manager');
  });

  test('strips hash prefix from standard interview IDs', () => {
    // Standard format: abc123def-session-name → splits on first 2 dash-segments
    const result = extractResumeSlug('abc123-my-interview');
    expect(result).toBe('interview');
  });

  test('returns full ID when no prefix to strip', () => {
    // Short IDs that don't match the hash-prefix pattern
    expect(extractResumeSlug('simple')).toBe('simple');
  });

  test('handles recovered prefix with complex slug', () => {
    expect(extractResumeSlug('recovered-some-complex-name')).toBe(
      'some-complex-name',
    );
  });
});

describe('sendJson', () => {
  test('sends JSON response with correct status and content type', async () => {
    const server = createServer(
      (_request: IncomingMessage, response: ServerResponse) => {
        sendJson(response, 200, { status: 'ok' });
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      );
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe('ok');
    } finally {
      server.close();
    }
  });

  test('sends error status code', async () => {
    const server = createServer(
      (_request: IncomingMessage, response: ServerResponse) => {
        sendJson(response, 404, { error: 'Not found' });
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('Not found');
    } finally {
      server.close();
    }
  });

  test('JSON body ends with newline', async () => {
    const server = createServer(
      (_request: IncomingMessage, response: ServerResponse) => {
        sendJson(response, 200, { key: 'value' });
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const text = await res.text();
      expect(text.endsWith('\n')).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('sendHtml', () => {
  test('sends HTML with correct content type', async () => {
    const html = '<html><body>Hello</body></html>';
    const server = createServer(
      (_request: IncomingMessage, response: ServerResponse) => {
        sendHtml(response, html);
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toBe(html);
    } finally {
      server.close();
    }
  });
});

describe('readJsonBody', () => {
  test('parses valid JSON body', async () => {
    const server = createServer(
      async (request: IncomingMessage, response: ServerResponse) => {
        const body = await readJsonBody(request);
        sendJson(response, 200, body);
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const payload = { name: 'test', count: 42 };
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as typeof payload;
      expect(data).toEqual(payload);
    } finally {
      server.close();
    }
  });

  test('returns empty object for empty body', async () => {
    const server = createServer(
      async (request: IncomingMessage, response: ServerResponse) => {
        const body = await readJsonBody(request);
        sendJson(response, 200, { received: body });
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
      });
      const data = (await res.json()) as { received: unknown };
      expect(data.received).toEqual({});
    } finally {
      server.close();
    }
  });

  test('rejects body exceeding 64KB size limit', async () => {
    // readJsonBody destroys the request on overflow, so we test the
    // error path directly rather than via HTTP (the socket dies before
    // a response can be sent).
    let caughtError: Error | null = null;

    const server = createServer(
      async (request: IncomingMessage, response: ServerResponse) => {
        try {
          await readJsonBody(request);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          caughtError =
            error instanceof Error ? error : new Error(String(error));
          // Socket already destroyed — can't send response
        }
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      // Send a body larger than 64KB — connection will reset
      const bigPayload = { data: 'x'.repeat(65 * 1024) };
      try {
        await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bigPayload),
        });
      } catch {
        // Expected: connection reset when request is destroyed
      }

      // Give the server a tick to finish processing
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toContain('too large');
    } finally {
      server.close();
    }
  });

  test('parses array JSON body', async () => {
    const server = createServer(
      async (request: IncomingMessage, response: ServerResponse) => {
        const body = await readJsonBody(request);
        sendJson(response, 200, {
          type: Array.isArray(body) ? 'array' : 'other',
        });
      },
    );

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind'));
          return;
        }
        resolve(addr.port);
      });
      server.on('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([1, 2, 3]),
      });
      const data = (await res.json()) as { type: string };
      expect(data.type).toBe('array');
    } finally {
      server.close();
    }
  });
});
