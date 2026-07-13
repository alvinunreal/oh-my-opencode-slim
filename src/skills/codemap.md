# src/skills/

## Responsibility

- Owns metadata-driven OpenCode custom skills shipped with this package
- Maintains the skill contract artifacts (`SKILL.md`, `README.md`, per-skill helper files) that are copied into `${configDir}/skills` at install time
- Preserves a canonical registry boundary: runtime code consumes skill definitions as data, not as executable plugin dependencies
- Skills are partitioned into orchestrator-only workflows and general-purpose skills for broad reuse

## Design

### Skill Registry

- `CUSTOM_SKILLS` in `src/cli/custom-skills-registry.ts` is the authoritative skill manifest for bundled skills
- Each entry maps folder name + `sourcePath` to an install-time consumer
- Skills are categorized by purpose and access scope:

| Skill | Type | Purpose |
|-------|------|-------|
| `codemap/` | General-purpose | Repository mapping and codebase documentation skill |
| `clonedeps/` | General-purpose | Workflow skill for dependency source mirroring and inspection |
| `simplify/` | General-purpose | Readability and maintainability guidance skill |
| `deepwork/` | Orchestrator-only | Heavy coding sessions, multi-phase implementation, and risky refactors |
| `verification-planning/` | Orchestrator-only | Project-specific evidence planning and verification affordances before non-trivial implementation |
| `reflect/` | Orchestrator-only | Learning from repeated work and suggesting reusable improvements |
| `release-smoke-test/` | Orchestrator-only | Packed release-candidate and bugfix validation |
| `worktrees/` | Orchestrator-only | Safe Git worktree lanes for parallel, risky, or isolated work |
| `oh-my-opencode-slim/` | Orchestrator-only | Plugin configuration and self-improvement guidance |

### Installation Pipeline

- `install.ts` runs `installCustomSkill()` which recursively copies bundled skill directories into the OpenCode skills directory
- During plugin release, the `files` whitelist in `package.json` must include `src/skills` so `src/skills/**` survive `npm pack`
- OpenCode plugin startup discovers these installed folders and reads each `SKILL.md` as a prompt-level contract

### Runtime Consumption

- Files are considered static runtime payload
- No plugin TS module in `src/` imports these files directly
- They are loaded by OpenCode via filesystem installation at runtime

## Flow

1. **Skill Discovery**: `src/cli/custom-skills-registry.ts` defines `CUSTOM_SKILLS` array with skill metadata
2. **Installation**: `bun run install` delegates to `src/cli/install.ts`, where `installCustomSkills()` gates copying of each `CUSTOM_SKILLS` entry
3. **Validation**: `installCustomSkill()` computes `packageRoot`, validates `sourcePath`, then performs a recursive directory copy via `copyDirRecursive()`
4. **Distribution**: During plugin release, `package.json` `files` whitelist ensures `src/skills/**` are included in the published tarball
5. **Runtime Discovery**: OpenCode plugin startup discovers installed skill folders and reads each `SKILL.md` as a prompt-level contract

## Integration

### Build & Release Dependencies

- `src/cli/custom-skills-registry.ts`: Source-of-truth registry consumed by installer and permission helpers
- `src/cli/install.ts`: Contains `installCustomSkills()` and `installCustomSkill()` functions
- `verify-release-artifact.ts`: Enforces artifact completeness by asserting key bundled skill payloads are present in the tarball:
  - `src/skills/simplify/SKILL.md`
  - `src/skills/codemap/SKILL.md`
  - `src/skills/clonedeps/SKILL.md`
  - `src/skills/deepwork/SKILL.md`
  - `src/skills/verification-planning/SKILL.md`
  - `src/skills/reflect/SKILL.md`
  - `src/skills/release-smoke-test/SKILL.md`
  - `src/skills/worktrees/SKILL.md`
  - `src/skills/oh-my-opencode-slim/SKILL.md`
- `package.json` scripts (`verify:release`, `build`) rely on these assets to ensure install-time skill availability

### Permission System

- `src/cli/skills.ts:getSkillPermissionsForAgent()` auto-populates permission rules for bundled skills when agent policy is derived from built-in recommendations
- Bundled skills are treated as data payloads with explicit permission boundaries defined in the skill manifests

### Skill Contracts

Each skill directory contains:
- `SKILL.md`: Skill contract defining name, description, and usage contract
- `README.md`: Documentation and examples for the skill
- Optional helper files and subdirectories for skill-specific functionality

These artifacts are copied verbatim to the OpenCode skills directory during installation and serve as the skill's interface definition.
