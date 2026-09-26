import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  MARKETPLACE_MANIFEST_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3,
  MarketplaceDigestSchema,
  MarketplaceDigestV3Schema,
  MarketplacePackageIdSchema,
  MarketplaceVersionSchema,
} from './schemas.js';

export const MARKETPLACE_LOCKFILE_SCHEMA_VERSION = 2 as const;

const BoundedTextSchema = (max: number) => z.string().trim().min(1).max(max);

export const MarketplaceLocalSourceSchema = z
  .object({
    kind: z.literal('local'),
    path: z
      .string()
      .trim()
      .min(1)
      .refine(isAbsolute, 'Local marketplace source paths must be absolute'),
  })
  .strict();

export const MarketplaceRegistrySourceSchema = z
  .object({
    kind: z.literal('registry'),
    registry: BoundedTextSchema(200),
    indexUrl: z.string().url(),
    packageUrl: z.string().url(),
  })
  .strict();

export const MarketplaceInMemorySourceSchema = z
  .object({
    kind: z.literal('in-memory'),
    label: BoundedTextSchema(120),
  })
  .strict();

export const MarketplaceSourceSchema = z.discriminatedUnion('kind', [
  MarketplaceLocalSourceSchema,
  MarketplaceRegistrySourceSchema,
  MarketplaceInMemorySourceSchema,
]);

const MarketplaceLockEntryFields = {
  manifestVersion: MarketplaceVersionSchema,
  source: MarketplaceSourceSchema,
} as const;

export const MarketplaceLockEntryV2Schema = z
  .object({
    manifestSchemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION),
    ...MarketplaceLockEntryFields,
    digest: MarketplaceDigestSchema,
  })
  .strict();

export const MarketplaceLockEntryV3Schema = z
  .object({
    manifestSchemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3),
    ...MarketplaceLockEntryFields,
    digest: MarketplaceDigestV3Schema,
  })
  .strict();

export const MarketplaceLockEntrySchema = z.discriminatedUnion(
  'manifestSchemaVersion',
  [MarketplaceLockEntryV2Schema, MarketplaceLockEntryV3Schema],
);

export const MarketplaceLockfileSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_LOCKFILE_SCHEMA_VERSION),
    packages: z.record(MarketplacePackageIdSchema, MarketplaceLockEntrySchema),
  })
  .strict();

export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;
export type MarketplaceLockEntryV2 = z.infer<
  typeof MarketplaceLockEntryV2Schema
>;
export type MarketplaceLockEntryV3 = z.infer<
  typeof MarketplaceLockEntryV3Schema
>;
export type MarketplaceLockEntry = z.infer<typeof MarketplaceLockEntrySchema>;
export type MarketplaceLockfile = z.infer<typeof MarketplaceLockfileSchema>;
