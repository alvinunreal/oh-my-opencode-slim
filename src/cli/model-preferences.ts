import type { AgentName, ModelPreferencesByAgent } from './types';

const AGENT_NAMES: AgentName[] = [
  'orchestrator',
  'oracle',
  'designer',
  'explorer',
  'librarian',
  'fixer',
];

const PROVIDER_MODEL_PATTERN = /^[^/\s]+\/[^\s]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeModelPreferences(
  value: unknown,
): ModelPreferencesByAgent | undefined {
  const objectValue = asRecord(value);
  if (!objectValue) return undefined;

  const normalized: ModelPreferencesByAgent = {};

  for (const agent of AGENT_NAMES) {
    const rawList = objectValue[agent];
    if (!Array.isArray(rawList)) continue;

    const deduped = [...new Set(rawList)]
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => PROVIDER_MODEL_PATTERN.test(entry));

    if (deduped.length > 0) {
      normalized[agent] = deduped;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function resolvePreferredModelForAgent(input: {
  agent: AgentName;
  preferences?: ModelPreferencesByAgent;
  candidates: ReadonlyArray<string>;
}): string | undefined {
  const preferred = input.preferences?.[input.agent];
  if (!preferred || preferred.length === 0) return undefined;

  const candidateByLower = new Map<string, string>();
  for (const candidate of input.candidates) {
    candidateByLower.set(candidate.toLowerCase(), candidate);
  }

  for (const wanted of preferred) {
    const resolved = candidateByLower.get(wanted.toLowerCase());
    if (resolved) return resolved;
  }

  return undefined;
}
