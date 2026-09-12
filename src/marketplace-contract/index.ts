import { compare, gt, satisfies } from 'semver';
import { z } from 'zod';
import {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
} from '../marketplace/canonical';
import { MarketplaceRetiredError } from '../marketplace/errors';
import { isMarketplacePackageRetired } from '../marketplace/retirements';
import {
  MARKETPLACE_DIGEST_DOMAIN,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION,
  MarketplaceAgentManifestSchema,
  MarketplaceAgentManifestSummarySchema,
  type MarketplaceDigest,
  MarketplaceDigestSchema,
  type MarketplacePackageBundle,
  MarketplacePackageBundleSchema,
  type MarketplacePackageId,
  MarketplacePackageIdSchema,
  type MarketplacePackageManifest,
  MarketplacePackageManifestSchema,
  type MarketplaceVersion,
  MarketplaceVersionSchema,
} from '../marketplace/schemas';

export type {
  MarketplaceDigest,
  MarketplacePackageBundle,
  MarketplacePackageId,
  MarketplacePackageManifest,
  MarketplaceVersion,
};
export {
  canonicalizeMarketplaceBundle,
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
  MARKETPLACE_DIGEST_DOMAIN,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION,
  MarketplaceAgentManifestSchema,
  MarketplaceDigestSchema,
  MarketplacePackageBundleSchema,
  MarketplacePackageIdSchema,
  MarketplacePackageManifestSchema,
  MarketplaceVersionSchema,
};

export const MARKETPLACE_REGISTRY_SCHEMA_VERSION = 3 as const;
export const DEFAULT_MARKETPLACE_REGISTRY_URL =
  'https://registry.ohmyopencodeslim.com/v2/' as const;

const MarketplaceAgentSummarySchema = MarketplaceAgentManifestSummarySchema;

/** Public catalog metadata; package prompts never enter the index. */
export const MarketplaceManifestSummarySchema = MarketplaceAgentSummarySchema;

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

export const MarketplaceRegistryRetirementSchema = z
  .object({ id: MarketplacePackageIdSchema })
  .strict();

function validateRegistryEntries(
  entries: readonly MarketplaceRegistryEntry[],
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

const CANONICAL_MARKETPLACE_RETIREMENT_IDS = [
  'alvin/deepwork-implementer',
  'alvin/deepwork-recon',
  'alvin/deepwork-reviewer',
] as const;

const MarketplaceRegistryIndexV3Schema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_REGISTRY_SCHEMA_VERSION),
    entries: z.array(MarketplaceRegistryEntrySchema).max(100_000),
    retirements: z.array(MarketplaceRegistryRetirementSchema).max(100_000),
  })
  .strict()
  .superRefine((index, ctx) => {
    validateRegistryEntries(index.entries, ctx);
    const seen = new Set<string>();
    for (let position = 0; position < index.retirements.length; position += 1) {
      const retirement = index.retirements[position];
      if (seen.has(retirement.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['retirements', position],
          message: `Duplicate marketplace retirement ${retirement.id}`,
        });
      }
      seen.add(retirement.id);
      const previous = index.retirements[position - 1];
      if (
        previous &&
        compareMarketplaceCodeUnits(previous.id, retirement.id) >= 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['retirements', position],
          message: 'Marketplace retirements must be sorted by ID',
        });
      }
    }
    for (const id of CANONICAL_MARKETPLACE_RETIREMENT_IDS) {
      if (!seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['retirements'],
          message: `Registry must contain canonical retirement ${id}`,
        });
      }
    }
  });

export const MarketplaceRegistryIndexSchema = MarketplaceRegistryIndexV3Schema;

export type MarketplaceManifestSummary = z.infer<
  typeof MarketplaceManifestSummarySchema
>;
export type MarketplaceRegistryEntry = z.infer<
  typeof MarketplaceRegistryEntrySchema
>;
export type MarketplaceRegistryRetirement = z.infer<
  typeof MarketplaceRegistryRetirementSchema
>;
export type MarketplaceRegistryIndex = z.infer<
  typeof MarketplaceRegistryIndexSchema
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
  const parsed = MarketplacePackageBundleSchema.shape.manifest.parse(manifest);
  const { prompt: _prompt, ...summary } = parsed;
  return summary as MarketplaceManifestSummary;
}

export function createMarketplaceRegistryEntry(
  bundle: MarketplacePackageBundle,
): MarketplaceRegistryEntry {
  const parsed = MarketplacePackageBundleSchema.parse(bundle);
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

export function createMarketplaceRegistryIndex(
  entries: readonly MarketplaceRegistryEntry[],
  retirements: readonly MarketplaceRegistryRetirement[] = CANONICAL_MARKETPLACE_RETIREMENT_IDS.map(
    (id) => ({ id }),
  ),
): MarketplaceRegistryIndex {
  const sorted = [...entries].sort(
    (left, right) =>
      compareMarketplaceCodeUnits(left.id, right.id) ||
      compare(left.version, right.version) ||
      compareMarketplaceCodeUnits(left.version, right.version),
  );
  const sortedRetirements = [...retirements].sort((left, right) =>
    compareMarketplaceCodeUnits(left.id, right.id),
  );
  return parseMarketplaceRegistryIndex({
    schemaVersion: MARKETPLACE_REGISTRY_SCHEMA_VERSION,
    entries: sorted,
    retirements: sortedRetirements,
  });
}

export function retiredMarketplaceRegistryIds(
  index: MarketplaceRegistryIndex,
): ReadonlySet<string> {
  return new Set(index.retirements.map(({ id }) => id));
}

export function isMarketplaceRegistryIdRetired(
  index: MarketplaceRegistryIndex,
  id: string,
): boolean {
  return retiredMarketplaceRegistryIds(index).has(id);
}

export function filterMarketplaceRegistryEntries(
  index: MarketplaceRegistryIndex,
): MarketplaceRegistryEntry[] {
  const retired = retiredMarketplaceRegistryIds(index);
  return index.entries.filter((entry) => !retired.has(entry.id));
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

export function validateMarketplaceRegistryEntry(
  entry: MarketplaceRegistryEntry,
  bundle: MarketplacePackageBundle,
): void {
  const parsed = MarketplacePackageBundleSchema.safeParse(bundle);
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
  if (
    isMarketplacePackageRetired(selector.id) ||
    isMarketplaceRegistryIdRetired(index, selector.id)
  ) {
    throw new MarketplaceRetiredError(
      `${selector.id}${selector.version ? `@${selector.version}` : ''} is retired and cannot be installed`,
    );
  }
  const candidates = filterMarketplaceRegistryEntries(index).filter(
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
