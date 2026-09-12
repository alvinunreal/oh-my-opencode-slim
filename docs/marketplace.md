# Marketplace

Install, inspect, and activate marketplace packages. Startup and every local
read are offline. Only explicit registry `install` and `update` operations
make bounded HTTPS requests to the beta registry.

Package manifests are data-only, exact-version locked, and stored under the
XDG data directory. Installation and preset activation are separate: install
a package, then enable it in the active preset. Activated agents apply after
the next OpenCode session or reload. The live agent
registry is never hot-swapped.

## CLI

```bash
bunx oh-my-opencode-slim marketplace install community/example
bunx oh-my-opencode-slim marketplace install community/example@1.2.3
bunx oh-my-opencode-slim marketplace update community/example
bunx oh-my-opencode-slim marketplace import ./package.json
bunx oh-my-opencode-slim marketplace import ./package-v2.json --update
bunx oh-my-opencode-slim marketplace list
bunx oh-my-opencode-slim marketplace show author/name
bunx oh-my-opencode-slim marketplace verify [author/name]
bunx oh-my-opencode-slim marketplace enable author/name
bunx oh-my-opencode-slim marketplace disable author/name
bunx oh-my-opencode-slim marketplace remove author/name
bunx oh-my-opencode-slim marketplace status [--json]
```

`import` is the explicit local author workflow and records the canonical
absolute local source path in the lockfile. Add `--update` to import a strictly
newer version into an existing package. Registry `install` accepts an ID or an
exact `ID@version`; an unversioned ID selects the highest compatible version.
Registry `update` requires an installed package and selects only a strictly
newer compatible version. `enable` activates an installed agent package in the
active preset as a separately named agent. An agent may optionally extend one
built-in specialist.

`status` reports installed packages, configured activation, live-session
agents when used from the in-session tool, diagnostics, and whether a
reload is required. Diagnostics include store problems (missing, corrupt,
or operational read failures) and activation rejections (collision,
missing required dependency, invalid alias). Operational failures leave
in-session `reload_required` as `unknown` because disk identity cannot be
compared.

## In-session tool

The orchestrator can use the `marketplace` tool for the same lifecycle. Its
`install`/`update` actions use the fixed registry, while `import` is the only
local path action. Do not shell out to the CLI when the tool is available.

Disable it with `disabled_tools: ["marketplace"]`. Specialists cannot
invoke it.

Read-only actions (list, show, verify, status) do not change activation or
contact the registry.
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
| configured_agents | Active-preset activation on disk |
| live_packages | Packages already in this session's registry, with version, digest, and runtime name |
| diagnostics | Store and activation issues (missing, corrupt, operational, collision, missing required dependency, invalid alias, retired), labeled `disk` or `live` |
| reload_required | `true`/`false` when live and desired identities can be compared; `unknown` for CLI and when store/desired resolution failed operationally |

## Limits

- The beta registry is fixed at `https://registry.ohmyopencodeslim.com/v2/`;
  configurable registries and redirects are not supported.
- Declared skills and MCPs are preflighted against built-in capabilities and
  on-disk host configuration. Missing dependencies disable that package for
  the session; nothing is auto-installed.
- Startup and local `list`, `show`, `verify`, `status`, activation, and removal
  read only the local store and never contact a registry.

## Registry contract

Registry CI and static site tooling can import the narrow
`oh-my-opencode-slim/marketplace-contract` package subpath. It provides the
schema-v3 indexes (including retirement tombstones), deterministic
artifact paths, manifest-summary projection, selector resolution, and the same
canonical bundle SHA-256 digest used by the plugin store. It also exports
`renderDefaultMarketplaceAutoDelegationBlock(manifest)`, the authoritative
default routing block for marketplace agents. Built-in extensions use the
current built-in role routing plus the package's routing suffix; standalone
packages use a generic lane block. This default renderer does not apply owner
or runtime display-alias overrides. The public contract does not add
root-package exports.
