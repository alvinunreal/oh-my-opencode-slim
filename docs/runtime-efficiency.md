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
writes and no parent-hydration `session.get` reads. Companion request detection
keeps its 250ms interval; its config refresh is a separate once-per-second
duty.

## Pass-local facts

Agent registration reuses merged overrides, model arrays and MCP inputs within
each pass; a larger custom-agent roster no longer repeats those whole-table
derivations. Health accounting comes from completed registrations.

On v2, one prompt admission reuses its validated session identity and preset
binding for profile capture; the next admission rechecks host identity and
storage. Stored history is read for agent attribution only when a message lacks
an agent. Message transforms use a request-local view of valid/user messages,
rebuilt after structural edits, preserving phase/council anchors and the
trailing goal pointer byte-for-byte.

## Optional implementations

Interview, Marketplace and Companion load through their existing activation
paths instead of unrelated eager imports. Each host has one Interview owner.
Public entry paths are unchanged and ESM chunks ship with the package; release
verification checks every relative static and dynamic import target.

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
packed-artifact checks cover lazy imports. Operation counts and emitted bytes
are not CPU, RSS or end-to-end latency benchmarks.
