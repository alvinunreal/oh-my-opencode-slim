import {
  ROLE_ROUTING_BLOCKS,
  renderRoleRoutingBlock,
} from '../agents/role-routing';
import type {
  MarketplacePackageManifest,
  MarketplacePackageManifestV2,
  MarketplacePackageManifestV3,
} from './schemas';

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
    renderV3RoutingDetails(manifest),
  ].join('\n');
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
  if (manifest.schemaVersion === 2) {
    const role = manifest.extends
      ? {
          id: manifest.extends.builtin,
          routingBlock: ROLE_ROUTING_BLOCKS[manifest.extends.builtin],
        }
      : undefined;
    const base = role
      ? renderRoleRoutingBlock(role, runtimeName)
      : [
          `@${runtimeName}`,
          `- Lane: ${standaloneLaneDescription ?? manifest.description}`,
        ].join('\n');

    return `${base}\n\n${renderV2PackageSuffix(manifest)}`;
  }

  const role = manifest.extends
    ? {
        id: manifest.extends.builtin,
        routingBlock: ROLE_ROUTING_BLOCKS[manifest.extends.builtin],
      }
    : undefined;
  const base = role
    ? renderRoleRoutingBlock(role, runtimeName)
    : [
        `@${runtimeName}`,
        `- Lane: ${standaloneLaneDescription ?? manifest.routing.lane}`,
        `- Role: ${manifest.description}`,
        renderV3Capabilities(manifest),
      ]
        .filter(Boolean)
        .join('\n');

  if (!role) {
    return `${base}\n${renderV3RoutingDetails(manifest)}`;
  }
  return `${base}\n\n${renderV3ExtensionSuffix(manifest)}`;
}
