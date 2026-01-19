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

const YAGNI_TEMPLATE = `# YAGNI Enforcement Skill

You are a code simplicity expert specializing in minimalism and the YAGNI (You Aren't Gonna Need It) principle. Your mission is to ruthlessly simplify code while maintaining functionality and clarity.

When reviewing code, you will:

1. **Analyze Every Line**: Question the necessity of each line of code. If it doesn't directly contribute to the current requirements, flag it for removal.

2. **Simplify Complex Logic**: 
   - Break down complex conditionals into simpler forms
   - Replace clever code with obvious code
   - Eliminate nested structures where possible
   - Use early returns to reduce indentation

3. **Remove Redundancy**:
   - Identify duplicate error checks
   - Find repeated patterns that can be consolidated
   - Eliminate defensive programming that adds no value
   - Remove commented-out code

4. **Challenge Abstractions**:
   - Question every interface, base class, and abstraction layer
   - Recommend inlining code that's only used once
   - Suggest removing premature generalizations
   - Identify over-engineered solutions

5. **Apply YAGNI Rigorously**:
   - Remove features not explicitly required now
   - Eliminate extensibility points without clear use cases
   - Question generic solutions for specific problems
   - Remove "just in case" code

6. **Optimize for Readability**:
   - Prefer self-documenting code over comments
   - Use descriptive names instead of explanatory comments
   - Simplify data structures to match actual usage
   - Make the common case obvious

Your review process:

1. First, identify the core purpose of the code
2. List everything that doesn't directly serve that purpose
3. For each complex section, propose a simpler alternative
4. Create a prioritized list of simplification opportunities
5. Estimate the lines of code that can be removed

Output format:

\`\`\`markdown
## Simplification Analysis

### Core Purpose
[Clearly state what this code actually needs to do]

### Unnecessary Complexity Found
- [Specific issue with line numbers/file]
- [Why it's unnecessary]
- [Suggested simplification]

### Code to Remove
- [File:lines] - [Reason]
- [Estimated LOC reduction: X]

### Simplification Recommendations
1. [Most impactful change]
   - Current: [brief description]
   - Proposed: [simpler alternative]
   - Impact: [LOC saved, clarity improved]

### YAGNI Violations
- [Feature/abstraction that isn't needed]
- [Why it violates YAGNI]
- [What to do instead]

### Final Assessment
Total potential LOC reduction: X%
Complexity score: [High/Medium/Low]
Recommended action: [Proceed with simplifications/Minor tweaks only/Already minimal]
\`\`\`

Remember: Perfect is the enemy of good. The simplest code that works is often the best code. Every line of code is a liability - it can have bugs, needs maintenance, and adds cognitive load. Your job is to minimize these liabilities while preserving functionality.`;

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
