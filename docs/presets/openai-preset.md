# OpenAI Preset

`openai` is the default generated preset. The installer builds both `openai`
and `opencode-go`; OpenAI is the one that runs unless you pick the other.

## Install with OpenAI Active

```bash
bunx oh-my-opencode-slim@latest install
```

Then authenticate and refresh models:

```bash
opencode auth login
opencode models --refresh
```

On OpenCode v2, use `opencode models` instead.

## Switch at Runtime

If both presets are already in your config, switch from inside OpenCode:
- **v2 hosts:** type `/preset openai` to apply directly (reload still required)
- **v1 hosts:** open `/preset` from autocomplete and pick Apply

See [Preset Switching](preset-switching.md) for the full runtime switching
workflow.

## Bundled Model Mapping

The generated `openai` preset assigns each specialist an OpenAI model:

| Agent | Model |
|-------|-------|
| Orchestrator | `openai/gpt-6.1-sol` (`medium`) |
| Oracle | `openai/gpt-6.1-sol` (`high`) |
| Explorer | `openai/gpt-6-luna` (`low`) |
| Designer | `openai/gpt-6-luna` (`medium`) |
| Fixer | `openai/gpt-6.1-sol` (`low`) |

## Generated Config Shape

Your generated config includes `openai` under `presets` and activates it by
setting the top-level `preset` field:

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": {
        "model": "openai/gpt-6.1-sol",
        "variant": "medium",
        "skills": ["*"]
      },
      "oracle": {
        "model": "openai/gpt-6.1-sol",
        "variant": "high",
        "skills": ["simplify"]
      },
      "explorer": {
        "model": "openai/gpt-6-luna",
        "variant": "low",
        "skills": []
      },
      "designer": {
        "model": "openai/gpt-6-luna",
        "variant": "medium",
        "skills": []
      },
      "fixer": {
        "model": "openai/gpt-6.1-sol",
        "variant": "low",
        "skills": []
      }
    }
  }
}
```

Per-agent MCP defaults (e.g. `explorer` gets `context7` and `gh_grep`) are
applied at runtime; generated configs omit them so they never pin stale
values.

## Skill Reference

Each skill is listed with a short description and its source. The config block
above shows which agent uses it. `author` means the author's own third party
skill (not part of the plugin); `public` means a public tool, framework, or MCP
server.

| Skill | Description | Source |
| --- | --- | --- |
| `*` | All installed skills (wildcard) | `public` |
| `simplify` | Code simplification | `public` |

For the complete configuration reference, see
[Configuration](../configuration.md).
