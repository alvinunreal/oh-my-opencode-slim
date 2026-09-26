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

This is a data-contract export only. It does not install or activate packages,
provide a marketplace CLI, or expose a registry lifecycle service.
