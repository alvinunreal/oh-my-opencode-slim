# Local Marketplace

Install, inspect, and activate local offline marketplace packages. There is
no website, network registry, or remote package resolution in this release.

Package manifests are data-only, exact-version locked, and stored under the
XDG data directory. Installation and preset activation are separate: install
a package, then enable it in the active preset. Activated agents and
profiles apply after the next OpenCode session or reload. The live agent
registry is never hot-swapped.

## CLI

```bash
bunx oh-my-opencode-slim marketplace install ./package.json
bunx oh-my-opencode-slim marketplace import ./package.json
bunx oh-my-opencode-slim marketplace list
bunx oh-my-opencode-slim marketplace show author/name
bunx oh-my-opencode-slim marketplace verify [author/name]
bunx oh-my-opencode-slim marketplace update ./package-v2.json
bunx oh-my-opencode-slim marketplace enable author/name
bunx oh-my-opencode-slim marketplace profile librarian author/profile
bunx oh-my-opencode-slim marketplace profile oracle --clear
bunx oh-my-opencode-slim marketplace disable author/name
bunx oh-my-opencode-slim marketplace remove author/name
bunx oh-my-opencode-slim marketplace status [--json]
```

`import` is an alias for `install` and records the canonical absolute local
source path in the lockfile. Use `update` to select a different exact
version. `enable` activates an installed `agent` package in the active
preset as a separately named role-derived agent. `profile` selects at most
one installed `profile` package per supported specialist role; `--clear`
writes a tombstone.

`status` reports installed packages, configured activation, live-session
agents when used from the in-session tool, diagnostics, and whether a
reload is required. Diagnostics include store problems (missing, corrupt,
or operational read failures) and activation rejections (collision,
missing required dependency, invalid alias). Operational failures leave
in-session `reload_required` as `unknown` because disk identity cannot be
compared.

## In-session tool

The orchestrator can use the `marketplace` tool for the same local
lifecycle: install, import, list, show, verify, update, enable, disable,
profile, remove, and status. Do not shell out to the CLI for these actions
when the tool is available.

Disable it with `disabled_tools: ["marketplace"]`. Specialists cannot
invoke it.

Read-only actions (list, show, verify, status) do not change activation.
Mutating actions write the local store and plugin config only and report
`reload_required` only when disk activation differs from this session.
Inactive or idempotent mutations do not include a reload note. The CLI
has no live registry, so its reload status is `unknown`. In-session
status is also `unknown` when the store or desired activation cannot be
read (for example EACCES).

## Status fields

| Field | Meaning |
|-------|---------|
| installed | Exact locked versions in the local store |
| configured_agents / configured_profiles | Active-preset activation on disk |
| live_packages | Packages already in this session's registry, with version, digest, and runtime name |
| diagnostics | Store and activation issues (missing, corrupt, operational, collision, missing required dependency, invalid alias), labeled `disk` or `live` |
| reload_required | `true`/`false` when live and desired identities can be compared; `unknown` for CLI and when store/desired resolution failed operationally |

## Limits

- Local `package.json` files only. No remote URLs or registry IDs.
- Required skills and MCPs are preflighted against built-in capabilities
  and on-disk host configuration. Missing required dependencies disable
  that package for the session. Optional requirements stay unavailable
  and are never auto-installed.
- Startup reads only the local store and never contacts a registry.
