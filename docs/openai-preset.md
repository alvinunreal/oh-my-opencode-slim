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

## Switch at Runtime

If both presets are already in your config, switch from inside OpenCode:

```text
/preset openai
```

See [Preset Switching](preset-switching.md) for the full runtime switching
workflow.

## Bundled Model Mapping

The generated `openai` preset assigns each specialist an OpenAI model:

| Agent | Model |
|-------|-------|
| Orchestrator | `openai/gpt-5.6-terra` (`medium`) |
| Oracle | `openai/gpt-5.6-sol` (`high`) |
| Librarian | `openai/gpt-5.6-luna` (`low`) |
| Explorer | `openai/gpt-5.6-luna` (`low`) |
| Designer | `openai/gpt-5.6-luna` (`medium`) |
| Fixer | `openai/gpt-5.6-luna` (`medium`) |

## Generated Config Shape

Your generated config includes `openai` under `presets` and activates it by
setting the top-level `preset` field:

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": {
        "model": "openai/gpt-5.6-terra",
        "variant": "medium",
        "skills": ["*"],
        "mcps": ["*", "!context7"]
      },
      "oracle": {
        "model": "openai/gpt-5.6-sol",
        "variant": "high",
        "skills": ["simplify"],
        "mcps": []
      },
      "librarian": {
        "model": "openai/gpt-5.6-luna",
        "variant": "low",
        "skills": [],
        "mcps": ["websearch", "context7", "gh_grep"]
      },
      "explorer": {
        "model": "openai/gpt-5.6-luna",
        "variant": "low",
        "skills": [],
        "mcps": []
      },
      "designer": {
        "model": "openai/gpt-5.6-luna",
        "variant": "medium",
        "skills": [],
        "mcps": []
      },
      "fixer": {
        "model": "openai/gpt-5.6-luna",
        "variant": "medium",
        "skills": [],
        "mcps": []
      }
    }
  }
}
```

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
[Configuration](configuration.md).
