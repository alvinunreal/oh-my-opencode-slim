import { SPECIALIST_DESCRIPTIONS } from '../agents/role-descriptions.js';
import type { SpecialistRole } from '../config/agent-roles.js';
import {
  type MarketplacePackageManifest,
  type MarketplacePackageManifestV2,
  type MarketplacePackageManifestV3,
  resolveMarketplaceBuiltin,
} from './schemas.js';

/**
 * Stored manifests are byte-faithful and may carry a legacy builtin name;
 * resolve it before any lookup so rendering never sees an unmapped role.
 */
function extensionBuiltin(
  manifest: MarketplacePackageManifest,
): SpecialistRole | undefined {
  const builtin = manifest.extends?.builtin;
  return builtin === undefined
    ? undefined
    : (resolveMarketplaceBuiltin(builtin) as SpecialistRole);
}

function renderV2PackageSuffix(manifest: MarketplacePackageManifestV2): string {
  return [
    `- Lane: ${manifest.routing.description}`,
    `- **Delegate when:** ${manifest.routing.when}`,
  ].join('\n');
}

function renderRoutingList(values: readonly string[]): string {
  return values.join(' • ');
}

function renderV3Capabilities(manifest: MarketplacePackageManifestV3): string {
  const capabilities = [
    manifest.tools.length > 0
      ? `Tools: ${manifest.tools.join(', ')}`
      : undefined,
    manifest.skills.length > 0
      ? `Skills: ${manifest.skills.join(', ')}`
      : undefined,
    manifest.mcps.length > 0 ? `MCPs: ${manifest.mcps.join(', ')}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return capabilities.length > 0
    ? `- Capabilities: ${capabilities.join('; ')}`
    : '';
}

function renderV3RoutingDetails(
  manifest: MarketplacePackageManifestV3,
): string {
  return [
    `- Stats: ${renderRoutingList(manifest.routing.stats)}`,
    `- **Delegate when:** ${renderRoutingList(manifest.routing.delegateWhen)}`,
    `- **Avoid:** ${renderRoutingList(manifest.routing.avoid)}`,
    ...(manifest.routing.additionalInstructions?.length
      ? [
          `- **Additional instructions:** ${renderRoutingList(manifest.routing.additionalInstructions)}`,
        ]
      : []),
  ].join('\n');
}

function renderV3ExtensionSuffix(
  manifest: MarketplacePackageManifestV3,
): string {
  return [
    `- Lane: ${manifest.routing.lane}`,
    renderV3Capabilities(manifest),
    renderV3RoutingDetails(manifest),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Render the default marketplace routing block for a runtime agent name.
 *
 * The default is deliberately independent of owner prompt overrides. Runtime
 * routing may provide a display alias, while the public contract uses the
 * manifest's canonical agentName by leaving runtimeName unset.
 */
export function renderMarketplaceAutoDelegationBlock(
  manifest: MarketplacePackageManifest,
  runtimeName = manifest.agentName,
  standaloneLaneDescription?: string,
): string {
  const roleId = extensionBuiltin(manifest);
  const role = roleId
    ? `@${runtimeName} — ${SPECIALIST_DESCRIPTIONS[roleId]}`
    : undefined;
  if (manifest.schemaVersion === 2) {
    const base =
      role ??
      `@${runtimeName}\n- Lane: ${standaloneLaneDescription ?? manifest.description}`;
    return `${base}\n\n${renderV2PackageSuffix(manifest)}`;
  }
  if (role) return `${role}\n\n${renderV3ExtensionSuffix(manifest)}`;
  const base = [
    `@${runtimeName}`,
    `- Lane: ${standaloneLaneDescription ?? manifest.routing.lane}`,
    `- Role: ${manifest.description}`,
    renderV3Capabilities(manifest),
  ]
    .filter(Boolean)
    .join('\n');
  return `${base}\n${renderV3RoutingDetails(manifest)}`;
}
