import { valid, validRange } from 'semver';
import { z } from 'zod';
import { SUPPORTED_SPECIALIST_ROLES } from '../config/agent-roles.js';
import { AGENT_THEME_COLORS } from '../config/constants.js';
import { ProviderModelIdSchema } from '../config/model-id-schema.js';
import { MARKETPLACE_TOOL_NAMES } from './capabilities.js';
import { MarketplacePackageIdSchema } from './id-schema.js';

export { MARKETPLACE_TOOL_NAMES } from './capabilities.js';
export { MarketplacePackageIdSchema } from './id-schema.js';

export const MARKETPLACE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3 = 3 as const;
export const MARKETPLACE_DIGEST_DOMAIN = 'marketplace-agent-bundle-v2' as const;
export const MARKETPLACE_DIGEST_DOMAIN_V3 =
  'marketplace-agent-bundle-v3' as const;
export const MARKETPLACE_ROUTING_LINE_MAX_LENGTH = 256 as const;

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

/**
 * Stored builtin names are byte-faithful: legacy `librarian` packages keep
 * their published name so bundle digests stay stable across the merge.
 * Interpretation happens at activation — see
 * ActivatedMarketplacePackageManifestSchema.
 */
export const MarketplaceBuiltinSchema = z.enum([
  ...SUPPORTED_SPECIALIST_ROLES,
  'librarian',
] as const);
type MarketplaceBuiltin = z.infer<typeof MarketplaceBuiltinSchema>;

/**
 * Rename continuity: packages extending `librarian` extend the merged
 * `explorer` (which inherited librarian's role and MCPs). Warned once per
 * process.
 */
const MARKETPLACE_BUILTIN_RENAMES: Record<string, string> = {
  librarian: 'explorer',
};

/**
 * Pure legacy→merged builtin resolver. Store manifests are byte-faithful
 * (they may still carry old names), so every consumer that maps a builtin to
 * runtime behavior — activation parsing and manifest rendering alike — must
 * resolve before looking up. Only the activation schema warns.
 */
export function resolveMarketplaceBuiltin(value: string): string {
  return MARKETPLACE_BUILTIN_RENAMES[value] ?? value;
}

const warnedMarketplaceBuiltinRenames = new Set<string>();

export const ActivatedMarketplaceBuiltinSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const renamed = resolveMarketplaceBuiltin(value);
    if (renamed !== value && !warnedMarketplaceBuiltinRenames.has(value)) {
      warnedMarketplaceBuiltinRenames.add(value);
      console.warn(
        `[oh-my-opencode-slim] Marketplace builtin '${value}' was merged into '${renamed}'; the package now extends '${renamed}'. Update the manifest when convenient.`,
      );
    }
    return renamed;
  }
  return value;
}, z.enum(SUPPORTED_SPECIALIST_ROLES));

const BoundedTextSchema = (max: number) => z.string().trim().min(1).max(max);
const MarketplacePromptSchema = z
  .string()
  .max(100_000)
  .refine((prompt) => prompt.trim().length > 0, {
    message: 'Prompt must contain non-whitespace content',
  });
const SingleLineTextSchema = (max: number) =>
  z
    .string()
    .refine((value) => !/[\r\n]/.test(value), {
      message: 'Value must be a single-line string',
    })
    .trim()
    .min(1)
    .max(max);
const MarketplaceRoutingLineSchema = SingleLineTextSchema(
  MARKETPLACE_ROUTING_LINE_MAX_LENGTH,
);

const UniqueStringArraySchema = z
  .array(z.string().trim().min(1).max(200))
  .max(128)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Values must be unique',
  });

const UniqueSingleLineStringArraySchema = z
  .array(SingleLineTextSchema(200))
  .max(128)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Values must be unique',
  });

const MarketplaceToolSchema = z.enum(MARKETPLACE_TOOL_NAMES);

const MarketplaceAuthorSchema = z
  .object({
    name: BoundedTextSchema(120),
    email: z.string().email().optional(),
    url: z.string().url().optional(),
  })
  .strict();

const MarketplaceModelIdSchema = BoundedTextSchema(200).pipe(
  ProviderModelIdSchema,
);

export const MarketplaceModelCandidateSchema = z.union([
  MarketplaceModelIdSchema,
  z
    .object({
      id: MarketplaceModelIdSchema,
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

const MarketplaceModelPolicySchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('session') }).strict(),
  z.object({ source: z.literal('orchestrator') }).strict(),
  MarketplaceExplicitModelSchema,
  z.object({ source: z.literal('builtin') }).strict(),
]);

const MarketplaceCompatibilitySchema = z
  .object({
    plugin: BoundedTextSchema(64).refine(
      (range) => validRange(range) !== null,
      'Expected a valid plugin semantic-version range',
    ),
  })
  .strict();

const MarketplaceRoutingSchema = z
  .object({
    description: SingleLineTextSchema(500),
    when: SingleLineTextSchema(500),
    keywords: UniqueStringArraySchema,
  })
  .strict();

const UniqueRoutingLineArraySchema = z
  .array(MarketplaceRoutingLineSchema)
  .max(8)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Routing values must be unique',
  });

export const MarketplaceRoutingV3Schema = z
  .object({
    lane: MarketplaceRoutingLineSchema,
    stats: UniqueRoutingLineArraySchema.min(1),
    delegateWhen: UniqueRoutingLineArraySchema.min(1),
    avoid: UniqueRoutingLineArraySchema.min(1),
    additionalInstructions: UniqueRoutingLineArraySchema.optional(),
  })
  .strict();

const MarketplaceExtensionSchema = z
  .object({
    builtin: MarketplaceBuiltinSchema,
    promptMode: z.enum(['append', 'replace']),
  })
  .strict();

