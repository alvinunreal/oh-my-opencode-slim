import { describe, expect, test } from 'bun:test';
import { buildCacheKey } from './cache';

describe('smartfetch/cache', () => {
  test('includes save_binary but not format in the cache key', () => {
    const markdownKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      false,
    );
    const htmlKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      false,
    );
    const binaryKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      true,
    );

    expect(markdownKey).toBe(htmlKey);
    expect(markdownKey).not.toBe(binaryKey);
    expect(JSON.parse(markdownKey)).toMatchObject({
      saveBinary: false,
    });
    expect(JSON.parse(binaryKey)).toMatchObject({
      saveBinary: true,
    });
  });
});
