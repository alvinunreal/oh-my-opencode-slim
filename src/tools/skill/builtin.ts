import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SkillDefinition } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper to load skill markdown files
function loadSkillTemplate(filename: string): string {
  try {
    const skillsDir = join(__dirname, "../../../skills");
    return readFileSync(join(skillsDir, filename), "utf-8");
  } catch (error) {
    console.warn(`Failed to load skill template ${filename}:`, error);
    return "";
  }
}

const technicalWritingSkill: SkillDefinition = {
  name: "technical-writing",
  description:
    "Technical documentation writer. Use for README files, API docs, architecture docs, and user guides.",
  template: loadSkillTemplate("technical-writing.md"),
};

const yagniEnforcementSkill: SkillDefinition = {
  name: "yagni-enforcement",
  description:
    "Code complexity analysis and YAGNI enforcement. Use after major refactors or before finalizing PRs to simplify code.",
  template: loadSkillTemplate("yagni-enforcement.md"),
};

const playwrightSkill: SkillDefinition = {
  name: "playwright",
  description:
    "MUST USE for any browser-related tasks. Browser automation via Playwright MCP - verification, browsing, information gathering, web scraping, testing, screenshots, and all browser interactions.",
  template: loadSkillTemplate("playwright.md"),
  mcpConfig: {
    playwright: {
      command: "npx",
      args: ["@playwright/mcp@latest"],
    },
  },
};

const builtinSkillsMap = new Map<string, SkillDefinition>([
  [technicalWritingSkill.name, technicalWritingSkill],
  [yagniEnforcementSkill.name, yagniEnforcementSkill],
  [playwrightSkill.name, playwrightSkill],
]);

export function getBuiltinSkills(): SkillDefinition[] {
  return Array.from(builtinSkillsMap.values());
}

export function getSkillByName(name: string): SkillDefinition | undefined {
  return builtinSkillsMap.get(name);
}
