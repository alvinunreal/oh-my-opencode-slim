import { describe, expect, test } from 'bun:test';
import {
  MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
  MarketplaceLockEntryV2Schema,
  MarketplaceLockEntryV3Schema,
  MarketplaceLockfileSchema,
  MarketplaceSourceSchema,
} from './store-schemas';

const digest = 'a'.repeat(64);

const sourceCases = [
  { kind: 'local', path: '/tmp/agents/example' },
  {
    kind: 'registry',
    registry: 'community',
    indexUrl: 'https://registry.example/v3/index.json',
    packageUrl: 'https://registry.example/artifacts/community/example.json',
  },
  { kind: 'in-memory', label: 'programmatic install' },
] as const;

const v2Entry = {
  manifestSchemaVersion: 2,
  manifestVersion: '1.2.3',
  source: sourceCases[0],
  digest: {
    algorithm: 'sha256',
    domain: 'marketplace-agent-bundle-v2',
    value: digest,
  },
} as const;

const v3Entry = {
  manifestSchemaVersion: 3,
  manifestVersion: '2.0.0-beta.1',
  source: sourceCases[1],
  digest: {
    algorithm: 'sha256',
    domain: 'marketplace-agent-bundle-v3',
    value: digest,
  },
} as const;

describe('marketplace persisted store schemas', () => {
  test('accepts every supported persisted package source', () => {
    for (const source of sourceCases) {
      expect(MarketplaceSourceSchema.safeParse(source).success).toBe(true);
    }
    expect(
      MarketplaceSourceSchema.safeParse({
        kind: 'local',
        path: 'relative/path',
      }).success,
    ).toBe(false);
  });

  test('accepts matching V2 and V3 lock entries and lockfiles', () => {
    expect(MarketplaceLockEntryV2Schema.safeParse(v2Entry).success).toBe(true);
    expect(MarketplaceLockEntryV3Schema.safeParse(v3Entry).success).toBe(true);
    expect(
      MarketplaceLockfileSchema.safeParse({
        schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
        packages: {
          'community/v2-agent': v2Entry,
          'community/v3-agent': v3Entry,
        },
      }).success,
    ).toBe(true);
  });

  test('rejects digest domains or manifest schema versions that disagree', () => {
    expect(
      MarketplaceLockEntryV2Schema.safeParse({
        ...v2Entry,
        digest: { ...v2Entry.digest, domain: 'marketplace-agent-bundle-v3' },
      }).success,
    ).toBe(false);
    expect(
      MarketplaceLockEntryV3Schema.safeParse({
        ...v3Entry,
        digest: { ...v3Entry.digest, domain: 'marketplace-agent-bundle-v2' },
      }).success,
    ).toBe(false);
    expect(
      MarketplaceLockEntryV2Schema.safeParse({
        ...v2Entry,
        manifestSchemaVersion: 3,
      }).success,
    ).toBe(false);
    expect(
      MarketplaceLockEntryV3Schema.safeParse({
        ...v3Entry,
        manifestSchemaVersion: 2,
      }).success,
    ).toBe(false);
  });

  test('rejects invalid lockfile versions and package identity keys', () => {
    expect(
      MarketplaceLockfileSchema.safeParse({
        schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION + 1,
        packages: {},
      }).success,
    ).toBe(false);
    expect(
      MarketplaceLockfileSchema.safeParse({
        schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
        packages: { 'not-an-id': v2Entry },
      }).success,
    ).toBe(false);
    expect(
      MarketplaceLockEntryV2Schema.safeParse({
        ...v2Entry,
        manifestVersion: 'v1.2.3',
      }).success,
    ).toBe(false);
  });
});
