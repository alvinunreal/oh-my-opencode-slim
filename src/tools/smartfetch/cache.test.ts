import { describe, expect, test } from 'bun:test';
import {
  buildCacheKey,
  CACHE,
  calculateCacheSize,
  conditionalHeaders,
  lookup,
} from './cache';
import type { BinaryFetch, CachedFetch } from './types';

const cacheOptions = {
  format: 'markdown' as const,
  extract_main: true,
  prefer_llms_txt: 'auto' as const,
  save_binary: false,
};

describe('smartfetch/cache', () => {
  test('keeps the 50 MiB/15-minute LRU and charges stored payload bytes', () => {
    expect(CACHE.maxSize).toBe(50 * 1024 * 1024);
    expect(CACHE.ttl).toBe(15 * 60 * 1000);
    try {
      CACHE.set('size-probe', makeBinary(new Uint8Array(4096)));
      expect(CACHE.calculatedSize).toBe(4096);
    } finally {
      CACHE.clear();
    }
  });

  test('URL fragments are not part of the cache key (RFC 3986)', () => {
    const key = (url: string) => buildCacheKey(url, cacheOptions);
    const noFragment = key('https://example.com/docs');
    for (const fragment of ['#sec1', '#sec2', '#']) {
      expect(key(`https://example.com/docs${fragment}`)).toBe(noFragment);
    }
  });

  test('query strings still distinguish cache keys', () => {
    const page1 = buildCacheKey(
      'https://example.com/docs?page=1#x',
      cacheOptions,
    );
    const page2 = buildCacheKey(
      'https://example.com/docs?page=2#x',
      cacheOptions,
    );
    expect(page1).not.toBe(page2);
  });

  test('a stale cache lookup retains the entry but reports it as not fresh', async () => {
    CACHE.set(
      'expired-entry',
      makeCached({
        text: 'body',
        etag: '"abc"',
        lastModified: 'Tue, 01 Jan 2030 00:00:00 GMT',
      }),
      { ttl: 1 },
    );
    try {
      await Bun.sleep(12);
      const { entry, fresh } = lookup('expired-entry');
      expect(fresh).toBe(false);
      expect(entry?.etag).toBe('"abc"');
      if (!entry) throw new Error('stale entry missing');
      expect(conditionalHeaders(entry)).toEqual({
        'If-None-Match': '"abc"',
        'If-Modified-Since': 'Tue, 01 Jan 2030 00:00:00 GMT',
      });
      expect(conditionalHeaders(makeCached({}))).toEqual({});
    } finally {
      CACHE.clear();
    }
  });

  test('option changes still produce distinct cache keys', () => {
    const url = 'https://example.com/docs#sec1';
    const base = buildCacheKey(url, cacheOptions);
    for (const variant of [
      { ...cacheOptions, extract_main: false },
      { ...cacheOptions, prefer_llms_txt: 'always' as const },
      { ...cacheOptions, save_binary: true },
      { ...cacheOptions, format: 'html' as const },
    ]) {
      expect(buildCacheKey(url, variant)).not.toBe(base);
    }
    expect(JSON.parse(base)).toMatchObject({ saveBinary: false });
  });

  test('llms.txt cache key omits format and differs from every page key', () => {
    const url = 'https://docs.example.com/page';
    const llms = buildCacheKey(url, { ...cacheOptions, format: undefined });
    expect(Object.hasOwn(JSON.parse(llms), 'format')).toBe(false);
    for (const format of ['markdown', 'text', 'html'] as const) {
      expect(buildCacheKey(url, { ...cacheOptions, format })).not.toBe(llms);
    }
  });

  test('llms.txt-shaped result is charged once for its content', () => {
    const llmsTxt = Array.from(
      { length: 64 },
      (_, i) => `# Section ${i}\nhttps://example.com/doc-${i}`,
    ).join('\n');
    const result = makeCached({
      rawContent: llmsTxt,
      html: llmsTxt,
      markdown: llmsTxt,
      text: llmsTxt,
    });

    expect(calculateCacheSize(result)).toBe(Buffer.byteLength(llmsTxt));
  });

  test('text-page result with equal content in distinct references is charged once', () => {
    const content = 'plain text line'.repeat(512);
    const result = makeCached({
      rawContent: content,
      html: content.slice(0),
      markdown: `\n${content}\n`.trim(),
      text: ` ${content} `.slice(1, -1),
    });

    expect(calculateCacheSize(result)).toBe(Buffer.byteLength(content));
  });

  test('html result with four distinct fields is charged for all four', () => {
    const rawContent = 'raw html source'.repeat(50);
    const html = '<html><body>markup</body></html>'.repeat(50);
    const markdown = '# heading\ntext'.repeat(50);
    const text = 'plain extract'.repeat(50);
    const result = makeCached({ rawContent, html, markdown, text });

    expect(calculateCacheSize(result)).toBe(
      Buffer.byteLength(rawContent) +
        Buffer.byteLength(html) +
        Buffer.byteLength(markdown) +
        Buffer.byteLength(text),
    );
  });

  test('binary result is charged for its data byteLength', () => {
    const data = new Uint8Array(4096);
    expect(calculateCacheSize(makeBinary(data))).toBe(4096);
  });

  test('binary result without data falls back to 1024 bytes', () => {
    expect(calculateCacheSize(makeBinary())).toBe(1024);
  });
});

function makeCached(overrides: Partial<CachedFetch>): CachedFetch {
  return {
    finalUrl: 'https://example.com/',
    statusCode: 200,
    contentType: 'text/plain',
    rawContent: '',
    markdown: '',
    text: '',
    html: '',
    extractedMain: false,
    usedLlmsTxt: false,
    sourceKind: 'text',
    upgradedToHttps: false,
    redirectChain: [],
    truncated: false,
    wordCount: 0,
    ...overrides,
  };
}

function makeBinary(data?: Uint8Array): BinaryFetch {
  return {
    finalUrl: 'https://example.com/file',
    statusCode: 200,
    contentType: 'application/pdf',
    redirectChain: [],
    upgradedToHttps: false,
    truncated: false,
    binary: true,
    binaryKind: 'pdf',
    data,
  };
}
