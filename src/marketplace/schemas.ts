import { isAbsolute } from 'node:path';
import { valid, validRange } from 'semver';
import { z } from 'zod';
import { SUPPORTED_SPECIALIST_ROLES } from '../config/agent-roles';

export const MARKETPLACE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MARKETPLACE_LOCKFILE_SCHEMA_VERSION = 1 as const;
export const MARKETPLACE_ROLE_CONTRACT_VERSION = '1.0.0' as const;
export const MARKETPLACE_DIGEST_DOMAIN = 'marketplace-bundle-v1' as const;

const packageIdPattern =
  /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;

export const MarketplacePackageIdSchema = z
  .string()
  .trim()
  .regex(
    packageIdPattern,
    'Expected a canonical package ID such as author/name',
  );

export const MarketplaceVersionSchema = z
  .string()
  .refine(
    (version) => valid(version) !== null,
    'Expected an exact semantic version',
  );

export const MarketplaceRoleSchema = z.enum(SUPPORTED_SPECIALIST_ROLES);

const BoundedTextSchema = (max: number) => z.string().trim().min(1).max(max);

export const MarketplaceAuthorSchema = z
  .object({
    name: BoundedTextSchema(120),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  })
  .strict();

const UniqueBoundedStringArraySchema: z.ZodType<string[]> = z
  .array(z.string().trim().min(1).max(64))
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Values must be unique',
  });

function uniqueCapabilityArray<T extends z.ZodTypeAny>(
  itemSchema: T,
  max: number,
) {
  return z
    .array(itemSchema)
    .max(max)
    .refine((values) => new Set(values).size === values.length, {
      message: 'Values must be unique',
    });
}

const RequirementSetSchema = z
  .object({
    required: UniqueBoundedStringArraySchema.default([]),
    optional: UniqueBoundedStringArraySchema.default([]),
  })
  .strict();

export const MarketplaceRequirementsSchema = z
  .object({
    skills: RequirementSetSchema.default({ required: [], optional: [] }),
    mcps: RequirementSetSchema.default({ required: [], optional: [] }),
  })
  .strict()
  .superRefine((requirements, ctx) => {
    if (
      requirements.skills.required.some((skill) =>
        requirements.skills.optional.includes(skill),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['skills'],
        message: 'Required and optional skills must not overlap',
      });
    }
    if (
      requirements.mcps.required.some((mcp) =>
        requirements.mcps.optional.includes(mcp),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mcps'],
        message: 'Required and optional MCPs must not overlap',
      });
    }
  });

export const MarketplaceCapabilityRequestSchema = z
  .object({
    tools: uniqueCapabilityArray(
      z.enum([
        'read',
        'glob',
        'grep',
        'ast_grep_search',
        'webfetch',
        'websearch',
      ]),
      6,
    ).default([]),
    permissions: uniqueCapabilityArray(
      z.enum([
        'filesystem.read',
        'filesystem.write',
        'network.fetch',
        'session.delegate',
      ]),
      4,
    ).default([]),
  })
  .strict()
  .default({ tools: [], permissions: [] });

export const MarketplaceCompatibilitySchema = z
  .object({
    plugin: BoundedTextSchema(64).refine(
      (range) => validRange(range) !== null,
      'Expected a valid plugin semantic-version range',
    ),
    roleContract: BoundedTextSchema(64).refine(
      (range) => validRange(range) !== null,
      'Expected a valid role-contract semantic-version range',
    ),
  })
  .strict();

export const MarketplaceRoutingSchema = z
  .object({
    description: BoundedTextSchema(500),
    keywords: UniqueBoundedStringArraySchema.default([]),
    delegation: z
      .object({
        when: BoundedTextSchema(500),
        preferredRoles: z.array(MarketplaceRoleSchema).max(6).default([]),
      })
      .strict(),
  })
  .strict();

export const MarketplaceAgentOverridesSchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    variant: z.string().trim().min(1).max(100).optional(),
    temperature: z.number().min(0).max(2).optional(),
    displayName: BoundedTextSchema(120).optional(),
    description: BoundedTextSchema(500).optional(),
  })
  .strict()
  .default({});

const ManifestBaseSchema = z.object({
  schemaVersion: z
    .literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION)
    .default(MARKETPLACE_MANIFEST_SCHEMA_VERSION),
  id: MarketplacePackageIdSchema,
  version: MarketplaceVersionSchema,
  displayName: BoundedTextSchema(120),
  description: BoundedTextSchema(1000),
  instructions: BoundedTextSchema(100_000),
  author: MarketplaceAuthorSchema,
  tags: UniqueBoundedStringArraySchema,
  license: BoundedTextSchema(64),
  compatibility: MarketplaceCompatibilitySchema,
  routing: MarketplaceRoutingSchema,
  requirements: MarketplaceRequirementsSchema,
  capabilities: MarketplaceCapabilityRequestSchema,
});

export const MarketplaceAgentManifestSchema = ManifestBaseSchema.extend({
  kind: z.literal('agent'),
  baseRole: MarketplaceRoleSchema,
  agentName: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Expected a valid agent name'),
  overrides: MarketplaceAgentOverridesSchema,
}).strict();

export const MarketplaceProfileManifestSchema = ManifestBaseSchema.extend({
  kind: z.literal('profile'),
  targetRole: MarketplaceRoleSchema,
  instructionMode: z.enum(['append', 'replace']),
  overrides: MarketplaceAgentOverridesSchema,
}).strict();

export const MarketplacePackageManifestSchema = z.discriminatedUnion('kind', [
  MarketplaceAgentManifestSchema,
  MarketplaceProfileManifestSchema,
]);

/**
 * A package bundle deliberately contains only its manifest. There is no
 * executable entrypoint, hook, script, or arbitrary file payload in V3.
 */
export const MarketplacePackageBundleSchema = z
  .object({ manifest: MarketplacePackageManifestSchema })
  .strict();

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
    registry: z.string().trim().min(1).max(200),
    packageUrl: z.string().url().optional(),
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

export const MarketplaceDigestSchema = z
  .object({
    algorithm: z.literal('sha256'),
    domain: z.literal(MARKETPLACE_DIGEST_DOMAIN),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const MarketplaceLockEntrySchema = z
  .object({
    manifestSchemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION),
    manifestVersion: MarketplaceVersionSchema,
    source: MarketplaceSourceSchema,
    digest: MarketplaceDigestSchema,
  })
  .strict();

export const MarketplaceLockfileSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_LOCKFILE_SCHEMA_VERSION),
    packages: z.record(MarketplacePackageIdSchema, MarketplaceLockEntrySchema),
  })
  .strict();

export type MarketplacePackageId = z.infer<typeof MarketplacePackageIdSchema>;
export type MarketplaceVersion = z.infer<typeof MarketplaceVersionSchema>;
export type MarketplaceRole = z.infer<typeof MarketplaceRoleSchema>;
export type MarketplaceAgentManifest = z.infer<
  typeof MarketplaceAgentManifestSchema
>;
export type MarketplaceProfileManifest = z.infer<
  typeof MarketplaceProfileManifestSchema
>;
export type MarketplacePackageManifest = z.infer<
  typeof MarketplacePackageManifestSchema
>;
export type MarketplacePackageBundle = z.infer<
  typeof MarketplacePackageBundleSchema
>;
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;
export type MarketplaceDigest = z.infer<typeof MarketplaceDigestSchema>;
export type MarketplaceLockEntry = z.infer<typeof MarketplaceLockEntrySchema>;
export type MarketplaceLockfile = z.infer<typeof MarketplaceLockfileSchema>;
