# src/tools/smartfetch/

## Responsibility

- Implement the built-in `webfetch` tool: fetch remote documents, enforce redirect/origin policy, probe `llms.txt` when useful, and return normalized text/markdown/html output (`tool.ts`, `network.ts`).
- Handle content shaping around that fetch step: HTML extraction, metadata/frontmatter rendering, heading cleanup, cache keying, binary persistence, and secondary-model fallback (`utils.ts`, `cache.ts`, `binary.ts`, `secondary-model.ts`).

## Design Patterns and Decisions

- **One orchestration entrypoint:** `createWebfetchTool` in `tool.ts` owns permission prompts, cache lookup/revalidation, llms.txt preference logic, binary-vs-text branching, metadata emission, and optional secondary-model summarization.
- **Transport/policy split from rendering:** `network.ts` focuses on URL normalization, redirect allowlists, charset/body decoding, header extraction, and llms.txt probing, while `utils.ts` focuses on turning fetched content into cleaned text/markdown/html plus frontmatter and user-facing messages.
- **Cache keyed by fetch shape:** `cache.ts` keys fetches by URL plus behavior-affecting options (`extract_main`, `prefer_llms_txt`, `save_binary`), while render format is derived from the cached fetch result so text/markdown/html do not force redundant network requests.
- **Graceful degradation:** missing/invalid `llms.txt`, blocked redirects, metadata-only binary responses, and secondary-model failures all return a usable result instead of throwing away the fetched content.

## Data & Control Flow

1. `createWebfetchTool` normalizes the requested URL, derives permission patterns/allowed origins, asks for `webfetch` permission, and computes the cache key (`tool.ts`, `network.ts`, `cache.ts`).
2. If `prefer_llms_txt` applies, `probeLlmsText` tries `/llms-full.txt` then `/llms.txt`, following only permitted redirects and rejecting HTML/login-wall responses (`network.ts`).
3. When the tool falls back to the page itself, `fetchWithUpgradeFallback` handles HTTPS upgrade fallback, redirect enforcement, conditional headers for revalidation, binary detection, and bounded body reads (`network.ts`, `tool.ts`).
4. Text/HTML payloads are decoded and normalized through `extractFromHtml`, `cleanFetchedMarkdown`, `extractHeadingsFromMarkdown`, `frontmatter`, and `joinRenderedContent`; binary payloads optionally persist via `saveBinary` and return a metadata message (`utils.ts`, `binary.ts`, `tool.ts`).
5. If the caller supplied a prompt and configured secondary models, `runSecondaryModelWithFallback` truncates input to a bounded size, disables tool access for the helper session, retries across configured models, and the tool degrades back to base fetched content if that step fails (`secondary-model.ts`, `tool.ts`).

## Integration Points

- `src/index.ts` registers the tool under the public name `webfetch`, so agents can call it alongside background, LSP, and AST-grep tools.
- `src/tools/smartfetch/index.ts` re-exports the tool factory, description, and shared types for other modules or docs to import without reaching into implementation files.
- `secondary-model.ts` depends on the OpenCode plugin client (`PluginInput['client']`) to spawn an isolated helper session, resolve `small_model` from the effective OpenCode config, and resolve `explorer` / `librarian` fallbacks from slim's own plugin config loader.
- `cache.ts`, `network.ts`, and `utils.ts` are intentionally reusable seams for tests: cache behavior, redirect policy, llms probing, heading extraction, and render/metadata helpers can be verified without hitting the full tool entrypoint.
