## Responsibility

- Expose plugin tool definitions for code intelligence and workflow tooling from
  `src/tools/index.ts`.
- Publish and compose two primary operational domains:
  - AST pattern search/replace via `ast-grep/`.
  - URL fetch/transform with optional secondary model via `smartfetch/`.
- Provide runtime factories for orchestration helpers:
  - `createCouncilTool` (`council.ts`).

## Design

- `src/tools/index.ts` is the canonical export surface. It re-exports:
  - `ast_grep_search`, `ast_grep_replace`.
  - `createWebfetchTool`.
  - `createCouncilTool`.
- **Common tool schema pattern**: all tool files use `@opencode-ai/plugin/tool` or
  `@opencode-ai/plugin` `tool` with typed schemas and `ToolDefinition` objects.
- **AST-grep stack (`ast-grep/`)**:
  - `cli.ts` handles invocation flow via `runSg`, `getAstGrepPath`,
    `startBackgroundInit`.
  - `types.ts` defines `CliLanguage`, `CliMatch`, `SgResult`.
  - `constants.ts` owns binary resolution (`getSgCliPath`, `findSgCliPathSync`),
    limits (`DEFAULT_MAX_MATCHES`, `DEFAULT_MAX_OUTPUT_BYTES`, `DEFAULT_TIMEOUT_MS`).
  - `downloader.ts` implements `ensureAstGrepBinary` and release-specific
    fallback download.
  - `utils.ts` centralizes user-facing renderers.
- **Smartfetch stack (`smartfetch/`)**:
  - `tool.ts` defines `createWebfetchTool` and the complete execution path.
  - `network.ts` enforces redirect policy, read limits, HTML/binary detection,
    and `fetchWithRedirects`.
  - `cache.ts` uses `CACHE` (`LRUCache`) and `buildCacheKey` for memoization.
  - `utils.ts` normalizes and renders downloaded content (`extractFromHtml`,
    `cleanFetchedMarkdown`, `joinRenderedContent`).
  - `binary.ts` persists payloads with `saveBinary`.
  - `secondary-model.ts` runs
    `readSecondaryModelFromConfig`/`runSecondaryModelWithFallback`.

## Flow

- **AST-grep path**:
  - Tool executes (`ast_grep_search`/`ast_grep_replace`) and calls `runSg`.
  - `runSg` builds CLI args, resolves `sg` via sync cache/path checks,
    fallback download if missing, and executes with timeout.
  - JSON output is parsed into `SgResult`, respecting truncation/error states.
  - `formatSearchResult` / `formatReplaceResult` produce output.
- **Smartfetch path**:
  - `createWebfetchTool` validates permissions (`ctx.ask`) and timeout, reads
    secondary model candidates, then checks cache (`CACHE`).
  - If permitted, it probes llms docs, else performs fetch with redirect
    fallback and capped read size.
  - Response is decoded, content-type normalized, converted by format mode, and
    optionally passed to secondary model (`runSecondaryModelWithFallback`).
  - For binary, metadata-only or saved-result branches are selected based on
    `save_binary`, size, and MIME type.
- **Council**:
  - `createCouncilTool` enforces caller guard (`council` / `orchestrator`) before
    invoking `CouncilManager.runCouncil`.

## Integration

- `src/index.ts` imports these exports and injects them into plugin tool surfaces.
- OpenCode-facing dependencies used directly in these modules:
  - `@opencode-ai/plugin` / `@opencode-ai/plugin/tool` (`tool`, schemas).
  - `lru-cache`, `bun` runtime APIs, network stack.
  - DOM extraction libs in smartfetch.
- Consumers include orchestrator/council agents, `@opencode` task runners, and
  any extension tests that import tools/types from the `src/tools` modules.
