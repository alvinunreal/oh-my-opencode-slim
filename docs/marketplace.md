# Marketplace

Install, inspect, and activate marketplace packages. Startup and every local
read are offline. Only explicit registry `install` and `update` operations
make bounded HTTPS requests to the beta registry.

Package manifests are data-only, exact-version locked, and stored under the
XDG data directory. The CLI registry `install` command installs a package and
enables its agent in the active preset in one operation. Local imports and
in-session tool actions remain separate from preset activation. Activated agents
apply after the next OpenCode session or reload. The live agent registry is
never hot-swapped.

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
exact `ID@version`; an unversioned ID selects the highest compatible version and
enables the installed agent in the active preset. Registry installs try the v3
endpoint first and use v2 only when v3 is unavailable or does not contain the
requested package; malformed or integrity-invalid v3 data is not downgraded.
Registry `update` requires an installed package and selects only a strictly
newer compatible version. `enable` activates an already installed agent package
in the active preset as a separately named agent. An agent may optionally extend one
built-in specialist.
`remove` clears the package from every user and project preset activation list
before deleting it locally, so a separate `disable` command is unnecessary.
The old unsafe `--force` removal path is not supported.

`status` reports installed packages, configured activation, live-session
agents when used from the in-session tool, diagnostics, and whether a
reload is required. Diagnostics include store problems (missing, corrupt,
or operational read failures) and activation rejections (collision,
missing required dependency, invalid alias). Operational failures leave
in-session `reload_required` as `unknown` because disk identity cannot be
compared.

## Manifest routing versions

Schema-v2 manifests retain the legacy routing object. Schema-v3 manifests use
a deterministic routing object with `lane`, `stats`,
`delegateWhen`, `avoid`, and optional `additionalInstructions`; extensions are
append-only. V3 routing lines are single-line bounded values, and list order is
preserved in the generated routing block. For both versions, an activated
marketplace agent receives its authored `prompt` unchanged; manifest routing
metadata is rendered only in the orchestrator's routing prompt.

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

- The beta registry uses `https://registry.ohmyopencodeslim.com/v3/` first and
  falls back to `/v2/` only for an unavailable or missing v3 package;
  configurable registries and redirects are not supported.
- Declared skills and MCPs are preflighted against built-in capabilities and
  on-disk host configuration. Missing dependencies disable that package for
  the session; nothing is auto-installed.
- Startup and local `list`, `show`, `verify`, `status`, activation, and removal
  read only the local store and never contact a registry.

## Registry contract

Registry CI and static site tooling can import the narrow
`oh-my-opencode-slim/marketplace-contract` package subpath. The fixed `/v2/`
registry remains a v2-manifest index and must be parsed with its v2 parser.
The contract also exposes separate v3 manifest/index schemas, parsers, summary
projection, selector resolution, and the future `/v3/` registry base URL;
v2 parsing never accepts v3 artifacts. Both contracts use deterministic
artifact paths, retirement tombstones, and canonical bundle SHA-256 digests.
It also exports `renderDefaultMarketplaceAutoDelegationBlock(manifest)`, the
authoritative deterministic routing block. Built-in v3 extensions use the
current built-in role routing followed by lane, stats, delegation, and
avoidance guidance; standalone v3 packages include their role sentence and
mechanically derived declared capabilities. This default renderer does not
apply owner or runtime display-alias overrides. The public contract does not
add root-package exports.
