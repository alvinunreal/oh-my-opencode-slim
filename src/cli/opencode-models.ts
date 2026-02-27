import { getEnv } from '../utils';
import { resolveNanoGptApiKeyFromOpenCodeFiles } from './provider-usage';
import { resolveOpenCodePath } from './system';
import type { DiscoveredModel, OpenCodeFreeModel } from './types';

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export interface ModelDiscoveryOptions {
  timeoutMs?: number;
  opencodePath?: string;
  spawnCommand?: typeof Bun.spawn;
  fetchImpl?: typeof fetch;
  nanogptApiKey?: string;
}

type NanoGptModelAccessMode = 'subscription' | 'paid' | 'visible';

interface OpenCodeModelVerboseRecord {
  id: string;
  providerID: string;
  name?: string;
  status?: 'alpha' | 'beta' | 'deprecated' | 'active';
  cost?: {
    input?: number;
    output?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  limit?: {
    context?: number;
    output?: number;
  };
  capabilities?: {
    reasoning?: boolean;
    toolcall?: boolean;
    attachment?: boolean;
  };
  quota?: {
    requestsPerDay?: number;
  };
  meta?: {
    requestsPerDay?: number;
    dailyLimit?: number;
  };
}

function normalizeProviderID(providerID: string): string {
  const lowered = providerID.toLowerCase();
  if (lowered === 'nano-gpt') return 'nanogpt';
  return lowered;
}

const NANOGPT_MODEL_ENDPOINTS: Record<NanoGptModelAccessMode, string> = {
  visible: 'https://nano-gpt.com/api/v1/models',
  subscription: 'https://nano-gpt.com/api/subscription/v1/models',
  paid: 'https://nano-gpt.com/api/paid/v1/models',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNanoGptModelID(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('nanogpt/')) {
    return trimmed.replace(/^nanogpt\//, '');
  }
  if (trimmed.startsWith('nano-gpt/')) {
    return trimmed.replace(/^nano-gpt\//, '');
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0) return undefined;
  const provider = trimmed.slice(0, slashIndex).toLowerCase();
  const remainder = trimmed.slice(slashIndex + 1);
  if (provider === 'nanogpt' || provider === 'nano-gpt') {
    return remainder || undefined;
  }

  return trimmed;
}

function extractNanoGptModelIDs(payload: unknown): string[] {
  const queue: unknown[] = [payload];
  const ids: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null) continue;

    if (typeof current === 'string') {
      const parsed = parseNanoGptModelID(current);
      if (parsed) ids.push(parsed);
      continue;
    }

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const objectValue = asRecord(current);
    if (!objectValue) continue;

    const direct =
      parseNanoGptModelID(objectValue.id) ??
      parseNanoGptModelID(objectValue.model) ??
      parseNanoGptModelID(objectValue.name);
    if (direct) ids.push(direct);

    for (const value of Object.values(objectValue)) {
      if (
        Array.isArray(value) ||
        (value && typeof value === 'object') ||
        typeof value === 'string'
      ) {
        queue.push(value);
      }
    }
  }

  return [...new Set(ids)];
}

function annotateNanoGptAccess(
  model: DiscoveredModel,
  access: NanoGptModelAccessMode,
): DiscoveredModel {
  if (model.providerID !== 'nanogpt') return model;
  return {
    ...model,
    nanoGptAccess: access,
  };
}

function isFreeModel(record: OpenCodeModelVerboseRecord): boolean {
  const inputCost = record.cost?.input ?? 0;
  const outputCost = record.cost?.output ?? 0;
  const cacheReadCost = record.cost?.cache?.read ?? 0;
  const cacheWriteCost = record.cost?.cache?.write ?? 0;

  return (
    inputCost === 0 &&
    outputCost === 0 &&
    cacheReadCost === 0 &&
    cacheWriteCost === 0
  );
}

function parseDailyRequestLimit(
  record: OpenCodeModelVerboseRecord,
): number | undefined {
  const explicitLimit =
    record.quota?.requestsPerDay ??
    record.meta?.requestsPerDay ??
    record.meta?.dailyLimit;

  if (typeof explicitLimit === 'number' && Number.isFinite(explicitLimit)) {
    return explicitLimit;
  }

  const source = `${record.id} ${record.name ?? ''}`.toLowerCase();
  const match = source.match(
    /\b(300|2000|5000)\b(?:\s*(?:req|requests|rpd|\/day))?/,
  );
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeDiscoveredModel(
  record: OpenCodeModelVerboseRecord,
  providerFilter?: string,
): DiscoveredModel | null {
  const normalizedProviderID = normalizeProviderID(record.providerID);
  const normalizedProviderFilter = providerFilter
    ? normalizeProviderID(providerFilter)
    : undefined;

  if (
    normalizedProviderFilter &&
    normalizedProviderID !== normalizedProviderFilter
  )
    return null;

  const fullModel = `${normalizedProviderID}/${record.id}`;

  return {
    providerID: normalizedProviderID,
    model: fullModel,
    name: record.name ?? record.id,
    status: record.status ?? 'active',
    contextLimit: record.limit?.context ?? 0,
    outputLimit: record.limit?.output ?? 0,
    reasoning: record.capabilities?.reasoning === true,
    toolcall: record.capabilities?.toolcall === true,
    attachment: record.capabilities?.attachment === true,
    dailyRequestLimit: parseDailyRequestLimit(record),
    costInput: record.cost?.input,
    costOutput: record.cost?.output,
  };
}

export function parseOpenCodeModelsVerboseOutput(
  output: string,
  providerFilter?: string,
  freeOnly = true,
): DiscoveredModel[] {
  const lines = output.split(/\r?\n/);
  const models: DiscoveredModel[] = [];
  const modelHeaderPattern = /^[a-z0-9-]+\/.+$/i;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line || !line.includes('/')) continue;

    if (!modelHeaderPattern.test(line)) continue;

    let jsonStart = -1;
    for (let search = index + 1; search < lines.length; search++) {
      if (lines[search]?.trim().startsWith('{')) {
        jsonStart = search;
        break;
      }

      if (modelHeaderPattern.test(lines[search]?.trim() ?? '')) {
        break;
      }
    }

    if (jsonStart === -1) continue;

    let braceDepth = 0;
    const jsonLines: string[] = [];
    let jsonEnd = -1;

    for (let cursor = jsonStart; cursor < lines.length; cursor++) {
      const current = lines[cursor] ?? '';
      jsonLines.push(current);

      for (const char of current) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }

      if (braceDepth === 0 && jsonLines.length > 0) {
        jsonEnd = cursor;
        break;
      }
    }

