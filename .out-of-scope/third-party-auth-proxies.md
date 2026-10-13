# Bundled Third-Party Auth Proxies & Provider Wrappers

This project does not bundle, install, or provide CLI setup options for unofficial API reverse-proxies or third-party authentication bridges.

## Why this is out of scope

Early versions included setup flags and documentation for unofficial proxies (e.g. `cli-proxy-api` for Antigravity or OmniRoute routing). alvinunreal removed them (#96): *"I removed antigravity support, docs are outdated - will fix. But antigravity with opencode doesn't seem to work anymore"* — clarifying *"Support isn't removed - this plugin can be used with any model"*; only the bundled installation instructions went away. The reasons:

- `oh-my-opencode-slim` is an agent orchestration plugin, not an authentication provider or API gateway.
- Third-party reverse-proxies and unofficial OAuth interceptors frequently break when upstream providers alter auth flows or endpoints, causing false bug reports and high maintenance overhead.
- Bundling proxy scripts or specialized flags into the installer couples the plugin to specific external tools.

The plugin is model- and provider-agnostic. Any model that OpenCode supports can be used with `oh-my-opencode-slim` simply by configuring its identifier in `oh-my-opencode-slim.json`. If a user needs a third-party auth bridge, they can install the corresponding OpenCode auth plugin or local proxy independently.

## Prior requests

- #96 — "Antigravity option doesn't work." (closed; support removed from installer)
- #641 — "Question: Antigravity via OmniRoute account suspension risk?" (closed as wontfix)
