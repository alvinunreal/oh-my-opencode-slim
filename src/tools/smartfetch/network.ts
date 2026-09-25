import path from 'node:path';
import { fitUtf8 } from './binary';
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
  FetchWithRedirectsResult,
  LlmsProbeResult,
} from './types';
import { trimBlankRuns } from './utils';

export function normalizeUrl(input: string): {
  url: string;
  upgradedToHttps: boolean;
  fallbackUrl: string | undefined;
} {
  const parsed = new URL(input);
  let upgradedToHttps = false;
  let fallbackUrl: string | undefined;
  if (parsed.protocol === 'http:') {
    fallbackUrl = parsed.toString();
    parsed.protocol = 'https:';
    upgradedToHttps = true;
  }
  // Fragments never reach the server (RFC 3986 §3.5); strip them from the
  // URLs actually fetched so the same document requested with different
  // anchors issues a single request. The caller retains the requested URL.
  parsed.hash = '';
  if (fallbackUrl) {
    const fallback = new URL(fallbackUrl);
    fallback.hash = '';
    fallbackUrl = fallback.toString();
  }
  return { url: parsed.toString(), upgradedToHttps, fallbackUrl };
}

export function isDocsLikeUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    DOCS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    DOCS_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))
  );
}

export function buildPermissionPatterns(
  normalized: ReturnType<typeof normalizeUrl>,
  shouldProbeLlmsTxt: boolean,
): string[] {
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

function isPermittedRedirect(from: string, to: string) {
  try {
    const a = new URL(from);
    const b = new URL(to);
    return a.origin === b.origin && !b.username && !b.password;
  } catch {
    return false;
  }
}

function mimeOf(contentType: string) {
  return contentType.split(';')[0]?.trim().toLowerCase() || '';
}

export function isBinaryContentType(contentType: string) {
  return BINARY_PREFIXES.some((prefix) =>
    mimeOf(contentType).startsWith(prefix),
  );
}

export function getBinaryKind(contentType: string): BinaryFetch['binaryKind'] {
  const mime = mimeOf(contentType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'binary';
}

const ACCEPT_HEADER =
  'text/html;q=1.0, application/xhtml+xml;q=0.9, text/markdown;q=0.8, text/plain;q=0.8, */*;q=0.1';
export const ACCEPT_BY_FORMAT = {
  markdown:
    'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7, */*;q=0.1',
  text: 'text/plain, text/markdown;q=0.9, text/html;q=0.8, application/xhtml+xml;q=0.7, */*;q=0.1',
  html: ACCEPT_HEADER,
} as const;

function inferCharsetFromHtml(text: string) {
  const metaCharset = text.match(
    /<meta[^<>]+charset\s*=\s*["']?([^\s"'>/;]+)/i,
  )?.[1];
  if (metaCharset) return metaCharset.trim();
  const httpEquiv = text.match(
    /<meta[^<>]+http-equiv\s*=\s*["']content-type["'][^<>]+content\s*=\s*["'][^"']*charset=([^\s"'>;]+)/i,
  )?.[1];
  if (httpEquiv) return httpEquiv.trim();
  return undefined;
}

export function looksLikeHtmlText(text: string) {
  return /^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(text);
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
      if (allowed > 0) {
        chunks.push(value.slice(0, allowed));
        total += allowed;
      }
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

  return { data: Buffer.concat(chunks, total), truncated };
}

export async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // A failed cancellation must not mask the fetch result.
  }
}

export async function fetchWithRedirects(
  url: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<FetchWithRedirectsResult> {
  const redirects = [];
  let current = url;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'opencode-smartfetch/1.0',
        Accept: ACCEPT_HEADER,
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
        ...extraHeaders,
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        await discard(response);
        throw new Error(
          `Redirect response missing location header: ${response.status}`,
        );
      }
      if (!URL.canParse(location, current)) {
        await discard(response);
        throw new Error(`Invalid redirect location: ${location}`);
      }
      const next = new URL(location, current).toString();
      redirects.push({ from: current, to: next, status: response.status });
      if (!isPermittedRedirect(current, next)) {
        await discard(response);
        return {
          blockedRedirect: true,
          redirectUrl: next,
          statusCode: response.status,
          redirectChain: redirects,
        };
      }
      await discard(response);
      current = next;
      continue;
    }

    return { response, finalUrl: current, redirectChain: redirects };
  }

  throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
}

