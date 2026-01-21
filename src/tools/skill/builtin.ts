import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import type { SkillDefinition } from "./types";
import type { PluginConfig, AgentName } from "../../config/schema";

/** Map old agent names to new names for backward compatibility */
const AGENT_ALIASES: Record<string, string> = {
  "explore": "explorer",
  "frontend-ui-ux-engineer": "designer",
};

/** Default skills per agent - "*" means all skills */
export const DEFAULT_AGENT_SKILLS: Record<AgentName, string[]> = {
  orchestrator: ["*"],
  designer: ["playwright"],
  oracle: [],
  librarian: [],
  explorer: [],
  fixer: [],
};

const YAGNI_TEMPLATE = readFileSync(
  fileURLToPath(new URL("./templates/yagni.md", import.meta.url)),
  "utf-8"
);

const PLAYWRIGHT_TEMPLATE = `# Playwright Browser Automation Skill

This skill provides browser automation capabilities via the Playwright MCP server.

**Capabilities**:
- Navigate to web pages
- Click elements and interact with UI
- Fill forms and submit data
- Take screenshots
- Extract content from pages
- Verify visual state
- Run automated tests

**Common Use Cases**:
- Verify frontend changes visually
- Test responsive design across viewports
- Capture screenshots for documentation
- Scrape web content
- Automate browser-based workflows

**Process**:
1. Load the skill to access MCP tools
2. Use playwright MCP tools for browser automation
3. Screenshots are saved to a session subdirectory (check tool output for exact path)
4. Report results with screenshot paths when relevant

**Example Workflow** (Designer agent):
1. Make UI changes to component
2. Use playwright to open page
3. Take screenshot of before/after
4. Verify responsive behavior
5. Return results with visual proof`;

const yagniEnforcementSkill: SkillDefinition = {
  name: "yagni-enforcement",
  description:
    "Code complexity analysis and YAGNI enforcement. Use after major refactors or before finalizing PRs to simplify code.",
  template: YAGNI_TEMPLATE,
};

const playwrightSkill: SkillDefinition = {
  name: "playwright",
  description:
    "MUST USE for any browser-related tasks. Browser automation via Playwright MCP - verification, browsing, information gathering, web scraping, testing, screenshots, and all browser interactions.",
  template: PLAYWRIGHT_TEMPLATE,
  mcpConfig: {
    playwright: {
      command: "npx",
      args: ["@playwright/mcp@latest"],
    },
  },
};

const builtinSkillsMap = new Map<string, SkillDefinition>([
  [yagniEnforcementSkill.name, yagniEnforcementSkill],
  [playwrightSkill.name, playwrightSkill],
]);

export function getBuiltinSkills(): SkillDefinition[] {
  return Array.from(builtinSkillsMap.values());
}

export function getSkillByName(name: string): SkillDefinition | undefined {
  return builtinSkillsMap.get(name);
}

/**
 * Get skills available for a specific agent
 * @param agentName - The name of the agent
 * @param config - Optional plugin config with agent overrides
 */
export function getSkillsForAgent(
  agentName: string,
  config?: PluginConfig
): SkillDefinition[] {
  const allSkills = getBuiltinSkills();
  const agentSkills = getAgentSkillList(agentName, config);
  
  // "*" means all skills
  if (agentSkills.includes("*")) {
    return allSkills;
  }
  
  return allSkills.filter((skill) => agentSkills.includes(skill.name));
}

/**
 * Check if an agent can use a specific skill
 */
export function canAgentUseSkill(
  agentName: string,
  skillName: string,
  config?: PluginConfig
): boolean {
  const agentSkills = getAgentSkillList(agentName, config);
  
  // "*" means all skills
  if (agentSkills.includes("*")) {
    return true;
  }
  
  return agentSkills.includes(skillName);
}

/**
 * Get the skill list for an agent (from config or defaults)
 * Supports backward compatibility with old agent names via AGENT_ALIASES
 */
function getAgentSkillList(agentName: string, config?: PluginConfig): string[] {
  // Check if config has override for this agent (new name first, then alias)
  const agentConfig = config?.agents?.[agentName] ??
    config?.agents?.[Object.keys(AGENT_ALIASES).find(k => AGENT_ALIASES[k] === agentName) ?? ""];
  if (agentConfig?.skills !== undefined) {
    return agentConfig.skills;
  }
  
  // Fall back to defaults
  const defaultSkills = DEFAULT_AGENT_SKILLS[agentName as AgentName];
  return defaultSkills ?? [];
}
