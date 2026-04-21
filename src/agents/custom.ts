import { type AgentDefinition, resolvePrompt } from './orchestrator';

const DEFAULT_CUSTOM_PROMPT = (name: string) =>
  `You are a specialized AI agent called ${name}. Follow the user's instructions carefully.`;

/**
 * Create a custom agent definition from user configuration.
 * Custom agents are user-defined specialists that the orchestrator
 * can delegate to, without modifying core source code.
 *
 * @param name - The agent name (as defined in config)
 * @param model - The model identifier for this agent
 * @param basePrompt - Inline prompt from config (or default)
 * @param description - Agent description for orchestrator prompt
 * @param filePrompt - File-based prompt override (from loadAgentPrompt)
 * @param fileAppendPrompt - File-based append prompt (from loadAgentPrompt)
 * @returns An AgentDefinition for the custom agent
 */
export function createCustomAgent(
  name: string,
  model: string,
  basePrompt?: string,
  description?: string,
  filePrompt?: string,
  fileAppendPrompt?: string,
): AgentDefinition {
  const effectiveBase = basePrompt ?? DEFAULT_CUSTOM_PROMPT(name);
  const prompt = resolvePrompt(effectiveBase, filePrompt, fileAppendPrompt);

  return {
    name,
    description: description ?? `Custom agent: ${name}`,
    config: {
      model,
      temperature: 0.1,
      prompt,
    },
  };
}
