# MCP Servers

Built-in Model Context Protocol (MCP) servers ship with oh-my-opencode-slim and give agents access to external tools - library documentation and code search.

---

## Built-in websearch (recommended)

The plugin no longer ships a websearch MCP. OpenCode has a built-in `websearch` tool that replaces it, so you do not need an API key or an extra MCP server.

Enable the built-in tool by setting these environment variables in your shell profile or launch command:

```sh
env OPENCODE_ENABLE_EXA=true OPENCODE_ENABLE_PARALLEL=true opencode
```

The oh-my-opencode-slim installer sets `OPENCODE_ENABLE_EXA=1` alongside its
background-subagents export when you accept the environment setup. Parallel
search remains opt-in.

The built-in tool is Exa-backed (optionally Parallel), needs no API key, and is only available when using the `opencode` provider OR when those flags are set. Control access per agent with `permission: { "websearch": "allow" }` (all tools are allowed by default).

---

## Built-in MCPs

| MCP | Purpose | Endpoint |
|-----|---------|----------|
| `context7` | Official library documentation (up-to-date) | `https://mcp.context7.com/mcp` |
| `gh_grep` | GitHub code search via grep.app | `https://mcp.grep.app` |

---

## Default Permissions Per Agent

| Agent | Default MCPs |
|-------|-------------|
| `orchestrator` | `*`, `!context7` |
| `librarian` | `context7`, `gh_grep` |
| `designer` | none |
| `oracle` | none |
| `explorer` | none |
| `fixer` | none |
 | `councillor` | none |

---

## Configuring MCP Access

Control which MCPs each agent can use via the `mcps` array in your preset config (`~/.config/opencode/oh-my-opencode-slim.json` or `.jsonc`):

| Syntax | Meaning |
|--------|---------|
| `["*"]` | All MCPs |
| `["*", "!context7"]` | All MCPs except `context7` |
| `["context7", "gh_grep"]` | Only listed MCPs |
| `[]` | No MCPs |
| `["!*"]` | Deny all MCPs |

**Rules:**
- `*` expands to all available MCPs
- `!item` excludes a specific MCP
- Conflicts (e.g. `["a", "!a"]`) → deny wins

**Example:**

```json
{
  "presets": {
    "my-preset": {
      "orchestrator": {
        "mcps": ["*", "!context7"]
      },
      "librarian": {
        "mcps": ["context7", "gh_grep"]
      },
      "oracle": {
        "mcps": ["*", "!gh_grep"]
      },
      "fixer": {
        "mcps": []
      }
    }
  }
}
```

---

## Disabling MCPs Globally

To disable specific MCPs for all agents regardless of preset, add them to `disabled_mcps` at the root of your config:

```json
{
  "disabled_mcps": ["gh_grep"]
}
```

This is useful when you want to cut external network calls entirely (e.g. air-gapped environments or cost control).

---

## Optional: Build Remote Agent

Pair a phone running [Build Remote Agent](https://grokbuildremote.com/) as a **spectator** for this OpenCode session. Protocol `gbr/1`. Independent product; not affiliated with xAI or SpaceX. The phone does not orchestrate oh-my-opencode-slim agents.

This is **not** a built-in MCP. Add it only if you want a pairing device.

```bash
curl -fsSL https://grokbuildremote.com/install.sh | bash
gbr-agent version    # need v0.6.0+
gbr-agent pair && gbr-agent run
```

```bash
git clone https://github.com/LinespottingOrg/GrokBuildRemote-Agents.git
cd GrokBuildRemote-Agents/mcp/gbr-mcp && npm install
```

OpenCode config (`~/.config/opencode/opencode.json` or project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gbr": {
      "type": "local",
      "command": ["node", "GrokBuildRemote-Agents/mcp/gbr-mcp/bin/gbr-mcp.js"],
      "enabled": true
    }
  }
}
```

Allow it per agent with the existing `mcps` array, for example on `orchestrator`:

```json
{
  "presets": {
    "my-preset": {
      "orchestrator": {
        "mcps": ["*", "!context7", "gbr"]
      }
    }
  }
}
```

After `gbr-agent run`, Bot API is `http://127.0.0.1:8788` (`/health`, `/v1/sessions`). Never put mailbox keys in slim config. Agent source: [GrokBuildRemote-Agents](https://github.com/LinespottingOrg/GrokBuildRemote-Agents).
