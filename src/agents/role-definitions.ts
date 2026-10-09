import {
  type SpecialistRole,
  SUPPORTED_SPECIALIST_ROLES,
} from '../config/agent-roles';
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
  LIBRARIAN_PROMPT,
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

export const SPECIALIST_ROLES = SUPPORTED_SPECIALIST_ROLES;
export type { SpecialistRole };

export const ROLE_DEFINITIONS: Readonly<
  Record<SpecialistRole, SpecialistRoleDefinition>
> = Object.freeze({
  explorer: Object.freeze({
    id: 'explorer',
    prompt: EXPLORER_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    description:
      "Fast codebase search and pattern matching. Use for finding files, locating code patterns, and answering 'where is X?' questions.",
  }),
  librarian: Object.freeze({
    id: 'librarian',
    prompt: LIBRARIAN_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    description:
      'External documentation and library research. Use for official docs lookup, GitHub examples, and understanding library internals.',
  }),
  oracle: Object.freeze({
    id: 'oracle',
    prompt: ORACLE_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    description:
      'Strategic technical advisor. Use for architecture decisions, complex debugging, code review, simplification, and engineering guidance.',
  }),
  designer: Object.freeze({
    id: 'designer',
    prompt: DESIGNER_PROMPT,
    permission: { task: { ...TASK_OBSERVER_DISPATCH_ONLY } },
    description:
      'UI/UX design, review, and implementation. Use for styling, responsive design, component architecture and visual polish.',
  }),
  fixer: Object.freeze({
    id: 'fixer',
    prompt: FIXER_PROMPT,
    permission: { task: { ...TASK_NO_NESTED_DISPATCH } },
    description:
      'Fast implementation specialist. Receives complete context and task spec, executes code changes efficiently.',
  }),
  observer: Object.freeze({
    id: 'observer',
    prompt: OBSERVER_PROMPT,
    permission: { task: { ...TASK_NO_NESTED_DISPATCH } },
    description:
      'Visual analysis. Use for interpreting images, screenshots, PDFs, and diagrams - extracts structured observations without loading raw files into main context. Requires a vision-capable model.',
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
