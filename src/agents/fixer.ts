import type { AgentDefinition } from './orchestrator';
import { createRoleAgent, ROLE_DEFINITIONS } from './role-definitions';

export function createFixerAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  return createRoleAgent(
    ROLE_DEFINITIONS.fixer,
    model,
    customPrompt,
    customAppendPrompt,
  );
}
