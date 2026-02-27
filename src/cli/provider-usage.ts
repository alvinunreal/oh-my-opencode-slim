import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv } from '../utils';
import {
  getConfigDir,
  getDataDir,
  getOpenCodeAuthPaths,
  getOpenCodeConfigPaths,
} from './paths';

export interface ProviderUsageCounters {
  dailyUsed?: number;
  dailyLimit?: number;
  dailyRemaining?: number;
  monthlyUsed?: number;
  monthlyLimit?: number;
  monthlyRemaining?: number;
  weeklyUsed?: number;
  weeklyLimit?: number;
  weeklyRemaining?: number;
}

export interface ProviderUsageSnapshot {
  nanogpt?: ProviderUsageCounters;
  chutes?: ProviderUsageCounters;
}

export interface ChutesDailyUsage {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  amount: number;
  buckets: string[];
  monthRequests: number;
  monthInputTokens: number;
  monthOutputTokens: number;
  monthAmount: number;
}

interface FetchUsageOptions {
  nanogptApiKey?: string;
  chutesApiKey?: string;
  nanogptUsageUrl?: string;
  chutesUsageUrl?: string;
  includeNanogpt?: boolean;
  includeChutes?: boolean;
  openCodeConfigDir?: string;
  openCodeDataDir?: string;
}

type AuthScheme = 'authorization-key' | 'bearer' | 'x-api-key';

const NANOGPT_ENDPOINTS = ['https://nano-gpt.com/api/subscription/v1/usage'];

const CHUTES_ENDPOINTS = ['https://api.chutes.ai/users/me/quotas'];

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function stripJsonComments(json: string): string {
  const commentPattern = /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g;
  const trailingCommaPattern = /\\"|"(?:\\"|[^"])*"|(,)(\s*[}\]])/g;

  return json
    .replace(commentPattern, (match, commentGroup) =>
      commentGroup ? '' : match,
    )
    .replace(trailingCommaPattern, (match, comma, closing) =>
      comma ? closing : match,
    );
}

function parseJsonLikeFile(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return undefined;

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return JSON.parse(stripJsonComments(content)) as unknown;
  }
}

function isPlaceholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    lowered.includes('your_') ||
    lowered.includes('your-api-key') ||
    lowered.includes('<api') ||
    lowered.includes('changeme') ||
    lowered.includes('example')
  );
}

function resolveEnvReference(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;

  if (/^\$[A-Z0-9_]+$/i.test(value)) {
    return getEnv(value.slice(1));
  }
  if (/^\$\{[A-Z0-9_]+\}$/i.test(value)) {
    return getEnv(value.slice(2, -1));
  }
  if (/^env:[A-Z0-9_]+$/i.test(value)) {
    return getEnv(value.slice(4));
  }
  if (/^process\.env\.[A-Z0-9_]+$/i.test(value)) {
    return getEnv(value.replace(/^process\.env\./i, ''));
  }

  return undefined;
}

function normalizeApiKeyValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || isPlaceholder(trimmed)) return undefined;

  const fromEnv = resolveEnvReference(trimmed);
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }

  if (trimmed.length < 8) return undefined;
  return trimmed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getByPathCaseInsensitive(
  root: unknown,
  path: readonly string[],
): unknown {
  let cursor: unknown = root;

  for (const segment of path) {
    if (!isObject(cursor)) return undefined;
    const foundKey = Object.keys(cursor).find(
      (key) => key.toLowerCase() === segment.toLowerCase(),
    );
    if (!foundKey) return undefined;
    cursor = cursor[foundKey];
  }

  return cursor;
}

function extractKeyFromObject(objectValue: unknown): string | undefined {
  if (!isObject(objectValue)) return undefined;

  for (const keyName of [
    'apiKey',
    'api_key',
    'key',
    'token',
    'accessToken',
    'access_token',
    'bearerToken',
  ]) {
    const value = getByPathCaseInsensitive(objectValue, [keyName]);
    if (typeof value !== 'string') continue;
    const normalized = normalizeApiKeyValue(value);
    if (normalized) return normalized;
  }

  return undefined;
}