    if (jsonEnd === -1) continue;

    try {
      const parsed = JSON.parse(
        jsonLines.join('\n'),
      ) as OpenCodeModelVerboseRecord;
      const normalized = normalizeDiscoveredModel(parsed, providerFilter);
      if (!normalized) continue;
      if (freeOnly && !isFreeModel(parsed)) continue;
      if (normalized) models.push(normalized);
    } catch {
      // Ignore malformed blocks and continue parsing the next model.
    }

    index = jsonEnd;
  }

  return models;
}

async function discoverModelsByProvider(
  providerID?: string,
  freeOnly = true,
  options?: ModelDiscoveryOptions,
): Promise<{
  models: DiscoveredModel[];
  error?: string;
}> {
  try {
    const timeout = Math.max(
      100,
      options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    const opencodePath = options?.opencodePath ?? resolveOpenCodePath();
    const spawn = options?.spawnCommand ?? Bun.spawn;
    const proc = spawn([opencodePath, 'models', '--refresh', '--verbose'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        proc.kill();
        reject(new Error(`Model discovery timeout after ${timeout}ms`));
      }, timeout);
      proc.exited.finally(() => clearTimeout(id));
    });

    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return {
        models: [],
        error: stderr.trim() || 'Failed to fetch OpenCode models.',
      };
    }

    return {
      models: parseOpenCodeModelsVerboseOutput(stdout, providerID, freeOnly),
    };
  } catch (error) {
    return {
      models: [],
      error:
        error instanceof Error
          ? error.message
          : 'Unable to run `opencode models --refresh --verbose`.',
    };
  }
}

