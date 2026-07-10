# Author's Preset

This is the exact configuration the author runs day-to-day.

---

## The Config

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "showStartupToast": false,
  "companion": {
    "enabled": true,
    "position": "bottom-left",
    "size": "small"
  },
  "presets": {
    "openai": {
      "orchestrator": {
        "model": "openai/gpt-5.6-fast",
        "skills": [
          "*",
          "!make-interfaces-feel-better"
        ],
        "mcps": [
          "*",
          "!context7",
          "!gh_app",
          "!websearch"
        ]
      },
      "oracle": {
        "model": "openai/gpt-5.6-fast",
        "variant": "high",
        "skills": [
          "ce-brainstorm",
          "workers-best-practices",
          "web-perf"
        ],
        "mcps": [
          "codegraph",
          "searxng",
          "crawl4ai"
        ]
      },
      "librarian": {
        "model": "openai/gpt-5.3-codex-spark",
        "variant": "low",
        "skills": [
          "customer-research"
        ],
        "mcps": [
          "websearch",
          "context7",
          "gh_app",
          "searxng",
          "crawl4ai"
        ]
      },
      "explorer": {
        "model": "openai/gpt-5.3-codex-spark",
        "variant": "low",
        "skills": [],
        "mcps": [
          "codegraph"
        ]
      },
      "designer": {
        "model": "omniroute/antigravity/gemini-3-flash-agent",
        "skills": [
          "make-interfaces-feel-better",
          "better-icons",
          "vue",
          "nuxt",
          "motion",
          "image",
          "marketing-psychology",
          "video"
        ],
        "mcps": [
          "codegraph"
        ]
      },
      "fixer": {
        "model": "omniroute/antigravity/gemini-3-flash-agent",
        "variant": "low",
        "skills": [
          "vitest",
          "pnpm",
          "vite",
          "tsdown"
        ],
        "mcps": [
          "codegraph",
          "searxng",
          "crawl4ai"
        ]
      }
    }
  },
  "agents": {
    "fast-generic": {
      "model": "openai/gpt-5.3-codex-spark",
      "variant": "low",
      "prompt": "You are a fast generic execution agent for routine mechanical command work. Run requested shell commands, inspect results, and report concise outcomes. For git commits or pushes, inspect git status, git diff, and recent log first; stage only intended files; avoid secrets; preserve repository commit-message style; never amend, rebase, reset --hard, clean, force-push, delete branches, or perform destructive history operations unless the user explicitly requested that exact operation. Do not edit code or make architecture/design decisions.",
      "orchestratorPrompt": "Delegate to @fast-generic for routine mechanical command work: git status/diff/log reconnaissance, normal commit preparation, creating commits, pushing commits, and no-edit command validation such as lint, typecheck, static verification, tests, builds, or package-manager equivalents. Ask it to inspect diffs before committing, stage only intended files, avoid secrets, preserve repository commit-message style, and report final commit hashes or push results. Do not use it for code edits, design work, architecture, debugging strategy, docs research, or destructive git history operations such as amend, rebase, reset --hard, clean, force-push, or deleting branches unless the user explicitly requested that exact operation.",
      "skills": [],
      "mcps": []
    }
  },
  "tmux": {
    "enabled": true,
    "layout": "main-vertical",
    "main_pane_size": 60
  }
}

```

## Skill Reference

Each skill is listed with a short description and its source. The config block above shows which agent uses it. `author` means the author's own third party skill (not part of the plugin); `public` means a public tool, framework, or MCP server.

| Skill | Description | Source |
| --- | --- | --- |
| `*` (excl. `!make-interfaces-feel-better`) | All installed skills except those explicitly excluded | `author` |
| `better-icons` | Icon design | `author` |
| `ce-brainstorm` | Brainstorming workflow | `author` |
| `codegraph` | (MCP) code graph navigation | `public` |
| `context7` | (MCP) library docs lookup | `public` |
| `crawl4ai` | (MCP) web crawling | `public` |
| `customer-research` | Customer research | `author` |
| `gh_app` | (MCP) GitHub app access | `public` |
| `image` | Image generation/editing | `author` |
| `make-interfaces-feel-better` | UI/UX polish | `author` |
| `marketing-psychology` | Marketing psychology | `author` |
| `motion` | Animation/motion design | `author` |
| `nuxt` | Nuxt framework | `public` |
| `pnpm` | pnpm package manager | `public` |
| `searxng` | (MCP) metasearch engine | `public` |
| `tsdown` | tsdown bundler | `public` |
| `video` | Video generation/editing | `author` |
| `vitest` | Vitest test runner | `public` |
| `vite` | Vite build tool | `public` |
| `vue` | Vue framework | `public` |
| `web-perf` | Web performance optimization | `author` |
| `websearch` | (MCP) web search | `public` |
| `workers-best-practices` | Worker best practices | `author` |

For the complete configuration reference, see [Configuration](configuration.md).

