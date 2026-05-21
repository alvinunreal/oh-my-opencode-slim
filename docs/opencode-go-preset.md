# OpenCode Go Preset

`opencode-go` is a bundled generated preset for users who want to run the
Pantheon agents through OpenCode Go models instead of the default OpenAI setup.

The installer generates both `openai` and `opencode-go` presets. OpenAI stays
active by default unless you select OpenCode Go during install or switch to it
later.

Because the `opencode-go` preset uses GLM-5.1 for Orchestrator and GLM is not
multimodal, installing with `--preset=opencode-go` also enables the Observer
agent and configures it with `opencode-go/kimi-k2.6` for visual analysis.

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
`"disabled_agents": ["verifier"]` to your config and restart OpenCode so Observer is
available before switching to `opencode-go`.

`disabled_agents` is global, not per-preset. If you later switch back to OpenAI
and restart while keeping `"disabled_agents": ["verifier"]`, Observer will remain enabled
and use the default Observer model unless you configure one explicitly.

## Bundled Model Mapping

The generated `opencode-go` preset maps each specialist to a model tuned for its
role:

| Agent | Model |
|-------|-------|
| Orchestrator | `opencode-go/glm-5.1` |
| Oracle | `opencode-go/deepseek-v4-pro` (`max`) |
| Council | `opencode-go/deepseek-v4-pro` (`high`) |
| Librarian | `opencode-go/minimax-m2.7` |
| Explorer | `opencode-go/minimax-m2.7` |
| Designer | `opencode-go/kimi-k2.6` (`medium`) |
| Fixer | `opencode-go/deepseek-v4-flash` (`high`) |
| Observer | `opencode-go/kimi-k2.6` |

## Generated Config Shape

Your generated config includes `opencode-go` under `presets` and activates it by
setting the top-level `preset` field:

```jsonc
{
  "preset": "opencode-go",
  "disabled_agents": ["verifier"],
  "presets": {
    "opencode-go": {
      "orchestrator": { "model": "opencode-go/glm-5.1" },
      "oracle": {
        "model": "opencode-go/deepseek-v4-pro",
        "variant": "max"
      },
      "council": {
        "model": "opencode-go/deepseek-v4-pro",
        "variant": "high"
      },
      "librarian": { "model": "opencode-go/minimax-m2.7" },
      "explorer": { "model": "opencode-go/minimax-m2.7" },
      "designer": {
        "model": "opencode-go/kimi-k2.6",
        "variant": "medium"
      },
      "fixer": {
        "model": "opencode-go/deepseek-v4-flash",
        "variant": "high"
      },
      "observer": { "model": "opencode-go/kimi-k2.6" }
    }
  }
}
```

For the complete configuration reference, see
[Configuration](configuration.md).
