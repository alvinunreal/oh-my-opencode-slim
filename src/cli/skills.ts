import { spawnSync } from 'node:child_process';

/**
 * A recommended skill to install via `npx skills add`.
 */
export interface RecommendedSkill {
  /** Human-readable name for prompts */
  name: string;
  /** GitHub repo URL for `npx skills add` */
  repo: string;
  /** Skill name within the repo (--skill flag) */
  skillName: string;
  /** List of agents that should auto-allow this skill */
  allowedAgents: string[];
  /** Description shown to user during install */
  description: string;
  /** Optional commands to run after the skill is added */
  postInstallCommands?: string[];
}

/**
 * List of recommended skills.
 * Add new skills here to include them in the installation flow.
 */
export const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  {
    name: 'simplify',
    repo: 'https://github.com/brianlovin/claude-config',
    skillName: 'simplify',
    allowedAgents: ['orchestrator'],
    description: 'YAGNI code simplification expert',
  },
  {
    name: 'agent-browser',
    repo: 'https://github.com/vercel-labs/agent-browser',
    skillName: 'agent-browser',
    allowedAgents: ['designer'],
    description: 'High-performance browser automation',
    postInstallCommands: [
      'npm install -g agent-browser',
      'agent-browser install',
    ],
  },
];

/**
 * Install a skill using `npx skills add`.
 * @param skill - The skill to install
 * @returns True if installation succeeded, false otherwise
 */
export function installSkill(skill: RecommendedSkill): boolean {
  const args = [
    'skills',
    'add',
    skill.repo,
    '--skill',
    skill.skillName,
    '-a',
    'opencode',
    '-y',
    '--global',
  ];

  try {
    const result = spawnSync('npx', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      return false;
    }

    // Run post-install commands if any
    if (skill.postInstallCommands && skill.postInstallCommands.length > 0) {
      console.log(`Running post-install commands for ${skill.name}...`);
      for (const cmd of skill.postInstallCommands) {
        console.log(`> ${cmd}`);
        const [command, ...cmdArgs] = cmd.split(' ');
        const cmdResult = spawnSync(command, cmdArgs, { stdio: 'inherit' });
        if (cmdResult.status !== 0) {
          console.warn(`Post-install command failed: ${cmd}`);
        }
      }
    }

    return true;
  } catch (error) {
    console.error(`Failed to install skill: ${skill.name}`, error);
    return false;
  }
}

/**
 * Get permission presets for a specific agent based on recommended skills.
 * @param agentName - The name of the agent
 * @param skillList - Optional explicit list of skills to allow (overrides recommendations)
 * @returns Permission rules for the skill permission type
 */
export function getSkillPermissionsForAgent(
  agentName: string,
  skillList?: string[],
): Record<string, 'allow' | 'ask' | 'deny'> {
  // Orchestrator gets all skills by default, others are restricted
  const permissions: Record<string, 'allow' | 'ask' | 'deny'> = {
    '*': agentName === 'orchestrator' ? 'allow' : 'deny',
  };

  // If the user provided an explicit skill list (even empty), honor it
  if (skillList) {
    permissions['*'] = 'deny';
    for (const name of skillList) {
      if (name === '*') {
        permissions['*'] = 'allow';
      } else if (name.startsWith('!')) {
        permissions[name.slice(1)] = 'deny';
      } else {
        permissions[name] = 'allow';
      }
    }
    return permissions;
  }

  // Otherwise, use recommended defaults
  for (const skill of RECOMMENDED_SKILLS) {
    const isAllowed =
      skill.allowedAgents.includes('*') ||
      skill.allowedAgents.includes(agentName);
    if (isAllowed) {
      permissions[skill.skillName] = 'allow';
    }
  }

  return permissions;
}
