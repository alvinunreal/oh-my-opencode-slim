import { compare, gt, satisfies } from 'semver';
import { z } from 'zod';
import {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
} from '../marketplace/canonical';
import { renderMarketplaceAutoDelegationBlock } from '../marketplace/routing';
import {
  MARKETPLACE_DIGEST_DOMAIN,
  MARKETPLACE_DIGEST_DOMAIN_V3,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3,
  MarketplaceAgentManifestSchema,
  MarketplaceAgentManifestSummarySchema,
  MarketplaceAgentManifestSummaryV2Schema,
  MarketplaceAgentManifestSummaryV3Schema,
  type MarketplaceDigest,
  MarketplaceDigestSchema,
  type MarketplaceDigestV3,
  MarketplaceDigestV3Schema,
  MarketplaceExtensionV3Schema,
  type MarketplacePackageBundle,
  MarketplacePackageBundleSchema,
  MarketplacePackageBundleV2Schema,
  MarketplacePackageBundleV3Schema,
  type MarketplacePackageId,
  MarketplacePackageIdSchema,
  type MarketplacePackageManifest,
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifestV2,
  MarketplacePackageManifestV2Schema,
  type MarketplacePackageManifestV3,
  MarketplacePackageManifestV3Schema,
  MarketplaceRoutingV3Schema,
  type MarketplaceVersion,
  MarketplaceVersionSchema,
} from '../marketplace/schemas';

export type {
  MarketplaceDigest,
  MarketplaceDigestV3,
  MarketplacePackageBundle,
  MarketplacePackageId,
  MarketplacePackageManifest,
  MarketplacePackageManifestV2,
  MarketplacePackageManifestV3,
  MarketplaceVersion,
};
export {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
  MARKETPLACE_DIGEST_DOMAIN,
  MARKETPLACE_DIGEST_DOMAIN_V3,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3,
  MarketplaceAgentManifestSchema,
  MarketplaceAgentManifestSummarySchema,
  MarketplaceAgentManifestSummaryV2Schema,
  MarketplaceAgentManifestSummaryV3Schema,
  MarketplaceDigestSchema,
  MarketplaceDigestV3Schema,
  MarketplaceExtensionV3Schema,
  MarketplacePackageBundleSchema,
  MarketplacePackageBundleV2Schema,
  MarketplacePackageBundleV3Schema,
  MarketplacePackageIdSchema,
  MarketplacePackageManifestSchema,
  MarketplacePackageManifestV2Schema,
  MarketplacePackageManifestV3Schema,
  MarketplaceRoutingV3Schema,
  MarketplaceVersionSchema,
};

/**
 * Render the authoritative default auto-delegation block for a marketplace
 * manifest. Owner-configured orchestrator prompts and runtime display aliases
 * are runtime concerns and are intentionally not represented here.
 */
export function renderDefaultMarketplaceAutoDelegationBlock(
  manifest: MarketplacePackageManifest,
): string {
  return renderMarketplaceAutoDelegationBlock(manifest);
}

export const MARKETPLACE_REGISTRY_SCHEMA_VERSION = 3 as const;
export const DEFAULT_MARKETPLACE_REGISTRY_URL =
  'https://registry.ohmyopencodeslim.com/v2/' as const;
export const DEFAULT_MARKETPLACE_REGISTRY_V3_URL =
  'https://registry.ohmyopencodeslim.com/v3/' as const;
export const DEFAULT_MARKETPLACE_REGISTRY_URL_V3 =
  DEFAULT_MARKETPLACE_REGISTRY_V3_URL;
export const MARKETPLACE_REGISTRY_V3_SCHEMA_VERSION = 3 as const;

// The v2 endpoint intentionally remains v2-only. In particular, changing the
// union used by package parsing must not make old registry indexes accept v3.
const MarketplaceAgentSummarySchema = MarketplaceAgentManifestSummaryV2Schema;

/** Public catalog metadata; package prompts never enter the index. */
export const MarketplaceManifestSummarySchema = MarketplaceAgentSummarySchema;

/** Public catalog metadata for the future v3 registry endpoint. */
export const MarketplaceManifestSummaryV3Schema =
  MarketplaceAgentManifestSummaryV3Schema;

