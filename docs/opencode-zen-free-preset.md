# OpenCode Zen Free Preset

This preset runs entirely on free-tier models. Every agent uses an `opencode/...-free`
model, so there is no cost.

No subscription or API key required. Set the preset and start.

---

## The Config

```jsonc
{
  "preset": "opencode-zen-free",
  "presets": {
    "opencode-zen-free": {
      "orchestrator": {
        "model": "opencode/hy3-free",
        "temperature": 0.4,
        "skills": ["*"],
        "mcps": ["*", "!context7"]
      },
      "oracle": {
        "model": "opencode/big-pickle",
        "temperature": 0.4,
        "variant": "max",
        "skills": ["simplify"],
        "mcps": []
      },
      "explorer": {
        "model": "opencode/north-mini-code-free",
        "temperature": 0.2,
        "skills": [],
        "mcps": []
      },
      "librarian": {
        "model": "opencode/deepseek-v4-flash-free",
        "temperature": 0.2,
        "skills": [],
        "mcps": ["websearch", "context7", "gh_grep"]
      },
      "designer": {
        "model": "opencode/mimo-v2.5-free",
        "temperature": 0.3,
        "variant": "medium",
        "skills": [],
        "mcps": []
      },
      "fixer": {
        "model": "opencode/deepseek-v4-flash-free",
        "temperature": 0.2,
        "variant": "high",
        "skills": [],
        "mcps": []
      },
      "observer": {
        "model": "opencode/north-mini-code-free",
        "temperature": 0.2,
        "variant": "low",
        "skills": [],
        "mcps": []
      }
    }
  }
}
```

## Skill Reference

| Skill | Description | Source |
| --- | --- | --- |
| `*` | All installed skills (wildcard) | public |
| `simplify` | Code simplification | public |

For the complete configuration reference, see [Configuration](configuration.md).
