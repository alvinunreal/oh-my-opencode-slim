# src/tools/grep/

## Responsibility

Implements the local `grep` override shipped by slim. The module provides a ripgrep-first search tool with OpenCode-compatible semantics, managed backend resolution, hybrid `mtime` ordering, and final GNU grep fallback.

## Design

### Module layout

```text
src/tools/grep/
├── tool.ts         # Tool wrapper: normalize -> ask -> run -> format -> metadata
├── schema.ts       # Public input schema
├── types.ts        # Request/result/event types
├── constants.ts    # Identity, defaults, hard caps, tool description
├── normalize.ts    # Raw args -> NormalizedGrepInput, realpath/permission scope
├── rg-args.ts      # ripgrep argv builder
├── runtime.ts      # Process lifecycle, timeout/cancel, retries, semaphore
├── direct.ts       # Streaming rg hot path for content/count/files modes
├── mtime.ts        # Hybrid discover/sort/replay strategy for sort_by=mtime
├── fallback.ts     # Final GNU grep fallback backend
├── resolver.ts     # system rg -> managed rg -> install-on-miss -> GNU grep
├── downloader.ts   # Managed ripgrep installer in user cache
├── json-stream.ts  # JSON/NUL stream parsers
├── aggregate.ts    # Content collector with context drain
├── result-utils.ts # Result shaping and truncation helpers
├── path-utils.ts   # Display paths, byte identities, non-UTF8-safe rendering
├── summary.ts      # Human summary builders
├── format.ts       # Final human-readable output
└── *.test.ts       # Focused subsystem suites
```

### Execution paths

1. **Direct rg path**
   - normal hot path
   - streaming parse
   - early-stop by visible limit

2. **`mtime-hybrid`**
   - discovery of matching files
   - mtime sort
   - replay in sorted order
   - degrades to `mtime-fallback` when byte-paths are not safely orderable/replayable

3. **GNU grep fallback**
   - last-resort degraded backend
   - explicit warning-driven behavior
   - only entered when ripgrep cannot be provided
   - non-UTF8 path/content fidelity is best-effort only because fallback parsing operates on decoded GNU grep output, not ripgrep byte payloads

### Backend resolution policy

The resolver follows this order:

1. `system rg`
2. managed cached `rg`
3. install latest stable `rg` on miss
4. `system GNU grep`

Aborts during auto-install propagate cleanly and are not cached as permanent install failure.

## Flow

```text
Tool call
  ↓
tool.ts
  ↓ normalize.ts
NormalizedGrepInput
  ↓
ctx.ask(permissionPatterns)
  ↓
runner.ts
  ├─→ resolver.ts
  ├─→ direct.ts
  ├─→ mtime.ts
  └─→ fallback.ts
  ↓
format.ts
  ↓
structured metadata + human output
```

## Integration

- Registered by `src/index.ts` as the local `grep` override.
- Exported from `src/tools/index.ts` and `src/tools/grep/index.ts`.
- Uses `src/utils/zip-extractor.ts` for managed ripgrep archive extraction.
- Does not patch OpenCode core.

## Notes

- The default path is optimized for LLM use: larger defaults, streaming parse, early-stop, and structured metadata.
- Ripgrep-native non-UTF8 paths/content are rendered with stable `bytes:base64:...` identities when raw bytes are available.
- GNU grep fallback is intentionally degraded for non-UTF8 data: it may decode with replacement characters or skip unparsable output, and it does not promise the same stable byte identity surface as the ripgrep path.
- Rare compatibility paths are explicit and warning-driven instead of silently pretending to match ripgrep exactly.
