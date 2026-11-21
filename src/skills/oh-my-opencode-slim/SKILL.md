---
name: oh-my-opencode-slim
description: Configure oh-my-opencode-slim agents, models, prompts, presets, Skill/MCP grants and optional features. Also use for recurring workflow friction that calls for a small configuration change.
---

# Configure Slim

## Inspect

Read the current `oh-my-opencode-slim.json[c]`, active `preset`, relevant agent
entries and ancestor `.opencode/` overrides. The user config search is
`OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`.
`.jsonc` wins over `.json` in each location. Root `agents` overrides preset
agent fields. Honor `OPENCODE_DISABLE_PROJECT_CONFIG`.

Prompt files live in each config directory's `oh-my-opencode-slim/` folder.
Resolve replacement and append independently: current project, nearest
ancestors, then user directories. Per project check the preset directory
before its root; for user files check all preset directories before roots.
Inline `prompt` wins over `<agent>.md`, which wins over the default.
`<agent>_append.md` follows that base. Prefer a small append to a full rewrite.
A user `skills/<name>/SKILL.md` can shadow a bundled skill.

## Choose the smallest useful change

- Use existing specialists for recon (Explorer), strategy (Oracle), UI/UX
  (Designer), bounded implementation (Fixer), or visual analysis (Observer).
  Enable optional agents by removing them from `disabled_agents`.
- Set per-lineup models/variants under `presets.<preset>.<agent>`; use root
  `agents.<name>` for settings shared across lineups. Explain spend changes.
- Use `skills` and `mcps` lists for grants (`[]`, named grants, `*`, `!name`).
  Grant only what the job needs; tools have separate `permission` rules.
- Create a custom specialist only for a recurring job not covered above. Set
  its model, focused `prompt`, and `orchestratorPrompt` with explicit delegate
  and don't-delegate criteria. Built-ins also support inline `prompt`;
  `orchestratorPrompt` is for non-Orchestrator agents only.
- Tune prompts for repeatable routing, project conventions, communication or
  verification issues. Solve one-off issues in the current turn instead.

## Apply safely

1. Explain the proposed change, target path and effects on cost, permissions
   and delegation. Ask first unless the user requested the exact edit.
2. Preserve unrelated settings, JSONC comments and exact agent/Skill/MCP names.
3. Validate the config and effective preset. Use `doctor` from the project.
4. State activation scope: a session preset changes inference settings only;
   prompt, grant and registry edits need a new host generation. Restart or
   reload to apply those changes.

See the repository's `docs/configuration.md` for the active option reference.
