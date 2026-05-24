## DES-015: Plugin source verification block inserted before Step 5

Rationale anchor: REQ-016.

Insert a new subsection "Step 4.5: Verify Active Plugin Source (Fork-Specific)"
into `docs/installation.md` immediately before the existing Step 5
fork-specific addendum, inside the `<!-- slim-fork-addendum -->` block.

The subsection prescribes a decision tree:

1. Run `opencode plugin install boin/oh-my-opencode-slim`. If it returns
   `git dep preparation failed`, fall back to step 2.
2. Local checkout fallback: clone the fork to
   `~/.config/opencode/plugins/oh-my-opencode-slim-sdd`, `bun install`,
   `bun run build`, then add the absolute path as a string entry in
   the `plugin` array of `~/.config/opencode/opencode.json`.
3. Verification gate (mandatory regardless of which path succeeded):
   `grep -l spec_propose <plugin-dist-path>/dist/index.js` MUST return a
   hit. If it does not, the loaded plugin is upstream, not the fork —
   stop and re-do step 1/2.

The block is kept inside the existing addendum markers so upstream
merges continue to surface it as a single delete.

## DES-016: council.gamma example added to Step 5 preset description

Rationale anchor: REQ-017.

Augment the existing "Variants in the preset" bullet list in Step 5 with
a concrete `council` block example that includes `alpha`, `beta`, and
`gamma`. Use `<alias>/gemini` as the gamma model in the gateway variant
and `google/gemini-3-pro` in the official-providers variant, mirroring
the rest of Step 5's two-path structure.

Add a one-line rationale: "council without gamma silently degrades to a
two-edge debate; the third edge is the disagreement signal, not a
fallback."

## DES-017: Step 8 "Interaction discipline" + grill anti-pattern hardening

Rationale anchor: REQ-018.

Add Step 8 to `docs/installation.md`, inside the addendum markers,
after Step 7. Step 8 contains:

1. A three-item enumeration of valid reasons to stop and ask the user:
   - Genuine human-only judgment (business priority, scope/quality
     tradeoff, taste call the agent cannot derive).
   - Irreversible side effect (destructive git, external API write,
     production deploy, money, messages to other humans).
   - Scope explosion (the task as briefed implies >N files or >M lines
     of change beyond what the user approved; agent must reconfirm
     scope before continuing).
2. A one-line rule: anything outside those three categories is the
   agent's call. Do not stop to confirm routing, model choice, file
   layout, or anything the agent could resolve by reading the code.
3. A pointer back to the grill skill's phase-4 rules for the
   deep-dive case (spec authoring).

Separately, edit `src/skills/grill/SKILL.md` § Anti-patterns to add:

- Self-check before writing any `H-N`: "Could `grep`, a file read, or a
  doc fetch answer this? If yes, it belongs in phase 3, not phase 4."

This is documentation + skill-text only; no runtime code changes.
