import { describe, expect, test } from 'bun:test';
import {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
} from './canonical';
import type { MarketplacePackageBundle } from './schemas';

describe('marketplace canonicalization', () => {
  test('sorts object keys by code units while preserving array order', () => {
    expect(canonicalizeMarketplaceValue({ z: 1, a: [3, 2] })).toBe(
      '{"a":[3,2],"z":1}',
    );
    expect(compareMarketplaceCodeUnits('a', 'b')).toBeLessThan(0);
    expect(compareMarketplaceCodeUnits('b', 'a')).toBeGreaterThan(0);
    expect(compareMarketplaceCodeUnits('a', 'a')).toBe(0);
  });

  test('produces a stable SHA-256 package digest', () => {
    const bundle = {
      manifest: { id: 'community/test' },
    } as MarketplacePackageBundle;
    expect(digestMarketplaceBundle(bundle)).toBe(
      digestMarketplaceBundle(bundle),
    );
    expect(digestMarketplaceBundle(bundle)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('omits undefined object fields and stays stable through JSON round trips', () => {
    const bundle = {
      manifest: {
        id: 'community/test',
        optionalColor: undefined,
        metadata: { omitted: undefined, retained: true },
      },
    } as unknown as MarketplacePackageBundle;
    const serialized = JSON.parse(JSON.stringify(bundle));

    expect(canonicalizeMarketplaceBundle(bundle)).toBe(
      canonicalizeMarketplaceBundle(serialized),
    );
    expect(digestMarketplaceBundle(bundle)).toBe(
      digestMarketplaceBundle(serialized),
    );
  });

  test('rejects values outside the JSON data model', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      new Date(),
      cyclic,
    ]) {
      expect(() => canonicalizeMarketplaceValue(value)).toThrow();
    }
    expect(() => canonicalizeMarketplaceValue([undefined])).toThrow();
    expect(() =>
      canonicalizeMarketplaceValue({ [Symbol('key')]: 'value' }),
    ).toThrow();
  });
});
