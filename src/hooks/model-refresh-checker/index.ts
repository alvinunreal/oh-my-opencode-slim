import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  buildDynamicModelPlan,
  buildSmartRoutingPlanV3,
  detectCurrentConfig,
  discoverModelCatalog,
  discoverNanoGptModelsByPolicy,
  fetchExternalModelSignals,
  fetchProviderUsageSnapshot,
  filterCatalogToEnabledProviders,
  getExistingLiteConfigPath,
  parseConfig,
  writeConfig,
} from '../../cli/config-manager';
import { normalizeModelPreferences } from '../../cli/model-preferences';
import type {
  DynamicModelPlan,
  InstallConfig,
  OpenCodeConfig,
} from '../../cli/types';
import { log } from '../../utils/logger';
import {
  DEFAULT_REFRESH_INTERVAL_HOURS,
  MODEL_REFRESH_STATE_PATH,
} from './constants';
import type { ModelRefreshCheckerOptions, ModelRefreshState } from './types';

const AGENTS = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function shouldRunModelRefresh(input: {
  state: ModelRefreshState;
  nowMs: number;
  intervalMs: number;
}): boolean {
  const { state, nowMs, intervalMs } = input;
  if (!state.lastSuccessAt) return true;

  const lastSuccessMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) return true;
  return nowMs - lastSuccessMs >= intervalMs;
}

