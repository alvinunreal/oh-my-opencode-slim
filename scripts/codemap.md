# scripts/

## Responsibility

- Maintain repository-level build, packaging, and release validation automation.
- Generate derived artifacts from source-of-truth types/schemas and verify that published outputs remain host-safe.
- Provide pre- and post-packaging checks that prevent leaking local paths and validate plugin installability in external
  OpenCode runtimes.

## Design

- `generate-schema.ts`
  - Imports `PluginConfigSchema` from `src/config/schema.ts` and emits canonical JSON Schema via `z.toJSONSchema`.
  - Writes `oh-my-opencode-ultraslim.schema.json` with explicit `$schema`, `title`, and plugin description.
- `verify-release-artifact.ts`
  - Uses `spawnSync` + `npm pack --json --ignore-scripts`.
  - Scans `dist/**/*` for leaked machine paths (`/Users/*`, `/home/*`).
  - Validates required package payload keys (`package.json`, `dist/index.js`, `README.md`, `LICENSE`,
    `src/skills/codemap/SKILL.md`, `src/skills/simplify/SKILL.md`, etc.).
  - Performs clean install smoke by importing the installed `dist/index.js` default export in a temp project.
- `verify-opencode-host-smoke.ts`
  - Builds temporary OpenCode environment (bin from `bun add opencode-ai`), mounts the plugin tarball,
    launches `opencode serve`, and probes `http://127.0.0.1:<port>/global/health`.
  - Captures logs and fails on `failed to load plugin` and `cannot find module` patterns.
- All scripts are executable boundary files (`#!/usr/bin/env bun` / Node), with explicit temp-dir lifecycle management
  and defensive cleanup via `rmSync(..., { force: true, recursive: true })`.

## Flow

- `bun run build` invokes `scripts/generate-schema.ts` through `package.json#generate-schema` after type declaration generation.
- `bun run verify:release` runs `verify-release-artifact.ts`: sanitize dist -> pack artifact -> validate files -> install/import check.
- `bun run verify:host-smoke` runs `verify-opencode-host-smoke.ts`: pack tarball -> boot isolated host -> wait for health -> verify no plugin-load errors.
- Both verification scripts are non-interactive and designed for CI/CD pre-publish gates.

## Integration

- Bound to `package.json` scripts for local dev and release pipelines.
- Release verification depends on build outputs from `bun run build:plugin` and `bun run build:cli` because it expects
  `dist/index.js`, `dist/cli/index.js`, and generated schema.
- Package integrity expectations are mirrored by tests and release scripts that assert packaged skill metadata and
  runtime files are present.
- Smoke checks instantiate the same plugin entrypoint (`dist/index.js`) that `src/index.ts` exports,
  catching runtime breakage before publishing.
