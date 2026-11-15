import { PresetAgentsSchema } from './schema';

/**
 * Old generated presets wrote `explorer.mcps: []` beside librarian's
 * `["context7", "gh_grep"]`; rename continuity lets that stale empty list mask
 * the retained list. Strip only this exact shape from raw preset layers, before
 * alias merging erases the provenance. Config files are never rewritten.
 */
const OLD_GENERATED_MCPS = ['context7', 'gh_grep'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Normalize raw `presets` in place; one warning per repaired preset. */
export function repairLegacyExplorerMcps(
  rawConfig: unknown,
  warn: (message: string) => void,
): void {
  if (!isRecord(rawConfig) || !isRecord(rawConfig.presets)) return;
  for (const [name, preset] of Object.entries(rawConfig.presets)) {
    if (!isRecord(preset)) continue;
    // Mirror normalizePreset: a flat preset may legitimately have a custom
    // agent named `agents`, so only a valid agent map is the wrapper syntax.
    let agents: Record<string, unknown> = preset;
    let structured = false;
    if (
      isRecord(preset.agents) &&
      PresetAgentsSchema.safeParse(preset.agents).success
    ) {
      agents = preset.agents;
      structured = true;
    }
    const legacy = agents.librarian;
    const canonical = agents.explorer;
    if (!isRecord(legacy) || !isRecord(canonical)) continue;
    const canonicalMcps = canonical.mcps;
    const legacyMcps = legacy.mcps;
    if (!Array.isArray(canonicalMcps) || canonicalMcps.length !== 0) continue;
    if (
      !Array.isArray(legacyMcps) ||
      legacyMcps.length !== OLD_GENERATED_MCPS.length ||
      !OLD_GENERATED_MCPS.every((mcp) => legacyMcps.includes(mcp))
    )
      continue;

    delete canonical.mcps;
    const path = `presets.${name}.${structured ? 'agents.' : ''}explorer.mcps`;
    warn(
      `Config key "${path}" matches the old generated preset shape (empty explorer MCPs beside librarian's context7/gh_grep); it is ignored on load so the retained librarian MCP list is inherited. Config files are not rewritten. See docs/configuration.md.`,
    );
  }
}
