import { MarketplaceRetiredError } from './errors';

/** Package IDs that are permanently unavailable for new marketplace state. */
export const RETIRED_MARKETPLACE_PACKAGE_IDS = [
  'alvin/deepwork-implementer',
  'alvin/deepwork-recon',
  'alvin/deepwork-reviewer',
  'alvin/evidence-scout',
  'alvin/visual-inspector',
] as const;

const retiredPackageIds = new Set<string>(RETIRED_MARKETPLACE_PACKAGE_IDS);

export function isMarketplacePackageRetired(id: string): boolean {
  return retiredPackageIds.has(id.trim().toLowerCase());
}

export function assertMarketplacePackageNotRetired(id: string): void {
  const normalized = id.trim().toLowerCase();
  if (isMarketplacePackageRetired(normalized)) {
    throw new MarketplaceRetiredError(
      `${normalized} is retired and cannot be installed, updated, or activated`,
    );
  }
}
