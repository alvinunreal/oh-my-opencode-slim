import { type AgentDefinition, resolvePrompt } from './orchestrator';
import { createSynthesisOnlyPermission } from './permissions';

const COUNCIL_COMPACTION_EXCEPTION =
  'Exception: if the host asks you to produce a session checkpoint or compaction summary in a specific template, follow that template exactly and do not use the council report format.';

const COUNCIL_REPORT = `Report:

## Council Response
Synthesize the supplied findings and dissent. If no seat answered, report synthesis unavailable.

## Per-Councillor Details
By exact seat name: insight and stated confidence, or failure status.

## Council Summary
Among replies: Consensus Level (unanimous | majority | split), agreements, disagreements and resolution, uncertainty, next action.`;

/** Keep a custom report format and restore missing requirements after prompt overrides. */
export function ensureCouncilPrompt(prompt: string): string {
  if (!prompt.includes('## Council Response')) {
    prompt = `${prompt}\n\n${COUNCIL_REPORT}`;
  }
  return prompt.includes(COUNCIL_COMPACTION_EXCEPTION)
    ? prompt
    : `${prompt}\n\n${COUNCIL_COMPACTION_EXCEPTION}`;
}

const COUNCIL_AGENT_PROMPT = `${COUNCIL_REPORT}\n\n${COUNCIL_COMPACTION_EXCEPTION}`;

export function createCouncilAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  return {
    name: 'council',
    description:
      'Multi-model consensus agent that synthesizes viewpoints from council members',
    config: {
      model,
      prompt: resolvePrompt(
        'council',
        customPrompt,
        undefined,
        COUNCIL_AGENT_PROMPT,
        customAppendPrompt,
      ),
      permission: createSynthesisOnlyPermission(),
    },
  };
}
