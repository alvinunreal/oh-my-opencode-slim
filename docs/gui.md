# Desktop GUI (experimental)

OpenCode Desktop can render an OMOS preset editor as a plugin GUI part
(`./gui-experimental`). It edits the same user/project config files as
`/preset` — same discovery, JSONC-preserving writes, and switch guards.

## Requirements

- OpenCode Desktop 2.2+ (GUI plugin SDK)
- The plugin listed in the **global** `opencode.json(c)`; one entry loads every part

Open the editor from the side panel's **+** menu (**OMOS Presets**), the
command palette, or the composer pill above the prompt.

## What it does

- **Preset dropdown** — inspect/apply/create/duplicate/delete presets.
  Deletes are staged: they show **Undo** until the menu closes.
- **Agent rows** — per-agent model picker (host model list, grouped, searched;
  shows Desktop's own favorites/recents), variant slider, temperature, and
  provider options JSON under **More settings**. Saves touch only edited
  fields and preserve fallback chains.
- **Scope toggles** — **Default preset** (saved user default; off clears it)
  and **Use for this session only** (binds/unbinds the session's future
  child-agent team via the session-preset RPC). Neither changes a
  conversation's native model.
- **Go caps** — published monthly allowances per Go plan beside
  `opencode-go` models, from the public usage-limit docs (24h cache).
- **Roster tab** — global `disabled_agents` switches; protected agents locked.

## Notes

- OMOS's config watcher applies edited inference settings to **new** child
  sessions; existing session teams keep their frozen team until reapplied.
- Values shown and validated come from the runtime config loader, so
  `{env:...}` placeholders display their expanded value; edits keep the
  placeholder in the file. Presets in a file that uses unquoted `{env:...}`
  tokens are shown read-only.
- Favorites are read read-only from the Desktop app's local model store;
  availability failures never block model selection.
- The GUI plugin API is experimental and may change between OpenCode releases.
