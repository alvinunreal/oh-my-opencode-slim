import type { PluginInput } from '@opencode-ai/plugin';
import { buildRetryGuidance } from './guidance';
import { detectDelegateTaskError } from './patterns';

export function createDelegateTaskRetryHook(_ctx: PluginInput) {
  return {
    'tool.execute.after': async (
      input: { tool: string },
      output: { output: unknown },
    ): Promise<void> => {
      const toolName = input.tool.toLowerCase();
      const isDelegateTool = toolName === 'task' || toolName === 'background_task';
      if (!isDelegateTool) return;

      if (typeof output.output !== 'string') return;

      const detected = detectDelegateTaskError(output.output);
      if (!detected) return;

      output.output += `\n${buildRetryGuidance(detected)}`;
    },
  };
}
