# Marketplace package contract

The package exposes its marketplace data contract from the
`oh-my-opencode-slim/marketplace-contract` subpath. This entry point is intended
for tooling that needs to parse, validate, canonicalize, or inspect marketplace
package and registry data without importing the OpenCode plugin entry point.

```ts
import {
  MarketplacePackageBundleSchema,
  MarketplaceRegistryIndexSchema,
  digestMarketplaceBundle,
  parseMarketplaceRegistryIndex,
} from 'oh-my-opencode-slim/marketplace-contract';
```

The export includes the package and registry Zod schemas and associated types,
canonicalization and digest helpers, manifest-summary projection, registry
entry/index helpers, selector parsing, and compatibility-based registry entry
resolution. The V2 and V3 schema/API variants are exported separately where
their wire formats differ. The registry contract validates package identity,
version compatibility, deterministic artifact paths, digests, and ordered
registry entries.

## Canonical bundle digest

Parse an input with the matching V2 or V3 package-bundle schema before
canonicalizing or hashing it. The canonical text is JSON with object keys
recursively sorted by JavaScript string comparison (UTF-16 code units); array
order is preserved. Primitive and string encoding follows ECMAScript
`JSON.stringify`. Undefined-valued object properties are omitted. Values
outside the JSON data model (including undefined array elements, non-finite
numbers, non-plain objects, accessors, symbol keys, and cycles) are rejected.

The parsed manifest prompt is preserved exactly as a JavaScript string:
it must contain non-whitespace content and be at most 100,000 characters, but
leading indentation, trailing newlines, CRLF sequences, and other whitespace
are not trimmed or normalized. Prompt whitespace is part of the canonical
bundle and therefore changes its digest.

The SHA-256 digest is over the UTF-8 bytes of that exact canonical text, with no
BOM and no trailing newline. Unicode is not normalized: canonically equivalent
but differently encoded strings remain distinct. For example, the canonical
text retains the decomposed `e` plus combining acute accent in the vector
fixture. ECMAScript number encoding applies, so `-0` is encoded as `0`.

The digest domain (`marketplace-agent-bundle-v2` or
`marketplace-agent-bundle-v3`) is metadata in the registry digest object; it is
not prepended to or otherwise included in the bytes being hashed. Fixed
schema-parsed V2/V3 input bundles, their exact canonical texts, and literal
SHA-256 vectors are covered by `src/marketplace/canonical.test.ts`.

## Registry version selection

An unpinned selector resolves to the highest compatible package version by
Semantic Versioning precedence, including prereleases. An exact version pin
selects that version, and `minimumVersion` is an exclusive lower bound. These
rules apply to both V2 and V3 registry indexes.

This is a data-contract export only. It does not install or activate packages,
provide a marketplace CLI, or expose a registry lifecycle service.
