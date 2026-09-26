import type { AgentDefinition } from './orchestrator';
import { createRoleAgent, ROLE_DEFINITIONS } from './role-definitions';

export function createOracleAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  return createRoleAgent(
    ROLE_DEFINITIONS.oracle,
    model,
    customPrompt,
    customAppendPrompt,
  );
}
