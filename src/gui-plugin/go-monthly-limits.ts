import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GoMonthlyLimitRow, GoMonthlyLimits } from './rpc';

export const GO_MONTHLY_LIMITS_URL = 'https://opencode.ai/docs/console/go/';
const TTL = 24 * 60 * 60 * 1000;
const BACKOFF = 6 * 60 * 60 * 1000;
const MAX_BYTES = 256 * 1024;
const TIMEOUT = 5000;
const MAX_ROWS = 256;
const space = (value: string) => value.replace(/\s+/g, ' ').trim();
const isCap = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 200 &&
  /^(?:\$\d[\d,]*(?:\.\d+)?|Unlimited(?:\s+[^<>\r\n]+)?)$/.test(value);

function cell(value: string): string {
  return space(
    value
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<\/?small>/gi, '')
      .replace(/`|\*\*/g, ''),
  );
}

function modelLabel(value: string): string {
  let label = cell(value);
  // Only these published suffixes are aliases. Never infer model IDs or versions.
  const qualifier =
    /\s*\((?:Peak|Off-Peak|[≤>]\s*[^()]+\s+tokens|\d+(?:\.\d+)?% off)\)$/;
  while (qualifier.test(label)) label = label.replace(qualifier, '').trim();
  return label;
}

function table(block: string, header: string[]): string[][] {
  const lines = block.split(/\r?\n/).map((line) => line.trim());
  const split = (line: string) => line.slice(1, -1).split('|').map(cell);
  const starts = lines.flatMap((line, index) =>
    line.startsWith('|') &&
    line.endsWith('|') &&
    JSON.stringify(split(line)) === JSON.stringify(header)
      ? [index]
      : [],
  );
  if (starts.length !== 1)
    throw new Error('Missing or ambiguous published table');
  const start = starts[0]!;
  const separator = lines[start + 1];
  if (
    !separator ||
    !/^\|[\s:|-]+\|$/.test(separator) ||
    split(separator).length !== header.length
  ) {
    throw new Error('Invalid table separator');
  }
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.startsWith('|'); i++) {
    const line = lines[i]!;
    const row = split(line);
    if (
      !line.endsWith('|') ||
      row.length !== header.length ||
      row.some((value) => !value)
    )
      throw new Error('Malformed table row');
    rows.push(row);
  }
  if (!rows.length || rows.length > MAX_ROWS)
    throw new Error('Invalid table size');
  return rows;
}

/** Parse only the published pricing tabs, joined to exact endpoint labels. */
export function parseGoMonthlyLimits(markdown: string): GoMonthlyLimitRow[] {
  if (Buffer.byteLength(markdown) > MAX_BYTES)
    throw new Error('Oversized pricing document');
  const pricing = [
    ...markdown.matchAll(/<PlanTabs\b([^>]*)>([\s\S]*?)<\/PlanTabs>/g),
  ].filter((match) => /\bid=["']go-pricing["']/.test(match[1]!));
  if (pricing.length !== 1) throw new Error('Missing published pricing tabs');
  const endpoints = markdown.match(
    /^## Endpoints\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m,
  );
  if (!endpoints) throw new Error('Missing endpoints section');
  const ids = new Map<string, string>();
  for (const [label, id] of table(endpoints[1]!, [
    'Model',
    'Model ID',
    'Endpoint',
    'AI SDK Package',
  ])) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(id!) ||
      (ids.has(label!) && ids.get(label!) !== id)
    ) {
      throw new Error('Conflicting endpoint mapping');
    }
    ids.set(label!, id!);
  }
  const plans: Map<string, string>[] = [];
  for (const plan of ['go', 'go-plus', 'go-teams']) {
    const slots = [
      ...pricing[0]![2]!.matchAll(
        /<div\s+slot=["']([^"']+)["']\s*>([\s\S]*?)<\/div>/g,
      ),
    ].filter((match) => match[1] === plan);
    if (slots.length !== 1) throw new Error('Missing plan');
    const caps = new Map<string, string>();
    for (const row of table(slots[0]![2]!, [
      'Model',
      'Input',
      'Output',
      'Cached Read',
      'Cached Write',
      'Monthly limit',
    ])) {
      const id = ids.get(modelLabel(row[0]!));
      const cap = row[5]!;
      if (!id || !isCap(cap)) {
        throw new Error('Unknown model or monthly limit');
      }
      if (caps.has(id) && caps.get(id) !== cap)
        throw new Error('Conflicting monthly limits');
      caps.set(id, cap);
    }
    plans.push(caps);
  }
  const [go, plus, teams] = plans as [
    Map<string, string>,
    Map<string, string>,
    Map<string, string>,
  ];
  if (
    go.size !== plus.size ||
    go.size !== teams.size ||
    [...go.keys()].some((id) => !plus.has(id) || !teams.has(id))
  ) {
    throw new Error('Incomplete plan coverage');
  }
  return [...go].map(([modelID, cap]) => ({
    modelID,
    go: cap,
    goPlus: plus.get(modelID)!,
    goTeams: teams.get(modelID)!,
  }));
}

interface Cache {
  version: 1;
  rows: GoMonthlyLimitRow[];
  updatedAt?: number;
  retryAt: number;
  etag?: string;
  lastModified?: string;
}

function validCache(value: unknown, now: number): value is Cache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Cache;
  const timestamp = (n: unknown) =>
    typeof n === 'number' &&
    Number.isSafeInteger(n) &&
    n >= 946684800000 &&
    n <= now;
  const header = (s: unknown) =>
    s === undefined ||
    (typeof s === 'string' && s.length <= 1024 && !/[\r\n]/.test(s));
  if (
    cache.version !== 1 ||
    !Array.isArray(cache.rows) ||
    cache.rows.length > MAX_ROWS ||
    !Number.isSafeInteger(cache.retryAt) ||
    cache.retryAt < 0 ||
    cache.retryAt > now + BACKOFF ||
    !header(cache.etag) ||
    !header(cache.lastModified)
  )
    return false;
  if (
    cache.rows.length
      ? !timestamp(cache.updatedAt)
      : cache.updatedAt !== undefined
  )
    return false;
  const ids = new Set<string>();
  return cache.rows.every((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.modelID !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(row.modelID) ||
      ids.has(row.modelID)
    )
      return false;
    ids.add(row.modelID);
    return [row.go, row.goPlus, row.goTeams].every(isCap);
  });
}

async function readBody(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_BYTES)
    throw new Error('Oversized response');
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('Oversized response');
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Construction is inert: disk and network are first touched by the picker RPC. */
export function createGoMonthlyLimitsService(
  options: {
    now?: () => number;
    fetch?: typeof globalThis.fetch;
    cachePath?: string;
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
  } = {},
) {
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? globalThis.fetch;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const cachePath =
    options.cachePath ??
    join(
      process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
      'opencode',
      'omos-gui',
      'go-monthly-limits.json',
    );
  let cache: Cache = { version: 1, rows: [], retryAt: 0 };
  let loaded: Promise<void> | undefined;
  let inFlight: Promise<void> | undefined;

  async function load() {
    try {
      const file = await open(cachePath, 'r');
      try {
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) return;
        const parsed: unknown = JSON.parse(
          buffer.subarray(0, bytesRead).toString('utf8'),
        );
        if (validCache(parsed, now())) cache = parsed;
      } finally {
        await file.close();
      }
    } catch {
      /* Missing, corrupt, or inaccessible cache is not fatal. */
    }
  }

  async function save() {
    const temp = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(temp, JSON.stringify(cache), { flag: 'wx', mode: 0o600 });
      await rename(temp, cachePath);
    } catch {
      /* Memory cache still works on read-only filesystems. */
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async function refresh() {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const headers: Record<string, string> = {
          Accept: 'text/markdown',
          'User-Agent': 'omos-gui/go-monthly-limits',
        };
        if (cache.rows.length && cache.etag)
          headers['If-None-Match'] = cache.etag;
        if (cache.rows.length && cache.lastModified)
          headers['If-Modified-Since'] = cache.lastModified;
        const response = await fetcher(GO_MONTHLY_LIMITS_URL, {
          headers,
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.status === 304 && cache.rows.length)
          return { ...cache, updatedAt: now(), retryAt: 0 };
        if (
          response.status !== 200 ||
          !/^(text\/markdown|text\/plain)(?:\s*;|$)/i.test(
            response.headers.get('content-type') ?? '',
          )
        ) {
          void response.body?.cancel().catch(() => {});
          throw new Error('Unexpected pricing response');
        }
        const rows = parseGoMonthlyLimits(await readBody(response));
        return {
          version: 1 as const,
          rows,
          updatedAt: now(),
          retryAt: 0,
          etag: response.headers.get('etag') ?? undefined,
          lastModified: response.headers.get('last-modified') ?? undefined,
        };
      };
      cache = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = schedule(() => {
            controller.abort();
            reject(new Error('Pricing request timed out'));
          }, TIMEOUT);
        }),
      ]);
    } catch {
      cache = { ...cache, retryAt: now() + BACKOFF };
    } finally {
      if (timer) cancel(timer);
      controller.abort();
    }
    await save();
  }

  return {
    /** Test-only seam: await a background refresh (including its cache write). */
    async waitForIdle(): Promise<void> {
      if (loaded) await loaded;
      if (inFlight) await inFlight;
    },

    async getGoMonthlyLimits(): Promise<GoMonthlyLimits> {
      if (!loaded) loaded = load();
      await loaded;
      const fresh =
        cache.updatedAt !== undefined && now() - cache.updatedAt < TTL;
      if (!fresh && now() >= cache.retryAt) {
        inFlight ??= refresh()
          .catch(() => {})
          .finally(() => {
            inFlight = undefined;
          });
        if (!cache.rows.length) await inFlight;
      }
      return {
        status: cache.rows.length
          ? cache.updatedAt !== undefined && now() - cache.updatedAt < TTL
            ? 'fresh'
            : 'stale'
          : 'unavailable',
        sourceURL: GO_MONTHLY_LIMITS_URL,
        ...(cache.updatedAt === undefined
          ? {}
          : { updatedAt: new Date(cache.updatedAt).toISOString() }),
        rows: cache.rows.map((row) => ({ ...row })),
      };
    },
  };
}
