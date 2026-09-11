import { MarketplacePackageIdSchema } from './schemas';

export function normalizeMarketplacePackageId(value: string): string {
  const normalized = value.trim().toLowerCase();
  const result = MarketplacePackageIdSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(`Invalid marketplace package ID: ${value}`);
  }
  return normalized;
}
