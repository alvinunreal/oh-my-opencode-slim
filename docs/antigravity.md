# Antigravity Provider Setup Guide

Complete guide for configuring Antigravity provider with oh-my-opencode-slim to access Claude and Gemini models through the "google" provider configuration.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Configuration](#configuration)
- [Provider Setup](#provider-setup)
- [Agent Model Assignment](#agent-model-assignment)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)

---

## Overview

Antigravity provides access to high-quality Claude and Gemini models through a unified interface. This guide shows you how to configure oh-my-opencode-slim to use Antigravity via the "google" provider configuration.

**Benefits:**
- Access to Claude Opus 4.5 Thinking and Sonnet 4.5 Thinking models
- Gemini 3 Pro High and Flash models
- Unified configuration through OpenCode
- Excellent for complex reasoning tasks (Claude) and fast responses (Gemini)

---

## Installation

### Prerequisites

1. **Install oh-my-opencode-slim:**
   ```bash
   bunx oh-my-opencode-slim@latest install
   ```

2. **Set up Antigravity/LLM-Mux:**
   Follow the installation guide at https://nghyane.github.io/llm-mux/#/installation

3. **Start the Antigravity service:**
   Ensure your Antigravity service is running on `http://127.0.0.1:8317`

---

## Configuration

### Step 1: Configure Provider in OpenCode

Edit `~/.config/opencode/opencode.json` and add the "google" provider configuration:

```json
{
  "provider": {
    "google": {
      "options": {
        "baseURL": "http://127.0.0.1:8317/v1beta",
        "apiKey": "sk-dummy"
      },
      "models": {
        "gemini-3-pro-high": {
          "name": "Gemini 3 Pro High",
          "attachment": true,
          "limit": {
            "context": 1048576,
            "output": 65535
          },
          "modalities": {
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          }
        },
        "gemini-3-flash": {
          "name": "Gemini 3 Flash",
          "attachment": true,
          "limit": {
            "context": 1048576,
            "output": 65536
          },
          "modalities": {
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          }
        },
        "claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking",
          "attachment": true,
          "limit": {
            "context": 200000,
            "output": 32000
          },
          "modalities": {
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          }
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking",
          "attachment": true,
          "limit": {
            "context": 200000,
            "output": 32000
          },
          "modalities": {
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

### Step 2: Configure Agent Models

Edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`) and add the Antigravity preset:

```json
{
  "preset": "antigravity",
  "presets": {
    "antigravity": {
      "orchestrator": {
        "model": "google/claude-opus-4-5-thinking",
        "skills": ["*"],
        "mcps": ["websearch"]
      },
      "oracle": {
        "model": "google/gemini-3-pro-high",
        "variant": "high",
        "skills": [],
        "mcps": []
      },
      "librarian": {
        "model": "google/gemini-3-flash",
        "variant": "low",
        "skills": [],
        "mcps": ["websearch", "context7", "grep_app"]
      },
      "explorer": {
        "model": "google/gemini-3-flash",
        "variant": "low",
        "skills": [],
        "mcps": []
      },
      "designer": {
        "model": "google/gemini-3-flash",
        "variant": "medium",
        "skills": ["agent-browser"],
        "mcps": []
      },
      "fixer": {
        "model": "google/gemini-3-flash",
        "variant": "low",
        "skills": [],
        "mcps": []
      }
    }
  }
}
```

---

## Provider Setup

### Available Models

| Model | Type | Context Window | Output Limit | Best For |
|-------|------|----------------|--------------|----------|
| `claude-opus-4-5-thinking` | Claude | 200K tokens | 32K tokens | Complex reasoning, orchestrator |
| `claude-sonnet-4-5-thinking` | Claude | 200K tokens | 32K tokens | Balanced reasoning and speed |
| `gemini-3-pro-high` | Gemini | 1M tokens | 65K tokens | High-quality responses |
| `gemini-3-flash` | Gemini | 1M tokens | 65K tokens | Fast responses, cost-effective |

### Model Recommendations

**For Orchestrator:** Use `claude-opus-4-5-thinking`
- Best reasoning capabilities for multi-agent coordination
- Excellent at planning complex workflows
- Can handle large context windows

**For Oracle:** Use `gemini-3-pro-high`  
- Strategic thinking and debugging
- High-quality architectural advice

**For Support Agents:** Use `gemini-3-flash`
- Fast and cost-effective for routine tasks
- Good for librarian, explorer, designer, and fixer roles

---

## Agent Model Assignment

### Basic Configuration

The preset assigns models based on their strengths:

```json
{
  "presets": {
    "antigravity": {
      "orchestrator": { "model": "google/claude-opus-4-5-thinking" },
      "oracle": { "model": "google/gemini-3-pro-high", "variant": "high" },
      "librarian": { "model": "google/gemini-3-flash", "variant": "low" },
      "explorer": { "model": "google/gemini-3-flash", "variant": "low" },
      "designer": { "model": "google/gemini-3-flash", "variant": "medium" },
      "fixer": { "model": "google/gemini-3-flash", "variant": "low" }
    }
  }
}
```

### Custom Assignments

You can customize which model each agent uses:

**Example: All Claude for reasoning-heavy work:**
```json
{
  "presets": {
    "claude-heavy": {
      "orchestrator": { "model": "google/claude-opus-4-5-thinking" },
      "oracle": { "model": "google/claude-sonnet-4-5-thinking", "variant": "high" },
      "librarian": { "model": "google/claude-sonnet-4-5-thinking", "variant": "low" },
      "explorer": { "model": "google/claude-sonnet-4-5-thinking", "variant": "low" },
      "designer": { "model": "google/claude-sonnet-4-5-thinking", "variant": "medium" },
      "fixer": { "model": "google/claude-sonnet-4-5-thinking", "variant": "low" }
    }
  }
}
```

**Example: Mixed setup with cost optimization:**
```json
{
  "presets": {
    "cost-optimized": {
      "orchestrator": { "model": "google/claude-sonnet-4-5-thinking" },
      "oracle": { "model": "google/gemini-3-pro-high", "variant": "high" },
      "librarian": { "model": "google/gemini-3-flash", "variant": "low" },
      "explorer": { "model": "google/gemini-3-flash", "variant": "low" },
      "designer": { "model": "google/gemini-3-flash", "variant": "low" },
      "fixer": { "model": "google/gemini-3-flash", "variant": "low" }
    }
  }
}
```

---

## Usage Examples

### Switching to Antigravity Preset

```bash
# Edit the preset in your config
export OH_MY_OPENCODE_SLIM_PRESET=antigravity
opencode
```

### Testing Configuration

1. **Verify provider connection:**
   ```bash
   opencode auth status
   ```

2. **Test agent responses:**
   ```bash
   opencode
   # In OpenCode, run: ping all agents
   ```

3. **Check logs for any connection issues:**
   ```bash
   tail -f ~/.config/opencode/logs/opencode.log
   ```

### Example Workflow

Once configured, you can ask the orchestrator to handle complex tasks:

```
Orchestrator, please analyze this codebase and create a comprehensive refactoring plan.
Use your team to:
1. Map the current architecture
2. Identify bottlenecks and issues  
3. Create a detailed implementation plan
4. Estimate effort and risks
```

The orchestrator will delegate to specialists using the configured Antigravity models.

---

## Troubleshooting

### Provider Connection Issues

**Problem:** Agents not responding or showing connection errors

**Solutions:**
1. Verify Antigravity service is running:
   ```bash
   curl http://127.0.0.1:8317/v1beta/models
   ```

2. Check the baseURL in your config matches your service:
   ```json
   {
     "options": {
       "baseURL": "http://127.0.0.1:8317/v1beta"
     }
   }
   ```

3. Verify your API key (can be dummy value like "sk-dummy")

### Model Not Found Errors

**Problem:** "Model not found" or similar errors

**Solutions:**
1. Ensure the model names match exactly:
   - `claude-opus-4-5-thinking` (not `claude-opus-4.5-thinking`)
   - `gemini-3-flash` (not `gemini-3-flash-preview`)

2. Check your provider configuration includes all required fields:
   ```json
   {
     "models": {
       "model-name": {
         "name": "Display Name",
         "attachment": true,
         "limit": { "context": 1048576, "output": 65535 },
         "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
       }
     }
   }
   ```

### Authentication Issues

**Problem:** 401 Unauthorized or similar auth errors

**Solutions:**
1. The `apiKey` can be any dummy value for Antigravity
2. Ensure the baseURL is correct and accessible
3. Restart OpenCode after changing configuration

### Performance Issues

**Problem:** Slow responses or timeouts

**Solutions:**
1. Use `gemini-3-flash` for faster responses on support agents
2. Check your Antigravity service performance
3. Consider reducing context sizes for large files

### Switching Between Presets

To test different configurations:

```bash
# Use environment variable for quick testing
export OH_MY_OPENCODE_SLIM_PRESET=openai
opencode

# Or edit ~/.config/opencode/oh-my-opencode-slim.json (or .jsonc)
# Change the "preset" field and restart OpenCode
```

---

## Additional Resources

- **LLM-Mux Installation:** https://nghyane.github.io/llm-mux/#/installation
- **OpenCode Documentation:** https://opencode.ai/docs
- **Quick Reference:** [docs/quick-reference.md](quick-reference.md)
- **Installation Guide:** [docs/installation.md](installation.md)