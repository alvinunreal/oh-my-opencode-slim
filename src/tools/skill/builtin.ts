import type { SkillDefinition } from "./types";

const playwrightSkill: SkillDefinition = {
  name: "playwright",
  description:
    "MUST USE for any browser-related tasks. Browser automation via Playwright MCP - verification, browsing, information gathering, web scraping, testing, screenshots, and all browser interactions.",
  template: `# Playwright Browser Automation

This skill provides browser automation capabilities via the Playwright MCP server.`,
  mcpConfig: {
    playwright: {
      command: "npx",
      args: ["@playwright/mcp@latest"],
    },
  },
};

const builtinSkillsMap = new Map<string, SkillDefinition>([
  [playwrightSkill.name, playwrightSkill],
]);

export function getBuiltinSkills(): SkillDefinition[] {
  return Array.from(builtinSkillsMap.values());
}

export function getSkillByName(name: string): SkillDefinition | undefined {
  return builtinSkillsMap.get(name);
}
