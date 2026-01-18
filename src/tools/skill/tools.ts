import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";
import { SKILL_MCP_TOOL_DESCRIPTION, SKILL_TOOL_DESCRIPTION } from "./constants";
import { getSkillByName, getBuiltinSkills } from "./builtin";
import type { SkillArgs, SkillMcpArgs, SkillDefinition } from "./types";
import { SkillMcpManager } from "./mcp-manager";

function formatSkillsXml(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";

  const skillsXml = skills
    .map(skill => {
      const lines = [
        "  <skill>",
        `    <name>${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
        "  </skill>",
      ];
      return lines.join("\n");
    })
    .join("\n");

  return `\n\n<available_skills>\n${skillsXml}\n</available_skills>`;
}

async function formatMcpCapabilities(
  skill: SkillDefinition,
  manager: SkillMcpManager,
  sessionId: string
): Promise<string | null> {
  if (!skill.mcpConfig || Object.keys(skill.mcpConfig).length === 0) {
    return null;
  }

  const sections: string[] = ["", "## Available MCP Servers", ""];

  for (const [serverName, config] of Object.entries(skill.mcpConfig)) {
    const info = {
      serverName,
      skillName: skill.name,
      sessionId,
    };

    sections.push(`### ${serverName}`);
    sections.push("");

    try {
      const [tools, resources, prompts] = await Promise.all([
        manager.listTools(info, config).catch(() => []),
        manager.listResources(info, config).catch(() => []),
        manager.listPrompts(info, config).catch(() => []),
      ]);

      if (tools.length > 0) {
        sections.push("**Tools:**");
        sections.push("");
        for (const t of tools as Tool[]) {
          sections.push(`#### \`${t.name}\``);
          if (t.description) {
            sections.push(t.description);
          }
          sections.push("");
          sections.push("**inputSchema:**");
          sections.push("```json");
          sections.push(JSON.stringify(t.inputSchema, null, 2));
          sections.push("```");
          sections.push("");
        }
      }

      if (resources.length > 0) {
        sections.push(
          `**Resources**: ${(resources as Resource[])
            .map(r => r.uri)
            .join(", ")}`
        );
      }

      if (prompts.length > 0) {
        sections.push(
          `**Prompts**: ${(prompts as Prompt[]).map(p => p.name).join(", ")}`
        );
      }

      if (tools.length === 0 && resources.length === 0 && prompts.length === 0) {
        sections.push("*No capabilities discovered*");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sections.push(`*Failed to connect: ${errorMessage.split("\n")[0]}*`);
    }

    sections.push("");
    sections.push(
      `Use \`omo_skill_mcp\` tool with \`mcp_name="${serverName}"\` to invoke.`
    );
    sections.push("");
  }

  return sections.join("\n");
}

export function createSkillTools(
  manager: SkillMcpManager
): { omo_skill: ToolDefinition; omo_skill_mcp: ToolDefinition } {
  const skills = getBuiltinSkills();
  const description =
    SKILL_TOOL_DESCRIPTION + (skills.length > 0 ? formatSkillsXml(skills) : "");

  const skill: ToolDefinition = tool({
    description,
    args: {
      name: tool.schema.string().describe("The skill identifier from available_skills"),
    },
    async execute(args: SkillArgs, toolContext) {
      const sessionId = toolContext?.sessionID
        ? String(toolContext.sessionID)
        : "unknown";
      const skillDefinition = getSkillByName(args.name);
      if (!skillDefinition) {
        const available = skills.map(s => s.name).join(", ");
        throw new Error(
          `Skill "${args.name}" not found. Available skills: ${available || "none"}`
        );
      }

      const output = [
        `## Skill: ${skillDefinition.name}`,
        "",
        skillDefinition.template.trim(),
      ];

      if (skillDefinition.mcpConfig) {
        const mcpInfo = await formatMcpCapabilities(
          skillDefinition,
          manager,
          sessionId
        );
        if (mcpInfo) {
          output.push(mcpInfo);
        }
      }

      return output.join("\n");
    },
  });

  const skill_mcp: ToolDefinition = tool({
    description: SKILL_MCP_TOOL_DESCRIPTION,
    args: {
      skillName: tool.schema.string().describe("Skill name that provides the MCP"),
      mcpName: tool.schema.string().describe("MCP server name"),
      toolName: tool.schema.string().describe("Tool name to invoke"),
      toolArgs: tool.schema.record(tool.schema.string(), tool.schema.any()).optional(),
    },
    async execute(args: SkillMcpArgs, toolContext) {
      const sessionId = toolContext?.sessionID
        ? String(toolContext.sessionID)
        : "unknown";
      const skillDefinition = getSkillByName(args.skillName);
      if (!skillDefinition) {
        const available = skills.map(s => s.name).join(", ");
        throw new Error(
          `Skill "${args.skillName}" not found. Available skills: ${available || "none"}`
        );
      }

      if (!skillDefinition.mcpConfig || !skillDefinition.mcpConfig[args.mcpName]) {
        throw new Error(
          `Skill "${args.skillName}" has no MCP named "${args.mcpName}".`
        );
      }

      const config = skillDefinition.mcpConfig[args.mcpName];
      const info = {
        serverName: args.mcpName,
        skillName: skillDefinition.name,
        sessionId,
      };

      const result = await manager.callTool(
        info,
        config,
        args.toolName,
        args.toolArgs || {}
      );

      if (typeof result === "string") {
        return result;
      }

      return JSON.stringify(result);
    },
  });

  return { omo_skill: skill, omo_skill_mcp: skill_mcp };
}