export async function fetchWithUpgradeFallback(
  normalized: ReturnType<typeof normalizeUrl>,
  signal: AbortSignal,
  requestHeaders?: Record<string, string>,
) {
  let primary: FetchWithRedirectsResult;
  try {
    primary = await fetchWithRedirects(normalized.url, signal, requestHeaders);
  } catch (error) {
    if (!normalized.fallbackUrl || signal.aborted) throw error;
    const result = await fetchWithRedirects(
      normalized.fallbackUrl,
      signal,
      requestHeaders,
    );
    return { result, upgradedToHttps: false };
  }
  if (
    !normalized.fallbackUrl ||
    (!('blockedRedirect' in primary) &&
      (primary.response.ok || primary.response.status === 304))
  ) {
    return { result: primary, upgradedToHttps: normalized.upgradedToHttps };
  }
  if (!('blockedRedirect' in primary)) await discard(primary.response);
  try {
    const result = await fetchWithRedirects(
      normalized.fallbackUrl,
      signal,
      requestHeaders,
    );
    if (
      'blockedRedirect' in primary &&
      ('blockedRedirect' in result || !result.response.ok)
    ) {
      if (!('blockedRedirect' in result)) await discard(result.response);
      return { result: primary, upgradedToHttps: normalized.upgradedToHttps };
    }
    return { result, upgradedToHttps: false };
  } catch (error) {
    if (!('blockedRedirect' in primary) || signal.aborted) throw error;
    return { result: primary, upgradedToHttps: normalized.upgradedToHttps };
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
  const mime = mimeOf(contentType);
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

export function decodeBody(
  data: Uint8Array,
  charset: string | undefined,
  contentType?: string,
): DecodedBody {
  let declaredCharset = charset?.trim() || undefined;
  if (!declaredCharset && contentType && isHtmlLikeContentType(contentType)) {
    declaredCharset = inferCharsetFromHtml(
      new TextDecoder().decode(data.subarray(0, 2048)),
    );
  }

  if (!declaredCharset) {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(data),
        decodedCharset: 'utf-8',
        decodeFallback: false,
        decodeWarning: undefined,
      };
    } catch {
      return {
        text: new TextDecoder('windows-1252').decode(data),
        decodedCharset: 'windows-1252',
        decodeFallback: true,
        decodeWarning: 'Guessed charset without declaration: windows-1252',
      };
    }
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
      text: new TextDecoder().decode(data),
      decodedCharset: 'utf-8',
      decodeFallback: true,
      decodeWarning: `Unsupported charset decoder: ${declaredCharset}`,
    };
  }
}

export function looksLikeTextBody(data: Uint8Array) {
  if (!data.byteLength) return true;
  if (data.includes(0)) return false;
  const sample = data.subarray(0, Math.min(data.byteLength, 2048));
  let controls = 0;
  for (const byte of sample) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls++;
  }
  return controls / sample.byteLength < 0.02;
}

export function isGenericBinaryMime(contentType: string) {
  return mimeOf(contentType) === 'application/octet-stream';
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
  if (name.length <= maxLength && Buffer.byteLength(name) <= 255) return name;
  const parsed = path.parse(name);
  const ext = Buffer.byteLength(parsed.ext) <= 255 ? parsed.ext : '';
  return `${fitUtf8(ext ? parsed.name : name, 255 - Buffer.byteLength(ext), maxLength - ext.length)}${ext}`;
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

export async function probeLlmsText(
  url: URL,
  signal: AbortSignal,
  fallbackOrigin?: string,
): Promise<LlmsProbeResult> {
  const origins = [`${url.protocol}//${url.host}`];
  if (fallbackOrigin && !origins.includes(fallbackOrigin)) {
    origins.push(fallbackOrigin);
  }
  let lastError: string | undefined;
  for (const candidate of origins.flatMap((origin) => [
    `${origin}/llms-full.txt`,
    `${origin}/llms.txt`,
  ])) {
    try {
      const result = await fetchWithRedirects(candidate, signal, {
        Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1',
      });
      if ('blockedRedirect' in result) {
        lastError = `llms.txt probe blocked by cross-host redirect: ${result.redirectUrl}`;
        continue;
      }
      const { response, finalUrl, redirectChain } = result;
      if (!response.ok) {
        await discard(response);
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
      const looksLikeLoginWall = /<title>\s*(log in|sign in|login)\b/i.test(
        text,
      );
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
