import type { AggregatedFederatedUpdate, LocalFederatedUpdate } from './types';

function mergeAverages(rows: Array<{ value: number; weight: number }>): number {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return 0;
  return (
    rows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight
  );
}

export class FederatedAggregator {
  aggregate(updates: LocalFederatedUpdate[]): AggregatedFederatedUpdate {
    if (updates.length === 0) {
      return {
        modelRewards: {},
        featureAdjustments: {},
        participants: 0,
      };
    }

    const modelKeys = new Set<string>();
    const featureKeys = new Set<string>();
    for (const update of updates) {
      for (const key of Object.keys(update.modelRewards)) modelKeys.add(key);
      for (const key of Object.keys(update.featureAdjustments)) {
        featureKeys.add(key);
      }
    }

    const modelRewards: Record<string, number> = {};
    for (const key of modelKeys) {
      const rows = updates
        .map((update) => {
          const value = update.modelRewards[key];
          if (typeof value !== 'number') return null;
          return { value, weight: Math.max(1, update.sampleCount) };
        })
        .filter(
          (row): row is { value: number; weight: number } => row !== null,
        );
      modelRewards[key] = mergeAverages(rows);
    }

    const featureAdjustments: Record<string, number> = {};
    for (const key of featureKeys) {
      const rows = updates
        .map((update) => {
          const value = update.featureAdjustments[key];
          if (typeof value !== 'number') return null;
          return { value, weight: Math.max(1, update.sampleCount) };
        })
        .filter(
          (row): row is { value: number; weight: number } => row !== null,
        );
      featureAdjustments[key] = mergeAverages(rows);
    }

    return {
      modelRewards,
      featureAdjustments,
      participants: updates.length,
    };
  }
}
