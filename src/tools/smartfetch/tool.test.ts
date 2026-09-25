import { afterEach, describe, expect, mock, test } from 'bun:test';
import { buildCacheKey, CACHE } from './cache';
import { createWebfetchTool } from './tool';

let mockV2Client: Record<string, unknown>;

mock.module('../../utils/opencode-client', () => ({
  getClient: () => mockV2Client,
}));

function createExecutionContext() {
  return {
    ask: mock(async () => undefined),
    metadata: mock(() => undefined),
    abort: new AbortController().signal,
    directory: '/tmp/smartfetch-test',
  } as any;
}

async function expireCached(key: string) {
  const entry = CACHE.get(key);
  if (!entry) throw new Error(`Missing cache entry: ${key}`);
  CACHE.set(key, entry, { ttl: 1 });
  await Bun.sleep(12);
}

describe('smartfetch/tool', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    CACHE.clear();
    mock.restore();
  });

  test('normalizes omitted arguments before probing, extracting and rendering metadata', async () => {
    const visited: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      visited.push(url);
      if (url.endsWith('/llms-full.txt') || url.endsWith('/llms.txt')) {
        return new Response('missing', { status: 404 });
      }
      return new Response(
        `<html><head><title>Docs</title></head><body><nav>Navigation only</nav><article><h1>Welcome</h1><p>${'Documentation content with useful details. '.repeat(30)}</p></article></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;
    const result = await createWebfetchTool({ client: {} } as any).execute(
      { url: 'https://docs.example.com/page' },
      createExecutionContext(),
    );
    expect(result).toContain('requested_url:');
    expect(result).toContain('extracted_main: true');
    expect(result).toContain('Welcome');
    expect(result).not.toContain('Navigation only');
    expect(visited).toEqual([
      'https://docs.example.com/llms-full.txt',
      'https://docs.example.com/llms.txt',
      'https://docs.example.com/page',
    ]);
  });

  test('negotiates markdown separately from HTML and treats markdown as text', async () => {
    const accepts: string[] = [];
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const accept = new Headers(init?.headers).get('Accept') || '';
        accepts.push(accept);
        return new Response(
          accept.startsWith('text/markdown')
            ? '# Markdown heading'
            : '<h1>HTML heading</h1>',
          {
            headers: {
              'content-type': accept.startsWith('text/markdown')
                ? 'text/markdown'
                : 'text/html',
            },
          },
        );
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = {
      url: 'https://example.com/article',
      prefer_llms_txt: 'never' as const,
    };
    const markdown = await webfetch.execute(
      { ...args, format: 'markdown' },
      createExecutionContext(),
    );
    const html = await webfetch.execute(
      { ...args, format: 'html' },
      createExecutionContext(),
    );
    expect(markdown).toContain('# Markdown heading');
    expect(markdown).toContain('source_kind: "text"');
    expect(html).toContain('HTML heading');
    expect(accepts).toHaveLength(2);
    expect(accepts[0]).toStartWith('text/markdown');
    expect(accepts[1]).toStartWith('text/html');
  });

  test('a persistent Cloudflare challenge reports 403 and mentions the retry', async () => {
    const fetchMock = mock(
      async () =>
        new Response('challenge', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge' },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(
      createWebfetchTool({ client: {} } as any).execute(
        { url: 'https://example.com/page', prefer_llms_txt: 'never' },
        createExecutionContext(),
      ),
    ).rejects.toThrow(
      'Request failed with status code: 403 (Cloudflare challenge',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('rejects a pre-aborted request after permission without network I/O', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    const fetchMock = mock(async () => new Response('unreachable'));
    globalThis.fetch = fetchMock as typeof fetch;
    const ctx = { ...createExecutionContext(), abort: controller.signal };
    const webfetch = createWebfetchTool({ client: {} } as any);
    await expect(
      webfetch.execute(
        {
          url: 'https://example.com/page',
          format: 'text',
          extract_main: false,
          prefer_llms_txt: 'never',
          include_metadata: true,
          save_binary: false,
        },
        ctx,
      ),
    ).rejects.toThrow('pre-aborted');
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects 304 when no validators were sent', async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has('If-None-Match')).toBe(false);
        return new Response(null, { status: 304 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    await expect(
      webfetch.execute(
        {
          url: 'https://example.com/page',
          format: 'text',
          extract_main: false,
          prefer_llms_txt: 'never',
          include_metadata: true,
          save_binary: false,
        },
        createExecutionContext(),
      ),
    ).rejects.toThrow('Request failed with status code: 304');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('revalidates stale ETag and Last-Modified with 304 and refreshes TTL', async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (fetchMock.mock.calls.length === 1)
          return new Response('first body', {
            headers: {
              'content-type': 'text/plain',
              etag: '"first"',
              'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT',
            },
          });
        const headers = new Headers(init?.headers);
        expect(headers.get('If-None-Match')).toBe('"first"');
        expect(headers.get('If-Modified-Since')).toBe(
          'Tue, 01 Jan 2030 00:00:00 GMT',
        );
        return new Response(null, {
          status: 304,
          headers: { etag: '"renewed"' },
        });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = {
      url: 'https://example.com/page',
      prefer_llms_txt: 'never' as const,
    };
    const invoke = () => webfetch.execute(args, createExecutionContext());
    expect(await invoke()).toContain('first body');
    const key = buildCacheKey(args.url, {
      format: 'markdown',
      extract_main: true,
      prefer_llms_txt: 'never',
      save_binary: false,
    });
    await expireCached(key);
    const revalidated = await invoke();
    expect(revalidated).toContain('first body');
    expect(revalidated).toContain('etag: "\\"renewed\\""');
    expect(revalidated).toContain('cache_hit: true');
    expect(revalidated).toContain('revalidated: true');
    expect(await invoke()).toContain('first body');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('revalidation 200 replaces cached content and the validator', async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('If-None-Match'));
        return new Response(seen.length === 1 ? 'old body' : 'new body', {
          headers: {
            'content-type': 'text/plain',
            etag: seen.length === 1 ? '"old"' : '"new"',
          },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = {
      url: 'https://example.com/replace',
      prefer_llms_txt: 'never' as const,
    };
    const key = buildCacheKey(args.url, {
      format: 'markdown',
      extract_main: true,
      prefer_llms_txt: 'never',
      save_binary: false,
    });
    const invoke = () => webfetch.execute(args, createExecutionContext());
    await invoke();
    await expireCached(key);
    expect(await invoke()).toContain('new body');
    await expireCached(key);
    await invoke();
    expect(seen).toEqual([null, '"old"', '"new"']);
  });

  test('304 after a changed redirect target triggers a fresh unconditional request', async () => {
    const seen: Array<[string, string | null]> = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const validator = new Headers(init?.headers).get('If-None-Match');
        seen.push([String(url), validator]);
        if (String(url).endsWith('/page'))
          return new Response(null, {
            status: 302,
            headers: { location: seen.length < 3 ? '/old' : '/new' },
          });
        if (seen.length === 2)
          return new Response('old body', {
            headers: { 'content-type': 'text/plain', etag: '"old"' },
          });
        if (seen.length === 4) return new Response(null, { status: 304 });
        return new Response('new body', {
          headers: { 'content-type': 'text/plain', etag: '"new"' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = {
      url: 'https://example.com/page',
      prefer_llms_txt: 'never' as const,
    };
    await webfetch.execute(args, createExecutionContext());
    const key = buildCacheKey(args.url, {
      format: 'markdown',
      extract_main: true,
      prefer_llms_txt: 'never',
      save_binary: false,
    });
    await expireCached(key);
    const updated = await webfetch.execute(args, createExecutionContext());
    expect(updated).toContain('new body');
    expect(updated).toContain('final_url: "https://example.com/new"');
    expect(seen).toEqual([
      ['https://example.com/page', null],
      ['https://example.com/old', null],
      ['https://example.com/page', '"old"'],
      ['https://example.com/new', '"old"'],
      ['https://example.com/page', null],
      ['https://example.com/new', null],
    ]);
  });

  test('stale pages without validators fetch unconditionally and never serve stale after a network error', async () => {
    const validators: Array<string | null> = [];
    let fail = false;
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        validators.push(new Headers(init?.headers).get('If-None-Match'));
        if (fail) throw new Error('offline');
        return new Response('updated body', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = {
      url: 'https://example.com/no-etag',
      prefer_llms_txt: 'never' as const,
    };
    const key = buildCacheKey(args.url, {
      format: 'markdown',
      extract_main: true,
      prefer_llms_txt: 'never',
      save_binary: false,
    });
    await webfetch.execute(args, createExecutionContext());
    await expireCached(key);
    expect(await webfetch.execute(args, createExecutionContext())).toContain(
      'updated body',
    );
    expect(validators).toEqual([null, null]);
    await expireCached(key);
    fail = true;
    await expect(
      webfetch.execute(args, createExecutionContext()),
    ).rejects.toThrow('offline');
  });

  test('stale llms.txt entries are re-probed without conditionals', async () => {
    const calls: Array<[string, string | null]> = [];
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push([
          String(url),
          new Headers(init?.headers).get('If-None-Match'),
        ]);
        return new Response('# Fresh docs', {
          headers: { 'content-type': 'text/plain', etag: '"llms"' },
        });
      },
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = { url: 'https://docs.example.com/page' };
    await webfetch.execute(args, createExecutionContext());
    const key = buildCacheKey(args.url, {
      format: 'markdown',
      extract_main: true,
      prefer_llms_txt: 'auto',
      save_binary: false,
    });
    await expireCached(key);
    const result = await webfetch.execute(args, createExecutionContext());
    expect(result).toContain('used_llms_txt: true');
    expect(result).toContain('cache_hit: false');
    expect(calls).toEqual([
      ['https://docs.example.com/llms-full.txt', null],
      ['https://docs.example.com/llms-full.txt', null],
    ]);
  });

  test('unsaved binary metadata includes the same download limit as saved binaries', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(new Uint8Array([0, 1, 2]), {
          headers: { 'content-type': 'image/png' },
        }),
    ) as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const result = await webfetch.execute(
      {
        url: 'https://example.com/figure.png',
        format: 'markdown',
        extract_main: true,
        prefer_llms_txt: 'never',
        include_metadata: true,
        save_binary: false,
      },
      createExecutionContext(),
    );
    expect(result).toContain('download_limit_bytes: 2097152');
    expect(result).toContain('save_binary: false');
    expect(result).toContain('cache_hit: false');
  });

  test('returns a required llms.txt message when prefer_llms_txt is always and no llms.txt is available', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (
        url === 'https://docs.example.com/llms-full.txt' ||
        url === 'https://docs.example.com/llms.txt'
      ) {
        return new Response('not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const webfetch = createWebfetchTool({ client: {} } as any);
    const ctx = createExecutionContext();
    const result = await webfetch.execute(
      {
        url: 'https://docs.example.com/page',
        format: 'markdown',
        extract_main: true,
        prefer_llms_txt: 'always',
        include_metadata: true,
        save_binary: false,
      },
      ctx,
    );

    expect(result).toContain('Required llms.txt content was unavailable.');
    expect(result).toContain('Original URL: https://docs.example.com/page');
    expect(result).toContain('prefer_llms_txt: "always"');
    expect(result).toContain('used_llms_txt: false');
    expect(ctx.ask).toHaveBeenCalledTimes(1);
    expect(ctx.metadata).not.toHaveBeenCalled();
  });

  test('same document with different fragments issues a single request', async () => {
    CACHE.clear();

    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === 'https://example.com/docs') {
        return new Response('document body', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const webfetch = createWebfetchTool({ client: {} } as any);

    const firstCtx = createExecutionContext();
    const firstResult = await webfetch.execute(
      {
        url: 'https://example.com/docs#sec1',
        format: 'markdown',
        extract_main: true,
        prefer_llms_txt: 'auto',
        include_metadata: true,
        save_binary: false,
      },
      firstCtx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toContain(
      'requested_url: "https://example.com/docs#sec1"',
    );
    expect(firstResult).toContain('cache_hit: false');

    const secondCtx = createExecutionContext();
    const secondResult = await webfetch.execute(
      {
        url: 'https://example.com/docs#sec2',
        format: 'markdown',
        extract_main: true,
        prefer_llms_txt: 'auto',
        include_metadata: true,
        save_binary: false,
      },
      secondCtx,
    );

    // The fragment-stripped cache key collides with the first request, so
    // the second fetch is served from cache without hitting the network,
    // and the reported requested_url stays the URL of the current request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secondResult).toContain('cache_hit: true');
    expect(secondResult).toContain(
      'requested_url: "https://example.com/docs#sec2"',
    );
  });

  test('fetches and cleans a 1 MiB U+2028 page in under one second', async () => {
    const page = `${'\u2028'.repeat(Math.floor((1024 * 1024) / 3))}![`;
    globalThis.fetch = mock(
      async () =>
        new Response(page, {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    ) as unknown as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const started = performance.now();
    const result = await webfetch.execute(
      {
        url: 'https://example.com/large',
        format: 'markdown',
        extract_main: false,
        prefer_llms_txt: 'never',
        include_metadata: false,
        save_binary: false,
      },
      createExecutionContext(),
    );
    expect(result).toBe('![');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a canonical URL does not share a credentialed response with another request', async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        `<html><head><link rel="canonical" href="https://example.com/private"></head><body>${url.includes('user:pass@') ? 'private account' : 'public page'}</body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const webfetch = createWebfetchTool({ client: {} } as any);
    const args = {
      format: 'text' as const,
      extract_main: false,
      prefer_llms_txt: 'never' as const,
      include_metadata: true,
      save_binary: false,
    };
    const fetchPage = (url: string) =>
      webfetch.execute({ ...args, url }, createExecutionContext());
    const privateResult = await fetchPage(
      'https://user:pass@example.com/private',
    );
    const publicResult = await fetchPage('https://example.com/private');
    expect(privateResult).toContain('private account');
    expect(publicResult).toContain('public page');
    expect(publicResult).not.toContain('private account');
    expect(publicResult).toContain('cache_hit: false');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('passes ctx.sessionID as parentID to the secondary-model session', async () => {
    const fetchMock = mock(async () => {
      return new Response(
        'Article about smartfetch: it fetches pages, extracts the main ' +
          'content, caches results, and summarizes them with a secondary ' +
          'model whenever a prompt is provided by the tool caller.',
        { status: 200, headers: { 'content-type': 'text/plain' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const session = {
      create: mock(async () => ({ data: { id: 'secondary-session' } })),
      prompt: mock(async () => ({
        data: { parts: [{ type: 'text', text: 'Extracted answer' }] },
      })),
      delete: mock(async () => ({ data: true })),
      abort: mock(async () => ({ data: true })),
    };
    const toolIds = { ids: mock(async () => ({ data: ['read'] })) };
    mockV2Client = { session, tool: toolIds };

    const webfetch = createWebfetchTool({ client: mockV2Client } as any, {
      webfetchModels: [{ id: 'provider/small-model' }],
    });
    const ctx = createExecutionContext();
    ctx.sessionID = 'main-session-id';
    const result = await webfetch.execute(
      {
        url: 'https://example.com/article',
        format: 'markdown',
        extract_main: true,
        prefer_llms_txt: 'auto',
        include_metadata: false,
        save_binary: false,
        prompt: 'Extract the answer',
      },
      ctx,
    );

    expect(session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          title: 'smartfetch-secondary',
          parentID: 'main-session-id',
        }),
      }),
    );
    expect(result).toContain('Extracted answer');
  });
});
