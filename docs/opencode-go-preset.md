# OpenCode Go Preset

`opencode-go` runs the Pantheon agents on OpenCode Go models instead of the
default OpenAI setup.

The installer builds both `openai` and `opencode-go`. OpenAI stays active unless
you choose OpenCode Go at install time or switch to it later.

Because the `opencode-go` Orchestrator model (`minimax-m3`) is not multimodal,
installing with `--preset=opencode-go` also enables the Observer agent and
configures it with `opencode-go/mimo-v2.5` (a native omnimodal model) for
visual analysis.

## Install with OpenCode Go Active

```bash
bunx oh-my-opencode-slim@latest install --preset=opencode-go
```

Then authenticate and refresh models:

```bash
opencode auth login
opencode models --refresh
```

## Switch at Runtime

If both presets are already in your config, switch from inside OpenCode:

```text
/preset opencode-go
```

See [Preset Switching](preset-switching.md) for the full runtime switching
workflow. If you originally installed with the default OpenAI preset, also add
`"disabled_agents": []` to your config and restart OpenCode so Observer is
available before switching to `opencode-go`.

`disabled_agents` is global, not per-preset. If you later switch back to OpenAI
and restart while keeping `"disabled_agents": []`, Observer will remain enabled
and use the default Observer model unless you configure one explicitly.

## Bundled Model Mapping

The generated `opencode-go` preset maps each specialist to a model tuned for its
role:

| Agent | Model |
|-------|-------|
| Orchestrator | `opencode-go/minimax-m3` (`max`) |
| Oracle | `opencode-go/qwen3.7-max` (`max`) |
| Librarian | `opencode-go/deepseek-v4-flash` (`high`) + MCPs |
| Explorer | `opencode-go/deepseek-v4-flash` (`max`) |
| Designer | `opencode-go/kimi-k2.7-code` (`medium`) |
| Fixer | `opencode-go/deepseek-v4-flash` (`high`) |
| Observer | `opencode-go/mimo-v2.5` (`max`) |

## Generated Config Shape

Your generated config includes `opencode-go` under `presets` and activates it by
setting the top-level `preset` field:

```jsonc
{
  "preset": "opencode-go",
  "disabled_agents": [],
  "presets": {
    "opencode-go": {
      "orchestrator": {
        "model": "opencode-go/glm-5.2"
      },
      "oracle": {
        "model": "opencode-go/qwen3.7-max",
        "variant": "max"
      },
      "librarian": {
        "model": "opencode-go/deepseek-v4-flash"
      },
      "explorer": {
        "model": "opencode-go/deepseek-v4-flash"
      },
      "designer": {
        "model": "opencode-go/kimi-k2.7-code",
        "variant": "medium"
      },
      "fixer": {
        "model": "opencode-go/deepseek-v4-flash",
        "variant": "high"
      },
      "observer": {
        "model": "opencode-go/kimi-k2.6"
      }
    }
  }
}
```

## Skill Reference

This preset defines no per-agent `skills` or `mcps`. All agents use whatever skills are globally installed (the `*` wildcard).

| Skill | Description | Source |
| --- | --- | --- |
| `*` | All installed skills (wildcard) | `public` |

For the complete configuration reference, see
[Configuration](configuration.md).
