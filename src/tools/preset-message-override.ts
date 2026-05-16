import type { AgentOverrideConfig, PluginConfig, Preset } from '../config';
import { AGENT_ALIASES } from '../config/constants';
import { getActiveRuntimePreset } from '../config/runtime-preset';
import {
  type MessageOverrideTarget,
  scheduleDeferredMessageOverride,
} from './preset-db-variant-override';

interface ModelDescriptor {
  providerID: string;
  modelID: string;
}

/**
 * Extract the variant string from a preset's per-agent override.
 *
 * Precedence:
 *   1. override.variant (top-level scalar)
 *   2. first array-form model entry's `variant` field
 *
 * Returns undefined if no variant can be determined.
 */
function resolveAgentVariant(
  override: AgentOverrideConfig | undefined,
): string | undefined {
  if (!override) return undefined;
  if (typeof override.variant === 'string') {
    return override.variant;
  }
  if (Array.isArray(override.model) && override.model.length > 0) {
    const first = override.model[0];
    if (
      typeof first === 'object' &&
      first !== null &&
      typeof (first as { variant?: unknown }).variant === 'string'
    ) {
      return (first as { variant?: string }).variant;
    }
  }
  return undefined;
}

/**
 * Resolve a model descriptor (`{ providerID, modelID }`) from a preset's
 * per-agent override. Handles both string and array forms.
 */
function resolveAgentModel(
  override: AgentOverrideConfig | undefined,
): ModelDescriptor | undefined {
  if (!override) return undefined;
  let id: string | undefined;
  if (typeof override.model === 'string') {
    id = override.model;
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const first = override.model[0];
    id =
      typeof first === 'string'
        ? first
        : typeof (first as { id?: unknown }).id === 'string'
          ? ((first as { id?: string }).id as string)
          : undefined;
  }
  if (typeof id !== 'string') return undefined;
  const parts = id.split('/');
  if (parts.length < 2) return undefined;
  return {
    providerID: parts[0],
    modelID: parts.slice(1).join('/'),
  };
}

function lookupPresetAgent(
  preset: Preset,
  agentName: string,
): AgentOverrideConfig | undefined {
  if (preset[agentName]) return preset[agentName];
  for (const [rawName, override] of Object.entries(preset)) {
    if ((AGENT_ALIASES[rawName] ?? rawName) === agentName) {
      return override;
    }
  }
  return undefined;
}

/**
 * Apply the active runtime preset's model + variant to an in-flight chat
 * message.
 *
 * OpenCode 1.15.x reads the agent's effective model/variant from
 * `user.model.{providerID,modelID,variant}` captured on the user message,
 * not from the live agent config. Without this hook, `/preset` changes
 * affect only newly created sessions — existing sessions keep their
 * original model/variant.
 *
 * Technique adapted from `code-yeongyu/oh-my-openagent`'s
 * `ultrawork-model-override`. See
 * https://github.com/alvinunreal/oh-my-opencode-slim/issues/438 for context.
 *
 * Stage A (in-band, sync):
 *   - Mutates `output.message.model.{providerID,modelID,variant}` and the
 *     flat `output.message.{variant,thinking}` aliases.
 *   - Affects the current turn's inference immediately.
 *
 * Stage B (deferred, bun-only):
 *   - Schedules a SQLite UPDATE on `opencode.db` so reload / chat history
 *     also reflect the override. No-op outside Bun.
 *
 * No-op when:
 *   - No runtime preset is active.
 *   - The preset has no entry for the message's agent.
 *   - The current message already matches both target model and variant.
 */
export function applyPresetVariantOverride(
  config: PluginConfig,
  agentName: string | undefined,
  output: { message?: Record<string, unknown> } | undefined,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
): void {
  if (!output?.message) return;

  const presetName = getActiveRuntimePreset();
  if (!presetName) return;

  const preset = config.presets?.[presetName];
  if (!preset) return;

  const messageAgentRaw =
    typeof output.message.agent === 'string'
      ? (output.message.agent as string)
      : undefined;
  const rawAgent = agentName ?? messageAgentRaw;
  if (!rawAgent) return;
  const resolvedAgent = AGENT_ALIASES[rawAgent] ?? rawAgent;

  const presetAgent = lookupPresetAgent(preset, resolvedAgent);
  if (!presetAgent) return;

  const targetVariant = resolveAgentVariant(presetAgent);
  const targetModel = resolveAgentModel(presetAgent);
  if (!targetVariant && !targetModel) return;

  const currentModelObj =
    typeof output.message.model === 'object' && output.message.model !== null
      ? (output.message.model as Record<string, unknown>)
      : undefined;
  const currentProvider =
    currentModelObj && typeof currentModelObj.providerID === 'string'
      ? (currentModelObj.providerID as string)
      : undefined;
  const currentModelID =
    currentModelObj && typeof currentModelObj.modelID === 'string'
      ? (currentModelObj.modelID as string)
      : undefined;
  const currentVariant =
    currentModelObj && typeof currentModelObj.variant === 'string'
      ? (currentModelObj.variant as string)
      : typeof output.message.variant === 'string'
        ? (output.message.variant as string)
        : undefined;

  const sameModel = targetModel
    ? currentProvider === targetModel.providerID &&
      currentModelID === targetModel.modelID
    : true;
  const sameVariant = targetVariant ? currentVariant === targetVariant : true;
  if (sameModel && sameVariant) return;

  // Stage A: mutate the in-flight user message synchronously.
  if (currentModelObj) {
    if (targetModel) {
      currentModelObj.providerID = targetModel.providerID;
      currentModelObj.modelID = targetModel.modelID;
    }
    if (targetVariant) {
      currentModelObj.variant = targetVariant;
    }
  } else if (targetModel) {
    output.message.model = {
      providerID: targetModel.providerID,
      modelID: targetModel.modelID,
      ...(targetVariant ? { variant: targetVariant } : {}),
    };
  }
  if (targetVariant) {
    output.message.variant = targetVariant;
    output.message.thinking = targetVariant;
  }

  log(`[preset-message-override] applied for ${resolvedAgent}`, {
    presetName,
    from: {
      providerID: currentProvider,
      modelID: currentModelID,
      variant: currentVariant,
    },
    to: {
      providerID: targetModel?.providerID,
      modelID: targetModel?.modelID,
      variant: targetVariant,
    },
  });

  // Stage B: persist via bun:sqlite (no-op outside Bun).
  const messageId =
    typeof output.message.id === 'string'
      ? (output.message.id as string)
      : undefined;
  if (messageId) {
    const target: MessageOverrideTarget = {
      ...(targetModel
        ? { providerID: targetModel.providerID, modelID: targetModel.modelID }
        : {}),
      ...(targetVariant ? { variant: targetVariant } : {}),
    };
    scheduleDeferredMessageOverride(messageId, target, log);
  }
}
