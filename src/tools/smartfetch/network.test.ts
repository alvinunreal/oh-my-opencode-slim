import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fitUtf8, saveBinary } from './binary';
import {
  decodeBody,
  extractHeaderMetadata,
  fetchWithRedirects,
  fetchWithUpgradeFallback,
  looksLikeTextBody,
  normalizeUrl,
  probeLlmsText,
} from './network';

describe('smartfetch/network', () => {
  test('sniffs repeated incomplete HTML tags without quadratic backtracking', () => {
    const input = new TextEncoder().encode('<meta '.repeat(200_000));
    const start = performance.now();
    decodeBody(input, undefined, 'text/html');
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  test('decodes undeclared UTF-8 losslessly and invalid UTF-8 as warned windows-1252', () => {
    const valid = decodeBody(
      new TextEncoder().encode('café'),
      undefined,
      'text/plain',
    );
    expect(valid.text).toBe('café');
    expect(valid.decodeFallback).toBe(false);
    const fallback = decodeBody(
      Uint8Array.of(0x63, 0x61, 0x66, 0xe9),
      undefined,
      'text/plain',
    );
    expect(fallback.text).toBe('café');
    expect(fallback.decodedCharset).toBe('windows-1252');
    expect(fallback.decodeWarning).toContain('windows-1252');
    expect(
      decodeBody(Uint8Array.of(1, 0xe9), undefined, 'text/plain').text,
    ).toBe('\u0001é');
  });

  test('sniffs HTML meta charset only inside the accepted 2048-byte window', () => {
    const makeBody = (padding: number) =>
      Uint8Array.from([
        ...new TextEncoder().encode(
          `${' '.repeat(padding)}<meta charset="windows-1252">`,
        ),
        0xe9,
      ]);
    expect(
      decodeBody(makeBody(1900), undefined, 'text/html').decodeFallback,
    ).toBe(false);
    const afterWindow = decodeBody(makeBody(2050), undefined, 'text/html');
    expect(afterWindow.decodeFallback).toBe(true);
    expect(afterWindow.decodedCharset).toBe('windows-1252');
  });

  test('sniffs control bytes in the first 2 KiB and rejects NUL anywhere', () => {
    const text = new TextEncoder().encode('é'.repeat(100));
    expect(looksLikeTextBody(text)).toBe(true);
    expect(looksLikeTextBody(Uint8Array.from([...text, 0]))).toBe(false);
    expect(
      looksLikeTextBody(Uint8Array.from([...new Uint8Array(2048).fill(65), 0])),
    ).toBe(false);
    expect(
      looksLikeTextBody(Uint8Array.from([...new Uint8Array(96).fill(65), 1])),
    ).toBe(true);
    expect(
      looksLikeTextBody(Uint8Array.from([...new Uint8Array(49).fill(65), 1])),
    ).toBe(false);
  });

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test('normalizeUrl strips fragments from both HTTPS and HTTP URLs', () => {
    const normalized = normalizeUrl('http://example.com/docs#sec1');
    expect(normalized.url).toBe('https://example.com/docs');
    expect(normalized.fallbackUrl).toBe('http://example.com/docs');
    expect(normalized.upgradedToHttps).toBe(true);
    expect(normalizeUrl('https://example.com/docs?page=2#anchor').url).toBe(
      'https://example.com/docs?page=2',
    );
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

  test('discards a malformed redirect response before reporting its location', async () => {
    const response = new Response('redirect body', {
      status: 302,
      headers: { location: 'http://[invalid' },
    });
    const fetchMock = mock(async () => response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      fetchWithRedirects('https://example.com/', new AbortController().signal),
    ).rejects.toThrow('Invalid redirect location: http://[invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(true);
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

  test('does not treat other 3xx statuses as redirects', async () => {
    globalThis.fetch = mock(
      async () => new Response('not a redirect', { status: 300 }),
    ) as typeof fetch;
    const result = await fetchWithRedirects(
      'https://example.com/a',
      new AbortController().signal,
    );
    expect('blockedRedirect' in result).toBe(false);
    if (!('blockedRedirect' in result))
      expect(result.response.status).toBe(300);
  });

  test('cancels a failed HTTPS response and attempts HTTP fallback only once', async () => {
    const urls: string[] = [];
    const primary = new Response('error', { status: 404 });
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).startsWith('https:')) return primary;
      throw new Error('HTTP fallback failed');
    }) as typeof fetch;
    await expect(
      fetchWithUpgradeFallback(
        normalizeUrl('http://example.com/a'),
        new AbortController().signal,
      ),
    ).rejects.toThrow('HTTP fallback failed');
    expect(urls).toEqual(['https://example.com/a', 'http://example.com/a']);
    expect(primary.bodyUsed).toBe(true);
  });

  test('forwards requested headers through HTTPS and HTTP fallback', async () => {
    const calls: Array<[string, string | null]> = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push([String(url), new Headers(init?.headers).get('Accept')]);
        return new Response(String(url).startsWith('https:') ? 'error' : 'ok', {
          status: String(url).startsWith('https:') ? 403 : 200,
        });
      },
    ) as typeof fetch;
    await fetchWithUpgradeFallback(
      normalizeUrl('http://example.com/page'),
      new AbortController().signal,
      { Accept: 'text/markdown, text/html;q=0.9' },
    );
    expect(calls).toEqual([
      ['https://example.com/page', 'text/markdown, text/html;q=0.9'],
      ['http://example.com/page', 'text/markdown, text/html;q=0.9'],
    ]);
  });

  test('retries a Cloudflare challenge from the original URL with opencode UA and closes its body', async () => {
    const challenged = new Response('challenge', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge' },
    });
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return calls.length === 1 ? challenged : new Response('allowed');
      },
    ) as typeof fetch;
    const { result } = await fetchWithUpgradeFallback(
      normalizeUrl('https://example.com/page'),
      new AbortController().signal,
      { Accept: 'text/markdown', 'If-None-Match': '"old"' },
    );
    expect('blockedRedirect' in result).toBe(false);
    if ('blockedRedirect' in result) throw new Error('unexpected redirect');
    expect(result.response.status).toBe(200);
    expect(challenged.bodyUsed).toBe(true);
    expect(calls.map(({ url }) => url)).toEqual([
      'https://example.com/page',
      'https://example.com/page',
    ]);
    expect(calls.map(({ headers }) => headers.get('User-Agent'))).toEqual([
      'opencode-smartfetch/1.0',
      'opencode',
    ]);
    for (const { headers } of calls) {
      expect(headers.get('Accept')).toBe('text/markdown');
      expect(headers.get('If-None-Match')).toBe('"old"');
    }
  });

  test('limits Cloudflare retry to two attempts per scheme and never retries an ordinary 403 or the llms probe', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('challenge', {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
      });
    }) as typeof fetch;
    await fetchWithUpgradeFallback(
      normalizeUrl('http://example.com/page'),
      new AbortController().signal,
    );
    expect(calls).toEqual([
      'https://example.com/page',
      'https://example.com/page',
      'http://example.com/page',
      'http://example.com/page',
    ]);
    calls.length = 0;
    await probeLlmsText(
      new URL('https://example.com/page'),
      new AbortController().signal,
    );
    expect(calls).toHaveLength(2);
    calls.length = 0;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('forbidden', {
        status: 403,
        headers: { 'cf-mitigated': 'other' },
      });
    }) as typeof fetch;
    await fetchWithUpgradeFallback(
      normalizeUrl('https://example.com/page'),
      new AbortController().signal,
    );
    expect(calls).toHaveLength(1);
  });

  test('an HTTPS 304 never falls back to HTTP', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const { result } = await fetchWithUpgradeFallback(
      normalizeUrl('http://example.com/page'),
      new AbortController().signal,
      { 'If-None-Match': '"old"' },
    );
    expect(urls).toEqual(['https://example.com/page']);
    expect('blockedRedirect' in result).toBe(false);
    if (!('blockedRedirect' in result))
      expect(result.response.status).toBe(304);
  });

  test('reports the primary blocked redirect when HTTP fallback also blocks', async () => {
    globalThis.fetch = mock(
      async (url: string | URL | Request) =>
        new Response('', {
          status: 302,
          headers: {
            location: String(url).startsWith('https:')
              ? 'https://other.example.com/landing'
              : 'http://else.example.com/landing',
          },
        }),
    ) as typeof fetch;
    const { result } = await fetchWithUpgradeFallback(
      normalizeUrl('http://example.com/a'),
      new AbortController().signal,
    );
    expect('blockedRedirect' in result && result.redirectUrl).toBe(
      'https://other.example.com/landing',
    );
  });

  test('accepts llms text even when its URL contains login', async () => {
    let accept: string | null = null;
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        accept = new Headers(init?.headers).get('Accept');
        return new Response('# Docs about logging in', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    ) as typeof fetch;
    const result = await probeLlmsText(
      new URL('https://login.example.com/'),
      new AbortController().signal,
    );
    expect('text' in result && result.text).toBe('# Docs about logging in');
    expect(accept).toBe('text/plain, text/markdown;q=0.9, */*;q=0.1');
  });

  test('rejects HTML/login responses before they reach the cache', async () => {
    const fetchMock = mock(
      async () =>
        new Response('<html><title>Login</title></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await probeLlmsText(
      new URL('https://docs.example.com/'),
      new AbortController().signal,
    );
    expect('text' in result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  const raw = `${'é'.repeat(180)}.pdf`;
  const latinName = extractHeaderMetadata(
    new Headers({ 'content-disposition': `attachment; filename="${raw}"` }),
    'https://example.com/x',
  ).filename;
  test('retains the PDF extension when sanitizing a multibyte filename', () => {
    expect(latinName).toEndWith('.pdf');
  });

  test('keeps byte-limited multibyte names unique across binary saves', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'smartfetch-r3-'));
    try {
      for (const name of [latinName ?? '', fitUtf8('界'.repeat(100), 255)]) {
        const save = () =>
          saveBinary(dir, Uint8Array.of(0), 'application/pdf', name);
        const files = [await save(), await save(), await save()];
        expect(path.basename(files[0])).toBe(name);
        expect(path.basename(files[1])).toEndWith('-1.pdf');
        const withinLimit = files.every(
          (file) => Buffer.byteLength(path.basename(file)) <= 255,
        );
        expect([new Set(files).size, withinLimit]).toEqual([3, true]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
