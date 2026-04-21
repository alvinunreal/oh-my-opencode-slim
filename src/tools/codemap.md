# src/tools/

## Responsibility

- Expose plugin tool definitions for code intelligence and workflow tooling from
  `src/tools/index.ts`.
- Publish three operational domains:
  - AST pattern search/replace via `ast-grep/`.
  - URL fetch/transform via `smartfetch/` with optional secondary-model pass.
  - Council orchestration via `createCouncilTool` (`council.ts`).

## Design

- `src/tools/index.ts` is the export surface and re-exports:
  - `ast_grep_search`, `ast_grep_replace`.
  - `createWebfetchTool`.
  - `createCouncilTool`.
- Shared schema contract: tool definitions are typed with `@opencode-ai/plugin`/`@opencode-ai/plugin/tool` and return `ToolDefinition` objects.

### AST-grep stack (`ast-grep/`)

- `cli.ts` owns execution path (`runSg`, `getAstGrepPath`, background init).
- `constants.ts` centralizes binary resolution, execution limits, and formatting helpers.
- `downloader.ts` handles release metadata lookup, download, and extraction for missing CLI.
- `utils.ts` formats matches/replacements for user-facing output.

### Smartfetch stack (`smartfetch/`)

- `tool.ts` owns permission prompts, cache check, fetch orchestration, binary/content branching.
- `network.ts` enforces redirect policy, response size caps, and binary/content detection.
- `cache.ts` memoizes by normalized URL + behavior-affecting options (`CACHE`).
- `utils.ts` performs extraction/normalization of text/markdown/html payloads.
- `binary.ts` stores binary payloads and returns deterministic metadata.
- `secondary-model.ts` drives optional post-fetch summarization with fallback.

## Flow

- **AST-grep path**
  - Tool call resolves schema input and invokes `runSg`.
  - `runSg` resolves CLI binary, executes with timeout, parses JSON results,
    then renders search/replace output.

- **Smartfetch path**
  - Permission + timeout + cache checks in `createWebfetchTool`.
  - Respect preferred `llms.txt` probing and redirect constraints.
  - Apply content-type branching and optional secondary-model summarization.
  - Emit text markdown/html, metadata message, or binary metadata handle.

- **Council tool path**
  - `createCouncilTool` checks caller context (`orchestrator`/`council`) and
    invokes `CouncilManager.runCouncil` with parent session context.

## Integration

- `src/index.ts` registers these tools into the plugin tool surface.
- `src/council/council-manager.ts` consumes `createCouncilTool` output for
  explicit consensus runs.
- Tests and agents import from `src/tools/*` for type-safe contracts and fixture-driven execution.
