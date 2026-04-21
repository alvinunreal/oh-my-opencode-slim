import path from 'node:path';
import {
  BINARY_PREFIXES,
  DEFAULT_ACCEPT_LANGUAGE,
  DOCS_HOST_PREFIXES,
  DOCS_HOST_SUFFIXES,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from './constants';
import type {
  BinaryFetch,
  DecodedBody,
  FetchResult,
  FetchWithRedirectsResult,
  LlmsProbeResult,
} from './types';
import { trimBlankRuns } from './utils';

export function normalizeUrl(input: string) {
  const parsed = new URL(input);
  const originalUrl = parsed.toString();
  let upgradedToHttps = false;
  let fallbackUrl: string | undefined;
  if (parsed.protocol === 'http:') {
    fallbackUrl = originalUrl;
    parsed.protocol = 'https:';
    upgradedToHttps = true;
  }
  return { url: parsed.toString(), upgradedToHttps, fallbackUrl, originalUrl };
}

export function isDocsLikeUrl(url: URL) {
  const host = url.hostname.toLowerCase();
  return (
    DOCS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    DOCS_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))
  );
}

export function buildPermissionPatterns(
  normalized: ReturnType<typeof normalizeUrl>,
  shouldProbeLlmsTxt: boolean,
) {
  const patterns = new Set<string>([normalized.url]);
  const origins = [new URL(normalized.url).origin];
  if (normalized.fallbackUrl) {
    patterns.add(normalized.fallbackUrl);
    origins.push(new URL(normalized.fallbackUrl).origin);
  }
  if (shouldProbeLlmsTxt) {
    for (const origin of origins) {
      patterns.add(`${origin}/llms-full.txt`);
      patterns.add(`${origin}/llms.txt`);
    }
  }
  return [...patterns];
}

export function buildAllowedOrigins(patterns: string[]) {
  const origins = new Set<string>();
  for (const pattern of patterns) {
    try {
      origins.add(new URL(pattern).origin);
    } catch {
      // ignore invalid patterns
    }
  }
  return origins;
}

export function canUseCanonicalCacheAlias(baseUrl: string, aliasUrl: string) {
  try {
    const base = new URL(baseUrl);
    const alias = new URL(aliasUrl);
    if (alias.username || alias.password) return false;
    return (
      base.protocol === alias.protocol &&
      base.hostname === alias.hostname &&
      base.port === alias.port &&
      base.pathname === alias.pathname &&
      base.search === alias.search
    );
  } catch {
    return false;
  }
}

