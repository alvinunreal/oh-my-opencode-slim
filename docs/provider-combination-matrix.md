# Provider Combination Test Matrix (2 to 6 Active)

This matrix tests 5 combinations across the 8 provider toggles in this project:

- `openai`
- `anthropic`
- `github-copilot`
- `zai-coding-plan`
- `kimi-for-coding`
- `google` (Antigravity/Gemini)
- `chutes`
- `opencode` free (`useOpenCodeFreeModels`)

## How this was determined

I generated outputs directly from `generateLiteConfig` in `src/cli/providers.ts` using fixed deterministic inputs:

- `selectedOpenCodePrimaryModel = opencode/glm-4.7-free`
- `selectedOpenCodeSecondaryModel = opencode/gpt-5-nano`
- `selectedChutesPrimaryModel = chutes/kimi-k2.5`
- `selectedChutesSecondaryModel = chutes/minimax-m2.1`

This represents the config output shape written by the installer when those selected models are available.

## Scenario S1 - 2 providers

Active providers: OpenAI + OpenCode Free

- Preset: `openai`
- Agents:
  - `orchestrator`: `openai/gpt-5.3-codex`
  - `oracle`: `openai/gpt-5.3-codex` (`high`)
  - `designer`: `openai/gpt-5.1-codex-mini` (`medium`)
  - `explorer`: `opencode/gpt-5-nano`
  - `librarian`: `opencode/gpt-5-nano`
  - `fixer`: `opencode/gpt-5-nano`
- Fallback chains:
  - `orchestrator`: `openai/gpt-5.3-codex -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `oracle`: `openai/gpt-5.3-codex -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `designer`: `openai/gpt-5.1-codex-mini -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `explorer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> opencode/big-pickle`
  - `librarian`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> opencode/big-pickle`
  - `fixer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> opencode/big-pickle`

## Scenario S2 - 3 providers

Active providers: OpenAI + Chutes + OpenCode Free

- Preset: `openai`
- Agents:
  - `orchestrator`: `openai/gpt-5.3-codex`
  - `oracle`: `openai/gpt-5.3-codex` (`high`)
  - `designer`: `openai/gpt-5.1-codex-mini` (`medium`)
  - `explorer`: `opencode/gpt-5-nano`
  - `librarian`: `opencode/gpt-5-nano`
  - `fixer`: `opencode/gpt-5-nano`
- Fallback chains:
  - `orchestrator`: `openai/gpt-5.3-codex -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `oracle`: `openai/gpt-5.3-codex -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `designer`: `openai/gpt-5.1-codex-mini -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `explorer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> chutes/minimax-m2.1 -> opencode/big-pickle`
  - `librarian`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> chutes/minimax-m2.1 -> opencode/big-pickle`
  - `fixer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> chutes/minimax-m2.1 -> opencode/big-pickle`

## Scenario S3 - 4 providers

Active providers: OpenAI + Copilot + ZAI Plan + OpenCode Free

- Preset: `openai`
- Agents:
  - `orchestrator`: `openai/gpt-5.3-codex`
  - `oracle`: `openai/gpt-5.3-codex` (`high`)
  - `designer`: `openai/gpt-5.1-codex-mini` (`medium`)
  - `explorer`: `opencode/gpt-5-nano`
  - `librarian`: `opencode/gpt-5-nano`
  - `fixer`: `opencode/gpt-5-nano`
- Fallback chains:
  - `orchestrator`: `openai/gpt-5.3-codex -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `oracle`: `openai/gpt-5.3-codex -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `designer`: `openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `explorer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> opencode/big-pickle`
  - `librarian`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> opencode/big-pickle`
  - `fixer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> opencode/big-pickle`

## Scenario S4 - 5 providers

Active providers: OpenAI + Gemini + Chutes + Copilot + OpenCode Free

- Preset: `antigravity-mixed-openai`
- Agents:
  - `orchestrator`: `chutes/kimi-k2.5`
  - `oracle`: `openai/gpt-5.3-codex` (`high`)
  - `designer`: `chutes/kimi-k2.5` (`medium`)
  - `explorer`: `opencode/gpt-5-nano`
  - `librarian`: `opencode/gpt-5-nano`
  - `fixer`: `opencode/gpt-5-nano`
- Fallback chains:
  - `orchestrator`: `chutes/kimi-k2.5 -> openai/gpt-5.3-codex -> github-copilot/grok-code-fast-1 -> google/antigravity-gemini-3-flash -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `oracle`: `openai/gpt-5.3-codex -> github-copilot/grok-code-fast-1 -> google/antigravity-gemini-3-pro -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `designer`: `chutes/kimi-k2.5 -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> google/antigravity-gemini-3-flash -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `explorer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> google/antigravity-gemini-3-flash -> chutes/minimax-m2.1 -> opencode/big-pickle`
  - `librarian`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> google/antigravity-gemini-3-flash -> chutes/minimax-m2.1 -> opencode/big-pickle`
  - `fixer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> github-copilot/grok-code-fast-1 -> google/antigravity-gemini-3-flash -> chutes/minimax-m2.1 -> opencode/big-pickle`

## Scenario S5 - 6 providers

Active providers: OpenAI + Anthropic + Copilot + ZAI Plan + Chutes + OpenCode Free

- Preset: `openai`
- Agents:
  - `orchestrator`: `openai/gpt-5.3-codex`
  - `oracle`: `openai/gpt-5.3-codex` (`high`)
  - `designer`: `openai/gpt-5.1-codex-mini` (`medium`)
  - `explorer`: `opencode/gpt-5-nano`
  - `librarian`: `opencode/gpt-5-nano`
  - `fixer`: `opencode/gpt-5-nano`
- Fallback chains:
  - `orchestrator`: `openai/gpt-5.3-codex -> anthropic/claude-opus-4-6 -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `oracle`: `openai/gpt-5.3-codex -> anthropic/claude-opus-4-6 -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `designer`: `openai/gpt-5.1-codex-mini -> anthropic/claude-sonnet-4-5 -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> chutes/kimi-k2.5 -> opencode/glm-4.7-free -> opencode/big-pickle`
  - `explorer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> anthropic/claude-haiku-4-5 -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> chutes/minimax-m2.1 -> opencode/big-pickle`
  - `librarian`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> anthropic/claude-sonnet-4-5 -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> chutes/minimax-m2.1 -> opencode/big-pickle`
  - `fixer`: `opencode/gpt-5-nano -> openai/gpt-5.1-codex-mini -> anthropic/claude-sonnet-4-5 -> github-copilot/grok-code-fast-1 -> zai-coding-plan/glm-4.7 -> chutes/minimax-m2.1 -> opencode/big-pickle`

## Notes

- This matrix shows deterministic `generateLiteConfig` output for the selected combinations.
- If the dynamic planner is used during full install (live model catalog), the generated `dynamic` preset may differ based on discovered models and capabilities.
