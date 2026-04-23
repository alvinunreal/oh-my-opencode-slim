# Author's Preset

This is the exact configuration the author runs day-to-day.

---

## The Config

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": { "orchestrator": { "model": "openai/gpt-5.5-fast", "skills": [ "*" ], "mcps": [ "*", "!context7"] },
        "oracle": { "model": "openai/gpt-5.5-fast", "variant": "high", "skills": [], "mcps": [] },
        "council": { "model": "openai/gpt-5.5-fast" },
        "librarian": { "model": "openai/gpt-5.3-codex-spark", "variant": "low", "skills": [], "mcps": [ "websearch", "context7", "grep_app" ] },
        "explorer": { "model": "openai/gpt-5.3-codex-spark", "variant": "low", "skills": [], "mcps": [] },
        "designer": { "model": "github-copilot/gemini-3.1-pro-preview", "skills": [ "agent-browser" ], "mcps": [] },
        "fixer": { "model": "openai/gpt-5.3-codex-spark", "variant": "low", "skills": [], "mcps": [] }
    }
  },
  "multiplexer": {
    "type": "auto",
    "layout": "main-vertical",
    "main_pane_size": 60
  },
  "council": {
    "presets": {
      "default": {
        "alpha":  { "model": "github-copilot/claude-sonnet-4.6", "variant": "high" },
        "beta": { "model": "github-copilot/gemini-3.1-pro-preview", "variant": "high" },
        "gamma": { "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo" }
      }
    }
  },
  "todoContinuation": {
    "maxContinuations": 50,
    "cooldownMs": 3000,
    "autoEnable": false,
    "autoEnableThreshold": 4
  } 
}
```
