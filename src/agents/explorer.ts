import type { AgentDefinition } from './orchestrator';
import { createRoleAgent, ROLE_DEFINITIONS } from './role-definitions';

export function createExplorerAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  return createRoleAgent(
    ROLE_DEFINITIONS.explorer,
    model,
    customPrompt,
    customAppendPrompt,
  );
}
