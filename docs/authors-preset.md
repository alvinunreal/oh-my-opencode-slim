# Author's Preset

This is the exact configuration the author runs day-to-day. It mixes three providers to get the best model for each role at the lowest cost: **OpenAI** for reasoning-heavy orchestration, **Fireworks AI (Kimi K2P5)** for fast/cheap breadth work, and **GitHub Copilot** for design and council diversity.

---

## The Config

```jsonc
{
  "preset": "best",
  "presets": {
    "best": { "orchestrator": { "model": "openai/gpt-5.4", "skills": [ "*" ], "mcps": [ "*"] },
      "oracle": { "model": "openai/gpt-5.4", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo", "variant": "low", "skills": [], "mcps": [ "websearch", "context7", "grep_app" ] },
      "explorer": { "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "github-copilot/gemini-3.1-pro-preview", "skills": [ "agent-browser" ], "mcps": [] },
      "fixer": { "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo", "variant": "low", "skills": [], "mcps": [] }
    }
  },
  "multiplexer": {
    "type": "auto",
    "layout": "main-vertical",
    "main_pane_size": 60
  },
  "council": {
    "master": { "model": "openai/gpt-5.4" },
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
