import {
  fetchChutesDailyUsage,
  fetchProviderUsageSnapshot,
} from './provider-usage';

type UsageProvider = 'nanogpt' | 'chutes' | 'both';
type PaceStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

interface UsageCommandOptions {
  provider: UsageProvider;
  json: boolean;
}

interface PaceInsight {
  status: PaceStatus;
  utilizationPct?: number;
  projectedMonthEnd?: number;
  recommendedDailyMax?: number;
  reason: string;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function monthMetaUtc(now = new Date()): {
  elapsedDays: number;
  totalDays: number;
  remainingDays: number;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const elapsedDays = now.getUTCDate();
  const totalDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const remainingDays = Math.max(1, totalDays - elapsedDays);
  return {
    elapsedDays,
    totalDays,
    remainingDays,
  };
}

function buildPaceInsight(input: {
  used?: number;
  remaining?: number;
  limit?: number;
}): PaceInsight {
  const limit = input.limit;
  const used = input.used;
  const remaining = input.remaining;

  if (typeof limit !== 'number' || limit <= 0) {
    return {
      status: 'unknown',
      reason: 'No monthly limit available.',
    };
  }

  const { elapsedDays, totalDays, remainingDays } = monthMetaUtc();
  const safeUsed = typeof used === 'number' ? Math.max(0, used) : undefined;
  const safeRemaining =
    typeof remaining === 'number'
      ? Math.max(0, remaining)
      : safeUsed !== undefined
        ? Math.max(0, limit - safeUsed)
        : undefined;

  const utilizationPct =
    safeUsed !== undefined ? round((safeUsed / limit) * 100) : undefined;
  const projectedMonthEnd =
    safeUsed !== undefined
      ? round((safeUsed / Math.max(1, elapsedDays)) * totalDays)
      : undefined;
  const recommendedDailyMax =
    safeRemaining !== undefined
      ? round(safeRemaining / remainingDays)
      : undefined;

  if (safeRemaining !== undefined && safeRemaining <= 0) {
    return {
      status: 'critical',
      utilizationPct,
      projectedMonthEnd,
      recommendedDailyMax,
      reason: 'Monthly allowance exhausted.',
    };
  }

  if (
    projectedMonthEnd !== undefined &&
    (projectedMonthEnd > limit * 1.05 || (safeRemaining ?? limit) < limit * 0.1)
  ) {
    return {
      status: 'critical',
      utilizationPct,
      projectedMonthEnd,
      recommendedDailyMax,
      reason: 'Current pace likely exceeds monthly allowance.',
    };
  }

  if (
    projectedMonthEnd !== undefined &&
    (projectedMonthEnd > limit * 0.9 || (safeRemaining ?? limit) < limit * 0.25)
  ) {
    return {
      status: 'warning',
      utilizationPct,
      projectedMonthEnd,
      recommendedDailyMax,
      reason: 'Pace is close to monthly allowance.',
    };
  }

  return {
    status: 'healthy',
    utilizationPct,
    projectedMonthEnd,
    recommendedDailyMax,
    reason: 'Pace is within monthly allowance.',
  };
}

function parseUsageOptions(args: string[]): UsageCommandOptions {
  let provider: UsageProvider = 'both';
  let json = false;

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg.startsWith('--provider=')) {
      const value = arg.split('=')[1];
      if (value === 'nanogpt' || value === 'chutes' || value === 'both') {
        provider = value;
      }
    }
  }

  return { provider, json };
}

