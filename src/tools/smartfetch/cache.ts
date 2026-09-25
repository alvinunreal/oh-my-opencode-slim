import { LRUCache } from 'lru-cache';
import type { FetchResult } from './types';

type CacheOptions = {
  format: 'text' | 'markdown' | 'html';
  extract_main: boolean;
  prefer_llms_txt: 'auto' | 'always' | 'never';
  save_binary: boolean;
};

export function calculateCacheSize(value: FetchResult): number {
  if ('binary' in value) return value.data?.byteLength ?? 1024;
  // llms.txt and plain-text pages point all four fields at the same
  // content, so charge bytes once per distinct string value.
  const refs = [value.rawContent, value.html, value.markdown, value.text];
  const seen = new Set<string>();
  let total = 0;
  for (const ref of refs) {
    if (typeof ref !== 'string' || seen.has(ref)) continue;
    seen.add(ref);
    total += Buffer.byteLength(ref);
  }
  return total;
}

export const CACHE = new LRUCache<string, FetchResult>({
  maxSize: 50 * 1024 * 1024,
  ttl: 15 * 60 * 1000,
  sizeCalculation: calculateCacheSize,
});

export function buildCacheKey(url: string, options: CacheOptions) {
  const parsed = new URL(url);
  // Fragments never reach the server (RFC 3986 §3.5); #sec1 and #sec2 are
  // the same document, so they must share one cache entry.
  parsed.hash = '';
  return JSON.stringify({
    url: parsed.toString(),
    format: options.format,
    extractMain: options.extract_main,
    preferLlmsTxt: options.prefer_llms_txt,
    saveBinary: options.save_binary,
  });
}
