# Provider Configurations

oh-my-opencode-slim uses **OpenAI** as the default provider. This document shows how to configure alternative providers by editing your plugin config file.

## Config File Location

Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc` for comments support).

## Default: OpenAI

The installer generates this configuration automatically:

```json
{
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.4", "variant": "high", "skills": ["*"], "mcps": ["*"] },
      "oracle": { "model": "openai/gpt-5.4", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.4-mini", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

## Kimi For Coding

To use Kimi, add a `kimi` preset and set it as active:

```json
{
  "preset": "kimi",
  "presets": {
    "kimi": {
      "orchestrator": { "model": "kimi-for-coding/k2p5", "variant": "high", "skills": ["*"], "mcps": ["*"] },
      "oracle": { "model": "kimi-for-coding/k2p5", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "kimi-for-coding/k2p5", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "kimi-for-coding/k2p5", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "kimi-for-coding/k2p5", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "kimi-for-coding/k2p5", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

Then authenticate:
```bash
opencode auth login
# Select "Kimi For Coding" provider
```

## GitHub Copilot

To use GitHub Copilot with Grok Code Fast:

```json
{
  "preset": "copilot",
  "presets": {
    "copilot": {
      "orchestrator": { "model": "github-copilot/claude-opus-4.6", "variant": "high", "skills": ["*"], "mcps": ["*"] },
      "oracle": { "model": "github-copilot/claude-opus-4.6", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "github-copilot/grok-code-fast-1", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "github-copilot/grok-code-fast-1", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "github-copilot/gemini-3.1-pro-preview", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "github-copilot/claude-sonnet-4.6", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

Then authenticate:
```bash
opencode auth login
# Select "github-copilot" provider
```

## ZAI Coding Plan

To use ZAI Coding Plan with GLM 5:

```json
{
  "preset": "zai-plan",
  "presets": {
    "zai-plan": {
      "orchestrator": { "model": "zai-coding-plan/glm-5", "variant": "high", "skills": ["*"], "mcps": ["*"] },
      "oracle": { "model": "zai-coding-plan/glm-5", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "zai-coding-plan/glm-5", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "zai-coding-plan/glm-5", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "zai-coding-plan/glm-5", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "zai-coding-plan/glm-5", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

Then authenticate:
```bash
opencode auth login
# Select "zai-coding-plan" provider
```

## Mixing Providers

You can mix models from different providers across agents. Create a custom preset:

```json
{
  "preset": "my-mix",
  "presets": {
    "my-mix": {
      "orchestrator": { "model": "openai/gpt-5.4", "skills": ["*"], "mcps": ["*"] },
      "oracle": { "model": "openai/gpt-5.4", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "kimi-for-coding/k2p5", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "github-copilot/grok-code-fast-1", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "kimi-for-coding/k2p5", "variant": "medium", "skills": ["agent-browser"], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] }
    }
  }
}
```

## Switching Presets

**Method 1: Edit the config file** — Change the `preset` field to match a key in your `presets` object.

**Method 2: Environment variable** (takes precedence over config file):
```bash
export OH_MY_OPENCODE_SLIM_PRESET=my-mix
opencode
```

---

## Fallback / Failover

The plugin can automatically fail over from one model to the next when a prompt times out or errors. This is separate from your preset selection — it's a runtime safety net.

**How it works:**

- Each agent can have a fallback chain under `fallback.chains.<agent>`
- The agent uses its configured model first
- If that model fails or times out, the manager aborts the session, waits briefly, and tries the next model in the chain
- Duplicate model IDs are ignored — the same model is never retried twice
- If fallback is disabled, tasks run with no failover

**Example:**

```jsonc
{
  "fallback": {
    "enabled": true,
    "timeoutMs": 15000,
    "retryDelayMs": 500,
    "chains": {
      "orchestrator": [
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3.1-pro"
      ],
      "fixer": [
        "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo",
        "openai/gpt-5.4-mini"
      ]
    }
  }
}
```

**Notes:**
- Model IDs must use `provider/model` format
- Chains are per agent: `orchestrator`, `oracle`, `designer`, `explorer`, `librarian`, `fixer`, `councillor`, `council-master`
- If an agent has no chain configured, only its primary model is used

---

## Provider-Specific Options

You can pass provider-specific model parameters via the `options` field on any agent config. These are forwarded directly to the AI SDK's `providerOptions` and affect model behavior at the API level.

### OpenAI — Concise Responses

```jsonc
{
  "presets": {
    "openai": {
      "oracle": {
        "model": "openai/gpt-5.4",
        "options": {
          "textVerbosity": "low"  // "low" | "medium" | "high"
        }
      }
    }
  }
}
```

### Anthropic — Extended Thinking

```jsonc
{
  "presets": {
    "anthropic": {
      "oracle": {
        "model": "anthropic/claude-sonnet-4-6",
        "options": {
          "thinking": {
            "type": "enabled",
            "budgetTokens": 16000
          }
        }
      }
    }
  }
}
```

### Google — Thinking Budget

```jsonc
{
  "presets": {
    "google": {
      "oracle": {
        "model": "google/gemini-3.1-pro",
        "options": {
          "thinkingConfig": {
            "includeThoughts": true,
            "thinkingBudget": 16000
          }
        }
      }
    }
  }
}
```

**Notes:**
- `options` works per-agent and per-preset, just like `model` and `variant`
- Options are **static** — they don't swap when fallback chains switch providers
- Provider-specific keys are namespaced by the SDK, so OpenAI options are safely ignored by Anthropic and vice versa
- Options from presets and root config are deep-merged (root keys override preset keys)
- Nested objects in options are recursively merged by key — to fully replace a nested object (e.g., disable a preset's `thinking` config), set all subkeys explicitly
