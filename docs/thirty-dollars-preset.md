# $30 Preset

This preset pairs **Codex Plus ($20/month)** with **GitHub Copilot Pro ($10/month)**.

Codex Plus covers the OpenAI models and Copilot covers the design models, so you get a mixed-provider setup for about **$30/month total**.

---

## The Config

```jsonc
{
    "preset": "thirtydollars",
    "presets": {
      "thirtydollars": { "orchestrator": { "model": "openai/gpt-5.6-terra", "variant": "medium", "skills": [ "*" ], "mcps": [ "*", "websearch"] },
        "oracle": { "model": "openai/gpt-5.6-sol", "variant": "high", "skills": [], "mcps": [] },
        "librarian": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": [ "websearch", "context7", "gh_grep" ] },
        "explorer": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": [] },
        "designer": { "model": "github-copilot/gemini-3.5-flash", "skills": [], "mcps": [] },
        "fixer": { "model": "openai/gpt-5.6-luna", "variant": "medium", "skills": [], "mcps": [] }
      }
    }
  }
```

## Skill Reference

| Skill | Description | Source |
| --- | --- | --- |
| `*` | All installed skills (wildcard) | `public` |

For the complete configuration reference, see [Configuration](configuration.md).