function isPermittedRedirect(
  from: string,
  to: string,
  allowedOrigins?: Set<string>,
) {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (a.protocol !== b.protocol) return false;
    if (a.port !== b.port) return false;
    if (b.username || b.password) return false;
    if (allowedOrigins) return allowedOrigins.has(b.origin);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

export function isBinaryContentType(contentType: string) {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
  return BINARY_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

export function getBinaryKind(contentType: string): BinaryFetch['binaryKind'] {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'binary';
}

function acceptHeader(_format: 'text' | 'markdown' | 'html') {
  return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/markdown;q=0.8, text/plain;q=0.8, */*;q=0.1';
}

function inferCharsetFromHtml(text: string) {
  const metaCharset = text.match(
    /<meta[^>]+charset\s*=\s*["']?([^\s"'>/;]+)/i,
  )?.[1];
  if (metaCharset) return metaCharset.trim();
  const httpEquiv = text.match(
    /<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]+content\s*=\s*["'][^"']*charset=([^\s"'>;]+)/i,
  )?.[1];
  if (httpEquiv) return httpEquiv.trim();
  return undefined;
}

export function looksLikeHtmlText(text: string) {
  return /^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(text);
}

function isLikelyDecodedText(text: string) {
  if (!text) return false;
  let suspicious = 0;
  let printable = 0;
  for (const char of text.slice(0, 2048)) {
    const code = char.charCodeAt(0);
    const isWhitespace =
      code === 9 || code === 10 || code === 13 || code === 32;
    const isControl = code < 32 && !isWhitespace;
    if (isControl) suspicious++;
    else printable++;
  }
  const total = Math.max(printable + suspicious, 1);
  return suspicious / total < 0.02 && printable / total > 0.85;
}

function tryDecodeWithCharset(data: Uint8Array, charset: string) {
  try {
    return new TextDecoder(
      charset,
      charset.toLowerCase() === 'utf-8' ? { fatal: true } : undefined,
    ).decode(data);
  } catch {
    return undefined;
  }
}

function detectBestEffortCharset(data: Uint8Array) {
  for (const charset of ['utf-8', 'windows-1252', 'iso-8859-1']) {
    const decoded = tryDecodeWithCharset(data, charset);
    if (decoded && isLikelyDecodedText(decoded)) {
      return { charset, text: decoded };
    }
  }
  return undefined;
}

export async function runWithScopedTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const abortHandler = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) controller.abort(parentSignal.reason);
  else parentSignal.addEventListener('abort', abortHandler, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abortHandler);
  }
}

export async function readBodyLimited(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
) {
  if (!response.body) return { data: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const allowed = maxBytes - total;
      if (allowed > 0) chunks.push(value.slice(0, allowed));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // ignore cancel failures
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data: merged, truncated };
}

export async function fetchWithRedirects(
  url: string,
  _timeoutMs: number,
  format: 'text' | 'markdown' | 'html',
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
  method: 'GET' | 'HEAD' = 'GET',
  allowedOrigins?: Set<string>,
): Promise<FetchWithRedirectsResult> {
  const redirects = [];
  let current = url;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      method,
      headers: {
        'User-Agent': 'opencode-smartfetch/1.0',
        Accept: acceptHeader(format),
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
        ...extraHeaders,
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(
          `Redirect response missing location header: ${response.status}`,
        );
      }
      const next = new URL(location, current).toString();
      redirects.push({ from: current, to: next, status: response.status });
      if (!isPermittedRedirect(current, next, allowedOrigins)) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore cancel failures
        }
        return {
          blockedRedirect: true,
          redirectUrl: next,
          statusCode: response.status,
          redirectChain: redirects,
        };
      }
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel failures
      }
      current = next;
      continue;
    }

    return { response, finalUrl: current, redirectChain: redirects };
  }

  throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
}

export async function fetchWithUpgradeFallback(
  normalized: ReturnType<typeof normalizeUrl>,
  timeoutMs: number,
  format: 'text' | 'markdown' | 'html',
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
  method: 'GET' | 'HEAD' = 'GET',
  allowedOrigins?: Set<string>,
) {
  try {
    const result = await fetchWithRedirects(
      normalized.url,
      timeoutMs,
      format,
      signal,
      extraHeaders,
      method,
      allowedOrigins,
    );
    if (normalized.fallbackUrl && 'blockedRedirect' in result) {
      const fallbackResult = await fetchWithRedirects(
        normalized.fallbackUrl,
        timeoutMs,
        format,
        signal,
        extraHeaders,
        method,
        allowedOrigins,
      );
      return { result: fallbackResult, upgradedToHttps: false };
    }
    if (
      normalized.fallbackUrl &&
      !('blockedRedirect' in result) &&
      result.response.status !== 304 &&
      !result.response.ok
    ) {
      const fallbackResult = await fetchWithRedirects(
        normalized.fallbackUrl,
        timeoutMs,
        format,
        signal,
        extraHeaders,
        method,
        allowedOrigins,
      );
      return { result: fallbackResult, upgradedToHttps: false };
    }
    return { result, upgradedToHttps: normalized.upgradedToHttps };
  } catch (error) {
    if (!normalized.fallbackUrl) throw error;
    const result = await fetchWithRedirects(
      normalized.fallbackUrl,
      timeoutMs,
      format,
      signal,
      extraHeaders,
      method,
      allowedOrigins,
    );
    return { result, upgradedToHttps: false };
  }
}

function parseContentLength(headers: Headers) {
  const raw = headers.get('content-length');
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseCharset(contentType: string) {
  const match = contentType.match(/charset\s*=\s*([^;]+)/i);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') || undefined;
}

export function isHtmlLikeContentType(contentType: string) {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

export function decodeBody(
  data: Uint8Array,
  charset: string | undefined,
  contentType?: string,
): DecodedBody {
  let declaredCharset = charset?.trim() || undefined;
  const utf8Text = new TextDecoder().decode(data);

  if (!declaredCharset && contentType && isHtmlLikeContentType(contentType)) {
    declaredCharset = inferCharsetFromHtml(utf8Text);
  }

  if (!declaredCharset) {
    const detected = detectBestEffortCharset(data);
    if (detected && detected.charset !== 'utf-8') {
      return {
        text: detected.text,
        decodedCharset: detected.charset,
        decodeFallback: true,
        decodeWarning: `Guessed charset without declaration: ${detected.charset}`,
      };
    }
    return {
      text: utf8Text,
      decodedCharset: 'utf-8',
      decodeFallback: false,
      decodeWarning: undefined,
    };
  }

  try {
    return {
      text: new TextDecoder(declaredCharset).decode(data),
      decodedCharset: declaredCharset,
      decodeFallback: false,
      decodeWarning: undefined,
    };
  } catch {
    return {
      text: utf8Text,
      decodedCharset: 'utf-8',
      decodeFallback: true,
      decodeWarning: `Unsupported charset decoder: ${declaredCharset}`,
    };
  }
}

export function looksLikeTextBody(data: Uint8Array) {
  if (!data.byteLength) return true;
  const sample = data.slice(0, Math.min(data.byteLength, 2048));
  if (detectBestEffortCharset(sample)) return true;

  let suspicious = 0;
  let printableAscii = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    const isWhitespace = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    if (isWhitespace || isPrintableAscii) printableAscii++;
    if (!isWhitespace && !isPrintableAscii) suspicious++;
  }
  return (
    suspicious / sample.byteLength < 0.02 &&
    printableAscii / sample.byteLength > 0.85
  );
}

export function isGenericBinaryMime(contentType: string) {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
  return mime === 'application/octet-stream';
}

function parseFilenameFromContentDisposition(value: string | null) {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // ignore invalid encoding
    }
  }
  const basic = value.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (basic?.[2]) return basic[2].trim();
  return undefined;
}

function inferFilenameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (!last?.includes('.')) return undefined;
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

function truncateFilename(name: string, maxLength = 180) {
  if (name.length <= maxLength) return name;
  const parsed = path.parse(name);
  const ext = parsed.ext || '';
  const baseLimit = Math.max(1, maxLength - ext.length);
  return `${parsed.name.slice(0, baseLimit)}${ext}`;
}

function sanitizeFilename(name: string) {
  let sanitized = Array.from(name, (char) => {
    const code = char.charCodeAt(0);
    if (code < 32 || '<>:"/\\|?*'.includes(char)) return '_';
    return char;
  }).join('');
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!sanitized) sanitized = 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return truncateFilename(sanitized);
}

export function extractHeaderMetadata(headers: Headers, finalUrl: string) {
  const filename =
    parseFilenameFromContentDisposition(headers.get('content-disposition')) ||
    inferFilenameFromUrl(finalUrl);
  const contentType = headers.get('content-type') || '';
  return {
    contentType: contentType || undefined,
    charset: parseCharset(contentType),
    etag: headers.get('etag') || undefined,
    lastModified: headers.get('last-modified') || undefined,
    contentLength: parseContentLength(headers),
    filename: filename ? sanitizeFilename(filename) : undefined,
  };
}

export function buildConditionalHeaders(cached: FetchResult | undefined) {
  if (!cached || (!cached.etag && !cached.lastModified)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  if (cached.etag) headers['If-None-Match'] = cached.etag;
  if (cached.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  return Object.keys(headers).length ? headers : undefined;
}

export async function probeLlmsText(
  url: URL,
  timeoutMs: number,
  signal: AbortSignal,
  fallbackOrigin?: string,
): Promise<LlmsProbeResult> {
  const origins = [`${url.protocol}//${url.host}`];
  if (fallbackOrigin && !origins.includes(fallbackOrigin)) {
    origins.push(fallbackOrigin);
  }
  const allowedOrigins = new Set(origins);
  let lastError: string | undefined;
  for (const candidate of origins.flatMap((origin) => [
    `${origin}/llms-full.txt`,
    `${origin}/llms.txt`,
  ])) {
    try {
      const result = await fetchWithRedirects(
        candidate,
        timeoutMs,
        'markdown',
        signal,
        {
          Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1',
        },
        'GET',
        allowedOrigins,
      );
      if ('blockedRedirect' in result) {
        lastError = `llms.txt probe blocked by cross-host redirect: ${result.redirectUrl}`;
        continue;
      }
      const { response, finalUrl, redirectChain } = result;
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore cancel failures
        }
        continue;
      }
      const headers = extractHeaderMetadata(response.headers, finalUrl);
      const body = await readBodyLimited(response, MAX_RESPONSE_BYTES);
      const decoded = decodeBody(
        body.data,
        headers.charset,
        headers.contentType,
      );
      const text = decoded.text;
      const finalPath = new URL(finalUrl).pathname.toLowerCase();
      const contentType = (headers.contentType || '').toLowerCase();
      const looksLikeLlmsPath =
        finalPath.endsWith('/llms.txt') || finalPath.endsWith('/llms-full.txt');
      const looksHtml =
        contentType.includes('text/html') ||
        contentType.includes('application/xhtml+xml');
      const looksLikeHtmlBody = /^\s*(<!doctype html|<html\b)/i.test(text);
      const looksLikeLoginWall =
        /<title>\s*(log in|sign in|login)\b/i.test(text) ||
        /\blog[ -]?in\b/i.test(finalUrl);
      if (!looksLikeLlmsPath) {
        lastError = `llms.txt probe resolved to non-llms path: ${finalUrl}`;
        continue;
      }
      if (looksHtml || looksLikeHtmlBody || looksLikeLoginWall) {
        lastError = `llms.txt probe returned HTML/login content: ${finalUrl}`;
        continue;
      }
      if (text.trim()) {
        return {
          url: finalUrl,
          statusCode: response.status,
          redirectChain,
          text: trimBlankRuns(text),
          headers,
          truncated: body.truncated,
          decodedCharset: decoded.decodedCharset,
          decodeFallback: decoded.decodeFallback,
          decodeWarning: decoded.decodeWarning,
          upgradedToHttps: candidate.startsWith('https://') && !!fallbackOrigin,
        };
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: lastError };
}
