import { describe, expect, test } from 'bun:test';
import {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
} from './canonical';
import type { MarketplacePackageBundle } from './schemas';
import {
  MarketplacePackageBundleV2Schema,
  MarketplacePackageBundleV3Schema,
} from './schemas';

const v2VectorInput = {
  manifest: {
    schemaVersion: 2,
    id: 'community/vector',
    version: '1.2.3',
    displayName: 'Café agent',
    description: 'Canonical vector with "quotes".',
    agentName: 'vector-agent',
    prompt: 'Cafe\u0301\n"ready" 😀',
    routing: {
      description: 'Unicode: naïve',
      when: 'Use \t care',
      keywords: ['β', 'alpha'],
    },
    skills: ['zeta', 'alpha'],
    mcps: [],
    tools: ['read'],
    author: { name: 'Zoë' },
    tags: ['vector'],
    license: 'MIT',
    compatibility: { plugin: '>=3.0.0 <4.0.0' },
    model: {
      source: 'explicit',
      candidates: [{ id: 'provider/model', variant: 'v1' }],
    },
    temperature: -0,
    color: undefined,
    extends: { builtin: 'explorer', promptMode: 'append' },
  },
};

const v3VectorInput = {
  manifest: {
    schemaVersion: 3,
    id: 'community/vector',
    version: '1.2.3',
    displayName: 'Café agent',
    description: 'Canonical vector with "quotes".',
    agentName: 'vector-agent',
    prompt: 'Cafe\u0301\n"ready" 😀',
    routing: {
      lane: 'Línea',
      stats: ['Fast', '💡'],
      delegateWhen: ['On demand'],
      avoid: ['Never'],
      additionalInstructions: undefined,
    },
    skills: ['zeta', 'alpha'],
    mcps: [],
    tools: ['read'],
    author: { name: 'Zoë' },
    tags: ['vector'],
    license: 'MIT',
    compatibility: { plugin: '>=3.0.0 <4.0.0' },
    model: {
      source: 'explicit',
      candidates: [{ id: 'provider/model', variant: 'v1' }],
    },
    temperature: -0,
    color: undefined,
    extends: { builtin: 'explorer', promptMode: 'append' },
  },
};

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

  test('matches fixed V2 and V3 canonical UTF-8 digest vectors', () => {
    const v2 = MarketplacePackageBundleV2Schema.parse(v2VectorInput);
    const v3 = MarketplacePackageBundleV3Schema.parse(v3VectorInput);
    const jsonQuoteEscape = String.fromCharCode(92, 34);

    expect(canonicalizeMarketplaceBundle(v2)).toBe(
      `{"manifest":{"agentName":"vector-agent","author":{"name":"Zoë"},"compatibility":{"plugin":">=3.0.0 <4.0.0"},"description":"Canonical vector with ${jsonQuoteEscape}quotes${jsonQuoteEscape}.","displayName":"Café agent","extends":{"builtin":"explorer","promptMode":"append"},"id":"community/vector","license":"MIT","mcps":[],"model":{"candidates":[{"id":"provider/model","variant":"v1"}],"source":"explicit"},"prompt":"Café\\n${jsonQuoteEscape}ready${jsonQuoteEscape} 😀","routing":{"description":"Unicode: naïve","keywords":["β","alpha"],"when":"Use \\t care"},"schemaVersion":2,"skills":["zeta","alpha"],"tags":["vector"],"temperature":0,"tools":["read"],"version":"1.2.3"}}`,
    );
    expect(digestMarketplaceBundle(v2)).toBe(
      'b12773c9dbff19e10b9a80f96f5aa00b6acfd34d8ca83907c7f4bd4a0997dd91',
    );
    expect(canonicalizeMarketplaceBundle(v3)).toBe(
      `{"manifest":{"agentName":"vector-agent","author":{"name":"Zoë"},"compatibility":{"plugin":">=3.0.0 <4.0.0"},"description":"Canonical vector with ${jsonQuoteEscape}quotes${jsonQuoteEscape}.","displayName":"Café agent","extends":{"builtin":"explorer","promptMode":"append"},"id":"community/vector","license":"MIT","mcps":[],"model":{"candidates":[{"id":"provider/model","variant":"v1"}],"source":"explicit"},"prompt":"Café\\n${jsonQuoteEscape}ready${jsonQuoteEscape} 😀","routing":{"avoid":["Never"],"delegateWhen":["On demand"],"lane":"Línea","stats":["Fast","💡"]},"schemaVersion":3,"skills":["zeta","alpha"],"tags":["vector"],"temperature":0,"tools":["read"],"version":"1.2.3"}}`,
    );
    expect(digestMarketplaceBundle(v3)).toBe(
      'c52aae61fd3da566b510793216f487678060c7785d16d6f1269552d70b140605',
    );
    expect(canonicalizeMarketplaceValue('Café')).not.toBe(
      canonicalizeMarketplaceValue('Cafe\u0301'),
    );

    const reversedV2 = MarketplacePackageBundleV2Schema.parse(
      reverseObjectKeys(v2VectorInput),
    );
    expect(canonicalizeMarketplaceBundle(reversedV2)).toBe(
      canonicalizeMarketplaceBundle(v2),
    );
    expect(digestMarketplaceBundle(reversedV2)).toBe(
      digestMarketplaceBundle(v2),
    );

    const roundTrippedV2 = MarketplacePackageBundleV2Schema.parse(
      JSON.parse(JSON.stringify(v2)),
    );
    expect(canonicalizeMarketplaceBundle(roundTrippedV2)).toBe(
      canonicalizeMarketplaceBundle(v2),
    );
    expect(digestMarketplaceBundle(roundTrippedV2)).toBe(
      digestMarketplaceBundle(v2),
    );
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

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}
