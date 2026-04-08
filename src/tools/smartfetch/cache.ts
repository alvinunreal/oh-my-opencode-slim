import { LRUCache } from 'lru-cache';
import { canUseCanonicalCacheAlias, isHtmlLikeContentType } from './network';
import type { FetchResult } from './types';

export const CACHE = new LRUCache<string, FetchResult>({
  maxSize: 50 * 1024 * 1024,
  ttl: 15 * 60 * 1000,
  sizeCalculation: (value) => {
    if ('binary' in value) return value.data?.byteLength ?? 1024;
    const rawContent =
      value.rawContent ?? value.html ?? value.markdown ?? value.text ?? '';
    return (
      Buffer.byteLength(rawContent) +
      Buffer.byteLength(value.html) +
      Buffer.byteLength(value.markdown) +
      Buffer.byteLength(value.text)
    );
  },
});

export function buildCacheKey(
  url: string,
  extractMain: boolean,
  preferLlmsTxt: 'auto' | 'always' | 'never',
  saveBinary: boolean,
) {
  const parsed = new URL(url);
  return JSON.stringify({
    url: parsed.toString(),
    extractMain,
    preferLlmsTxt,
    saveBinary,
  });
}

function cacheKeysFor(
  fetchResult: FetchResult,
  extractMain: boolean,
  preferLlmsTxt: 'auto' | 'always' | 'never',
  saveBinary: boolean,
) {
  const keys = new Set<string>();
  keys.add(
    buildCacheKey(
      fetchResult.requestedUrl,
      extractMain,
      preferLlmsTxt,
      saveBinary,
    ),
  );
  keys.add(
    buildCacheKey(fetchResult.finalUrl, extractMain, preferLlmsTxt, saveBinary),
  );
  if (
    fetchResult.canonicalUrl &&
    canUseCanonicalCacheAlias(fetchResult.finalUrl, fetchResult.canonicalUrl)
  ) {
    keys.add(
      buildCacheKey(
        fetchResult.canonicalUrl,
        extractMain,
        preferLlmsTxt,
        saveBinary,
      ),
    );
  }
  return [...keys];
}

export function cacheFetchResult(
  fetchResult: FetchResult,
  extractMain: boolean,
  preferLlmsTxt: 'auto' | 'always' | 'never',
  saveBinary: boolean,
) {
  for (const key of cacheKeysFor(
    fetchResult,
    extractMain,
    preferLlmsTxt,
    saveBinary,
  )) {
    CACHE.set(key, fetchResult);
  }
}

export function isInvalidLlmsResult(fetchResult: FetchResult | undefined) {
  if (!fetchResult || 'binary' in fetchResult) return false;
  if (!fetchResult.usedLlmsTxt || fetchResult.sourceKind !== 'llms_txt') {
    return false;
  }
  const finalPath = (() => {
    try {
      return new URL(fetchResult.finalUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (
    !(finalPath.endsWith('/llms.txt') || finalPath.endsWith('/llms-full.txt'))
  ) {
    return true;
  }
  if (isHtmlLikeContentType(fetchResult.contentType)) return true;
  if (/^\s*(<!doctype html|<html\b)/i.test(fetchResult.rawContent)) return true;
  if (
    /<title>\s*(log in|sign in|login)\b/i.test(fetchResult.rawContent) ||
    /\blog[ -]?in\b/i.test(fetchResult.finalUrl)
  ) {
    return true;
  }
  return false;
}
