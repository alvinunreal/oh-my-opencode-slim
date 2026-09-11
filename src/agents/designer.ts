import type { AgentDefinition } from './orchestrator';
import { createRoleAgent, ROLE_DEFINITIONS } from './role-definitions';

export function createDesignerAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  return createRoleAgent(
    ROLE_DEFINITIONS.designer,
    model,
    customPrompt,
    customAppendPrompt,
  );
}