export const MarketplaceExtensionV3Schema = z
  .object({
    builtin: MarketplaceBuiltinSchema,
    promptMode: z.literal('append'),
  })
  .strict();

const ManifestFields = {
  id: MarketplacePackageIdSchema,
  version: MarketplaceVersionSchema,
  displayName: BoundedTextSchema(120),
  description: SingleLineTextSchema(1000),
  agentName: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Expected a valid agent name'),
  prompt: MarketplacePromptSchema,
  skills: UniqueSingleLineStringArraySchema,
  mcps: UniqueSingleLineStringArraySchema,
  tools: z
    .array(MarketplaceToolSchema)
    .max(MARKETPLACE_TOOL_NAMES.length)
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
    .union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.enum(AGENT_THEME_COLORS)])
    .optional(),
} as const;

const ManifestV2Schema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION),
    ...ManifestFields,
    routing: MarketplaceRoutingSchema,
  })
  .strict();

const ManifestV3Schema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3),
    ...ManifestFields,
    routing: MarketplaceRoutingV3Schema,
  })
  .strict();

function validateBuiltinModelPolicy(
  manifest: { model: MarketplaceModelPolicy; extends?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (manifest.model.source === 'builtin' && !manifest.extends) {
    ctx.addIssue({
      code: 'custom',
      path: ['model', 'source'],
      message: "model.source 'builtin' requires extends",
    });
  }
}

export const MarketplacePackageManifestV2Schema = ManifestV2Schema.extend({
  extends: MarketplaceExtensionSchema.optional(),
})
  .strict()
  .superRefine(validateBuiltinModelPolicy);

export const MarketplacePackageManifestV3Schema = ManifestV3Schema.extend({
  extends: MarketplaceExtensionV3Schema.optional(),
})
  .strict()
  .superRefine(validateBuiltinModelPolicy);

export const MarketplacePackageManifestSchema = z.discriminatedUnion(
  'schemaVersion',
  [MarketplacePackageManifestV2Schema, MarketplacePackageManifestV3Schema],
);

/**
 * Activation-level manifests: same shape as the stored manifest, but legacy
 * builtin names resolve to their merged role (librarian → explorer) so every
 * downstream consumer sees the active agent.
 */
export const ActivatedMarketplacePackageManifestSchema = z.discriminatedUnion(
  'schemaVersion',
  [
    ManifestV2Schema.extend({
      extends: MarketplaceExtensionSchema.extend({
        builtin: ActivatedMarketplaceBuiltinSchema,
      }).optional(),
    })
      .strict()
      .superRefine(validateBuiltinModelPolicy),
    ManifestV3Schema.extend({
      extends: MarketplaceExtensionV3Schema.extend({
        builtin: ActivatedMarketplaceBuiltinSchema,
      }).optional(),
    })
      .strict()
      .superRefine(validateBuiltinModelPolicy),
  ],
);

export type ActivatedMarketplacePackageManifest = z.infer<
  typeof ActivatedMarketplacePackageManifestSchema
>;

export const MarketplaceAgentManifestSummaryV2Schema = ManifestV2Schema.omit({
  prompt: true,
})
  .extend({ extends: MarketplaceExtensionSchema.optional() })
  .strict()
  .superRefine(validateBuiltinModelPolicy);

export const MarketplaceAgentManifestSummaryV3Schema = ManifestV3Schema.omit({
  prompt: true,
})
  .extend({ extends: MarketplaceExtensionV3Schema.optional() })
  .strict()
  .superRefine(validateBuiltinModelPolicy);

export const MarketplaceAgentManifestSummarySchema = z.discriminatedUnion(
  'schemaVersion',
  [
    MarketplaceAgentManifestSummaryV2Schema,
    MarketplaceAgentManifestSummaryV3Schema,
  ],
);

// Kept as the precise agent-manifest name for consumers of the public contract.
export const MarketplaceAgentManifestSchema = MarketplacePackageManifestSchema;

export const MarketplacePackageBundleSchema = z
  .object({ manifest: MarketplacePackageManifestSchema })
  .strict();

export const MarketplacePackageBundleV2Schema = z
  .object({ manifest: MarketplacePackageManifestV2Schema })
  .strict();

export const MarketplacePackageBundleV3Schema = z
  .object({ manifest: MarketplacePackageManifestV3Schema })
  .strict();

export const MarketplaceDigestSchema = z
  .object({
    algorithm: z.literal('sha256'),
    domain: z.literal(MARKETPLACE_DIGEST_DOMAIN),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const MarketplaceDigestV3Schema = z
  .object({
    algorithm: z.literal('sha256'),
    domain: z.literal(MARKETPLACE_DIGEST_DOMAIN_V3),
    value: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type MarketplacePackageId = z.infer<typeof MarketplacePackageIdSchema>;
export type MarketplaceVersion = z.infer<typeof MarketplaceVersionSchema>;
export type MarketplaceModelPolicy = z.infer<
  typeof MarketplaceModelPolicySchema
>;
type MarketplaceAgentManifestV2 = z.infer<
  typeof MarketplacePackageManifestV2Schema
>;
type MarketplaceAgentManifestV3 = z.infer<
  typeof MarketplacePackageManifestV3Schema
>;
export type MarketplacePackageManifest = z.infer<
  typeof MarketplacePackageManifestSchema
>;
export type MarketplacePackageManifestV2 = MarketplaceAgentManifestV2;
export type MarketplacePackageManifestV3 = MarketplaceAgentManifestV3;
export type MarketplacePackageBundle = z.infer<
  typeof MarketplacePackageBundleSchema
>;
export type MarketplaceDigest = z.infer<typeof MarketplaceDigestSchema>;
export type MarketplaceDigestV3 = z.infer<typeof MarketplaceDigestV3Schema>;
