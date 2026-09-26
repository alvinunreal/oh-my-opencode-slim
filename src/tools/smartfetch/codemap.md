# src/tools/smartfetch/

## Responsibility

- Implement the built-in `webfetch` tool: fetch remote documents, enforce redirect/origin policy, probe `llms.txt` when useful, and return normalized text/markdown/html output (`tool.ts`, `network.ts`).
- Handle content shaping around that fetch step: HTML extraction, metadata/frontmatter rendering, heading cleanup, cache keying, binary persistence, and secondary-model fallback (`utils.ts`, `cache.ts`, `binary.ts`, `secondary-model.ts`).

## Design Patterns and Decisions

- **One orchestration entrypoint:** `createWebfetchTool` in `tool.ts` owns permission prompts, cache lookup, llms.txt preference logic, binary-vs-text branching, metadata emission, and optional secondary-model summarization.
- **Transport/policy split from rendering:** `network.ts` focuses on URL normalization, same-origin credential-free redirects, charset/body decoding, header extraction, and llms.txt probing, while `utils.ts` focuses on turning fetched content into cleaned text/markdown/html plus frontmatter and user-facing messages.
- **Cache keyed by fetch shape:** `cache.ts` keys pages by URL and request/representation options (`format`, `extract_main`, `prefer_llms_txt`, `save_binary`). Pages negotiate different `Accept` headers; llms.txt uses its own text `Accept` and a format-independent key, shared across output formats.
- **Graceful degradation:** missing/invalid `llms.txt`, blocked redirects, metadata-only binary responses, and secondary-model failures all return a usable result instead of throwing away the fetched content.
- **Warning-scoped JSDOM construction:** any new JSDOM construction or css-tree trigger point must be wrapped in `withCssTreeWarningsSuppressed` (see `utils.ts`) so css-tree lexer warnings never leak into the host process stderr.

## Data & Control Flow

1. `createWebfetchTool` normalizes the requested URL, derives permission patterns, asks for `webfetch` permission, and computes the cache key (`tool.ts`, `network.ts`, `cache.ts`).

2. If `prefer_llms_txt` applies, `probeLlmsText` tries `/llms-full.txt` then `/llms.txt`, following only permitted redirects and rejecting HTML/login-wall responses (`network.ts`).

3. When the tool falls back to the page itself, `fetchWithUpgradeFallback` handles HTTPS upgrade fallback and redirect enforcement; the tool then detects binaries and reads bodies within limits. Stale pages send stored validators; a `304` at the same final URL refreshes the cached body, while a changed redirect target requires an unconditional refetch. Stale llms.txt is probed again (`network.ts`, `cache.ts`, `tool.ts`).

4. Text/HTML payloads are decoded and normalized through `extractFromHtml`, `cleanFetchedMarkdown`, `extractHeadingsFromMarkdown`, `frontmatter`, and `joinRenderedContent`; binary payloads optionally persist via `saveBinary`. Small signature-verified images attach inline only for direct-routed multimodal callers without an explicit disk request. Inline decisions use the current call context, not cached model state (`utils.ts`, `binary.ts`, `tool.ts`).

5. If the caller supplied a prompt and configured secondary models, `runSecondaryModelWithFallback` truncates input to a bounded size, disables tool access for the helper session, retries across configured models, and the tool degrades back to base fetched content if that step fails (`secondary-model.ts`, `tool.ts`).

## Integration Points

- `src/index.ts` registers the tool under the public name `webfetch`, so agents can call it alongside council and AST-grep tools.
- `src/tools/smartfetch/index.ts` exports only the tool factory; internal types and description stay in their respective modules.
- `secondary-model.ts` depends on the OpenCode plugin client (`PluginInput['client']`) to spawn an isolated helper session. The secondary-model chain is resolved purely in memory at plugin construction by `resolveSecondaryModels` (`secondary-model.ts`): dedicated `webfetch` models, then the host's `small_model` (via `RuntimeConfig.smallModel()`), then the `explorer` / `librarian` agent models (via `RuntimeConfig.agent()`). No config files are re-read on the webfetch hot path — see `config-read-guard.test.ts`.
- `cache.ts`, `network.ts`, and `utils.ts` are intentionally reusable seams for tests: cache behavior, redirect policy, llms probing, heading extraction, and render/metadata helpers can be verified without hitting the full tool entrypoint.
