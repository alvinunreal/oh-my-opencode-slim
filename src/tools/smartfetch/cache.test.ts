import { describe, expect, test } from 'bun:test';
import { buildCacheKey } from './cache';

describe('smartfetch/cache', () => {
  test('includes format and save_binary in the cache key', () => {
    const markdownKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      'markdown',
      false,
    );
    const htmlKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      'html',
      false,
    );
    const binaryKey = buildCacheKey(
      'https://example.com/docs',
      true,
      'auto',
      'markdown',
      true,
    );

    expect(markdownKey).not.toBe(htmlKey);
    expect(markdownKey).not.toBe(binaryKey);
    expect(JSON.parse(markdownKey)).toMatchObject({
      format: 'markdown',
      saveBinary: false,
    });
    expect(JSON.parse(htmlKey)).toMatchObject({
      format: 'html',
      saveBinary: false,
    });
    expect(JSON.parse(binaryKey)).toMatchObject({
      format: 'markdown',
      saveBinary: true,
    });
  });
});
