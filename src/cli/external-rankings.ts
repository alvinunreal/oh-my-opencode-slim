import type { ExternalModelSignal, ExternalSignalMap } from './types';

interface ArtificialAnalysisResponse {
  data?: Array<{
    id?: string;
    name?: string;
    slug?: string;
    model_creator?: {
      slug?: string;
    };
    evaluations?: {
      artificial_analysis_intelligence_index?: number;
      artificial_analysis_coding_index?: number;
      livecodebench?: number;
    };
    pricing?: {
      price_1m_input_tokens?: number;
      price_1m_output_tokens?: number;
      price_1m_blended_3_to_1?: number;
    };
    median_time_to_first_token_seconds?: number;
  }>;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    pricing?: {
      prompt?: string;
      completion?: string;
    };
  }>;
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase();
}

function baseAliases(key: string): string[] {
  const normalized = normalizeKey(key);
  const aliases = new Set<string>([normalized]);
  const slashIndex = normalized.indexOf('/');
  const idPart =
    slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;

  aliases.add(idPart);
  aliases.add(idPart.replace(/-(free|flash)$/i, ''));

  return [...aliases];
}

function providerScopedAlias(alias: string, providerPrefix?: string): string {
  if (!providerPrefix || alias.includes('/')) return alias;
  return `${providerPrefix}/${alias}`;
}

function mergeSignal(
  existing: ExternalModelSignal | undefined,
  incoming: ExternalModelSignal,
): ExternalModelSignal {
  if (!existing) return incoming;

  return {
    qualityScore: incoming.qualityScore ?? existing.qualityScore,
    codingScore: incoming.codingScore ?? existing.codingScore,
    latencySeconds: incoming.latencySeconds ?? existing.latencySeconds,
    inputPricePer1M: incoming.inputPricePer1M ?? existing.inputPricePer1M,
    outputPricePer1M: incoming.outputPricePer1M ?? existing.outputPricePer1M,
    source: 'merged',
  };
}

function providerPrefixFromCreator(creatorSlug?: string): string | undefined {
  if (!creatorSlug) return undefined;
  const slug = creatorSlug.toLowerCase();
  if (slug.includes('openai')) return 'openai';
  if (slug.includes('anthropic')) return 'anthropic';
  if (slug.includes('google')) return 'google';
  if (slug.includes('chutes')) return 'chutes';
  if (slug.includes('copilot') || slug.includes('github'))
    return 'github-copilot';
  if (slug.includes('zai') || slug.includes('z-ai')) return 'zai-coding-plan';
  if (slug.includes('kimi')) return 'kimi-for-coding';
  if (slug.includes('opencode')) return 'opencode';
  return undefined;
}

function parseOpenRouterPrice(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed * 1_000_000;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

import { getEnv } from '../utils';

async function fetchArtificialAnalysisSignals(
  apiKey: string,
): Promise<ExternalSignalMap> {
  const response = await fetchJsonWithTimeout(
    'https://artificialanalysis.ai/api/v2/data/llms/models',
    {
      headers: {
        'x-api-key': apiKey,
      },
    },
    8000,
  );

  if (!response.ok) {
    throw new Error(
      `Artificial Analysis request failed (${response.status} ${response.statusText})`,
    );
  }

  const parsed = (await response.json()) as ArtificialAnalysisResponse;
  const map: ExternalSignalMap = {};

  for (const model of parsed.data ?? []) {
    const baseSignal: ExternalModelSignal = {
      qualityScore: model.evaluations?.artificial_analysis_intelligence_index,
      codingScore:
        model.evaluations?.artificial_analysis_coding_index ??
        model.evaluations?.livecodebench,
      latencySeconds: model.median_time_to_first_token_seconds,
      inputPricePer1M:
        model.pricing?.price_1m_input_tokens ??
        model.pricing?.price_1m_blended_3_to_1,
      outputPricePer1M:
        model.pricing?.price_1m_output_tokens ??
        model.pricing?.price_1m_blended_3_to_1,
      source: 'artificial-analysis',
    };

    const id = model.id ? normalizeKey(model.id) : undefined;
    const slug = model.slug ? normalizeKey(model.slug) : undefined;
    const name = model.name ? normalizeKey(model.name) : undefined;
    const providerPrefix = providerPrefixFromCreator(model.model_creator?.slug);

    for (const key of [id, slug, name]) {
      if (!key) continue;
      for (const alias of baseAliases(key)) {
        if (!providerPrefix || alias.includes('/')) {
          map[alias] = mergeSignal(map[alias], baseSignal);
        }

        const scopedAlias = providerScopedAlias(alias, providerPrefix);
        map[scopedAlias] = mergeSignal(map[scopedAlias], baseSignal);
      }
    }
  }

  return map;
}

async function fetchOpenRouterSignals(
  apiKey: string,
): Promise<ExternalSignalMap> {
  const response = await fetchJsonWithTimeout(
    'https://openrouter.ai/api/v1/models',
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    8000,
  );

  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed (${response.status} ${response.statusText})`,
    );
  }

  const parsed = (await response.json()) as OpenRouterModelsResponse;
  const map: ExternalSignalMap = {};

  for (const model of parsed.data ?? []) {
    if (!model.id) continue;
    const key = normalizeKey(model.id);
    const providerPrefix = key.split('/')[0];
    const signal: ExternalModelSignal = {
      inputPricePer1M: parseOpenRouterPrice(model.pricing?.prompt),
      outputPricePer1M: parseOpenRouterPrice(model.pricing?.completion),
      source: 'openrouter',
    };

    for (const alias of baseAliases(key)) {
      if (alias.includes('/')) {
        map[alias] = mergeSignal(map[alias], signal);
      }

      const scopedAlias = providerScopedAlias(alias, providerPrefix);
      map[scopedAlias] = mergeSignal(map[scopedAlias], signal);
    }
  }

  return map;
}

export async function fetchExternalModelSignals(options?: {
  artificialAnalysisApiKey?: string;
  openRouterApiKey?: string;
}): Promise<{
  signals: ExternalSignalMap;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const aggregate: ExternalSignalMap = {};

  const aaKey =
    options?.artificialAnalysisApiKey ?? getEnv('ARTIFICIAL_ANALYSIS_API_KEY');
  const orKey = options?.openRouterApiKey ?? getEnv('OPENROUTER_API_KEY');

  const aaPromise: Promise<ExternalSignalMap> = aaKey
    ? fetchArtificialAnalysisSignals(aaKey)
    : Promise.resolve({});
  const orPromise: Promise<ExternalSignalMap> = orKey
    ? fetchOpenRouterSignals(orKey)
    : Promise.resolve({});

  const [aaResult, orResult] = await Promise.allSettled([aaPromise, orPromise]);

  if (aaResult.status === 'fulfilled') {
    for (const [key, signal] of Object.entries(aaResult.value)) {
      aggregate[key] = mergeSignal(aggregate[key], signal);
    }
  } else if (aaKey) {
    warnings.push(
      `Artificial Analysis unavailable: ${aaResult.reason instanceof Error ? aaResult.reason.message : String(aaResult.reason)}`,
    );
  }

  if (orResult.status === 'fulfilled') {
    for (const [key, signal] of Object.entries(orResult.value)) {
      aggregate[key] = mergeSignal(aggregate[key], signal);
    }
  } else if (orKey) {
    warnings.push(
      `OpenRouter unavailable: ${orResult.reason instanceof Error ? orResult.reason.message : String(orResult.reason)}`,
    );
  }

  return { signals: aggregate, warnings };
}
