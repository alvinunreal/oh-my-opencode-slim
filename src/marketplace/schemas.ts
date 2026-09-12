import { isAbsolute } from 'node:path';
import { valid, validRange } from 'semver';
import { z } from 'zod';
import { SUPPORTED_SPECIALIST_ROLES } from '../config/agent-roles';
import { AGENT_THEME_COLORS } from '../config/constants';

export const MARKETPLACE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const MARKETPLACE_LOCKFILE_SCHEMA_VERSION = 2 as const;
export const MARKETPLACE_DIGEST_DOMAIN = 'marketplace-agent-bundle-v2' as const;

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
    (version) =>
      valid(version) !== null &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
        version,
      ),
    'Expected canonical exact semantic version spelling',
  );

export const MarketplaceBuiltinSchema = z.enum(SUPPORTED_SPECIALIST_ROLES);
export type MarketplaceBuiltin = z.infer<typeof MarketplaceBuiltinSchema>;

const BoundedTextSchema = (max: number) => z.string().trim().min(1).max(max);
const UniqueStringArraySchema = z
  .array(z.string().trim().min(1).max(200))
  .max(128)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Values must be unique',
  });

export const MARKETPLACE_TOOL_NAMES = [
  'read',
  'glob',
  'grep',
  'ast_grep_search',
  'edit',
  'write',
  'apply_patch',
  'ast_grep_replace',
  'bash',
  'webfetch',
  'websearch',
] as const;

const MarketplaceToolSchema = z.enum(MARKETPLACE_TOOL_NAMES);

export const MarketplaceAuthorSchema = z
  .object({
    name: BoundedTextSchema(120),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  })
  .strict();

export const MarketplaceModelCandidateSchema = z.union([
  BoundedTextSchema(200),
  z
    .object({
      id: BoundedTextSchema(200),
      variant: BoundedTextSchema(100).optional(),
    })
    .strict(),
]);

const MarketplaceExplicitModelSchema = z
  .object({
    source: z.literal('explicit'),
    candidates: z.array(MarketplaceModelCandidateSchema).min(1).max(16),
  })
  .strict();

export const MarketplaceModelPolicySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('session') }).strict(),
  z.object({ source: z.literal('orchestrator') }).strict(),
  MarketplaceExplicitModelSchema,
  z.object({ source: z.literal('builtin') }).strict(),
]);

export const MarketplaceCompatibilitySchema = z
  .object({
    plugin: BoundedTextSchema(64).refine(
      (range) => validRange(range) !== null,
      'Expected a valid plugin semantic-version range',
    ),
  })
  .strict();

export const MarketplaceRoutingSchema = z
  .object({
    description: BoundedTextSchema(500),
    when: BoundedTextSchema(500),
    keywords: UniqueStringArraySchema,
  })
  .strict();

export const MarketplaceExtensionSchema = z
  .object({
    builtin: MarketplaceBuiltinSchema,
    promptMode: z.enum(['append', 'replace']),
  })
  .strict();

const ManifestSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION),
    id: MarketplacePackageIdSchema,
    version: MarketplaceVersionSchema,
    displayName: BoundedTextSchema(120),
    description: BoundedTextSchema(1000),
    agentName: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Expected a valid agent name'),
    prompt: BoundedTextSchema(100_000),
    routing: MarketplaceRoutingSchema,
    skills: UniqueStringArraySchema,
    mcps: UniqueStringArraySchema,
    tools: z
      .array(MarketplaceToolSchema)
      .max(11)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Tools must be unique',
      }),
    author: MarketplaceAuthorSchema,
    tags: UniqueStringArraySchema,
    license: BoundedTextSchema(64),
    compatibility: MarketplaceCompatibilitySchema,
    model: MarketplaceModelPolicySchema,
    temperature: z.number().min(0).max(2).optional(),
    color: z
      .union([
        z.string().regex(/^#[0-9a-fA-F]{6}$/),
        z.enum(AGENT_THEME_COLORS),
      ])
      .optional(),
  })
  .strict();

export const MarketplacePackageManifestSchema = ManifestSchema.extend({
  extends: MarketplaceExtensionSchema.optional(),
})
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.model.source === 'builtin' && !manifest.extends) {
      ctx.addIssue({
        code: 'custom',
        path: ['model', 'source'],
        message: "model.source 'builtin' requires extends",
      });
    }
  });

export const MarketplaceAgentManifestSummarySchema = ManifestSchema.omit({
  prompt: true,
})
  .extend({ extends: MarketplaceExtensionSchema.optional() })
  .strict();

// Kept as the precise agent-manifest name for consumers of the public contract.
export const MarketplaceAgentManifestSchema = MarketplacePackageManifestSchema;

export const MarketplacePackageBundleSchema = z
  .object({
    manifest: MarketplacePackageManifestSchema,
  })
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
export type MarketplaceModelPolicy = z.infer<
  typeof MarketplaceModelPolicySchema
>;
export type MarketplaceAgentManifest = z.infer<
  typeof MarketplaceAgentManifestSchema
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
