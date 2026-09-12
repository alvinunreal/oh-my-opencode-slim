import {
  ROLE_ROUTING_BLOCKS,
  renderRoleRoutingBlock,
} from '../agents/role-routing';
import type { MarketplacePackageManifest } from './schemas';

function renderMarketplacePackageSuffix(
  manifest: MarketplacePackageManifest,
): string {
  return [
    `- Package: ${manifest.displayName}`,
    `- ${manifest.routing.description}`,
    `- **Delegate when:** ${manifest.routing.when}`,
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
  standaloneLaneDescription = manifest.description,
): string {
  const role = manifest.extends
    ? {
        id: manifest.extends.builtin,
        routingBlock: ROLE_ROUTING_BLOCKS[manifest.extends.builtin],
      }
    : undefined;
  const base = role
    ? renderRoleRoutingBlock(role, runtimeName)
    : [`@${runtimeName}`, `- Lane: ${standaloneLaneDescription}`].join('\n');

  return `${base}\n\n${renderMarketplacePackageSuffix(manifest)}`;
}
