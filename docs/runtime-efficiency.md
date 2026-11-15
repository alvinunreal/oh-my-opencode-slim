# Runtime efficiency

Slim keeps the same features and enabled defaults while avoiding repeated work.
Feature switches stay independent: disabling the sidebar does not remove pane
management, and disabling managed jobs does not remove native subagents, council
or observer.

## Configuration reads

Setup, TUI gates and Companion share one bounded merged-config cache. Its
fingerprint covers the selected source paths, their stat fields and referenced
`{env:NAME}` values. A watcher or explicit configuration notification passes
`fresh`, covering writes that timestamp granularity cannot distinguish. Read
failures are not cached. Preset editors keep their own raw user and validated
project reads.

The sidebar keeps its 1s render poll. With `sidebar: false`, the 5s config poll
still detects external multiplexer edits, but unchanged files are not parsed
again. `tui: false` also stops the server-side sidebar recorder: no state-file
writes and no parent-hydration `session.get` reads. `webfetch.enabled: false` or
`disabled_tools: ["webfetch"]` skips the enhanced implementation and its JSDOM
startup probe. Companion request detection keeps its 250ms interval; its
config refresh is a separate once-per-second duty.

## Pass-local facts

Agent registration reuses merged overrides, model arrays and MCP inputs within
each pass; a larger custom-agent roster no longer repeats those whole-table
derivations. Health accounting comes from completed registrations.

On v2 with session preset routing enabled, one prompt admission reuses its
validated session identity and preset binding for profile capture; the next
admission rechecks host identity and storage. `backgroundJobs.mode: "off"`
constructs neither the preset store nor the child profile bridge, registers no
session-preset RPC or server command, and leaves the native executor unchanged.
Preset delegation, prompt and event paths perform no session reads or KV work
in that mode; static agent inference settings still register with the host.
Stored history is read for agent attribution only when a message lacks
an agent. Message transforms use a request-local view of valid/user messages,
rebuilt after structural edits, preserving phase/council anchors and the
trailing goal pointer byte-for-byte.

## Optional implementations

The server entry keeps shared coordination in small leaf modules. Optional
implementations load inside their existing activation gates instead of through
hook, tool or utility barrels:

- `backgroundJobs.mode: "managed"` (V1 only) loads the board, supervisor,
  admission state, recovery and managed tools. `"native"` (the V2 default) loads
  only the thin host-read controls and, on V2, the queue-only report; `"off"`
  loads neither implementation. On V2 the managed gates are structurally false,
  so the board, persistence, recovery, adoption and wake modules are never
  resolved, independent of configuration. The v1 wake scheduler is separate from
  the pure message helpers used on both hosts.
- `autoUpdate: false` or the disabled `auto-update-checker` hook skips loading
  the v1 update implementation. On v2 the v1 server updater is never loaded
  (it cannot install there and its toast is a shim no-op); the host owns
  package management and the TUI notice. Tool guards follow their existing
  hook switches. When every post-tool consumer is off, the shared v1
  `tool.execute.after` hook is absent; on v2 the bridge keeps that hook only
  while it actually owns admission captures (routing enabled).
- Disabling both AST tools skips their shared implementation. ACP loads only
  when at least one enabled wrapper can use `acp_run`; disabling that tool also
  removes its unusable wrapper agents.
- Council seat assembly is loaded only when the council agent is present.
  Interview and Marketplace retain their feature gates, with one Interview
  owner per host.
- Disabled Companion startup uses a small cleanup module. It still disposes
  managers from earlier generations when no state file exists; persisted state
  uses the original manager's locking and pruning path.

Fallback retains the manager required by explicit preset applications and saved
session bindings on v2, even with the file watcher off. Disabling the
`foreground-fallback` hook removes that implementation entirely.

Both contracts on the thin TUI entry check the environment and `tui` gate before
loading the render stack. Public entry paths are unchanged and ESM chunks ship
with the package; release verification checks every relative static and dynamic
import target.

These are cold-start savings. ESM modules already evaluated in a process cannot
be unloaded by a later configuration change. Disposal stops owned work; start a
fresh host process to measure the full memory benefit of a smaller feature set.

## Prompt size

Default agent prompts retain role, routing and workflow constraints without
repeating tool catalogs, argument syntax or tool-selection instructions. Tool
descriptions own those details, so disabling a tool or MCP does not leave stock
usage advice advertising it. User-authored prompt overrides remain untouched.

## State and events

Board lookup and boolean predicates do not sort; ordered history still does.
TUI projection reads one board view, and native event batches coalesce recorder
writes and projection work into one locked commit. Cross-process locks, atomic
publication, retries and per-owner disposal remain in place.

The v2 event subscription freezes the union required by enabled consumers.
Native lifecycle, usage, forms and permissions remain observed; Interview text
streams are added only when Interview is enabled.

## Verification

Focused tests count reads/derivations and exercise file replacement, malformed
configuration, admission identity, event selection and publication. Prompt
snapshots and prefix-stability properties guard model-facing bytes. Build and
packed-artifact checks cover lazy imports. `bun run verify:optional-loading`
runs the built server entry in fresh processes, comparing evaluated module
bytes, registrations, heap/code stats and disposal across isolated feature
matrices. Operation counts and emitted bytes are not CPU, RSS or end-to-end
latency benchmarks.