export const MarketplaceRegistryEntrySchema = z
  .object({
    id: MarketplacePackageIdSchema,
    version: MarketplaceVersionSchema,
    artifactPath: z
      .string()
      .regex(
        /^artifacts\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}\/[0-9A-Za-z.+-]+\.json$/,
        'Expected a deterministic registry artifact path',
      ),
    digest: z
      .object({
        algorithm: z.literal('sha256'),
        domain: z.literal(MARKETPLACE_DIGEST_DOMAIN),
        value: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    summary: MarketplaceManifestSummarySchema,
  })
  .strict();

export const MarketplaceRegistryEntryV3Schema = z
  .object({
    id: MarketplacePackageIdSchema,
    version: MarketplaceVersionSchema,
    artifactPath: z
      .string()
      .regex(
        /^artifacts\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}\/[0-9A-Za-z.+-]+\.json$/,
        'Expected a deterministic registry artifact path',
      ),
    digest: z
      .object({
        algorithm: z.literal('sha256'),
        domain: z.literal(MARKETPLACE_DIGEST_DOMAIN_V3),
        value: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    summary: MarketplaceManifestSummaryV3Schema,
  })
  .strict();

function validateRegistryEntries(
  entries: readonly {
    id: string;
    version: string;
    artifactPath: string;
    summary: { id: string; version: string };
  }[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position];
    const key = `${entry.id}@${entry.version}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries', position],
        message: `Duplicate registry entry ${key}`,
      });
    }
    seen.add(key);
    if (entry.artifactPath !== registryArtifactPath(entry.id, entry.version)) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries', position, 'artifactPath'],
        message: `Artifact path must be ${registryArtifactPath(entry.id, entry.version)}`,
      });
    }
    if (
      entry.summary.id !== entry.id ||
      entry.summary.version !== entry.version
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries', position, 'summary'],
        message: 'Summary identity must match the registry entry',
      });
    }
    const previous = entries[position - 1];
    if (
      previous &&
      (compareMarketplaceCodeUnits(previous.id, entry.id) > 0 ||
        (previous.id === entry.id &&
          (compare(previous.version, entry.version) > 0 ||
            (compare(previous.version, entry.version) === 0 &&
              compareMarketplaceCodeUnits(previous.version, entry.version) >=
                0))))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries', position],
        message: 'Registry entries must be sorted by ID then version',
      });
    }
  }
}

const MarketplaceRegistryIndexV2EndpointSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_REGISTRY_SCHEMA_VERSION),
    entries: z.array(MarketplaceRegistryEntrySchema).max(100_000),
    // Empty legacy retirement lists are accepted during the catalog migration;
    // non-empty lists are rejected so tombstones cannot enter the contract.
    retirements: z.array(z.never()).max(100_000).optional(),
  })
  .strict()
  .superRefine((index, ctx) => {
    validateRegistryEntries(index.entries, ctx);
  });

export const MarketplaceRegistryIndexSchema =
  MarketplaceRegistryIndexV2EndpointSchema;
export const MarketplaceRegistryEntryV2Schema = MarketplaceRegistryEntrySchema;
export const MarketplaceRegistryIndexV2Schema = MarketplaceRegistryIndexSchema;

export const MarketplaceRegistryIndexV3Schema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_REGISTRY_V3_SCHEMA_VERSION),
    entries: z.array(MarketplaceRegistryEntryV3Schema).max(100_000),
    retirements: z.array(z.never()).max(100_000).optional(),
  })
  .strict()
  .superRefine((index, ctx) => {
    validateRegistryEntries(index.entries, ctx);
  });

export type MarketplaceManifestSummary = z.infer<
  typeof MarketplaceManifestSummarySchema
>;
export type MarketplaceManifestSummaryV3 = z.infer<
  typeof MarketplaceManifestSummaryV3Schema
>;
export type MarketplaceRegistryEntry = z.infer<
  typeof MarketplaceRegistryEntrySchema
>;
export type MarketplaceRegistryEntryV2 = MarketplaceRegistryEntry;
export type MarketplaceRegistryEntryV3 = z.infer<
  typeof MarketplaceRegistryEntryV3Schema
>;
export type MarketplaceRegistryIndex = z.infer<
  typeof MarketplaceRegistryIndexSchema
>;
export type MarketplaceRegistryIndexV2 = MarketplaceRegistryIndex;
export type MarketplaceRegistryIndexV3 = z.infer<
  typeof MarketplaceRegistryIndexV3Schema
>;

export function canonicalizeMarketplaceRegistryIndex(
  index: MarketplaceRegistryIndex,
): string {
  return canonicalizeMarketplaceValue(index);
}

export function registryArtifactPath(id: string, version: string): string {
  const [publisher, name] = id.split('/');
  return `artifacts/${publisher}/${name}/${version}.json`;
}

export function projectMarketplaceManifestSummary(
  manifest: MarketplacePackageManifest,
): MarketplaceManifestSummary {
  const parsed =
    MarketplacePackageBundleV2Schema.shape.manifest.parse(manifest);
  const { prompt: _prompt, ...summary } = parsed;
  return summary as MarketplaceManifestSummary;
}

export function projectMarketplaceManifestSummaryV3(
  manifest: MarketplacePackageManifest,
): MarketplaceManifestSummaryV3 {
  const parsed =
    MarketplacePackageBundleV3Schema.shape.manifest.parse(manifest);
  const { prompt: _prompt, ...summary } = parsed;
  return summary as MarketplaceManifestSummaryV3;
}

export function createMarketplaceRegistryEntry(
  bundle: MarketplacePackageBundle,
): MarketplaceRegistryEntry {
  const parsed = MarketplacePackageBundleV2Schema.parse(bundle);
  return {
    id: parsed.manifest.id,
    version: parsed.manifest.version,
    artifactPath: registryArtifactPath(
      parsed.manifest.id,
      parsed.manifest.version,
    ),
    digest: {
      algorithm: 'sha256',
      domain: MARKETPLACE_DIGEST_DOMAIN,
      value: digestMarketplaceBundle(parsed),
    },
    summary: projectMarketplaceManifestSummary(parsed.manifest),
  };
}

export function createMarketplaceRegistryEntryV3(
  bundle: MarketplacePackageBundle,
): MarketplaceRegistryEntryV3 {
  const parsed = MarketplacePackageBundleV3Schema.parse(bundle);
  return {
    id: parsed.manifest.id,
    version: parsed.manifest.version,
    artifactPath: registryArtifactPath(
      parsed.manifest.id,
      parsed.manifest.version,
    ),
    digest: {
      algorithm: 'sha256',
      domain: MARKETPLACE_DIGEST_DOMAIN_V3,
      value: digestMarketplaceBundle(parsed),
    },
    summary: projectMarketplaceManifestSummaryV3(parsed.manifest),
  };
}

export function createMarketplaceRegistryIndex(
  entries: readonly MarketplaceRegistryEntry[],
): MarketplaceRegistryIndex {
  const sorted = [...entries].sort(
    (left, right) =>
      compareMarketplaceCodeUnits(left.id, right.id) ||
      compare(left.version, right.version) ||
      compareMarketplaceCodeUnits(left.version, right.version),
  );
  return parseMarketplaceRegistryIndex({
    schemaVersion: MARKETPLACE_REGISTRY_SCHEMA_VERSION,
    entries: sorted,
  });
}

export function createMarketplaceRegistryIndexV3(
  entries: readonly MarketplaceRegistryEntryV3[],
): MarketplaceRegistryIndexV3 {
  const sorted = [...entries].sort(
    (left, right) =>
      compareMarketplaceCodeUnits(left.id, right.id) ||
      compare(left.version, right.version) ||
      compareMarketplaceCodeUnits(left.version, right.version),
  );
  return parseMarketplaceRegistryIndexV3({
    schemaVersion: MARKETPLACE_REGISTRY_V3_SCHEMA_VERSION,
    entries: sorted,
  });
}

export function parseMarketplaceRegistryIndex(
  value: unknown,
): MarketplaceRegistryIndex {
  const result = MarketplaceRegistryIndexSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid marketplace registry index: ${result.error.message}`,
    );
  }
  return result.data;
}

