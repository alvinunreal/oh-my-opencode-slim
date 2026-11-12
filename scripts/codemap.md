# scripts/

## Responsibility

Maintain repository-level build, packaging, and release validation automation. Generate derived artifacts from source-of-truth types/schemas and verify that published outputs remain host-safe. Provide pre- and post-packaging checks that prevent leaking local paths and validate plugin installability in external OpenCode runtimes.

## Design

- `generate-schema.ts`
  - Imports PluginConfigSchema from src/config/schema.ts and emits canonical JSON Schema via z.toJSONSchema.
  - Writes oh-my-opencode-slim.schema.json with explicit $schema, title, and plugin description.
- `package-imports.ts`
  - Uses Bun's import scanner to verify all static/dynamic relative targets are
    inside packed `dist/`, including hashed ESM chunks and nested edges.
  - Focused fixture tests live in `package-imports.test.ts`.
- `verify-release-artifact.ts`
  - Uses spawnSync + npm pack --json --ignore-scripts.
  - Scans dist/**/* for leaked machine paths (/Users/*, /home/*).
  - Validates required package payload keys (package.json, dist/index.js, README.md, LICENSE,
    src/skills/codemap/SKILL.md, src/skills/simplify/SKILL.md, etc.).
  - Performs clean install smoke by importing the installed server entry with Node and the optional OpenTUI-backed
    ./tui entry with Bun in a temp project.
- `check-companion-release.mjs`
  - Shared public native-repository API, release identity, archive hashing, and
    offline manifest validation helpers. Fails closed on API/incomplete releases.
  - Always queries `alvinunreal/oh-my-opencode-companion`, never the plugin repo.
- `verify-companion-release.mjs`
  - Verifies the pinned remote release identity and all five downloaded archive
    hashes before npm versioning/publishing; no local native files or Git tags.
- `sync-companion-manifest.mjs`
  - Reads the latest public native release, calculates actual archive hashes,
    updates both plugin manifests, and reports whether a plugin-local PR is needed.
  - Refuses downgrades and same-tag mutations; aligned manifests are untouched.
- `prepare-companion-release.mjs`
  - Requires five downloaded published archives, computes SHA256 checksums, and
    generates packaged JSON plus TypeScript fallback manifests only; no Cargo I/O.
- `companion-release-scripts.test.ts`
  - Covers plugin-only preparation/sync, no-op/fail-closed behavior, and extraction
    assumptions. `check-companion-release.test.ts` covers API/release/hash guards.
  - `companion-release-fixtures.ts` supplies deterministic release/archive fixtures.
- `verify-companion-manifest.ts`
  - Independently verifies packaged Companion metadata and TypeScript fallback
    consistency offline; does not need the native checkout or release tags.
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
- `verify-optional-loading.ts` / `optional-loading-probe.mjs`
  - Runs the built server entry in fresh Node processes across isolated feature matrices.
  - Separates Node coverage runs (evaluated module/byte totals) from timing samples; timing reports CPU/heap/code stats.
  - Fails verify mode when the fully disabled baseline no longer loads strictly fewer package bytes than the cold-gated controls.
- `verify-v2-native-lifecycle.ts`
  - Packed-artifact, headless OpenCode 2.2.6 lifecycle verification over a deterministic local model stub (the harness asserts that exact version; point `V2_LIFECYCLE_HOST` at a 2.2.6 binary when the installed host is newer).
  - Covers default/native/off child lifecycles, permission status/reply, restart recovery, explicit-managed startup rejection,
    and content-filter refusal fallback (foreground re-attach plus background result delivery).
  - Invoked directly (`bun scripts/verify-v2-native-lifecycle.ts [--modes=...] [--restart=running] [--self-check]`); no package-script wrapper.
- All scripts are executable boundary files (#!/usr/bin/env bun / Node), with explicit temp-dir lifecycle management
  and defensive cleanup via rmSync(..., { force: true, recursive: true }).

## Flow

- `bun run build` invokes generate-schema.ts through package.json#generate-schema after type declaration generation.
- `bun run gen:build-info` runs gen-build-info.ts: version + timestamp stamp into src/generated/build-info.ts.
- `bun run verify:release` runs verify-release-artifact.ts: sanitize dist -> pack artifact -> validate files ->
  install/import both server and TUI entrypoints.
- `bun run verify:companion-manifest` runs verify-companion-manifest.ts before npm publish to keep
  the packaged manifest, fallback manifest, asset names, and checksums synchronized offline.
- `bun run verify:companion-release` hashes the pinned standalone native release
  before npm versioning/publishing; `sync:companion-manifest` powers the scheduled/manual
  plugin-local manifest PR workflow without cross-repository write credentials.
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