function resolveNanoGptApiKey(
  options?: ModelDiscoveryOptions,
): string | undefined {
  return (
    options?.nanogptApiKey ??
    resolveNanoGptApiKeyFromOpenCodeFiles() ??
    getEnv('NANOGPT_API_KEY') ??
    getEnv('NANO_GPT_API_KEY') ??
    getEnv('NANOGPT_KEY')
  );
}

async function fetchNanoGptModelIDs(input: {
  access: NanoGptModelAccessMode;
  options?: ModelDiscoveryOptions;
}): Promise<{ ids: string[]; error?: string }> {
  const apiKey = resolveNanoGptApiKey(input.options);
  if (!apiKey) {
    return {
      ids: [],
      error: 'NanoGPT API key not found for model endpoint discovery.',
    };
  }

  const fetchImpl = input.options?.fetchImpl ?? fetch;
  const url = NANOGPT_MODEL_ENDPOINTS[input.access];

  const authHeaders: Array<Record<string, string>> = [
    { Authorization: `Bearer ${apiKey}` },
    { 'x-api-key': apiKey },
  ];

  for (const headers of authHeaders) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as unknown;
      return { ids: extractNanoGptModelIDs(payload) };
    } catch {}
  }

  return {
    ids: [],
    error: `NanoGPT endpoint unavailable: ${url}`,
  };
}

