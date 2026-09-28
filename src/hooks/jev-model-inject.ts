/**
 * Force the Jev-selected model onto task/subagent delegation calls.
 *
 * Why: OpenCode v1 `task()` has no model parameter in the LLM-facing schema,
 * and even on v2 the orchestrator may forget to pass `model`. The decision
 * layer already chose a strength-tier model for a task-type specialist; this
 * hook makes that choice stick at dispatch time.
 *
 * Only injects when:
 * - the call targets the specialist Jev recommended for this session,
 * - the decision status is `ok` (low_confidence stays prompt-authoritative),
 * - the caller did not already set an explicit model, and
 * - a model was resolved on that specialist's ladder.
 */
import { parseModelRef } from '../v2/adapters';
import { log } from '../utils/logger';
import {
  type JevRouteStore,
  toDelegationModelArg,
} from '../routing/jev/store';

const DELEGATION_TOOLS = new Set(['task', 'subagent']);

function agentFromArgs(args: Record<string, unknown>): string | undefined {
  const raw = args.subagent_type ?? args.agent;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function hasExplicitModel(args: Record<string, unknown>): boolean {
  const m = args.model;
  if (m == null) return false;
  if (typeof m === 'string') return m.trim() !== '';
  if (typeof m === 'object') {
    const obj = m as { id?: unknown; modelID?: unknown; providerID?: unknown };
    return Boolean(obj.id || obj.modelID || obj.providerID);
  }
  return false;
}

/**
 * Write the model into delegation args.
 *
 * v2: `{ providerID, id, variant? }` (Model.Ref) — same shape used by
 * `v2/types.ts` / client-shim. Falls back to the bare string when the id
 * has no provider slash.
 *
 * v1: string `provider/model` plus optional `modelVariant` (client-shim
 * already reads `args.modelVariant`).
 */
function setModelArg(
  args: Record<string, unknown>,
  modelId: string,
  variant: string | undefined,
  hostFlavor: string | undefined,
): void {
  if (args.model != null) return;

  if (hostFlavor === 'v2') {
    const ref = parseModelRef(modelId);
    if (ref) {
      args.model = variant
        ? { providerID: ref.providerID, id: ref.id, variant }
        : { providerID: ref.providerID, id: ref.id };
    } else {
      // No provider slash — keep the literal string rather than invent a provider.
      args.model = modelId;
    }
    return;
  }

  args.model = modelId;
  if (variant) args.modelVariant = variant;
}

export interface JevModelInjectDeps {
  store: JevRouteStore;
  /** hostFlavor: 'v2' when OpenCode v2 vocabulary is in use. */
  hostFlavor?: () => string | undefined;
  /**
   * Optional gate. When the session is not yet tracked as orchestrator,
   * `registerSessionAsOrchestrator` is attempted first so the FIRST task()
   * of a fresh session is not skipped.
   */
  shouldManageSession?: (sessionID: string) => boolean;
  registerSessionAsOrchestrator?: (sessionID: string) => void;
}

export function createJevModelInjectHook(deps: JevModelInjectDeps) {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      try {
        const toolName = input.tool?.toLowerCase?.() ?? '';
        if (!DELEGATION_TOOLS.has(toolName)) return;
        const sessionID = input.sessionID;
        if (!sessionID) return;

        // First-delegation fix: a fresh session may not be in the agent map
        // yet (task-session-manager registers later in this same before
        // chain). Register here so we do not skip the first inject.
        if (deps.shouldManageSession && !deps.shouldManageSession(sessionID)) {
          deps.registerSessionAsOrchestrator?.(sessionID);
          // Delegation tools are orchestrator-owned; still proceed even if
          // registration is async/deferred.
        }

        if (!output.args || typeof output.args !== 'object') return;
        const args = output.args as Record<string, unknown>;
        if (hasExplicitModel(args)) return;

        const agent = agentFromArgs(args);
        if (!agent) return;

        // Skip resume paths: model is already bound to the existing session.
        if (typeof args.task_id === 'string' && args.task_id.trim()) return;

        const prompt =
          typeof args.prompt === 'string'
            ? args.prompt
            : typeof args.description === 'string'
              ? args.description
              : '';
        if (!prompt.trim()) return;
        const found = deps.store.findForPrompt(sessionID, agent, prompt, {
          requireOk: true,
        });
        const result = found?.result;
        if (!result?.model?.id) return;

        const modelId = toDelegationModelArg(result.model);
        if (!modelId) return;

        setModelArg(
          args,
          modelId,
          result.model.variant,
          deps.hostFlavor?.(),
        );
        log('[jev-model-inject] applied model to delegation', {
          sessionID,
          agent,
          model: modelId,
          variant: result.model.variant,
          tier: result.modelTier,
        });
        // Consume once: parallel lanes keep their own task keys; a consumed
        // entry cannot leak into later, unrelated dispatches.
        if (found?.key) deps.store.consumeKey(found.key);
      } catch (err) {
        // Never block dispatch on injection failure.
        log('[jev-model-inject] skipped after error', String(err));
      }
    },
  };
}
