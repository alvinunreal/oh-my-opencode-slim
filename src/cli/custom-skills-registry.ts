/**
 * A custom skill bundled in this repository.
 * Registered in-process from src/skills/ via the host's `ctx.skill` channel
 * at plugin load — never copied to the OpenCode skills directory.
 */
export interface CustomSkill {
  /** Skill name (folder name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** List of agents that should auto-allow this skill */
  allowedAgents: string[];
  /** Source path in this repo (relative to project root) */
  sourcePath: string;
}

/**
 * Registry of custom skills bundled in this repository — the single gate for
 * in-process skill registration.
 */
export const CUSTOM_SKILLS: CustomSkill[] = [
  {
    name: 'simplify',
    description: 'Code simplification and readability-focused refactoring',
    allowedAgents: ['oracle'],
    sourcePath: 'src/skills/simplify',
  },
  {
    name: 'codemap',
    description: 'Repository understanding and hierarchical codemap generation',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/codemap',
  },
  {
    name: 'clonedeps',
    description: 'Clone important dependency source for local inspection',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/clonedeps',
  },
  {
    name: 'deepwork',
    description:
      'Heavy/complex coding sessions and large modifications workflow',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/deepwork',
  },
  {
    name: 'verification-planning',
    description:
      'Plan credible, proportionate evidence before non-trivial implementation',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/verification-planning',
  },
  {
    name: 'step-back',
    description:
      'Pause snowballing patches and reassess direction before continuing',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/step-back',
  },
  {
    name: 'deanchor',
    description:
      'Generalize from examples instead of copying them with light edits',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/deanchor',
  },
  {
    name: 'ai-estimates',
    description:
      'Estimate task duration for a human working with AI, not alone',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/ai-estimates',
  },
  {
    name: 'reflect',
    description:
      'Review repeated work and suggest reusable workflow improvements',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/reflect',
  },
  {
    name: 'oh-my-opencode-slim',
    description:
      'Configure, customize, and safely improve oh-my-opencode-slim setups',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/oh-my-opencode-slim',
  },
  {
    name: 'worktrees',
    description:
      'Manage Git worktrees as OMO safe isolated coding lanes for complex/risky/parallel work',
    allowedAgents: ['orchestrator'],
    sourcePath: 'src/skills/worktrees',
  },
];
