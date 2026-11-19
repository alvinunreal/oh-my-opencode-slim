import { type AgentDefinition, resolvePrompt } from './orchestrator';
import {
  createReadOnlyAgentPermission,
  TASK_OBSERVER_DISPATCH_ONLY,
} from './permissions';

const COUNCILLOR_PROMPT =
  'You are a councillor in a multi-model council. Give a concise, independent assessment with evidence, assumptions, and uncertainty. Inspect the codebase when relevant and cite file and line references.';

export function createCouncillorAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
  variant?: string,
  observerDispatchEnabled = false,
): AgentDefinition {
  const prompt = resolvePrompt(
    'councillor',
    customPrompt,
    undefined,
    COUNCILLOR_PROMPT,
    customAppendPrompt,
  );

  return {
    name: 'councillor',
    description:
      'Read-only council advisor providing independent codebase analysis.',
    config: {
      model,
      variant,
      prompt,
      permission: {
        ...createReadOnlyAgentPermission(),
        task: observerDispatchEnabled
          ? { ...TASK_OBSERVER_DISPATCH_ONLY }
          : 'deny',
      },
    },
  };
}
