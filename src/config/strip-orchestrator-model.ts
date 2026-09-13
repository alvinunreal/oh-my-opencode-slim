import type { ResolvedPreset } from './schema';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stripOrchestratorModel(
  agents: Record<string, unknown>,
  enabled: boolean | undefined,
  preset: ResolvedPreset | undefined,
): void {
  if (enabled !== true || preset?.orchestrator?.model !== undefined) return;

  const orchestrator = agents.orchestrator;
  if (!isRecord(orchestrator)) return;

  delete orchestrator.model;
  delete orchestrator.variant;
}

export function applyOrchestratorModelConfig(input: {
  agents: Record<string, unknown>;
  enabled: boolean | undefined;
  resolvedPresets?: Record<string, ResolvedPreset>;
  configPreset: string | undefined;
  runtimePreset: string | null;
}): void {
  const presetName = input.runtimePreset ?? input.configPreset;
  stripOrchestratorModel(
    input.agents,
    input.enabled,
    presetName ? input.resolvedPresets?.[presetName] : undefined,
  );
}
