---
name: reflect
description: Review recent work, find repeated workflow patterns, and suggest reusable skills, agents, commands, config changes, or playbooks. Use when the user asks to learn from past sessions, improve recurring workflows, or identify what should be turned into reusable agent instructions.
---

# Reflect

Reflect is an orchestrator-only workflow for learning from repeated work. It
looks back over recent sessions, project notes, and existing agent assets, then
recommends the smallest useful improvement: a skill, custom agent, command,
configuration change, prompt rule, documentation playbook, or no change.

The goal is to identify real repeated friction and suggest practical improvements with evidence.

## When to Use

Use Reflect when the user asks to:

- run `/reflect` or `/reflect <focus>`;
- learn from recent sessions or repeated workflows;
- find work they keep doing manually;
- improve their oh-my-opencode-slim setup based on actual usage using oh-my-opencode-slim skill;
- review whether a recurring process should become a reusable playbook;
- turn repeated workflow friction into a safer future default.

Do not use Reflect for ordinary implementation work, one-off debugging, broad
architecture review, or speculative agent creation without workflow evidence.

## Core Contract

Reflect must be conservative and evidence-driven.

Required behavior:

- inspect existing assets before suggesting new ones;
- prefer recent, repeated, user-visible friction over isolated incidents;
- recommend the smallest useful form;
- treat "create nothing" as a successful result when evidence is weak;
- ask before changing prompts, skills, commands, agents, MCP access, or config;
- avoid duplicating existing assets;
- explain restart requirements for OpenCode config, prompt, agent, skill, MCP, or
  plugin changes.

## Evidence Sources

Use available evidence in this order:

1. Current conversation and explicit user instructions.
2. Project-local guidance and memories, such as `AGENTS.md`, `.opencode/`,
   `.slim/`, notes, checkpoints, task progress files, and codemaps.
3. Existing skills, commands, agents, prompt overrides, MCP permissions, and
   oh-my-opencode-slim configuration.
4. Recent OpenCode logs or session artifacts if they are available and safe to
   inspect.
5. External docs only when a proposed workflow depends on a third-party tool or
   library whose behavior needs confirmation.

Respect privacy and safety boundaries. Do not inspect unrelated personal files,
credentials, private messages, or external accounts unless the user explicitly
asks and the workflow requires it.

## Workflow

Reflect can be triggered directly:

```text
/reflect
/reflect release workflow and checks
```

With no arguments, review recent work broadly. With arguments, focus the review
on that workflow area while still checking whether existing assets already cover
it.

### 1. Inventory Existing Assets

Before proposing anything, identify what already exists:

- bundled and user-installed skills;
- custom agents and their `orchestratorPrompt` guidance;
- custom commands;
- prompt overrides and append files;
- active oh-my-opencode-slim preset, model routing, skills, and MCP permissions;
- project playbooks, docs, codemaps, and local workflow notes.

If an existing asset already covers the candidate, recommend extending or using
that asset instead of creating a near-duplicate.

### 2. Find Repeated Workflow Patterns

Look for repeated signals such as:

- the same command sequence appears across sessions;
- the user repeatedly asks for the same review, setup, release, or debugging
  process;
- the same manual research or context-gathering steps keep recurring;
- the same specialist routing decision is repeatedly needed;
- the same project-specific rule is repeatedly re-explained;
- repeated failures happen because an agent lacks a stable instruction, tool, or
  permission boundary.

Strong candidates usually have at least two occurrences, stable inputs, a clear
output, and a clear stopping condition.

### 3. Score Candidates

For each candidate, decide:

- **Frequency:** How often has it happened?
- **Cost:** Does it waste meaningful time, context, money, or attention?
- **Risk:** Does inconsistent execution cause bugs, regressions, bad decisions,
  or unsafe changes?
- **Stability:** Are the inputs and desired output predictable?
- **Coverage:** Is there already an asset that handles it well?

Only recommend creating or changing assets when confidence is high.

### 4. Choose the Smallest Useful Form

Pick the least powerful form that solves the repeated problem:

- **Prompt/config rule:** a small behavior change to an existing agent.
- **Skill:** reusable workflow guidance for a task shape.
- **Command:** a repeatable manual trigger with stable inputs.
- **Custom agent:** a distinct specialist lane with clear delegation rules.
- **MCP/tool permission change:** a safe access adjustment for an existing agent.
- **Project playbook/doc:** human-readable process guidance when automation is too
  heavy.
- **Skip:** weak, one-off, ambiguous, sensitive, or already-covered work.

Avoid creating custom agents when a prompt rule or skill is enough. Avoid skills
when a short project playbook is enough. Avoid config changes when the benefit is
unclear.

### 5. Propose Before Changing

Unless the user explicitly requested a specific edit, present a concise proposal
before writing files or changing config:

```text
Found 2 strong repeated workflows and 1 weak candidate.

Recommended:
- Add a small orchestrator prompt rule for <workflow> because <evidence>.
- Extend existing <skill> instead of creating a new one because <overlap>.

Skip:
- <candidate> because it only appeared once.

Proceed with the proposed edits?
```

When applying changes, preserve existing user settings and prefer narrow,
append-only edits.

## Output Format

Return a compact report:

```text
Findings
- <workflow>: evidence, frequency/confidence, recommended form.

Recommended changes
- <asset/config/doc>: one-line purpose and why this is the smallest useful form.

Skipped
- <candidate>: why not worth packaging now.

Needs more evidence
- <candidate>: what would make it actionable.
```

If nothing qualifies, say:

```text
No strong repeated workflow found. I would not add or change any reusable assets
yet.
```

## Guardrails

- Do not manufacture assets to justify the workflow.
- Do not create overlapping skills or agents.
- Do not silently change global config, prompts, or permissions.
- Do not add broad instructions that make agents more eager, expensive, or
  invasive without a clear benefit.
- Do not overfit to a single session unless the user explicitly asks for that
  exact reusable workflow.
- Do not use private or sensitive material as examples in generated assets.
- When config, prompt, agent, skill, MCP, or plugin files change, tell the user:
  "This should apply on the next OpenCode run; restart OpenCode if you need it
  immediately."
