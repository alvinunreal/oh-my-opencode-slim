# Antigravity Setup Guide

## Quick Setup

1. Install with Antigravity support:
   ```bash
   bunx oh-my-opencode-slim install --antigravity=yes
   ```

2. Authenticate:
   ```bash
   opencode auth login
   # Select "google" provider
   ```

3. Start using:
   ```bash
   opencode
   ```

## How It Works

The installer automatically:
- Adds `opencode-antigravity-auth@latest` plugin
- Configures Google provider with all Antigravity and Gemini CLI models
- Sets up Antigravity-focused agent mapping presets

## Models Available

### Antigravity Models (via Google Infrastructure)

1. **antigravity-gemini-3.1-pro**
   - Name: Gemini 3.1 Pro (Antigravity)
   - Context: 1M tokens, Output: 65K tokens
   - Variants: low, high thinking levels
   - Best for: Complex reasoning, high-quality outputs

2. **antigravity-gemini-3-flash**
   - Name: Gemini 3 Flash (Antigravity)
   - Context: 1M tokens, Output: 65K tokens
   - Variants: minimal, low, medium, high thinking levels
   - Best for: Fast responses, efficient agent tasks

3. **antigravity-claude-sonnet-4-5**
   - Name: Claude Sonnet 4.5 (Antigravity)
   - Context: 200K tokens, Output: 64K tokens
   - Best for: Balanced performance

4. **antigravity-claude-sonnet-4-5-thinking**
   - Name: Claude Sonnet 4.5 Thinking (Antigravity)
   - Context: 200K tokens, Output: 64K tokens
   - Variants: low (8K budget), max (32K budget)
   - Best for: Deep reasoning tasks

5. **antigravity-claude-opus-4-5-thinking**
   - Name: Claude Opus 4.5 Thinking (Antigravity)
   - Context: 200K tokens, Output: 64K tokens
   - Variants: low (8K budget), max (32K budget)
   - Best for: Most complex reasoning

### Gemini CLI Models (Fallback)

6. **gemini-2.5-flash**
   - Name: Gemini 2.5 Flash (Gemini CLI)
   - Context: 1M tokens, Output: 65K tokens
   - Requires: Gemini CLI authentication

7. **gemini-2.5-pro**
   - Name: Gemini 2.5 Pro (Gemini CLI)
   - Context: 1M tokens, Output: 65K tokens
   - Requires: Gemini CLI authentication

8. **gemini-3-flash-preview**
   - Name: Gemini 3 Flash Preview (Gemini CLI)
   - Context: 1M tokens, Output: 65K tokens
   - Requires: Gemini CLI authentication

9. **gemini-3.1-pro-preview**
   - Name: Gemini 3.1 Pro Preview (Gemini CLI)
   - Context: 1M tokens, Output: 65K tokens
   - Requires: Gemini CLI authentication

## Agent Configuration

When you install with `--antigravity=yes`, the preset depends on other providers:

### antigravity-mixed-both (Kimi + OpenAI + Antigravity)
- **Orchestrator**: Kimi k2p5
- **Oracle**: OpenAI model
- **Explorer/Librarian/Designer/Fixer**: Gemini 3 Flash (Antigravity)

### antigravity-mixed-kimi (Kimi + Antigravity)
- **Orchestrator**: Kimi k2p5
- **Oracle**: Gemini 3.1 Pro (Antigravity)
- **Explorer/Librarian/Designer/Fixer**: Gemini 3 Flash (Antigravity)

### antigravity-mixed-openai (OpenAI + Antigravity)
- **Orchestrator**: Gemini 3 Flash (Antigravity)
- **Oracle**: OpenAI model
- **Explorer/Librarian/Designer/Fixer**: Gemini 3 Flash (Antigravity)

### antigravity (Pure Antigravity)
- **Orchestrator**: Gemini 3 Flash (Antigravity)
- **Oracle**: Gemini 3.1 Pro (Antigravity)
- **Explorer/Librarian/Designer/Fixer**: Gemini 3 Flash (Antigravity)

## Manual Configuration

If you prefer to configure manually, edit `~/.config/opencode/oh-my-opencode-slim.json` (or `.jsonc`) and add a pure Antigravity preset:

```json
{
  "preset": "antigravity",
  "presets": {
    "antigravity": {
      "orchestrator": {
        "model": "google/antigravity-gemini-3-flash",
        "skills": ["*"],
        "mcps": ["websearch"]
      },
      "oracle": {
        "model": "google/antigravity-gemini-3.1-pro",
        "skills": [],
        "mcps": []
      },
      "explorer": {
        "model": "google/antigravity-gemini-3-flash",
        "variant": "low",
        "skills": [],
        "mcps": []
      },
      "librarian": {
        "model": "google/antigravity-gemini-3-flash",
        "variant": "low",
        "skills": [],
        "mcps": ["websearch", "context7", "grep_app"]
      },
      "designer": {
        "model": "google/antigravity-gemini-3-flash",
        "variant": "medium",
        "skills": ["agent-browser"],
        "mcps": []
      },
      "fixer": {
        "model": "google/antigravity-gemini-3-flash",
        "variant": "low",
        "skills": [],
        "mcps": []
      }
    }
  }
}
```

## Troubleshooting

### Authentication Failed
```bash
# Ensure Antigravity service is running
# Check service status
curl http://127.0.0.1:8317/health

# Re-authenticate
opencode auth login
```

### Models Not Available
```bash
# Verify plugin is installed
cat ~/.config/opencode/opencode.json | grep antigravity

# Reinstall plugin
bunx oh-my-opencode-slim install --antigravity=yes --no-tui --kimi=no --openai=no --tmux=no --skills=no
```

### Wrong Model Selected
```bash
# Check current preset
echo $OH_MY_OPENCODE_SLIM_PRESET

# Change preset
export OH_MY_OPENCODE_SLIM_PRESET=antigravity
opencode
```

### Service Connection Issues
```bash
# Check if Antigravity service is running on correct port
lsof -i :8317

# Restart the service
# (Follow your Antigravity/LLM-Mux restart procedure)
# Or edit ~/.config/opencode/oh-my-opencode-slim.json (or .jsonc)
# Change the "preset" field and restart OpenCode
```

## Notes

- **Terms of Service**: Using Antigravity may violate Google's ToS. Use at your own risk.
- **Performance**: Antigravity models typically have lower latency than direct API calls
- **Fallback**: Gemini CLI models require separate authentication but work as fallback
- **Customization**: You can mix and match any models across agents by editing the config