function extractNanoGptApiKeyFromPayload(payload: unknown): string | undefined {
  const scopedPaths: Array<readonly string[]> = [
    ['provider', 'nanogpt'],
    ['provider', 'nano-gpt'],
    ['provider', 'nano_gpt'],
    ['providers', 'nanogpt'],
    ['providers', 'nano-gpt'],
    ['providers', 'nano_gpt'],
    ['auth', 'nanogpt'],
    ['auth', 'nano-gpt'],
    ['auth', 'nano_gpt'],
    ['credentials', 'nanogpt'],
    ['credentials', 'nano-gpt'],
    ['credentials', 'nano_gpt'],
    ['keys', 'nanogpt'],
    ['keys', 'nano-gpt'],
    ['keys', 'nano_gpt'],
    ['nanogpt'],
    ['nano-gpt'],
    ['nano_gpt'],
  ];

  for (const path of scopedPaths) {
    const scoped = getByPathCaseInsensitive(payload, path);
    const direct = extractKeyFromObject(scoped);
    if (direct) return direct;
  }

  if (!isObject(payload)) return undefined;

  const queue: Array<{ path: string[]; value: unknown }> = [
    {
      path: [],
      value: payload,
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current.value === 'string') {
      const pathJoined = current.path.join('.').toLowerCase();
      const lastKey =
        current.path[current.path.length - 1]?.toLowerCase() ?? '';
      const inNanoGptBranch = /nano[-_]?gpt/.test(pathJoined);
      const keyLike =
        /api[_-]?key|access[_-]?token|token|secret|key/.test(lastKey) ||
        lastKey === 'nanogpt_api_key' ||
        lastKey === 'nanogptapikey' ||
        lastKey === 'nano_gpt_api_key' ||
        lastKey === 'nano-gpt-api-key';
      if (inNanoGptBranch && keyLike) {
        const normalized = normalizeApiKeyValue(current.value);
        if (normalized) return normalized;
      }
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        queue.push({
          path: current.path,
          value: item,
        });
      }
      continue;
    }

    if (isObject(current.value)) {
      for (const [key, value] of Object.entries(current.value)) {
        queue.push({
          path: [...current.path, key],
          value,
        });
      }
    }
  }

  return undefined;
}

export function resolveNanoGptApiKeyFromOpenCodeFiles(input?: {
  openCodeConfigDir?: string;
  openCodeDataDir?: string;
}): string | undefined {
  const configDir = input?.openCodeConfigDir ?? getConfigDir();
  const dataDir = input?.openCodeDataDir ?? getDataDir();
  const configPaths =
    input?.openCodeConfigDir != null
      ? [join(configDir, 'opencode.json'), join(configDir, 'opencode.jsonc')]
      : getOpenCodeConfigPaths();
  const authPaths =
    input?.openCodeConfigDir != null || input?.openCodeDataDir != null
      ? [
          join(dataDir, 'auth.json'),
          join(dataDir, 'auth.jsonc'),
          join(configDir, 'auth.json'),
          join(configDir, 'auth.jsonc'),
        ]
      : getOpenCodeAuthPaths();

  for (const filePath of [...authPaths, ...configPaths]) {
    try {
      const parsed = parseJsonLikeFile(filePath);
      const key = extractNanoGptApiKeyFromPayload(parsed);
      if (key) return key;
    } catch {}
  }

  return undefined;
}

