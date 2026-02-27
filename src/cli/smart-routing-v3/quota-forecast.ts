import type { AgentName } from '../types';
import type {
  QuotaForecast,
  QuotaForecastPoint,
  RoutingQuotaStatus,
} from './types';

export interface UsageSnapshot {
  dateIso: string;
  calls: number;
  byAgent?: Partial<Record<AgentName, number>>;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function riskLevel(
  remaining: number,
  baseline: number,
): QuotaForecastPoint['riskLevel'] {
  if (remaining <= 0) return 'critical';
  if (baseline <= 0) return 'none';
  const pct = remaining / baseline;
  if (pct < 0.1) return 'critical';
  if (pct < 0.25) return 'high';
  if (pct < 0.5) return 'medium';
  if (pct < 0.75) return 'low';
  return 'none';
}

export function forecastQuota(input: {
  quota: RoutingQuotaStatus;
  history: UsageSnapshot[];
  horizonDays: number;
}): QuotaForecast {
  const horizonDays = Math.max(1, input.horizonDays);
  const recent = input.history.slice(-14);
  const dailyAverage = Math.max(
    1,
    Math.round(average(recent.map((entry) => entry.calls))),
  );
  const points: QuotaForecastPoint[] = [];

  let remaining = input.quota.dailyRemaining;
  let predictedExhaustionDateIso: string | undefined;
  for (let index = 0; index < horizonDays; index++) {
    const date = new Date();
    date.setDate(date.getDate() + index);
    remaining -= dailyAverage;
    if (!predictedExhaustionDateIso && remaining <= 0) {
      predictedExhaustionDateIso = date.toISOString();
    }
    points.push({
      dateIso: date.toISOString(),
      predictedUsage: dailyAverage,
      predictedRemaining: Math.max(0, remaining),
      riskLevel: riskLevel(remaining, input.quota.dailyRemaining),
    });
  }

  const recommendations: string[] = [];
  if (predictedExhaustionDateIso) {
    recommendations.push(
      'Shift high-volume agents to paygo or alternate providers.',
    );
    recommendations.push(
      'Increase fallback depth to reduce hard failures near quota exhaustion.',
    );
  } else {
    recommendations.push(
      'Quota forecast is healthy; keep hybrid mode and monitor weekly.',
    );
  }

  const confidence =
    recent.length >= 7 ? 0.82 : recent.length >= 3 ? 0.65 : 0.45;

  return {
    predictedExhaustionDateIso,
    confidence,
    points,
    recommendations,
  };
}
