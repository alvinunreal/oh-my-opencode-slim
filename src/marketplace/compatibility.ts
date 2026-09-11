import { satisfies, valid } from 'semver';
import { readPluginPackageVersion } from '../utils/package-metadata';
import { MarketplaceCompatibilityError } from './errors';
import {
  MARKETPLACE_ROLE_CONTRACT_VERSION,
  type MarketplacePackageManifest,
} from './schemas';

export interface MarketplaceCompatibilityOptions {
  pluginVersion?: string;
  roleContractVersion?: string;
}

export function satisfiesPluginCompatibility(
  version: string,
  range: string,
): boolean {
  return valid(version) !== null && satisfies(version, range);
}

export function validateMarketplaceCompatibility(
  manifest: MarketplacePackageManifest,
  options: MarketplaceCompatibilityOptions = {},
): void {
  const pluginVersion = options.pluginVersion ?? readPluginPackageVersion();
  if (!pluginVersion) {
    throw new MarketplaceCompatibilityError(
      'Cannot determine the installed plugin version for marketplace compatibility',
    );
  }
  const roleContractVersion =
    options.roleContractVersion ?? MARKETPLACE_ROLE_CONTRACT_VERSION;
  if (
    !satisfiesPluginCompatibility(pluginVersion, manifest.compatibility.plugin)
  ) {
    throw new MarketplaceCompatibilityError(
      `${manifest.id}@${manifest.version} requires plugin ${manifest.compatibility.plugin}; current plugin is ${pluginVersion}`,
    );
  }
  if (!satisfies(roleContractVersion, manifest.compatibility.roleContract)) {
    throw new MarketplaceCompatibilityError(
      `${manifest.id}@${manifest.version} requires role contract ${manifest.compatibility.roleContract}; current contract is ${roleContractVersion}`,
    );
  }
}