function getAtPath(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function pickNumber(
  root: unknown,
  paths: ReadonlyArray<readonly string[]>,
): number | undefined {
  for (const path of paths) {
    const value = asNumber(getAtPath(root, path));
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function hasAnyCounter(counters: ProviderUsageCounters): boolean {
  return Object.values(counters).some((value) => typeof value === 'number');
}

export function extractUsageCountersFromPayload(
  payload: unknown,
): ProviderUsageCounters {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') continue;
      const quota = asNumber((item as Record<string, unknown>).quota);
      if (typeof quota === 'number') {
        return {
          monthlyLimit: quota,
        };
      }
    }
  }

  const roots: unknown[] = [payload];

  const data = getAtPath(payload, ['data']);
  const result = getAtPath(payload, ['result']);
  const usage = getAtPath(payload, ['usage']);
  const quota = getAtPath(payload, ['quota']);

  if (data !== undefined) roots.push(data);
  if (result !== undefined) roots.push(result);
  if (usage !== undefined) roots.push(usage);
  if (quota !== undefined) roots.push(quota);

  for (const root of roots) {
    const counters: ProviderUsageCounters = {
      weeklyUsed: pickNumber(root, [
        ['weeklyUsed'],
        ['weekly_used'],
        ['weekly', 'used'],
        ['usage', 'weekly', 'used'],
        ['requests', 'weekly', 'used'],
        ['weeklyInputTokens', 'used'],
      ]),
      weeklyLimit: pickNumber(root, [
        ['weeklyLimit'],
        ['weekly_limit'],
        ['weekly', 'limit'],
        ['usage', 'weekly', 'limit'],
        ['requests', 'weekly', 'limit'],
        ['limits', 'weeklyInputTokens'],
        ['weeklyInputTokens', 'limit'],
      ]),
      weeklyRemaining: pickNumber(root, [
        ['weeklyRemaining'],
        ['weekly_remaining'],
        ['weekly', 'remaining'],
        ['usage', 'weekly', 'remaining'],
        ['requests', 'weekly', 'remaining'],
        ['weeklyInputTokens', 'remaining'],
      ]),
      dailyUsed: pickNumber(root, [
        ['dailyUsed'],
        ['daily_used'],
        ['daily', 'used'],
        ['usage', 'daily', 'used'],
        ['requests', 'daily', 'used'],
        ['stats', 'daily', 'used'],
      ]),
      dailyLimit: pickNumber(root, [
        ['dailyLimit'],
        ['daily_limit'],
        ['limits', 'daily'],
        ['daily', 'limit'],
        ['usage', 'daily', 'limit'],
        ['requests', 'daily', 'limit'],
        ['stats', 'daily', 'limit'],
      ]),
      dailyRemaining: pickNumber(root, [
        ['dailyRemaining'],
        ['daily_remaining'],
        ['daily', 'remaining'],
        ['usage', 'daily', 'remaining'],
        ['requests', 'daily', 'remaining'],
        ['stats', 'daily', 'remaining'],
      ]),
      monthlyUsed: pickNumber(root, [
        ['monthlyUsed'],
        ['monthly_used'],
        ['monthly', 'used'],
        ['usage', 'monthly', 'used'],
        ['requests', 'monthly', 'used'],
        ['stats', 'monthly', 'used'],
        ['credits', 'monthly', 'used'],
        ['credits', 'used'],
      ]),
      monthlyLimit: pickNumber(root, [
        ['monthlyLimit'],
        ['monthly_limit'],
        ['limits', 'monthly'],
        ['monthly', 'limit'],
        ['usage', 'monthly', 'limit'],
        ['requests', 'monthly', 'limit'],
        ['stats', 'monthly', 'limit'],
        ['credits', 'monthly', 'limit'],
        ['credits', 'total'],
      ]),
      monthlyRemaining: pickNumber(root, [
        ['monthlyRemaining'],
        ['monthly_remaining'],
        ['monthly', 'remaining'],
        ['usage', 'monthly', 'remaining'],
        ['requests', 'monthly', 'remaining'],
        ['stats', 'monthly', 'remaining'],
        ['credits', 'monthly', 'remaining'],
        ['credits', 'remaining'],
      ]),
    };

    if (typeof counters.dailyUsed !== 'number') {
      counters.dailyUsed = counters.weeklyUsed;
    }
    if (typeof counters.dailyLimit !== 'number') {
      counters.dailyLimit = counters.weeklyLimit;
    }
    if (typeof counters.dailyRemaining !== 'number') {
      counters.dailyRemaining = counters.weeklyRemaining;
    }
    if (typeof counters.monthlyUsed !== 'number') {
      counters.monthlyUsed = counters.weeklyUsed;
    }
    if (typeof counters.monthlyLimit !== 'number') {
      counters.monthlyLimit = counters.weeklyLimit;
    }
    if (typeof counters.monthlyRemaining !== 'number') {
      counters.monthlyRemaining = counters.weeklyRemaining;
    }

    if (hasAnyCounter(counters)) {
      return counters;
    }
  }

  return {};
}

function mergeDerivedCounters(
  counters: ProviderUsageCounters,
): ProviderUsageCounters {
  const merged: ProviderUsageCounters = {
    ...counters,
  };

  if (
    typeof merged.weeklyRemaining !== 'number' &&
    typeof merged.weeklyLimit === 'number' &&
    typeof merged.weeklyUsed === 'number'
  ) {
    merged.weeklyRemaining = Math.max(
      0,
      merged.weeklyLimit - merged.weeklyUsed,
    );
  }

  if (
    typeof merged.weeklyUsed !== 'number' &&
    typeof merged.weeklyLimit === 'number' &&
    typeof merged.weeklyRemaining === 'number'
  ) {
    merged.weeklyUsed = Math.max(
      0,
      merged.weeklyLimit - merged.weeklyRemaining,
    );
  }

  if (
    typeof merged.dailyRemaining !== 'number' &&
    typeof merged.dailyLimit === 'number' &&
    typeof merged.dailyUsed === 'number'
  ) {
    merged.dailyRemaining = Math.max(0, merged.dailyLimit - merged.dailyUsed);
  }

  if (
    typeof merged.monthlyRemaining !== 'number' &&
    typeof merged.monthlyLimit === 'number' &&
    typeof merged.monthlyUsed === 'number'
  ) {
    merged.monthlyRemaining = Math.max(
      0,
      merged.monthlyLimit - merged.monthlyUsed,
    );
  }

  if (
    typeof merged.monthlyUsed !== 'number' &&
    typeof merged.monthlyLimit === 'number' &&
    typeof merged.monthlyRemaining === 'number'
  ) {
    merged.monthlyUsed = Math.max(
      0,
      merged.monthlyLimit - merged.monthlyRemaining,
    );
  }

  if (typeof merged.dailyUsed !== 'number') {
    merged.dailyUsed = merged.weeklyUsed;
  }
  if (typeof merged.dailyLimit !== 'number') {
    merged.dailyLimit = merged.weeklyLimit;
  }
  if (typeof merged.dailyRemaining !== 'number') {
    merged.dailyRemaining = merged.weeklyRemaining;
  }
  if (typeof merged.monthlyUsed !== 'number') {
    merged.monthlyUsed = merged.weeklyUsed;
  }
  if (typeof merged.monthlyLimit !== 'number') {
    merged.monthlyLimit = merged.weeklyLimit;
  }
  if (typeof merged.monthlyRemaining !== 'number') {
    merged.monthlyRemaining = merged.weeklyRemaining;
  }

  return merged;
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(key: string, scheme: AuthScheme): Record<string, string> {
  if (scheme === 'authorization-key') {
    return { Authorization: key };
  }
  if (scheme === 'bearer') {
    return { Authorization: `Bearer ${key}` };
  }
  return { 'x-api-key': key };
}

async function fetchProviderCounters(input: {
  providerName: 'NanoGPT' | 'Chutes';
  apiKey?: string;
  explicitUrl?: string;
  endpoints: string[];
  authSchemes: AuthScheme[];
}): Promise<{ counters?: ProviderUsageCounters; warning?: string }> {
  if (!input.apiKey) {
    return {
      warning: `${input.providerName} usage fetch skipped: API key not set.`,
    };
  }

  const endpoints = input.explicitUrl
    ? [input.explicitUrl]
    : [...input.endpoints];
  let lastError: string | undefined;

  for (const endpoint of endpoints) {
    for (const scheme of input.authSchemes) {
      try {
        const response = await fetchJsonWithTimeout(
          endpoint,
          authHeaders(input.apiKey, scheme),
          8_000,
        );

        if (!response.ok) {
          lastError = `${response.status} ${response.statusText}`;
          continue;
        }

        const payload = (await response.json()) as unknown;
        const counters = mergeDerivedCounters(
          extractUsageCountersFromPayload(payload),
        );

        if (hasAnyCounter(counters)) {
          return {
            counters,
          };
        }

        lastError = 'response did not include recognizable usage counters';
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return {
    warning: `${input.providerName} usage unavailable: ${lastError ?? 'request failed'}`,
  };
}

type ProviderCounterFetchResult = {
  counters?: ProviderUsageCounters;
  warning?: string;
};

async function fetchChutesQuotasPayload(input: {
  apiKey: string;
  explicitUrl?: string;
}): Promise<unknown> {
  const endpoint = input.explicitUrl ?? CHUTES_ENDPOINTS[0];
  let lastError: string | undefined;

  for (const scheme of ['authorization-key', 'bearer', 'x-api-key'] as const) {
    try {
      const response = await fetchJsonWithTimeout(
        endpoint,
        authHeaders(input.apiKey, scheme),
        8_000,
      );

      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`;
        continue;
      }

      return (await response.json()) as unknown;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastError ?? 'request failed');
}

function extractChutesUserId(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) return undefined;
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const userId = asString((item as Record<string, unknown>).user_id);
    if (userId) return userId;
  }
  return undefined;
}

function asInteger(value: unknown, fallback: number): number {
  const numberValue = asNumber(value);
  if (typeof numberValue !== 'number') return fallback;
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.floor(numberValue));
}

function datePrefixIso(inputDate?: Date): string {
  const source = inputDate ?? new Date();
  const year = source.getUTCFullYear();
  const month = `${source.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${source.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function fetchChutesDailyUsage(input?: {
  apiKey?: string;
  quotaUrl?: string;
  dayUtc?: Date;
}): Promise<{ usage?: ChutesDailyUsage; warning?: string }> {
  const apiKey =
    input?.apiKey ??
    getEnv('CHUTES_API_KEY') ??
    getEnv('CHUTESAI_API_KEY') ??
    getEnv('CHUTES_KEY');

  if (!apiKey) {
    return {
      warning: 'Chutes daily usage skipped: API key not set.',
    };
  }

  try {
    const quotaPayload = await fetchChutesQuotasPayload({
      apiKey,
      explicitUrl: input?.quotaUrl ?? getEnv('CHUTES_USAGE_URL'),
    });

    const userId = extractChutesUserId(quotaPayload);
    if (!userId) {
      return {
        warning:
          'Chutes daily usage unavailable: could not determine user_id from quotas response.',
      };
    }

    const todayPrefix = datePrefixIso(input?.dayUtc);
    const monthPrefix = todayPrefix.slice(0, 7);
    const baseUrl = `https://api.chutes.ai/users/${userId}/usage`;
    const firstPage = await fetchJsonWithTimeout(
      `${baseUrl}?page=0&limit=24`,
      authHeaders(apiKey, 'authorization-key'),
      8_000,
    );

    let firstPayload: unknown;
    if (firstPage.ok) {
      firstPayload = (await firstPage.json()) as unknown;
    } else {
      const fallback = await fetchJsonWithTimeout(
        `${baseUrl}?page=0&limit=24`,
        authHeaders(apiKey, 'bearer'),
        8_000,
      );
      if (!fallback.ok) {
        return {
          warning: `Chutes daily usage unavailable: ${fallback.status} ${fallback.statusText}`,
        };
      }
      firstPayload = (await fallback.json()) as unknown;
    }

    if (!firstPayload || typeof firstPayload !== 'object') {
      return {
        warning:
          'Chutes daily usage unavailable: invalid usage response shape.',
      };
    }

    const first = firstPayload as Record<string, unknown>;
    const total = asInteger(first.total, 0);
    const limit = Math.max(1, asInteger(first.limit, 24));
    const pages = Math.max(1, Math.ceil(total / limit));
    const allItems: Array<Record<string, unknown>> = [];

    const appendItems = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const items = (payload as Record<string, unknown>).items;
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (item && typeof item === 'object') {
          allItems.push(item as Record<string, unknown>);
        }
      }
    };

    appendItems(firstPayload);

    for (let page = 1; page < pages; page++) {
      const response = await fetchJsonWithTimeout(
        `${baseUrl}?page=${page}&limit=${limit}`,
        authHeaders(apiKey, 'authorization-key'),
        8_000,
      );
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      appendItems(payload);

      if (payload && typeof payload === 'object') {
        const items = (payload as Record<string, unknown>).items;
        if (Array.isArray(items) && items.length > 0) {
          const hasCurrentMonth = items.some((item) => {
            if (!item || typeof item !== 'object') return false;
            const bucket = asString((item as Record<string, unknown>).bucket);
            return typeof bucket === 'string' && bucket.startsWith(monthPrefix);
          });
          if (!hasCurrentMonth) {
            break;
          }
        }
      }
    }

    const todayItems = allItems.filter((item) => {
      const bucket = asString(item.bucket) ?? '';
      return bucket.startsWith(todayPrefix);
    });

    const usage: ChutesDailyUsage = {
      date: todayPrefix,
      requests: todayItems.reduce(
        (sum, item) => sum + asInteger(item.count, 0),
        0,
      ),
      inputTokens: todayItems.reduce(
        (sum, item) => sum + asInteger(item.input_tokens, 0),
        0,
      ),
      outputTokens: todayItems.reduce(
        (sum, item) => sum + asInteger(item.output_tokens, 0),
        0,
      ),
      amount: todayItems.reduce(
        (sum, item) => sum + (asNumber(item.amount) ?? 0),
        0,
      ),
      buckets: todayItems
        .map((item) => asString(item.bucket))
        .filter((value): value is string => typeof value === 'string'),
      monthRequests: allItems.reduce((sum, item) => {
        const bucket = asString(item.bucket) ?? '';
        if (!bucket.startsWith(monthPrefix)) return sum;
        return sum + asInteger(item.count, 0);
      }, 0),
      monthInputTokens: allItems.reduce((sum, item) => {
        const bucket = asString(item.bucket) ?? '';
        if (!bucket.startsWith(monthPrefix)) return sum;
        return sum + asInteger(item.input_tokens, 0);
      }, 0),
      monthOutputTokens: allItems.reduce((sum, item) => {
        const bucket = asString(item.bucket) ?? '';
        if (!bucket.startsWith(monthPrefix)) return sum;
        return sum + asInteger(item.output_tokens, 0);
      }, 0),
      monthAmount: allItems.reduce((sum, item) => {
        const bucket = asString(item.bucket) ?? '';
        if (!bucket.startsWith(monthPrefix)) return sum;
        return sum + (asNumber(item.amount) ?? 0);
      }, 0),
    };

    return { usage };
  } catch (error) {
    return {
      warning: `Chutes daily usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function fetchProviderUsageSnapshot(
  options?: FetchUsageOptions,
): Promise<{
  usage: ProviderUsageSnapshot;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const includeNanogpt = options?.includeNanogpt ?? true;
  const includeChutes = options?.includeChutes ?? true;

  const nanogptFileKey = includeNanogpt
    ? resolveNanoGptApiKeyFromOpenCodeFiles({
        openCodeConfigDir: options?.openCodeConfigDir,
        openCodeDataDir: options?.openCodeDataDir,
      })
    : undefined;

  const nanogptKey = includeNanogpt
    ? (options?.nanogptApiKey ??
      nanogptFileKey ??
      getEnv('NANOGPT_API_KEY') ??
      getEnv('NANO_GPT_API_KEY') ??
      getEnv('NANOGPT_KEY'))
    : undefined;

  const chutesKey = includeChutes
    ? (options?.chutesApiKey ??
      getEnv('CHUTES_API_KEY') ??
      getEnv('CHUTESAI_API_KEY') ??
      getEnv('CHUTES_KEY'))
    : undefined;

  const [nanogpt, chutes] = await Promise.all<ProviderCounterFetchResult>([
    includeNanogpt
      ? fetchProviderCounters({
          providerName: 'NanoGPT',
          apiKey: nanogptKey,
          explicitUrl: options?.nanogptUsageUrl ?? getEnv('NANOGPT_USAGE_URL'),
          endpoints: NANOGPT_ENDPOINTS,
          authSchemes: ['bearer', 'x-api-key'],
        })
      : Promise.resolve<ProviderCounterFetchResult>({}),
    includeChutes
      ? fetchProviderCounters({
          providerName: 'Chutes',
          apiKey: chutesKey,
          explicitUrl: options?.chutesUsageUrl ?? getEnv('CHUTES_USAGE_URL'),
          endpoints: CHUTES_ENDPOINTS,
          authSchemes: ['authorization-key', 'bearer', 'x-api-key'],
        })
      : Promise.resolve<ProviderCounterFetchResult>({}),
  ]);

  if (nanogpt.warning) warnings.push(nanogpt.warning);
  if (chutes.warning) warnings.push(chutes.warning);

  return {
    usage: {
      nanogpt: nanogpt.counters,
      chutes: chutes.counters,
    },
    warnings,
  };
}
