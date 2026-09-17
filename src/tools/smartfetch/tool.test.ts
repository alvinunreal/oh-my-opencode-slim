import { afterEach, describe, expect, mock, test } from 'bun:test';
import { CACHE } from './cache';
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

describe('smartfetch/tool', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    CACHE.clear();
    mock.restore();
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
      helperAgent: 'explorer',
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
