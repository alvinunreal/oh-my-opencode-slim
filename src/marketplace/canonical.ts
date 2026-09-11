import { createHash } from 'node:crypto';
import type { MarketplacePackageBundle } from './schemas';

export function compareMarketplaceCodeUnits(
  left: string,
  right: string,
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical JSON used by the package store, registry CI, and the website. */
export function canonicalizeMarketplaceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeMarketplaceValue).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => compareMarketplaceCodeUnits(left, right),
    );
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalizeMarketplaceValue(entry)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Returns the exact UTF-8-compatible canonical JSON text for a bundle. */
export function canonicalizeMarketplaceBundle(
  bundle: MarketplacePackageBundle,
): string {
  return canonicalizeMarketplaceValue(bundle);
}

export function digestMarketplaceBundle(
  bundle: MarketplacePackageBundle,
): string {
  return createHash('sha256')
    .update(canonicalizeMarketplaceBundle(bundle), 'utf8')
    .digest('hex');
}
