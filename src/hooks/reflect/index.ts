const COMMAND_NAME = 'reflect';

function activationPrompt(focus: string): string {
  const focusBlock = focus
    ? ['Focus:', focus]
    : [
        'Focus:',
        'Review recent work broadly and identify repeated workflow friction worth improving.',
      ];

  return [
    'Use the reflect skill for this request.',
    '',
    'Reflect requirements:',
    '- inspect existing skills, commands, agents, prompt overrides, MCP permissions, config, and project playbooks before suggesting anything new;',
    '- find repeated workflow patterns from the current conversation, project notes, local memories, logs, or session artifacts that are available and safe to inspect;',
    '- prefer evidence from repeated recent behavior over speculation;',
    '- recommend the smallest useful improvement: prompt/config rule, skill, command, custom agent, MCP/tool permission change, project playbook, or skip;',
    '- treat creating nothing as a valid result when evidence is weak;',
    '- ask before changing prompts, skills, commands, agents, MCP access, or config unless the user explicitly requested the exact edit;',
    '- return a compact report with findings, recommended changes, skipped candidates, and items needing more evidence.',
    '',
    ...focusBlock,
  ].join('\n');
}

export function createReflectCommandHook(): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
} {
  let shouldHandleCommand = false;

  return {
    registerCommand: (opencodeConfig) => {
      const commandConfig = opencodeConfig.command as
        | Record<string, unknown>
        | undefined;
      if (commandConfig?.[COMMAND_NAME]) {
        shouldHandleCommand = false;
        return;
      }
      if (!opencodeConfig.command) opencodeConfig.command = {};
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Review repeated work and suggest workflow improvements',
        description:
          'Use reflect to learn from repeated workflows and suggest reusable improvements',
      };
      shouldHandleCommand = true;
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME || !shouldHandleCommand) return;

      output.parts.length = 0;
      output.parts.push({
        type: 'text',
        text: activationPrompt(input.arguments.trim()),
      });
    },
  };
}