function readRefreshState(): ModelRefreshState {
  try {
    if (!existsSync(MODEL_REFRESH_STATE_PATH)) return {};
    const raw = readFileSync(MODEL_REFRESH_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ModelRefreshState;
    return typeof parsed.lastSuccessAt === 'string'
      ? { lastSuccessAt: parsed.lastSuccessAt }
      : {};
  } catch (error) {
    log('[model-refresh-checker] failed to read state:', error);
    return {};
  }
}

function writeRefreshState(state: ModelRefreshState): void {
  try {
    mkdirSync(dirname(MODEL_REFRESH_STATE_PATH), { recursive: true });
    writeFileSync(
      MODEL_REFRESH_STATE_PATH,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf-8',
    );
  } catch (error) {
    log('[model-refresh-checker] failed to write state:', error);
  }
}

function getActivePresetAgents(
  liteConfig: Record<string, unknown>,
): Record<string, unknown> {
  const presetName = liteConfig.preset;
  const presets = asRecord(liteConfig.presets);
  if (typeof presetName !== 'string' || !presets) return {};
  return asRecord(presets[presetName]) ?? {};
}

function inferOpenCodeFreeEnabled(input: {
  hasOpencodeZen: boolean;
  activePresetAgents: Record<string, unknown>;
}): boolean {
  if (!input.hasOpencodeZen) return false;

  const hasExplicitOpenCodeAgent = Object.values(input.activePresetAgents).some(
    (agentConfig) => {
      const model = asRecord(agentConfig)?.model;
      return (
        typeof model === 'string' &&
        model.startsWith('opencode/') &&
        model !== 'opencode/big-pickle'
      );
    },
  );

  return hasExplicitOpenCodeAgent;
}

function applyDynamicPlan(
  liteConfig: Record<string, unknown>,
  plan: DynamicModelPlan,
  activePresetAgents: Record<string, unknown>,
): { nextConfig: OpenCodeConfig; changedAgents: number } {
  const nextConfig: OpenCodeConfig = {
    ...(liteConfig as OpenCodeConfig),
  };

  const presets = asRecord(nextConfig.presets) ?? {};
  const dynamicPreset: Record<string, unknown> = {};
  let changedAgents = 0;

  for (const agentName of AGENTS) {
    const assignment = plan.agents[agentName];
    if (!assignment) continue;

    const previous = asRecord(activePresetAgents[agentName]) ?? {};
    const previousModel = previous.model;

    dynamicPreset[agentName] = {
      ...previous,
      model: assignment.model,
      variant:
        assignment.variant ??
        (typeof previous.variant === 'string' ? previous.variant : undefined),
    };

    if (previousModel !== assignment.model) {
      changedAgents += 1;
    }
  }

  presets.dynamic = dynamicPreset;
  nextConfig.presets = presets;
  nextConfig.preset = 'dynamic';
  nextConfig.fallback = {
    enabled: true,
    timeoutMs: 15000,
    chains: plan.chains,
  };

  return { nextConfig, changedAgents };
}

function showToast(
  ctx: PluginInput,
  title: string,
  message: string,
  variant: 'info' | 'success' | 'error' = 'info',
  duration = 3500,
): void {
  ctx.client.tui
    .showToast({
      body: { title, message, variant, duration },
    })
    .catch(() => {});
}

async function runBackgroundRefresh(
  ctx: PluginInput,
  options: Required<ModelRefreshCheckerOptions>,
): Promise<void> {
  if (!options.enabled) return;

  const nowMs = Date.now();
  const intervalMs = options.intervalHours * 60 * 60 * 1000;
  const state = readRefreshState();

  if (!shouldRunModelRefresh({ state, nowMs, intervalMs })) {
    return;
  }

  const detected = detectCurrentConfig();
  if (!detected.isInstalled) return;

  const liteConfigPath = getExistingLiteConfigPath();
  const parsedLite = parseConfig(liteConfigPath);
  if (parsedLite.error) {
    log('[model-refresh-checker] lite config parse failed:', parsedLite.error);
    return;
  }

  const liteConfig = asRecord(parsedLite.config);
  if (!liteConfig) return;

  if (liteConfig.preset === 'manual') {
    log('[model-refresh-checker] skipping refresh for manual preset');
    return;
  }

  const activePresetAgents = getActivePresetAgents(liteConfig);
  const modelPreferences =
    normalizeModelPreferences(liteConfig.modelPreferences) ??
    normalizeModelPreferences(liteConfig.model_preferences);
  const useOpenCodeFreeModels = inferOpenCodeFreeEnabled({
    hasOpencodeZen: detected.hasOpencodeZen,
    activePresetAgents,
  });

  const catalogDiscovery = await discoverModelCatalog();
  if (catalogDiscovery.models.length === 0) {
    log(
      '[model-refresh-checker] model catalog unavailable:',
      catalogDiscovery.error ?? 'no models returned',
    );
    return;
  }

  const { signals, warnings } = await fetchExternalModelSignals();
  for (const warning of warnings) {
    log('[model-refresh-checker]', warning);
  }

  const usageFetch = await fetchProviderUsageSnapshot();
  for (const warning of usageFetch.warnings) {
    log('[model-refresh-checker]', warning);
  }

  const fetchedNano = usageFetch.usage.nanogpt;
  const fetchedChutes = usageFetch.usage.chutes;
  const configuredNanoPolicy =
    liteConfig.nanoGptRoutingPolicy === 'paygo-only' ||
    liteConfig.nanoGptRoutingPolicy === 'hybrid' ||
    liteConfig.nanoGptRoutingPolicy === 'subscription-only'
      ? liteConfig.nanoGptRoutingPolicy
      : 'subscription-only';

  const nanoDiscovery = detected.hasNanoGpt
    ? await discoverNanoGptModelsByPolicy(configuredNanoPolicy)
    : {
        models: [],
        subscriptionModels: [],
        paidModels: [],
        warnings: [],
      };
  for (const warning of nanoDiscovery.warnings) {
    log('[model-refresh-checker]', warning);
  }
  const hasNanoGptForRun =
    detected.hasNanoGpt === true && nanoDiscovery.models.length > 0;

  const refreshConfig: InstallConfig = {
    hasKimi: detected.hasKimi,
    hasOpenAI: detected.hasOpenAI,
    hasAnthropic: detected.hasAnthropic ?? false,
    hasCopilot: detected.hasCopilot ?? false,
    hasZaiPlan: detected.hasZaiPlan ?? false,
    hasAntigravity: detected.hasAntigravity,
    hasChutes: detected.hasChutes ?? false,
    hasNanoGpt: hasNanoGptForRun,
    hasOpencodeZen: true,
    useOpenCodeFreeModels,
    balanceProviderUsage: liteConfig.balanceProviderUsage === true,
    preferredModelsByAgent: modelPreferences,
    nanoGptRoutingPolicy: hasNanoGptForRun ? configuredNanoPolicy : undefined,
    availableNanoGptModels:
      nanoDiscovery.models.length > 0 ? nanoDiscovery.models : undefined,
    nanoGptSubscriptionModels:
      nanoDiscovery.subscriptionModels.length > 0
        ? nanoDiscovery.subscriptionModels
        : undefined,
    nanoGptPaidModels:
      nanoDiscovery.paidModels.length > 0
        ? nanoDiscovery.paidModels
        : undefined,
    nanoGptDailyBudget: fetchedNano?.dailyLimit,
    nanoGptMonthlyBudget: fetchedNano?.monthlyLimit,
    nanoGptMonthlyUsed: fetchedNano?.monthlyUsed,
    chutesPacingMode: detected.hasChutes ? 'balanced' : undefined,
    chutesMonthlyBudget: fetchedChutes?.monthlyLimit,
    chutesMonthlyUsed: fetchedChutes?.monthlyUsed,
    hasTmux: false,
    installSkills: false,
    installCustomSkills: false,
    setupMode: 'quick',
    modelsOnly: true,
  };

  const providerScopedCatalog = filterCatalogToEnabledProviders(
    catalogDiscovery.models,
    refreshConfig,
  );

  if (providerScopedCatalog.length === 0) {
    log('[model-refresh-checker] no models available for selected providers');
    return;
  }

  const dynamicPlan = buildDynamicModelPlan(
    providerScopedCatalog,
    refreshConfig,
    signals,
  );

  const selectedPolicy = refreshConfig.hasNanoGpt
    ? (refreshConfig.nanoGptRoutingPolicy ?? 'subscription-only')
    : 'hybrid';

  const smartV3Enabled =
    refreshConfig.hasNanoGpt === true &&
    (selectedPolicy === 'subscription-only' || selectedPolicy === 'paygo-only');

  const v3Plan = smartV3Enabled
    ? buildSmartRoutingPlanV3({
        catalog: providerScopedCatalog,
        policy: {
          mode: selectedPolicy,
          subscriptionBudget: {
            dailyRequests: refreshConfig.nanoGptDailyBudget,
            monthlyRequests: refreshConfig.nanoGptMonthlyBudget,
            enforcement: 'soft',
          },
        },
        quotaStatus: {
          dailyRemaining:
            fetchedNano?.dailyRemaining ??
            refreshConfig.nanoGptDailyBudget ??
            999,
          monthlyRemaining:
            fetchedNano?.monthlyRemaining ??
            refreshConfig.nanoGptMonthlyBudget ??
            9_999,
          lastCheckedAt: new Date(),
        },
        chutesPacing:
          refreshConfig.hasChutes && refreshConfig.chutesPacingMode
            ? {
                mode: refreshConfig.chutesPacingMode,
                monthlyBudget: refreshConfig.chutesMonthlyBudget,
                monthlyUsed: refreshConfig.chutesMonthlyUsed,
              }
            : undefined,
        modelPreferences: refreshConfig.preferredModelsByAgent,
      })
    : null;

  const planToApply = v3Plan?.plan ?? dynamicPlan;
  if (!planToApply) {
    log('[model-refresh-checker] planner returned no assignments');
    return;
  }

  const { nextConfig, changedAgents } = applyDynamicPlan(
    liteConfig,
    planToApply,
    activePresetAgents,
  );

  writeConfig(liteConfigPath, nextConfig);
  writeRefreshState({ lastSuccessAt: new Date(nowMs).toISOString() });

  if (options.showToast) {
    if (changedAgents > 0) {
      showToast(
        ctx,
        'Model refresh complete',
        `${changedAgents} agent model${changedAgents === 1 ? '' : 's'} updated.`,
        'success',
      );
    } else {
      showToast(
        ctx,
        'Model refresh complete',
        'Model assignments already up to date.',
      );
    }
  }
}

export function createModelRefreshCheckerHook(
  ctx: PluginInput,
  options: ModelRefreshCheckerOptions = {},
) {
  const normalizedOptions: Required<ModelRefreshCheckerOptions> = {
    enabled: options.enabled ?? true,
    intervalHours: options.intervalHours ?? DEFAULT_REFRESH_INTERVAL_HOURS,
    showToast: options.showToast ?? false,
  };

  let hasChecked = false;

  return {
    event: ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type !== 'session.created') return;
      if (hasChecked) return;

      const props = event.properties as
        | { info?: { parentID?: string } }
        | undefined;
      if (props?.info?.parentID) return;

      hasChecked = true;

      setTimeout(() => {
        runBackgroundRefresh(ctx, normalizedOptions).catch((error) => {
          log('[model-refresh-checker] background refresh failed:', error);
        });
      }, 0);
    },
  };
}

export type { ModelRefreshCheckerOptions } from './types';