export const parseMarketplaceRegistryIndexV2 = parseMarketplaceRegistryIndex;

export function parseMarketplaceRegistryIndexV3(
  value: unknown,
): MarketplaceRegistryIndexV3 {
  const result = MarketplaceRegistryIndexV3Schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid marketplace v3 registry index: ${result.error.message}`,
    );
  }
  return result.data;
}

export function validateMarketplaceRegistryEntry(
  entry: MarketplaceRegistryEntry,
  bundle: MarketplacePackageBundle,
): void {
  const parsed = MarketplacePackageBundleV2Schema.safeParse(bundle);
  if (!parsed.success)
    throw new Error(`Invalid marketplace artifact: ${parsed.error.message}`);
  const manifest = parsed.data.manifest;
  const summary = projectMarketplaceManifestSummary(manifest);
  if (
    manifest.id !== entry.id ||
    manifest.version !== entry.version ||
    entry.artifactPath !== registryArtifactPath(entry.id, entry.version)
  ) {
    throw new Error(
      'Marketplace artifact identity does not match registry entry',
    );
  }
  if (
    canonicalizeMarketplaceValue(summary) !==
    canonicalizeMarketplaceValue(entry.summary)
  ) {
    throw new Error(
      'Marketplace artifact summary does not match registry entry',
    );
  }
  const digest = digestMarketplaceBundle(parsed.data);
  if (entry.digest.value !== digest) {
    throw new Error(
      'Marketplace artifact digest does not match registry entry',
    );
  }
}

export function validateMarketplaceRegistryEntryV3(
  entry: MarketplaceRegistryEntryV3,
  bundle: MarketplacePackageBundle,
): void {
  const parsed = MarketplacePackageBundleV3Schema.safeParse(bundle);
  if (!parsed.success)
    throw new Error(`Invalid marketplace v3 artifact: ${parsed.error.message}`);
  const manifest = parsed.data.manifest;
  const summary = projectMarketplaceManifestSummaryV3(manifest);
  if (
    manifest.id !== entry.id ||
    manifest.version !== entry.version ||
    entry.artifactPath !== registryArtifactPath(entry.id, entry.version)
  ) {
    throw new Error(
      'Marketplace v3 artifact identity does not match registry entry',
    );
  }
  if (
    canonicalizeMarketplaceValue(summary) !==
    canonicalizeMarketplaceValue(entry.summary)
  ) {
    throw new Error(
      'Marketplace v3 artifact summary does not match registry entry',
    );
  }
  const digest = digestMarketplaceBundle(parsed.data);
  if (entry.digest.value !== digest) {
    throw new Error(
      'Marketplace v3 artifact digest does not match registry entry',
    );
  }
}

export interface MarketplaceRegistrySelector {
  id: string;
  version?: string;
}

export function parseMarketplaceRegistrySelector(
  selector: string,
): MarketplaceRegistrySelector {
  const value = selector.trim();
  const at = value.lastIndexOf('@');
  const id = at === -1 ? value : value.slice(0, at);
  const version = at === -1 ? undefined : value.slice(at + 1);
  const idResult = MarketplacePackageIdSchema.safeParse(id.toLowerCase());
  if (
    !idResult.success ||
    (version !== undefined &&
      !MarketplaceVersionSchema.safeParse(version).success)
  ) {
    throw new Error(`Invalid marketplace registry selector: ${selector}`);
  }
  return { id: idResult.data, ...(version ? { version } : {}) };
}

export function resolveMarketplaceRegistryEntry(
  index: MarketplaceRegistryIndex,
  selector: MarketplaceRegistrySelector,
  compatibility: { pluginVersion: string },
  minimumVersion?: string,
): MarketplaceRegistryEntry {
  const candidates = index.entries.filter(
    (entry) =>
      entry.id === selector.id &&
      (selector.version === undefined || entry.version === selector.version) &&
      (minimumVersion === undefined || gt(entry.version, minimumVersion)) &&
      satisfies(
        compatibility.pluginVersion,
        entry.summary.compatibility.plugin,
      ),
  );
  const selected = [...candidates].sort(
    (a, b) =>
      compare(b.version, a.version) ||
      compareMarketplaceCodeUnits(b.version, a.version),
  )[0];
  if (!selected) {
    throw new Error(
      `No compatible marketplace package found for ${selector.id}${selector.version ? `@${selector.version}` : ''}`,
    );
  }
  return selected;
}

export function resolveMarketplaceRegistryEntryV3(
  index: MarketplaceRegistryIndexV3,
  selector: MarketplaceRegistrySelector,
  compatibility: { pluginVersion: string },
  minimumVersion?: string,
): MarketplaceRegistryEntryV3 {
  const candidates = index.entries.filter(
    (entry) =>
      entry.id === selector.id &&
      (selector.version === undefined || entry.version === selector.version) &&
      (minimumVersion === undefined || gt(entry.version, minimumVersion)) &&
      satisfies(
        compatibility.pluginVersion,
        entry.summary.compatibility.plugin,
      ),
  );
  const selected = [...candidates].sort(
    (a, b) =>
      compare(b.version, a.version) ||
      compareMarketplaceCodeUnits(b.version, a.version),
  )[0];
  if (!selected) {
    throw new Error(
      `No compatible marketplace v3 package found for ${selector.id}${selector.version ? `@${selector.version}` : ''}`,
    );
  }
  return selected;
}
