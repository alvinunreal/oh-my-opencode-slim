/**
 * Filter available_skills block based on the current agent's permission.skill rules.
 * OpenCode core injects `<available_skills>` globally, so this hook rewrites that
 * block before the prompt is sent.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import { getSkillPermissionsForAgent } from '../../cli/skills';
import { getAgentOverride, type PluginConfig } from '../../config';

interface MessageInfo {
  role: string;
  agent?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

const AVAILABLE_SKILLS_BLOCK_REGEX =
  /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g;
const SKILL_NAME_REGEX = /<name>([^<]+)<\/name>/;

type SkillRule = 'allow' | 'ask' | 'deny';

interface SkillEntry {
  name: string;
  block: string;
}

function getCurrentAgent(messages: MessageWithParts[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.info.role === 'user') {
      return message.info.agent ?? 'orchestrator';
    }
  }

  return 'orchestrator';
}

function extractSkillEntries(blockContent: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const skillEntryRegex = /<skill>\s*([\s\S]*?)\s*<\/skill>/g;

  for (const match of blockContent.matchAll(skillEntryRegex)) {
    const block = match[0];
    const nameMatch = block.match(SKILL_NAME_REGEX);
    if (!nameMatch) {
      continue;
    }

    entries.push({
      name: nameMatch[1].trim(),
      block,
    });
  }

  return entries;
}

function isSkillAllowed(
  skillName: string,
  permissionRules: Record<string, SkillRule>,
): boolean {
  const specificRule = permissionRules[skillName];
  if (specificRule !== undefined) {
    return specificRule === 'allow';
  }

  return permissionRules['*'] === 'allow';
}

function filterAvailableSkillsText(
  text: string,
  permissionRules: Record<string, SkillRule>,
): string {
  return text.replace(
    AVAILABLE_SKILLS_BLOCK_REGEX,
    (_fullMatch, blockContent: string) => {
      const allowedEntries = extractSkillEntries(blockContent).filter((entry) =>
        isSkillAllowed(entry.name, permissionRules),
      );

      if (allowedEntries.length === 0) {
        return '<available_skills>\nNo skills available.\n</available_skills>';
      }

      return `<available_skills>\n${allowedEntries
        .map((entry) => entry.block)
        .join('\n')}\n</available_skills>`;
    },
  );
}

/**
 * Creates the experimental.chat.messages.transform hook for filtering available skills.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 */
export function createFilterAvailableSkillsHook(
  _ctx: PluginInput,
  config: PluginConfig,
) {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const { messages } = output;
      if (messages.length === 0) {
        return;
      }

      const agentName = getCurrentAgent(messages);
      const configuredSkills = getAgentOverride(config, agentName)?.skills;
      const permissionRules = getSkillPermissionsForAgent(
        agentName,
        configuredSkills,
      );

      for (const message of messages) {
        for (const part of message.parts) {
          if (
            part.type !== 'text' ||
            !part.text ||
            !part.text.includes('<available_skills>')
          ) {
            continue;
          }

          part.text = filterAvailableSkillsText(part.text, permissionRules);
        }
      }
    },
  };
}

export { filterAvailableSkillsText };
