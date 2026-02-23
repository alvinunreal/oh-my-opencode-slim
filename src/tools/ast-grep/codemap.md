# src/tools/ast-grep/

## Responsibility

- Wrap the external `ast-grep` CLI so the broader system can invoke AST-aware search and replace without caring about binary discovery or argument details (`cli.ts`, `tools.ts`).
- Provide well-typed tooling primitives (`types.ts`) plus formatted user output hints/summary helpers (`utils.ts`) that can be re-used by CLI commands or plugin UI layers.
- Manage the brittle parts of CLI usage: locating a binary from caches, npm packages, or homebrew, downloading platform-specific releases when needed, and surfacing environment status/limits (`constants.ts`, `downloader.ts`).

## Design Patterns and Decisions

- **Singleton initialization with retries:** `getAstGrepPath` caches an init promise so concurrent requests share discovery/download work and fallback from local binaries to downloads (`cli.ts`).
- **Tool definition as declarative metadata:** `tools.ts` exports `ast_grep_search` and `ast_grep_replace` via the OpenCode tool registry, which keeps descriptions, schemas, and execution logic centralized.
- **Separation of concerns:** `cli.ts` focuses on process spawning and JSON parsing, `constants.ts` owns binary path resolution plus environment checks/formatting, `utils.ts` formats results while `downloader.ts` handles platform maps, cache directories, and fetch/extraction.
- **Fail fast with hints:** Empty-match hints tailored per language (e.g., help removing trailing colons in Python) make search UX better while keeping AST requirements explicit.

## Data & Control Flow

- Tools (`ast_grep_search`, `ast_grep_replace`) call `runSg`, populating CLI arguments (pattern, rewrite, globs, context) and routing output through `formatSearchResult`/`formatReplaceResult` before reporting via `showOutputToUser` (`tools.ts`).
- `runSg` constructs the command, ensures the CLI binary exists (resetting via `getAstGrepPath` which may call `findSgCliPathSync` or trigger a download), spawns the process with timeout handling, and parses compact JSON while guarding against truncated output and CLI errors (`cli.ts`).
- Binary resolution uses `constants.ts` helpers to detect cached binaries, installed packages, platform-specific packages, or Homebrew paths, and exposes environment checks/formatting to upstream callers (`constants.ts`).
- `downloader.ts` is the fallback path: it infers the platform key, downloads the matching GitHub release, extracts `sg`, sets executable bits, and caches it under `~/.cache/omoslim/bin` (or Windows AppData) so subsequent commands reuse the binary.

## Integration Points

- `index.ts` re-exports `ast_grep_search`, `ast_grep_replace`, runtime helpers (`ensureCliAvailable`, `checkEnvironment`, etc.), and downloader utilities so other modules can plug into the tooling layer while sharing diagnostics (`index.ts`).
- The OpenCode plugin layer imports `builtinTools` from `src/tools/ast-grep/index.ts` to surface search/replace capabilities through the CLI tool registry.
- `constants.ts` and `downloader.ts` are used by `cli.ts` to decide where to execute `sg`, while environment helpers inform onboarding UIs or setup scripts about missing binaries.
- `types.ts` defines the shared `CliLanguage`, `CliMatch`, and `SgResult` shapes that drive type safety across CLI invocation, formatting utilities, and tooling schemas.
