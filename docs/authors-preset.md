# Author's Preset

This is the exact configuration the author runs day-to-day. It mixes three providers to get the best model for each role at the lowest cost: **OpenAI** for reasoning-heavy orchestration, **Fireworks AI (Kimi K2P5)** for fast/cheap breadth work, and **GitHub Copilot** for design and council diversity.

---

## The Config

```jsonc
{
  "preset": "best",
  "presets": {
    "best": {
      // High-reasoning orchestrator — needs to plan, delegate, and synthesize
      "orchestrator": {
        "model": "openai/gpt-5.4",
        "skills": ["*"],
        "mcps": ["*"]
      },
      // Strategic advisor — high variant for deep thinking
      "oracle": {
        "model": "openai/gpt-5.4",
        "variant": "high",
        "skills": [],
        "mcps": []
      },
      // External knowledge retrieval — fast and cheap, with all search MCPs
      "librarian": {
        "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo",
        "variant": "low",
        "skills": [],
        "mcps": ["websearch", "context7", "grep_app"]
      },
      // Codebase recon — fast model, no external tools needed
      "explorer": {
        "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo",
        "variant": "low",
        "skills": [],
        "mcps": []
      },
      // UI/UX work — Gemini excels at visual reasoning and browser tasks
      "designer": {
        "model": "github-copilot/gemini-3.1-pro-preview",
        "skills": ["agent-browser"],
        "mcps": []
      },
      // Fast implementation — Kimi is quick and capable for focused coding tasks
      "fixer": {
        "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo",
        "variant": "low",
        "skills": [],
        "mcps": []
      }
    }
  },

  // Real-time pane monitoring
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  },

  // Council: diverse providers for maximum perspective spread
  "council": {
    "master": { "model": "openai/gpt-5.4" },
    "presets": {
      "default": {
        "alpha": { "model": "github-copilot/claude-opus-4.6" },
        "beta":  { "model": "github-copilot/gemini-3.1-pro-preview" },
        "gamma": { "model": "fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo" }
      }
    }
  }
}
```

---

## Why These Choices

### Orchestrator & Oracle → `openai/gpt-5.4`

The Orchestrator is the most important agent — it plans, delegates, and synthesizes results from the whole team. Oracle handles hard architectural questions. Both benefit from the strongest available reasoning model.

### Librarian, Explorer, Fixer → Kimi K2P5 via Fireworks AI

[Fireworks AI](https://fireworks.ai) offers Kimi K2P5 as a routed endpoint (`fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo`). The model is fast and highly capable for coding tasks. These three agents do high-volume breadth work (searching, reading, writing), so speed and cost matter more than raw reasoning power.

To authenticate with Fireworks AI:
```bash
opencode auth login
# Select "fireworks-ai" provider
```

### Designer → `github-copilot/gemini-3.1-pro-preview`

Gemini has strong multimodal and visual reasoning — good fit for UI/UX work and browser-based tasks. GitHub Copilot subscription gives access to it alongside Claude and Grok.

### Council → Three Providers

The council uses one model each from Anthropic (Claude), Google (Gemini), and Fireworks/Kimi — three architecturally different models. The more diverse the perspectives, the more useful the synthesis. GPT-5.4 as master keeps synthesis coherent.

---

## Required Authentication

This preset requires three providers to be authenticated:

```bash
opencode auth login  # run once per provider

# Authenticate:
# → openai
# → github-copilot
# → fireworks-ai
```

Verify all agents are responding after setup:
```
ping all agents
```