function printHumanReadable(result: {
  provider: UsageProvider;
  nanogpt?: {
    weeklyUsed?: number;
    weeklyRemaining?: number;
    weeklyLimit?: number;
    dailyUsed?: number;
    dailyRemaining?: number;
    monthlyUsed?: number;
    monthlyRemaining?: number;
    monthlyLimit?: number;
  };
  chutes?: {
    date?: string;
    requestsToday?: number;
    inputTokensToday?: number;
    outputTokensToday?: number;
    amountToday?: number;
    monthlyUsed?: number;
    monthlyLimit?: number;
    monthlyRemaining?: number;
    monthRequests?: number;
    monthInputTokens?: number;
    monthOutputTokens?: number;
    monthAmount?: number;
  };
  insights?: {
    nanogpt?: PaceInsight;
    chutes?: PaceInsight;
  };
  warnings: string[];
}): void {
  if (result.provider === 'both' || result.provider === 'nanogpt') {
    console.log('NanoGPT');
    console.log(`  weekly used: ${result.nanogpt?.weeklyUsed ?? 'n/a'}`);
    console.log(
      `  weekly remaining: ${result.nanogpt?.weeklyRemaining ?? 'n/a'}`,
    );
    console.log(`  weekly limit: ${result.nanogpt?.weeklyLimit ?? 'n/a'}`);
    console.log(`  daily used: ${result.nanogpt?.dailyUsed ?? 'n/a'}`);
    console.log(
      `  daily remaining: ${result.nanogpt?.dailyRemaining ?? 'n/a'}`,
    );
    console.log(`  monthly used: ${result.nanogpt?.monthlyUsed ?? 'n/a'}`);
    console.log(
      `  monthly remaining: ${result.nanogpt?.monthlyRemaining ?? 'n/a'}`,
    );
    console.log(`  monthly limit: ${result.nanogpt?.monthlyLimit ?? 'n/a'}`);
    if (result.insights?.nanogpt) {
      console.log(`  pacing status: ${result.insights.nanogpt.status}`);
      console.log(
        `  projected month-end: ${result.insights.nanogpt.projectedMonthEnd ?? 'n/a'}`,
      );
      console.log(
        `  recommended/day: ${result.insights.nanogpt.recommendedDailyMax ?? 'n/a'}`,
      );
      console.log(`  note: ${result.insights.nanogpt.reason}`);
    }
  }

  if (result.provider === 'both' || result.provider === 'chutes') {
    if (result.provider === 'both') console.log('');
    console.log('Chutes');
    console.log(`  date (UTC): ${result.chutes?.date ?? 'n/a'}`);
    console.log(`  requests today: ${result.chutes?.requestsToday ?? 'n/a'}`);
    console.log(
      `  input tokens today: ${result.chutes?.inputTokensToday ?? 'n/a'}`,
    );
    console.log(
      `  output tokens today: ${result.chutes?.outputTokensToday ?? 'n/a'}`,
    );
    console.log(`  amount today: ${result.chutes?.amountToday ?? 'n/a'}`);
    console.log(`  month requests: ${result.chutes?.monthRequests ?? 'n/a'}`);
    console.log(
      `  month input tokens: ${result.chutes?.monthInputTokens ?? 'n/a'}`,
    );
    console.log(
      `  month output tokens: ${result.chutes?.monthOutputTokens ?? 'n/a'}`,
    );
    console.log(`  month amount: ${result.chutes?.monthAmount ?? 'n/a'}`);
    console.log(`  monthly used: ${result.chutes?.monthlyUsed ?? 'n/a'}`);
    console.log(
      `  monthly remaining: ${result.chutes?.monthlyRemaining ?? 'n/a'}`,
    );
    console.log(`  monthly limit: ${result.chutes?.monthlyLimit ?? 'n/a'}`);
    if (result.insights?.chutes) {
      console.log(`  pacing status: ${result.insights.chutes.status}`);
      console.log(
        `  projected month-end: ${result.insights.chutes.projectedMonthEnd ?? 'n/a'}`,
      );
      console.log(
        `  recommended/day: ${result.insights.chutes.recommendedDailyMax ?? 'n/a'}`,
      );
      console.log(`  note: ${result.insights.chutes.reason}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}

export async function usage(args: string[]): Promise<number> {
  const options = parseUsageOptions(args);
  const warnings: string[] = [];

  const needsNano =
    options.provider === 'both' || options.provider === 'nanogpt';
  const needsChutes =
    options.provider === 'both' || options.provider === 'chutes';

  const providerSnapshot = await fetchProviderUsageSnapshot({
    includeNanogpt: needsNano,
    includeChutes: needsChutes,
  });
  warnings.push(...providerSnapshot.warnings);

  const chutesDaily = needsChutes ? await fetchChutesDailyUsage() : undefined;
  if (chutesDaily?.warning) warnings.push(chutesDaily.warning);

  const result = {
    provider: options.provider,
    nanogpt: needsNano
      ? {
          weeklyUsed: providerSnapshot.usage.nanogpt?.weeklyUsed,
          weeklyRemaining: providerSnapshot.usage.nanogpt?.weeklyRemaining,
          weeklyLimit: providerSnapshot.usage.nanogpt?.weeklyLimit,
          dailyUsed: providerSnapshot.usage.nanogpt?.dailyUsed,
          dailyRemaining: providerSnapshot.usage.nanogpt?.dailyRemaining,
          monthlyUsed: providerSnapshot.usage.nanogpt?.monthlyUsed,
          monthlyRemaining: providerSnapshot.usage.nanogpt?.monthlyRemaining,
          monthlyLimit: providerSnapshot.usage.nanogpt?.monthlyLimit,
        }
      : undefined,
    chutes: needsChutes
      ? {
          date: chutesDaily?.usage?.date,
          requestsToday: chutesDaily?.usage?.requests,
          inputTokensToday: chutesDaily?.usage?.inputTokens,
          outputTokensToday: chutesDaily?.usage?.outputTokens,
          amountToday: chutesDaily?.usage?.amount,
          monthRequests: chutesDaily?.usage?.monthRequests,
          monthInputTokens: chutesDaily?.usage?.monthInputTokens,
          monthOutputTokens: chutesDaily?.usage?.monthOutputTokens,
          monthAmount: chutesDaily?.usage?.monthAmount,
          monthlyUsed:
            providerSnapshot.usage.chutes?.monthlyUsed ??
            chutesDaily?.usage?.monthRequests,
          monthlyLimit: providerSnapshot.usage.chutes?.monthlyLimit,
          monthlyRemaining:
            providerSnapshot.usage.chutes?.monthlyRemaining ??
            (typeof providerSnapshot.usage.chutes?.monthlyLimit === 'number' &&
            typeof chutesDaily?.usage?.monthRequests === 'number'
              ? Math.max(
                  0,
                  providerSnapshot.usage.chutes.monthlyLimit -
                    chutesDaily.usage.monthRequests,
                )
              : undefined),
        }
      : undefined,
    insights: {
      nanogpt: needsNano
        ? buildPaceInsight({
            used: providerSnapshot.usage.nanogpt?.monthlyUsed,
            remaining: providerSnapshot.usage.nanogpt?.monthlyRemaining,
            limit: providerSnapshot.usage.nanogpt?.monthlyLimit,
          })
        : undefined,
      chutes: needsChutes
        ? buildPaceInsight({
            used:
              providerSnapshot.usage.chutes?.monthlyUsed ??
              chutesDaily?.usage?.monthRequests,
            remaining:
              providerSnapshot.usage.chutes?.monthlyRemaining ??
              (typeof providerSnapshot.usage.chutes?.monthlyLimit ===
                'number' &&
              typeof chutesDaily?.usage?.monthRequests === 'number'
                ? Math.max(
                    0,
                    providerSnapshot.usage.chutes.monthlyLimit -
                      chutesDaily.usage.monthRequests,
                  )
                : undefined),
            limit: providerSnapshot.usage.chutes?.monthlyLimit,
          })
        : undefined,
    },
    warnings,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReadable(result);
  }

  return 0;
}
