# Author's Preset

This is the exact configuration the author runs day-to-day. It mixes three providers to get the best model for each role at the lowest cost: **OpenAI** for reasoning-heavy orchestration, **Fireworks AI (Kimi K2P5)** for fast/cheap breadth work, and **GitHub Copilot** for design and council diversity.

---

## The Config

```jsonc
{
  "preset": "openai",
  "presets": {
    "openai": { "orchestrator": { "model": "openai/gpt-5.5-fast", "skills": [ "*" ], "mcps": [ "*", "websearch"] },
        "oracle": { "model": "openai/gpt-5.5-fast", "variant": "high", "skills": [], "mcps": [] },
        "council": { "model": "openai/gpt-5.5" },
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
        "alpha":  { "model": "github-copilot/claude-opus-4.6" },
        "beta": { "model": "github-copilot/gemini-3.1-pro-preview" },
        "gamma": { "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo" }
      }
    }
  }
}
```