async function discoverNanoGptModelsByAccess(input: {
  access: NanoGptModelAccessMode;
  options?: ModelDiscoveryOptions;
}): Promise<{ models: DiscoveredModel[]; error?: string }> {
  const [catalogResult, endpointResult] = await Promise.all([
    discoverModelsByProvider('nanogpt', false, input.options),
    fetchNanoGptModelIDs({
      access: input.access,
      options: input.options,
    }),
  ]);

  if (catalogResult.models.length === 0) {
    return {
      models: [],
      error: catalogResult.error ?? endpointResult.error,
    };
  }

  if (endpointResult.ids.length === 0) {
    return {
      models: [],
      error:
        endpointResult.error ??
        'NanoGPT endpoint returned no models for requested access mode.',
    };
  }

  const allowedIds = new Set(endpointResult.ids.map((id) => id.toLowerCase()));
  const filtered = catalogResult.models
    .filter((model) => {
      if (model.providerID !== 'nanogpt') return false;
      const id = model.model.replace(/^nanogpt\//, '').toLowerCase();
      return allowedIds.has(id);
    })
    .map((model) => annotateNanoGptAccess(model, input.access));

  return {
    models: filtered,
    error: filtered.length > 0 ? undefined : endpointResult.error,
  };
}

export async function discoverModelCatalog(
  options?: ModelDiscoveryOptions,
): Promise<{
  models: DiscoveredModel[];
  error?: string;
}> {
  try {
    const timeout = Math.max(
      100,
      options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    const opencodePath = options?.opencodePath ?? resolveOpenCodePath();
    const spawn = options?.spawnCommand ?? Bun.spawn;
    const proc = spawn([opencodePath, 'models', '--refresh', '--verbose'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(() => {
        proc.kill();
        reject(new Error(`Model discovery timeout after ${timeout}ms`));
      }, timeout);
      proc.exited.finally(() => clearTimeout(id));
    });

    const exitCode = await Promise.race([proc.exited, timeoutPromise]);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      return {
        models: [],
        error: stderr.trim() || 'Failed to fetch OpenCode models.',
      };
    }

    const parsedModels = parseOpenCodeModelsVerboseOutput(
      stdout,
      undefined,
      false,
    );

    if (!parsedModels.some((model) => model.providerID === 'nanogpt')) {
      return {
        models: parsedModels,
      };
    }

    const nanoGptAccessCatalog = await discoverNanoGptModelsByPolicy(
      'hybrid',
      options,
    );
    const subscriptionSet = new Set(
      nanoGptAccessCatalog.subscriptionModels.map((model) =>
        model.toLowerCase(),
      ),
    );
    const paidSet = new Set(
      nanoGptAccessCatalog.paidModels.map((model) => model.toLowerCase()),
    );

    const annotated = parsedModels.map((model) => {
      if (model.providerID !== 'nanogpt') return model;

      const key = model.model.toLowerCase();
      const inSubscription = subscriptionSet.has(key);
      const inPaid = paidSet.has(key);
      const access: DiscoveredModel['nanoGptAccess'] =
        inSubscription && inPaid
          ? 'visible'
          : inSubscription
            ? 'subscription'
            : inPaid
              ? 'paid'
              : undefined;
      if (!access) return model;

      return {
        ...model,
        nanoGptAccess: access,
      };
    });

    return {
      models: annotated,
    };
  } catch (error) {
    return {
      models: [],
      error:
        error instanceof Error
          ? error.message
          : 'Unable to run `opencode models --refresh --verbose`.',
    };
  }
}

export async function discoverOpenCodeFreeModels(
  options?: ModelDiscoveryOptions,
): Promise<{
  models: OpenCodeFreeModel[];
  error?: string;
}> {
  const result = await discoverModelsByProvider('opencode', true, options);
  return { models: result.models as OpenCodeFreeModel[], error: result.error };
}

export async function discoverProviderFreeModels(
  providerID: string,
  options?: ModelDiscoveryOptions,
): Promise<{
  models: OpenCodeFreeModel[];
  error?: string;
}> {
  const result = await discoverModelsByProvider(providerID, true, options);
  return { models: result.models as OpenCodeFreeModel[], error: result.error };
}

export async function discoverProviderModels(
  providerID: string,
  options?: ModelDiscoveryOptions,
): Promise<{
  models: DiscoveredModel[];
  error?: string;
}> {
  if (normalizeProviderID(providerID) === 'nanogpt') {
    return discoverNanoGptModelsByPolicy('hybrid', options);
  }

  return discoverModelsByProvider(providerID, false, options);
}

export async function discoverNanoGptModelsByPolicy(
  policy: 'subscription-only' | 'hybrid' | 'paygo-only',
  options?: ModelDiscoveryOptions,
): Promise<{
  models: DiscoveredModel[];
  subscriptionModels: string[];
  paidModels: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];

  const [subscriptionResult, paidResult] = await Promise.all([
    discoverNanoGptModelsByAccess({ access: 'subscription', options }),
    discoverNanoGptModelsByAccess({ access: 'paid', options }),
  ]);

  if (subscriptionResult.error) warnings.push(subscriptionResult.error);
  if (paidResult.error) warnings.push(paidResult.error);

  const subscriptionModels = subscriptionResult.models.map((m) => m.model);
  const paidModels = paidResult.models.map((m) => m.model);

  if (policy === 'subscription-only') {
    return {
      models: subscriptionResult.models,
      subscriptionModels,
      paidModels,
      warnings,
    };
  }

  if (policy === 'paygo-only') {
    return {
      models: paidResult.models,
      subscriptionModels,
      paidModels,
      warnings,
    };
  }

  const deduped = new Map<string, DiscoveredModel>();
  for (const model of subscriptionResult.models) {
    deduped.set(model.model, model);
  }
  for (const model of paidResult.models) {
    if (!deduped.has(model.model)) {
      deduped.set(model.model, model);
      continue;
    }

    const existing = deduped.get(model.model);
    if (existing) {
      deduped.set(model.model, {
        ...existing,
        nanoGptAccess: 'visible',
      });
    }
  }

  return {
    models: [...deduped.values()],
    subscriptionModels,
    paidModels,
    warnings,
  };
}
