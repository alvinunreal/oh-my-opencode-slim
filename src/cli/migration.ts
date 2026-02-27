import type { AgentModelMap, InstallConfig } from './types';

type MigrationEntry = {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
};

export interface MigrationResult {
  config: InstallConfig;
  migrated: boolean;
  entries: MigrationEntry[];
  warnings: string[];
}

const PRIMARY_AGENTS = ['orchestrator', 'oracle', 'designer'] as const;
const SUPPORT_AGENTS = ['explorer', 'librarian', 'fixer'] as const;

function buildAgentMapFromLegacySlots(input: {
  primaryModel?: string;
  secondaryModel?: string;
  defaultSupportVariant?: string;
}): { assignments?: AgentModelMap; warning?: string } {
  if (!input.primaryModel) {
    return {};
  }

  const supportModel = input.secondaryModel ?? input.primaryModel;
  const assignments = {} as AgentModelMap;

  for (const agent of PRIMARY_AGENTS) {
    assignments[agent] = {
      model: input.primaryModel,
      variant:
        agent === 'oracle'
          ? 'high'
          : agent === 'designer'
            ? 'medium'
            : undefined,
      confidence: 0.8,
      reasoning: 'Migrated from legacy primary slot',
    };
  }

  for (const agent of SUPPORT_AGENTS) {
    assignments[agent] = {
      model: supportModel,
      variant: input.defaultSupportVariant ?? 'low',
      confidence: 0.8,
      reasoning: 'Migrated from legacy support slot',
    };
  }

  return {
    assignments,
    warning: input.secondaryModel
      ? undefined
      : 'Legacy support model missing; reused primary model for support agents.',
  };
}

function pickPrimaryFromAgentMap(map: AgentModelMap): string | undefined {
  return (
    map.orchestrator?.model ??
    map.oracle?.model ??
    map.designer?.model ??
    Object.values(map).find((entry) => entry.model)?.model
  );
}

function pickSupportFromAgentMap(
  map: AgentModelMap,
  fallbackPrimary?: string,
): string | undefined {
  return (
    map.explorer?.model ??
    map.librarian?.model ??
    map.fixer?.model ??
    fallbackPrimary
  );
}

export function migrateLegacyAssignmentsV1ToV2(
  config: InstallConfig,
): MigrationResult {
  const next: InstallConfig = { ...config };
  const entries: MigrationEntry[] = [];
  const warnings: string[] = [];

  if (
    next.hasChutes &&
    !next.selectedChutesModelsByAgent &&
    next.selectedChutesPrimaryModel
  ) {
    const migrated = buildAgentMapFromLegacySlots({
      primaryModel: next.selectedChutesPrimaryModel,
      secondaryModel: next.selectedChutesSecondaryModel,
    });

    if (migrated.assignments) {
      next.selectedChutesModelsByAgent = migrated.assignments;
      entries.push({
        field: 'selectedChutesPrimaryModel/selectedChutesSecondaryModel',
        oldValue: {
          primary: config.selectedChutesPrimaryModel,
          secondary: config.selectedChutesSecondaryModel,
        },
        newValue: migrated.assignments,
        reason: 'Migrated Chutes from legacy two-slot fields to per-agent map',
      });
      if (migrated.warning) warnings.push(`Chutes: ${migrated.warning}`);
    }
  }

  if (
    next.useOpenCodeFreeModels &&
    !next.selectedOpenCodeModelsByAgent &&
    next.selectedOpenCodePrimaryModel
  ) {
    const migrated = buildAgentMapFromLegacySlots({
      primaryModel: next.selectedOpenCodePrimaryModel,
      secondaryModel: next.selectedOpenCodeSecondaryModel,
    });

    if (migrated.assignments) {
      next.selectedOpenCodeModelsByAgent = migrated.assignments;
      entries.push({
        field: 'selectedOpenCodePrimaryModel/selectedOpenCodeSecondaryModel',
        oldValue: {
          primary: config.selectedOpenCodePrimaryModel,
          secondary: config.selectedOpenCodeSecondaryModel,
        },
        newValue: migrated.assignments,
        reason:
          'Migrated OpenCode from legacy two-slot fields to per-agent map',
      });
      if (migrated.warning) warnings.push(`OpenCode: ${migrated.warning}`);
    }
  }

  if (entries.length > 0) {
    next._migratedFromV1 = true;
    next._migrationTimestamp = new Date().toISOString();
    if (warnings.length > 0) {
      next._migrationWarnings = warnings;
    }
  }

  return {
    config: next,
    migrated: entries.length > 0,
    entries,
    warnings,
  };
}

export function rollbackAssignmentsV2ToLegacy(
  config: InstallConfig,
): InstallConfig {
  const next: InstallConfig = { ...config };

  if (
    next.hasChutes &&
    next.selectedChutesModelsByAgent &&
    !next.selectedChutesPrimaryModel
  ) {
    const primary = pickPrimaryFromAgentMap(next.selectedChutesModelsByAgent);
    const support = pickSupportFromAgentMap(
      next.selectedChutesModelsByAgent,
      primary,
    );

    next.selectedChutesPrimaryModel = primary;
    next.selectedChutesSecondaryModel = support;
  }

  if (
    next.useOpenCodeFreeModels &&
    next.selectedOpenCodeModelsByAgent &&
    !next.selectedOpenCodePrimaryModel
  ) {
    const primary = pickPrimaryFromAgentMap(next.selectedOpenCodeModelsByAgent);
    const support = pickSupportFromAgentMap(
      next.selectedOpenCodeModelsByAgent,
      primary,
    );

    next.selectedOpenCodePrimaryModel = primary;
    next.selectedOpenCodeSecondaryModel = support;
  }

  return next;
}
