import type { SpecialistRole } from '../config/agent-roles';
import type { AgentDefinition } from './orchestrator';
import type { AgentPermission } from './permissions';
import {
  TASK_NO_NESTED_DISPATCH,
  TASK_OBSERVER_DISPATCH_ONLY,
} from './permissions';
import {
  DESIGNER_PROMPT,
  EXPLORER_PROMPT,
  FIXER_PROMPT,
  OBSERVER_PROMPT,
  ORACLE_PROMPT,
} from './role-prompts';

export interface SpecialistRoleDefinition {
  readonly id: SpecialistRole;
  readonly prompt: string;
  readonly description: string;
  /** Per-role permission entries merged into the agent config. Carries the
   * nested-dispatch stance for `task`; absent means the generic default in
   * `applyDefaultPermissions` applies. */
  readonly permission?: AgentPermission;
}

export type { SpecialistRole };

export const ROLE_DEFINITIONS: Readonly<
  Record<SpecialistRole, SpecialistRoleDefinition>
> = Object.freeze({
  explorer: Object.freeze({
    id: 'explorer',
    prompt: EXPLORER_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    // Routing criteria live in the routing data / slim <Agents> lines; the
    // description (native dynamic subagent list) stays a single
    // non-duplicating identifier.
    description: 'Fast codebase search and external docs/web research.',
  }),
  oracle: Object.freeze({
    id: 'oracle',
    prompt: ORACLE_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    description: 'Strategic technical advisor.',
  }),
  designer: Object.freeze({
    id: 'designer',
    prompt: DESIGNER_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    description: 'UI/UX design, review, and implementation.',
  }),
  fixer: Object.freeze({
    id: 'fixer',
    prompt: FIXER_PROMPT,
    permission: { task: { ...TASK_NO_NESTED_DISPATCH } },
    description: 'Fast implementation specialist.',
  }),
  observer: Object.freeze({
    id: 'observer',
    prompt: OBSERVER_PROMPT,
    permission: { task: { ...TASK_NO_NESTED_DISPATCH } },
    description: 'Visual analysis specialist; requires a vision-capable model.',
  }),
});

export function createRoleAgent(
  role: SpecialistRoleDefinition,
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const prompt = customPrompt
    ? customPrompt
    : customAppendPrompt
      ? `${role.prompt}\n\n${customAppendPrompt}`
      : role.prompt;

  return {
    name: role.id,
    description: role.description,
    config: {
      model,
      prompt,
      ...(role.permission ? { permission: { ...role.permission } } : {}),
    },
  };
}
