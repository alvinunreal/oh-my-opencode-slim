# $30 Preset

This preset is for people who want a strong setup built around **Codex Plus ($20/month)** and **GitHub Copilot Pro ($10/month)**.

It uses Codex Plus for the OpenAI models and GitHub Copilot for the premium council/design models, giving you a mixed-provider setup for about **$30/month total**.

---

## The Config

```jsonc
{
    "preset": "thirtydollars",
    "presets": {
      "thirtydollars": { "orchestrator": { "model": "openai/gpt-5.5", "skills": [ "*" ], "mcps": [ "*", "websearch"] },
        "oracle": { "model": "openai/gpt-5.5", "variant": "high", "skills": [], "mcps": [] },
        "council": { "model": "openai/gpt-5.5" },
        "librarian": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [ "websearch", "context7", "grep_app" ] },
        "explorer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] },
        "designer": { "model": "github-copilot/gemini-3.1-pro-preview", "skills": [ "agent-browser" ], "mcps": [] },
        "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] }
      }
    },
   "council": {
      "presets": {
        "default": {
          "alpha":  { "model": "github-copilot/claude-sonnet-4.6" },
          "beta": { "model": "github-copilot/gemini-3.1-pro-preview" },
          "gamma": { "model": "openai/gpt-5.5" }
        }
      }
    }
  }
```
