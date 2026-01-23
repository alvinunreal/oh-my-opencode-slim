import type {
  Prompt,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { PluginConfig } from '../../config/schema';
import {
  canAgentUseMcp,
  canAgentUseSkill,
  getBuiltinSkills,
  getSkillByName,
  getSkillsForAgent,
} from './builtin';
import {
  SKILL_LIST_TOOL_DESCRIPTION,
  SKILL_MCP_TOOL_DESCRIPTION,
  SKILL_TOOL_DESCRIPTION,
} from './constants';
import type { SkillMcpManager } from './mcp-manager';
import type { SkillArgs, SkillDefinition, SkillMcpArgs } from './types';

type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

function formatSkillsList(skills: SkillDefinition[]): string {
  if (skills.length === 0) return 'No skills available for this agent.';

  return skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join('\n');
}

async function formatMcpCapabilities(
  skill: SkillDefinition,
  manager: SkillMcpManager,
  sessionId: string,
  agentName: string,
  pluginConfig?: PluginConfig,
): Promise<string | null> {
  if (!skill.mcpConfig || Object.keys(skill.mcpConfig).length === 0) {
    return null;
  }

  const sections: string[] = ['', '## Available MCP Servers', ''];

  for (const [serverName, config] of Object.entries(skill.mcpConfig)) {
    // Check if this agent can use this MCP
    if (!canAgentUseMcp(agentName, serverName, pluginConfig)) {
      continue; // Skip this MCP - agent doesn't have permission
    }

    const info = {
      serverName,
      skillName: skill.name,
      sessionId,
    };

    sections.push(`### ${serverName}`);
    sections.push('');

    try {
      const [tools, resources, prompts] = await Promise.all([
        manager.listTools(info, config).catch(() => []),
        manager.listResources(info, config).catch(() => []),
        manager.listPrompts(info, config).catch(() => []),
      ]);

      if (tools.length > 0) {
        sections.push('**Tools:**');
        sections.push('');
        for (const t of tools as Tool[]) {
          sections.push(`#### \`${t.name}\``);
          if (t.description) {
            sections.push(t.description);
          }
          sections.push('');
          sections.push('**inputSchema:**');
          sections.push('```json');
          sections.push(JSON.stringify(t.inputSchema, null, 2));
          sections.push('```');
          sections.push('');
        }
      }

      if (resources.length > 0) {
        sections.push(
          `**Resources**: ${(resources as Resource[])
            .map((r) => r.uri)
            .join(', ')}`,
        );
      }

      if (prompts.length > 0) {
        sections.push(
          `**Prompts**: ${(prompts as Prompt[]).map((p) => p.name).join(', ')}`,
        );
      }

      if (
        tools.length === 0 &&
        resources.length === 0 &&
        prompts.length === 0
      ) {
        sections.push('*No capabilities discovered*');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      sections.push(`*Failed to connect: ${errorMessage.split('\n')[0]}*`);
    }

    sections.push('');
    sections.push(
      `Use \`omos_skill_mcp\` tool with \`mcp_name="${serverName}"\` to invoke.`,
    );
    sections.push('');
  }

  return sections.join('\n');
}

export function createSkillTools(
  manager: SkillMcpManager,
  pluginConfig?: PluginConfig,
): {
  omos_skill: ToolDefinition;
  omos_skill_list: ToolDefinition;
  omos_skill_mcp: ToolDefinition;
} {
  const allSkills = getBuiltinSkills();
  const description = SKILL_TOOL_DESCRIPTION;

  const skill: ToolDefinition = tool({
    description,
    args: {
      name: tool.schema
        .string()
        .describe('The skill identifier from available_skills'),
    },
    async execute(args: SkillArgs, toolContext) {
      const tctx = toolContext as ToolContext | undefined;
      const sessionId = tctx?.sessionID ? String(tctx.sessionID) : 'unknown';
      const agentName = tctx?.agent ?? 'orchestrator';

      const skillDefinition = getSkillByName(args.name);
      if (!skillDefinition) {
        const available = allSkills.map((s) => s.name).join(', ');
        throw new Error(
          `Skill "${args.name}" not found. Available skills: ${available || 'none'}`,
        );
      }

      // Check if this agent can use this skill
      if (!canAgentUseSkill(agentName, args.name, pluginConfig)) {
        const allowedSkills = getSkillsForAgent(agentName, pluginConfig);
        const allowedNames = allowedSkills.map((s) => s.name).join(', ');
        throw new Error(
          `Agent "${agentName}" cannot use skill "${args.name}". ` +
            `Available skills for this agent: ${allowedNames || 'none'}`,
        );
      }

      const output = [
        `## Skill: ${skillDefinition.name}`,
        '',
        skillDefinition.template.trim(),
      ];

      if (skillDefinition.mcpConfig) {
        const mcpInfo = await formatMcpCapabilities(
          skillDefinition,
          manager,
          sessionId,
          agentName,
          pluginConfig,
        );
        if (mcpInfo) {
          output.push(mcpInfo);
        }
      }

      return output.join('\n');
    },
  });

  const skill_list: ToolDefinition = tool({
    description: SKILL_LIST_TOOL_DESCRIPTION,
    args: {},
    async execute(_, toolContext) {
      const tctx = toolContext as ToolContext | undefined;
      const agentName = tctx?.agent ?? 'orchestrator';
      const skills = getSkillsForAgent(agentName, pluginConfig);
      return formatSkillsList(skills);
    },
  });

  const skill_mcp: ToolDefinition = tool({
    description: SKILL_MCP_TOOL_DESCRIPTION,
    args: {
      skillName: tool.schema
        .string()
        .describe('Skill name that provides the MCP'),
      mcpName: tool.schema.string().describe('MCP server name'),
      toolName: tool.schema.string().describe('Tool name to invoke'),
      toolArgs: tool.schema
        .record(tool.schema.string(), tool.schema.any())
        .optional(),
    },
    async execute(args: SkillMcpArgs, toolContext) {
      const tctx = toolContext as ToolContext | undefined;
      const sessionId = tctx?.sessionID ? String(tctx.sessionID) : 'unknown';
      const agentName = tctx?.agent ?? 'orchestrator';

      const skillDefinition = getSkillByName(args.skillName);
      if (!skillDefinition) {
        const available = allSkills.map((s) => s.name).join(', ');
        throw new Error(
          `Skill "${args.skillName}" not found. Available skills: ${available || 'none'}`,
        );
      }

      // Check if this agent can use this skill
      if (!canAgentUseSkill(agentName, args.skillName, pluginConfig)) {
        throw new Error(
          `Agent "${agentName}" cannot use skill "${args.skillName}".`,
        );
      }

      // Check if this agent can use this MCP
      if (!canAgentUseMcp(agentName, args.mcpName, pluginConfig)) {
        throw new Error(
          `Agent "${agentName}" cannot use MCP "${args.mcpName}".`,
        );
      }

      if (
        !skillDefinition.mcpConfig ||
        !skillDefinition.mcpConfig[args.mcpName]
      ) {
        throw new Error(
          `Skill "${args.skillName}" has no MCP named "${args.mcpName}".`,
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
        args.toolArgs || {},
      );

      if (typeof result === 'string') {
        return result;
      }

      return JSON.stringify(result);
    },
  });

  return {
    omos_skill: skill,
    omos_skill_list: skill_list,
    omos_skill_mcp: skill_mcp,
  };
}
