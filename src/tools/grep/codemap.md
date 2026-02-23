# src/tools/grep/

The folder implements the `grep` tool that powers ripgrep/grep-based searches for the OpenCode ecosystem. It exposes shared helpers for resolving/running the CLI, parsing output, downloading a bundled ripgrep when missing, and wiring the tool definition that the plugin host uses.

## Responsibility

Serve as the authoritative implementation of the fast content-search tool. It discovers which binary to run (`rg` vs fallback `grep`), enforces safety defaults (timeouts, max files/size/depth), parses the child-process output, formats readable responses, and exposes the ready-to-use tool definition consumed by the CLI/plugin layer.

## Design

The module is structured around a few focused responsibilities: `constants.ts` holds the configuration (safety flags, defaults) and a cached `resolveGrepCli`/`resolveGrepCliWithAutoInstall` that looks for bundled/system binaries before installing ripgrep from `downloader.ts` (platform aware fetch + extract). `cli.ts` encapsulates backend-agnostic argument builders (`buildRgArgs`/`buildGrepArgs`), output parsers, and the top-level `runRg`/`runRgCount` functions that spawn the tool via Bun, apply timeouts, and convert stdout/stderr into typed results. `tools.ts` wraps `runRg` with `formatGrepResult` (which groups matches by file) into a `@opencode-ai/plugin/tool` definition. `index.ts` re-exports the key APIs so other systems can import the grep functionality without knowing internal layout.

## Flow

1. Callers pass `GrepOptions` to `runRg` (or `runRgCount`); the CLI module first resolves the best backend via `resolveGrepCli`, which itself may probe bundled paths, the system `rg`, a cached install under `~/.cache/omoslim/bin`, or finally `grep`. 2. `buildArgs` chooses `rg` versus `grep` flag sets, adds safety arguments, globs, excludes, and finally the search pattern and paths. 3. Bun spawns the selected executable with the assembled arguments and a timeout promise; stdout is read, truncated if necessary, and converted into `GrepMatch` objects via `parseOutput`/`parseCountOutput`. 4. The parsed matches are returned as a `GrepResult`, which `tools.ts` later formats (`formatGrepResult`) with grouped file sections before presenting to the user.

## Integration

`constants.ts` imports `downloader.ts` to provide a self-installing ripgrep bundle when the preferred CLI is missing. `runRg`/`runRgCount` are the primary exports consumed elsewhere via `src/tools/grep/index.ts`, which also re-exports the resolver helpers and downloader entry points for reuse. This folder feeds the plugin registry in `tools.ts` so that the `grep` tool appears in the OpenCode tool suite, and other modules (e.g., higher-level CLI handlers) can orchestrate searches without dealing with binaries or parsing. The downloader taps `../../utils` for `extractZip`, and all exports are typed through `types.ts` so other callers can rely on `GrepResult`/`CountResult` contracts.
