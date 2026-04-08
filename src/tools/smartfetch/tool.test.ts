import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createWebfetchTool } from './tool';

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
});
