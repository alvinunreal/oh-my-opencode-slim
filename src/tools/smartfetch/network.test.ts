import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  buildAllowedOrigins,
  buildConditionalHeaders,
  fetchWithRedirects,
} from './network';

describe('smartfetch/network', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test('collects unique allowed origins from permission patterns', () => {
    const origins = [
      ...buildAllowedOrigins([
        'https://docs.example.com/page',
        'https://docs.example.com/llms.txt',
        'https://cdn.example.com/asset',
        'not-a-url',
      ]),
    ].sort();

    expect(origins).toEqual([
      'https://cdn.example.com',
      'https://docs.example.com',
    ]);
  });

  test('follows permitted same-origin redirects', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://docs.example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: '/next' },
        });
      }

      if (url === 'https://docs.example.com/next') {
        return new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithRedirects(
      'https://docs.example.com/start',
      1_000,
      'markdown',
      new AbortController().signal,
    );

    expect('blockedRedirect' in result).toBe(false);
    if ('blockedRedirect' in result) {
      throw new Error('Expected redirect to be followed');
    }

    expect(result.finalUrl).toBe('https://docs.example.com/next');
    expect(result.redirectChain).toEqual([
      {
        from: 'https://docs.example.com/start',
        to: 'https://docs.example.com/next',
        status: 302,
      },
    ]);
  });

  test('blocks cross-origin redirects when the origin is not allowed', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://docs.example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://other.example.com/landing' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithRedirects(
      'https://docs.example.com/start',
      1_000,
      'markdown',
      new AbortController().signal,
    );

    expect(result).toEqual({
      blockedRedirect: true,
      redirectUrl: 'https://other.example.com/landing',
      statusCode: 302,
      redirectChain: [
        {
          from: 'https://docs.example.com/start',
          to: 'https://other.example.com/landing',
          status: 302,
        },
      ],
    });
  });

  test('allows redirects to explicitly allowed origins', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://docs.example.com/start') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://cdn.example.com/asset' },
        });
      }

      if (url === 'https://cdn.example.com/asset') {
        return new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchWithRedirects(
      'https://docs.example.com/start',
      1_000,
      'markdown',
      new AbortController().signal,
      undefined,
      'GET',
      new Set(['https://docs.example.com', 'https://cdn.example.com']),
    );

    expect('blockedRedirect' in result).toBe(false);
    if ('blockedRedirect' in result) {
      throw new Error('Expected redirect to be allowed');
    }

    expect(result.finalUrl).toBe('https://cdn.example.com/asset');
  });

  test('builds conditional headers from etag and last-modified without binary branching', () => {
    expect(buildConditionalHeaders(undefined)).toBeUndefined();

    expect(
      buildConditionalHeaders({
        requestedUrl: 'https://example.com/file',
        finalUrl: 'https://example.com/file',
        statusCode: 200,
        contentType: 'application/pdf',
        charset: undefined,
        etag: '"abc"',
        lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
        contentLength: 42,
        filename: 'file.pdf',
        canonicalUrl: 'https://example.com/file',
        redirectChain: [],
        upgradedToHttps: false,
        truncated: false,
        binary: true,
        binaryKind: 'pdf',
      }),
    ).toEqual({
      'If-None-Match': '"abc"',
      'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
  });
});
