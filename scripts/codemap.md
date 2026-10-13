# scripts/

## Responsibility

Maintain repository-level build, packaging, and release validation automation. Generate derived artifacts from source-of-truth types/schemas and verify that published outputs remain host-safe. Provide pre- and post-packaging checks that prevent leaking local paths and validate plugin installability in external OpenCode runtimes.

## Design

- `generate-schema.ts`
  - Imports PluginConfigSchema from src/config/schema.ts and emits canonical JSON Schema via z.toJSONSchema.
  - Writes oh-my-opencode-slim.schema.json with explicit $schema, title, and plugin description.
- `verify-release-artifact.ts`
  - Uses spawnSync + npm pack --json --ignore-scripts.
  - Scans dist/**/* for leaked machine paths (/Users/*, /home/*).
  - Validates required package payload keys (package.json, dist/index.js, README.md, LICENSE,
    src/skills/codemap/SKILL.md, src/skills/simplify/SKILL.md, etc.).
  - Performs clean install smoke by importing the installed server entry with Node and the optional OpenTUI-backed
    ./tui entry with Bun in a temp project.
- `check-companion-release.mjs`
  - Queries the GitHub release API and verifies all five uploaded native archives.
  - Retries 404/temporary HTTP and transport errors, but fails closed on
    persistent API errors rather than triggering a spurious native patch build.
  - Covered by `check-companion-release.test.ts` (complete, incomplete,
    missing, transient failures, and authorization failures).
- `verify-companion-source.mjs`
  - Compares release-affecting Rust/native assets and dependencies against the
    manifest's immutable Companion tag. Ignores only crate version stamps.
  - Fails before npm versioning and publishing when native sources outpace the
    released executable. Also powers the automatic native release drift gate.
- `prepare-companion-release.mjs`
  - Stamps the new version into Cargo.toml and Cargo.lock for native builds.
  - With published assets supplied, computes SHA256 checksums and generates the
    packaged JSON plus TypeScript fallback manifests for the release PR.
- `companion-release-scripts.test.ts`
  - Covers native source/tag drift detection, version-only exceptions, and
    digest generation against real fixture archive bytes.
- `verify-companion-manifest.ts`
  - Verifies the packaged Companion manifest matches `companion/Cargo.toml` and the
    TypeScript fallback manifest.
  - Requires the complete supported release-asset set and valid SHA-256 digests.
  - Runs from `prepublishOnly` so npm publish fails closed on stale Companion metadata.
- `verify-opencode-host-smoke.ts`
  - Builds temporary OpenCode environment (bin from bun add opencode-ai), mounts the plugin tarball,
    launches opencode serve, and probes http://127.0.0.1:<port>/global/health.
  - Uses OPENCODE_SMOKE_VERSION when set so scheduled CI can test the pinned supported host and latest-host canary;
    defaults to latest for local and release smoke runs.
  - Captures logs and fails on failed to load plugin and cannot find module patterns.
- `benchmark-opencode-cache.ts`
  - Executes baseline provider runs and benchmarks cache-hit rates across multiple scenarios.
  - Reports per-provider cache effectiveness: ratios of cache reads to total requests, identifies plateaus
    (issue #874 signature), and flags suspect large-prompt requests with zero cache reads.
- `cache-smoke.ts`
  - Live end-to-end probe answering "is provider prompt caching working reliably?"
  - Runs real sessions through the OpenCode server, captures request/response logs, and runs the cache smoke
    verifier: plateau detection + suspect large-prompt detection + coverage reporting.
  - Measures real-world cache effectiveness on current model instances with default settings.
- `e2e-windows-spawn.ts`
  - Manual end-to-end check for the Windows crossSpawn fix.
  - Reproduces the auto-updater failure: bun on PATH only as npm .cmd shims (no real bun.exe in any PATH directory).
  - Temporarily hides any bun.exe in the npm shim directory, then runs crossSpawn(['bun', ...]).
  - Expected on Windows: exit 0 and a printed bun version.
  - Before the fix: spawn error ENOENT for 'bun'.
- `gen-build-info.ts`
  - Generates src/generated/build-info.ts: the plugin version (from package.json) and the build timestamp
    as two string constants, so runtime logs can identify the exact build that produced them.
  - Runs as the first step of bun run build. The committed stamp is owned by postversion, which re-runs this script
    with --force and amends the release commit.
  - Keeps repeated dev builds from dirtying tracked source; BUILD_TIME identifies the release stamp, not each local build.
- `verify-opencode-cache-stability.ts`
  - Runs extended cache smoke runs across varied payloads, models, and tools to detect cache degradation
    or anomalies in the caching layer across different provider sessions.
  - Performs continuous monitoring to ensure cache hit rates and plateau detection remain within expected bounds.
- All scripts are executable boundary files (#!/usr/bin/env bun / Node), with explicit temp-dir lifecycle management
  and defensive cleanup via rmSync(..., { force: true, recursive: true }).

## Flow

- `bun run build` invokes generate-schema.ts through package.json#generate-schema after type declaration generation.
- `bun run gen:build-info` runs gen-build-info.ts: version + timestamp stamp into src/generated/build-info.ts.
- `bun run verify:release` runs verify-release-artifact.ts: sanitize dist -> pack artifact -> validate files ->
  install/import both server and TUI entrypoints.
- `bun run verify:companion-manifest` runs verify-companion-manifest.ts before npm publish to keep
  the Rust crate, packaged manifest, fallback manifest, asset names, and checksums synchronized.
- `bun run verify:host-smoke` runs verify-opencode-host-smoke.ts: pack tarball -> boot isolated host -> wait for health ->
  verify no plugin-load errors.
- `bun run cache:smoke` runs cache-smoke.ts: start server -> run scenarios -> collect request logs ->
  run cache smoke analysis (plateaus + suspects) -> report verdict.
- `scripts/e2e-windows-spawn.ts` is invoked directly (`bun scripts/e2e-windows-spawn.ts`): cross-spawn bun on
  Windows with shimmed PATH; it has no package-script wrapper.
- `scripts/benchmark-opencode-cache.ts` is a separate, independent benchmark invoked directly; cache-smoke.ts
  does not invoke it.

## Integration

- Bound to package.json scripts for local dev and release pipelines.
- Release verification depends on build outputs from bun run build:plugin and bun run build:cli because it expects
  dist/index.js, dist/cli/index.js, and generated schema.
- Package integrity expectations are mirrored by tests and release scripts that assert packaged skill metadata and
  runtime files are present.
- Smoke checks instantiate the same server and TUI entrypoints (dist/index.js, dist/tui.js) the package exports,
  catching runtime or optional UI dependency breakage before publishing.
- Windows crossSpawn E2E validation ensures compatibility with npm PATH shim scenarios.
- Cache stability verification depends on successful smoke runs and benchmark outputs for release validation.
