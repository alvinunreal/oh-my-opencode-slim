/**
 * Three-level `/preset` manager for the TUI.
 *
 * Level 1 — preset list (Apply / Edit / Create / Delete)
 * Level 2 — agents in a preset (Add / Edit / Remove / Save)
 * Level 3 — edit one agent's model, variant, temperature, options
 *
 * Pure TUI: uses `api.ui.*` dialog primitives and `api.client.providers()`
 * for the model list. Never sends a message to the server's `command()` flow,
 * so it triggers no LLM turn — same channel as the built-in `/models`.
 *
 * All preset mutations are written to the user-level config file
 * (`oh-my-opencode-slim.json[c]`). Applying a preset persists the preset
 * name only — the sidebar is NOT refreshed mid-session, because the agent
 * registry is unchanged and showing new models against running agents
 * would be misleading. The new preset takes effect on the next
 * conversation/reload, when `loadPluginConfig` re-reads the config and
 * merges the preset into `config.agents`. This is deliberate: hot-swapping
 * the agent tree during an active conversation could truncate context (a
 * new model may have a smaller window), drift prior assistant turns under a
 * changed system prompt, leave running subagents referencing stale agent
 * definitions, or shift tool/skill availability underfoot. A future path
 * to true in-session switching without reset requires a host API for atomic
 * agent-registry refresh with session compatibility checks.
 */
import type {
  TuiDialogSelectOption,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import type { JSX } from '@opentui/solid';
import { createElement, insert } from '@opentui/solid';
import type {
  AgentOverrideConfig,
  Preset,
  PresetDefinition,
  PresetInput,
} from './config';
import { normalizePreset, resolvePreset } from './config';
import { ALL_AGENT_NAMES } from './config/constants';
import { loadPluginConfig } from './config/loader';
import {
  deletePreset,
  findPresetDependents,
  getAllConfiguredPresets,
  getEditablePreset,
  getPresetSource,
  removeAgentFromPreset,
  setAgentOverride,
  switchPresetOnDisk,
  wouldCreatePresetCycle,
  writePreset,
} from './tools/preset-switch';
import type { TuiSnapshot } from './tui-state';

/** Build a `<text>` JSX element — required for DialogPrompt.description(). */
function desc(text: string): JSX.Element {
  const node = createElement('text');
  insert(node, text);
  return node as unknown as JSX.Element;
}

/** Sentinel option values used to embed actions in `DialogSelect` lists. */
const ACTION_NEW_PRESET = '__omo_new_preset__';
const ACTION_ADD_AGENT = '__omo_add_agent__';
const ACTION_REMOVE_AGENT = '__omo_remove_agent__';
const ACTION_SAVE = '__omo_save__';
const ACTION_SAVE_APPLY = '__omo_save_apply__';
const ACTION_BACK = '__omo_back__';
const ACTION_BASE_PRESET = '__omo_base_preset__';
const ACTION_INHERITED_PREFIX = '__omo_inherited__';

interface ManagerState {
  api: TuiPluginApi;
  directory: string;
  snapshotRef: { snapshot: TuiSnapshot };
}

/**
 * Entry point: open the preset manager at Level 1. Re-reads the config each
 * time it is opened so newly-edited files are reflected.
 */
export function openPresetManager(
  api: TuiPluginApi,
  directory: string,
  snapshotRef: { snapshot: TuiSnapshot },
): void {
  showPresetList({ api, directory, snapshotRef });
}

function showPresetList(state: ManagerState): void {
  const config = loadPluginConfig(state.directory, { silent: true });
  const allPresets = getAllConfiguredPresets(state.directory);
  const names = Array.from(
    new Set([...Object.keys(allPresets), ...Object.keys(config.presets ?? {})]),
  );
  const activePreset = config.preset ?? null;

  if (names.length === 0 && !activePreset) {
    // No presets at all: jump straight to "create" prompt.
    promptAndCreatePreset(state, () => showPresetList(state));
    return;
  }

  const options: TuiDialogSelectOption<string>[] = names.map((name) => {
    const isProject = getPresetSource(state.directory, name) === 'project';
    const tag = isProject ? ' [project - read-only]' : '';
    const title =
      name === activePreset ? `${name} (active)${tag}` : `${name}${tag}`;
    return {
      title,
      value: name,
      description: describePreset(name, allPresets, config.presets?.[name]),
    };
  });
  options.push({
    title: '+ Create new preset',
    value: ACTION_NEW_PRESET,
  });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: 'Presets',
        placeholder: 'Select a preset to apply or edit',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_NEW_PRESET) {
            promptAndCreatePreset(state, () => showPresetList(state));
            return;
          }
          showPresetActions(state, option.value);
        },
      }),
    }),
  );
}

function showPresetActions(state: ManagerState, presetName: string): void {
  const isProject = getPresetSource(state.directory, presetName) === 'project';
  const options: TuiDialogSelectOption<string>[] = [
    { title: 'Apply preset (reload to take effect)', value: 'apply' },
  ];

  if (!isProject) {
    options.push({ title: 'Edit agents', value: 'edit' });
    options.push({ title: 'Delete preset', value: 'delete' });
  }

  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Preset: ${presetName}`,
        options,
        onSelect: (option) => {
          switch (option.value) {
            case 'apply':
              applyPreset(state, presetName);
              break;
            case 'edit':
              editPreset(state, presetName);
              break;
            case 'delete':
              confirmDeletePreset(state, presetName);
              break;
            default:
              showPresetList(state);
          }
        },
      }),
    }),
  );
}

function applyPreset(state: ManagerState, presetName: string): void {
  applyPresetWithMessage(state, presetName, 'Preset saved');
}

/**
 * Apply a preset and show a combined toast. `title` lets Save & Apply show
 * a single distinct message instead of two separate toasts.
 *
 * The new preset takes effect on the next conversation/reload — the
 * sidebar is NOT refreshed mid-session, because the agent registry is
 * unchanged and showing new models against running agents would be
 * misleading.
 */
function applyPresetWithMessage(
  state: ManagerState,
  presetName: string,
  title: string,
): void {
  const config = loadPluginConfig(state.directory, { silent: true });
  const result = switchPresetOnDisk(state.directory, presetName, config);
  state.api.ui.dialog.clear();
  state.api.ui.toast({
    variant: result.ok ? 'success' : 'warning',
    title: result.ok ? title : 'Preset switch failed',
    message: result.ok
      ? `Saved preset "${presetName}". Reload OpenCode to use it. ${result.summary.join('; ')}`
      : result.message,
  });
}

function confirmDeletePreset(state: ManagerState, presetName: string): void {
  const isProject = getPresetSource(state.directory, presetName) === 'project';
  if (isProject) {
    state.api.ui.toast({
      variant: 'warning',
      title: 'Cannot delete preset',
      message: `Preset "${presetName}" is defined in project config (.opencode) and cannot be deleted here. Remove it from .opencode/oh-my-opencode-slim.jsonc directly.`,
    });
    showPresetActions(state, presetName);
    return;
  }

  const allPresets = getAllConfiguredPresets(state.directory);
  const dependents = findPresetDependents(presetName, allPresets);
  if (dependents.length > 0) {
    state.api.ui.toast({
      variant: 'warning',
      title: 'Cannot delete preset',
      message: `Cannot delete "${presetName}" because other preset(s) extend it: ${dependents.join(', ')}. Change their base preset first.`,
    });
    showPresetActions(state, presetName);
    return;
  }

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogConfirm({
        title: 'Delete preset',
        message: `Delete preset "${presetName}"? This cannot be undone.`,
        onConfirm: () => {
          const ok = deletePreset(state.directory, presetName);
          state.api.ui.dialog.clear();
          state.api.ui.toast({
            variant: ok ? 'success' : 'warning',
            title: ok ? 'Preset deleted' : 'Delete failed',
            message: ok
              ? `Deleted preset "${presetName}".`
              : `Could not delete "${presetName}" (it may have dependents or not exist in the user config file).`,
          });
          showPresetList(state);
        },
        onCancel: () => showPresetActions(state, presetName),
      }),
    }),
  );
}

function promptAndCreatePreset(
  state: ManagerState,
  onCancel: () => void,
): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogPrompt({
        title: 'Create new preset',
        placeholder: 'preset-name',
        onConfirm: (value) => {
          const name = value.trim();
          if (!name) {
            onCancel();
            return;
          }
          if (/\s/.test(name)) {
            state.api.ui.toast({
              variant: 'warning',
              title: 'Invalid name',
              message: 'Preset names cannot contain spaces.',
            });
            promptAndCreatePreset(state, onCancel);
            return;
          }
          // Check for name collision before opening an empty working copy,
          // to avoid silently overwriting an existing preset on save.
          const allPresets = getAllConfiguredPresets(state.directory);
          if (allPresets[name]) {
            if (getPresetSource(state.directory, name) === 'project') {
              state.api.ui.toast({
                variant: 'warning',
                title: 'Preset already exists',
                message: `A preset named "${name}" is already defined in project config (.opencode) and cannot be overwritten here.`,
              });
              promptAndCreatePreset(state, onCancel);
              return;
            }
            confirmOverwritePreset(state, name, onCancel);
            return;
          }
          editPresetWorkingCopy(state, name, { agents: {} });
        },
        onCancel,
      }),
    }),
  );
}

/**
 * Confirm overwriting an existing preset when the user enters a name that
 * already exists in the Create new preset prompt.
 */
function confirmOverwritePreset(
  state: ManagerState,
  name: string,
  onCancel: () => void,
): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogConfirm({
        title: 'Preset exists',
        message: `A preset named "${name}" already exists. Overwrite it with a new empty preset?`,
        onConfirm: () => {
          editPresetWorkingCopy(state, name, { agents: {} });
        },
        onCancel: () => promptAndCreatePreset(state, onCancel),
      }),
    }),
  );
}

function editPreset(state: ManagerState, presetName: string): void {
  const isProject = getPresetSource(state.directory, presetName) === 'project';
  if (isProject) {
    state.api.ui.toast({
      variant: 'warning',
      title: 'Preset is read-only',
      message: `Preset "${presetName}" is defined in project config (.opencode) and cannot be edited from the preset manager. Edit .opencode/oh-my-opencode-slim.jsonc directly.`,
    });
    showPresetActions(state, presetName);
    return;
  }

  // Retrieve the editable local delta directly so we do not materialize inherited agents
  const editable = getEditablePreset(state.directory, presetName);
  editPresetWorkingCopy(state, presetName, {
    extends: editable.extends,
    agents: { ...editable.agents },
  });
}

function editPresetWorkingCopy(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const allPresets = getAllConfiguredPresets(state.directory);

  let inheritedAgents: Preset = {};
  let inheritanceError: string | null = null;
  if (working.extends) {
    if (wouldCreatePresetCycle(presetName, working.extends, allPresets)) {
      inheritanceError = `Cycle detected with "${working.extends}"`;
    } else {
      try {
        inheritedAgents = resolvePreset(working.extends, allPresets);
      } catch (err) {
        inheritanceError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const options: TuiDialogSelectOption<string>[] = [];

  // 1. Base preset action
  const baseDesc = working.extends
    ? inheritanceError
      ? `Error: ${inheritanceError}. Select to change or remove.`
      : `Inherits from "${working.extends}". Select to change or remove.`
    : 'Select to inherit configuration from another preset.';

  options.push({
    title: `Base preset: ${working.extends ?? '(none)'}`,
    value: ACTION_BASE_PRESET,
    description: baseDesc,
  });

  // 2. Local agents (editable)
  const agentNames = Object.keys(working.agents);
  for (const name of agentNames) {
    options.push({
      title: name,
      value: name,
      description: describeOverride(working.agents[name]),
    });
  }

  // 3. Inherited agents (visible for context, not editable as local entries)
  if (working.extends && !inheritanceError) {
    const inheritedOnlyNames = Object.keys(inheritedAgents).filter(
      (name) => !(name in working.agents),
    );
    for (const name of inheritedOnlyNames) {
      options.push({
        title: `${name} (inherited from ${working.extends})`,
        value: `${ACTION_INHERITED_PREFIX}${name}`,
        description: describeOverride(inheritedAgents[name]),
      });
    }
  }

  // 4. Preset operations
  options.push({ title: '+ Add agent', value: ACTION_ADD_AGENT });
  options.push({ title: '− Remove agent', value: ACTION_REMOVE_AGENT });
  options.push({ title: '💾 Save', value: ACTION_SAVE });
  options.push({
    title: '💾 Save & Apply',
    value: ACTION_SAVE_APPLY,
  });
  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Edit preset: ${presetName}`,
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BASE_PRESET) {
            promptPickBasePreset(state, presetName, working);
            return;
          }
          if (option.value.startsWith(ACTION_INHERITED_PREFIX)) {
            const agentName = option.value.slice(
              ACTION_INHERITED_PREFIX.length,
            );
            state.api.ui.toast({
              variant: 'info',
              title: 'Inherited agent',
              message: `"${agentName}" is inherited from base preset "${working.extends}". Use "+ Add agent" to override it locally.`,
            });
            editPresetWorkingCopy(state, presetName, working);
            return;
          }
          switch (option.value) {
            case ACTION_ADD_AGENT:
              promptAddAgent(state, presetName, working);
              break;
            case ACTION_REMOVE_AGENT:
              promptRemoveAgent(state, presetName, working);
              break;
            case ACTION_SAVE:
              savePreset(state, presetName, working, false);
              break;
            case ACTION_SAVE_APPLY: {
              const saved = savePreset(state, presetName, working, false, true);
              if (saved) {
                applyPresetWithMessage(
                  state,
                  presetName,
                  'Preset saved & applied',
                );
              } else {
                state.api.ui.toast({
                  variant: 'warning',
                  title: 'Save failed',
                  message: `Could not write preset "${presetName}" to the config file.`,
                });
              }
              break;
            }
            case ACTION_BACK:
              showPresetList(state);
              break;
            default:
              // An agent was selected → edit it.
              editAgent(state, presetName, working, option.value);
          }
        },
      }),
    }),
  );
}

function promptPickBasePreset(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const allPresets = getAllConfiguredPresets(state.directory);

  const options: TuiDialogSelectOption<string>[] = [
    {
      title: '(none) — No base preset',
      value: '',
      description: 'Standalone preset without inherited configuration',
    },
  ];

  // Candidates: cannot be self, and cannot create a cycle
  const candidates = Object.keys(allPresets).filter((name) => {
    if (name === presetName) return false;
    if (wouldCreatePresetCycle(presetName, name, allPresets)) return false;
    return true;
  });

  for (const candidate of candidates) {
    let descStr = '';
    try {
      const resolved = resolvePreset(candidate, allPresets);
      const count = Object.keys(resolved).length;
      descStr = `${count} effective agent${count === 1 ? '' : 's'}: ${Object.keys(resolved).join(', ')}`;
    } catch {
      descStr = 'Configured preset';
    }

    options.push({
      title:
        candidate === working.extends
          ? `${candidate} (current base)`
          : candidate,
      value: candidate,
      description: descStr,
    });
  }

  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Base preset for "${presetName}"`,
        placeholder: 'Select a base preset',
        current: working.extends ?? '',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BACK) {
            editPresetWorkingCopy(state, presetName, working);
            return;
          }
          const nextExtends = option.value ? option.value : undefined;
          const nextWorking: PresetDefinition = {
            ...working,
            extends: nextExtends,
          };
          state.api.ui.toast({
            variant: 'success',
            title: 'Base preset updated',
            message: nextExtends
              ? `Base preset set to "${nextExtends}".`
              : 'Base preset cleared.',
          });
          editPresetWorkingCopy(state, presetName, nextWorking);
        },
      }),
    }),
  );
}

function promptAddAgent(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const present = new Set(Object.keys(working.agents));
  const available = ALL_AGENT_NAMES.filter((n) => !present.has(n));
  if (available.length === 0) {
    state.api.ui.toast({
      variant: 'info',
      title: 'No agents left',
      message: 'All known agents are already in this preset.',
    });
    editPresetWorkingCopy(state, presetName, working);
    return;
  }

  let inheritedAgents: Preset = {};
  if (working.extends) {
    try {
      const allPresets = getAllConfiguredPresets(state.directory);
      inheritedAgents = resolvePreset(working.extends, allPresets);
    } catch {
      // ignore resolution failures for hint
    }
  }

  const options: TuiDialogSelectOption<string>[] = available.map((n) => ({
    title: n,
    value: n,
    description: inheritedAgents[n]
      ? `Overrides inherited (${describeOverride(inheritedAgents[n])})`
      : undefined,
  }));
  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: 'Add agent',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BACK) {
            editPresetWorkingCopy(state, presetName, working);
            return;
          }
          // Add the agent with an empty override, then jump to Level 3.
          const nextAgents = setAgentOverride(working.agents, option.value, {});
          const nextWorking: PresetDefinition = {
            ...working,
            agents: nextAgents,
          };
          editAgent(state, presetName, nextWorking, option.value);
        },
      }),
    }),
  );
}

function promptRemoveAgent(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
): void {
  const agentNames = Object.keys(working.agents);
  if (agentNames.length === 0) {
    state.api.ui.toast({
      variant: 'info',
      title: 'No agents',
      message: working.extends
        ? 'This preset has no local agent overrides to remove.'
        : 'This preset has no agents to remove.',
    });
    editPresetWorkingCopy(state, presetName, working);
    return;
  }
  const options: TuiDialogSelectOption<string>[] = agentNames.map((n) => ({
    title: n,
    value: n,
    description: describeOverride(working.agents[n]),
  }));
  options.push({ title: '← Back', value: ACTION_BACK });

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: 'Remove agent',
        options,
        onSelect: (option) => {
          if (option.value === ACTION_BACK) {
            editPresetWorkingCopy(state, presetName, working);
            return;
          }
          const nextAgents = removeAgentFromPreset(
            working.agents,
            option.value,
          );
          const nextWorking: PresetDefinition = {
            ...working,
            agents: nextAgents,
          };
          state.api.ui.toast({
            variant: 'success',
            title: 'Agent removed',
            message: `Removed ${option.value} from preset.`,
          });
          editPresetWorkingCopy(state, presetName, nextWorking);
        },
      }),
    }),
  );
}

function savePreset(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  returnToList: boolean,
  silent = false,
): boolean {
  // Strip agents whose override is empty — they add nothing to the preset.
  const cleaned: Preset = {};
  for (const [agent, override] of Object.entries(working.agents)) {
    if (Object.keys(override).length > 0) {
      cleaned[agent] = override;
    }
  }
  const ok = writePreset(
    state.directory,
    presetName,
    working.extends ? { extends: working.extends, agents: cleaned } : cleaned,
  );
  if (!silent) {
    state.api.ui.toast({
      variant: ok ? 'success' : 'warning',
      title: ok ? 'Preset saved' : 'Save failed',
      message: ok
        ? `Saved preset "${presetName}" to config.`
        : `Could not write preset "${presetName}" to the config file.`,
    });
  }
  if (returnToList) {
    showPresetList(state);
  }
  return ok;
}

/**
 * Level 3: edit one agent's override. Walks through model → variant →
 * temperature → options, then commits back into the working preset.
 */
function editAgent(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
): void {
  const current = working.agents[agentName] ?? {};
  pickModel(state, presetName, working, agentName, current);
}

interface ModelOption {
  /** Full `providerID/modelID` string used in the preset config. */
  value: string;
  title: string;
  description: string;
  /** Variant names available for this model, if any. */
  variants: string[];
}

async function fetchModelOptions(api: TuiPluginApi): Promise<ModelOption[]> {
  // Guard: the TUI's client may not expose config.providers in all builds.
  if (!api.client?.config?.providers) {
    return [];
  }
  const res = (await api.client.config.providers()) as {
    data?: {
      providers?: Array<{
        id: string;
        models: Record<
          string,
          { name?: string; variants?: Record<string, unknown> }
        >;
      }>;
    };
  };
  const providers = res.data?.providers ?? [];
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider?.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!model) continue;
      options.push({
        value: `${provider.id}/${modelId}`,
        title: model.name ?? modelId,
        description: provider.id,
        variants: model.variants ? Object.keys(model.variants) : [],
      });
    }
  }
  return options;
}

function pickModel(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): void {
  // Show a toast while fetching — we keep the current dialog (Level 2)
  // visible until the model list is ready, then replace. This avoids a
  // dialog state conflict where a loading dialog's onClose could fire
  // dialog.clear() while the async callback later calls dialog.replace().
  state.api.ui.toast({
    variant: 'info',
    title: 'Loading models',
    message: `Fetching available models for ${agentName}…`,
  });

  void (async () => {
    let options: ModelOption[];
    try {
      options = await fetchModelOptions(state.api);
    } catch (err) {
      state.api.ui.toast({
        variant: 'warning',
        title: 'Could not load models',
        message: `Failed to fetch providers: ${String(err)}`,
      });
      editPresetWorkingCopy(state, presetName, working);
      return;
    }

    if (options.length === 0) {
      state.api.ui.toast({
        variant: 'warning',
        title: 'No models available',
        message:
          'Could not retrieve the model list. You can edit the preset config file manually.',
      });
      editPresetWorkingCopy(state, presetName, working);
      return;
    }

    try {
      // Only pass `current` if it matches an existing option, to avoid
      // DialogSelect crashing on a non-existent current value.
      let currentModel =
        typeof current.model === 'string'
          ? options.find((o) => o.value === current.model)?.value
          : undefined;

      const selectOptions: TuiDialogSelectOption<string>[] = options.map(
        (o) => ({
          title: o.title,
          value: o.value,
          description: o.description,
        }),
      );

      const ACTION_INHERIT_MODEL = '__omo_inherit_model__';
      if (working.extends) {
        let baseDesc = `Inherit model from base preset "${working.extends}"`;
        try {
          const allPresets = getAllConfiguredPresets(state.directory);
          const inheritedAgents = resolvePreset(working.extends, allPresets);
          const baseAgent = inheritedAgents[agentName];
          if (baseAgent?.model) {
            const modelStr =
              typeof baseAgent.model === 'string'
                ? baseAgent.model
                : Array.isArray(baseAgent.model) && baseAgent.model.length > 0
                  ? typeof baseAgent.model[0] === 'string'
                    ? baseAgent.model[0]
                    : baseAgent.model[0].id
                  : '';
            if (modelStr) {
              baseDesc = `Inherit "${modelStr}" from "${working.extends}"`;
            }
          }
        } catch {
          // ignore resolution errors for description
        }

        selectOptions.unshift({
          title: '(inherit from base) — No local model override',
          value: ACTION_INHERIT_MODEL,
          description: baseDesc,
        });

        if (current.model === undefined) {
          currentModel = ACTION_INHERIT_MODEL;
        }
      }

      state.api.ui.dialog.replace(() =>
        state.api.ui.Dialog({
          size: 'large',
          onClose: () => state.api.ui.dialog.clear(),
          children: state.api.ui.DialogSelect<string>({
            title: `Edit ${agentName} — model`,
            placeholder: 'Search models',
            current: currentModel,
            options: selectOptions,
            onSelect: (option) => {
              if (option.value === ACTION_INHERIT_MODEL) {
                const next: AgentOverrideConfig = { ...current };
                delete next.model;
                delete next.variant;
                pickTemperature(state, presetName, working, agentName, next);
                return;
              }
              const chosen = options.find((o) => o.value === option.value);
              const next: AgentOverrideConfig = {
                ...current,
                model: option.value,
              };
              pickVariant(
                state,
                presetName,
                working,
                agentName,
                next,
                chosen?.variants ?? [],
              );
            },
          }),
        }),
      );
    } catch (err) {
      state.api.ui.toast({
        variant: 'error',
        title: 'Model picker error',
        message: String(err),
      });
      editPresetWorkingCopy(state, presetName, working);
    }
  })();
}

function pickVariant(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
  availableVariants: string[],
): void {
  // No variants for this model → skip to temperature.
  if (availableVariants.length === 0) {
    pickTemperature(state, presetName, working, agentName, current);
    return;
  }

  const options: TuiDialogSelectOption<string>[] = [
    { title: 'none', value: '', description: 'no variant' },
    ...availableVariants.map((v) => ({ title: v, value: v })),
  ];

  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogSelect<string>({
        title: `Edit ${agentName} — variant (thinking strength)`,
        current: typeof current.variant === 'string' ? current.variant : '',
        options,
        onSelect: (option) => {
          const next: AgentOverrideConfig = { ...current };
          if (option.value) {
            next.variant = option.value;
          } else {
            delete next.variant;
          }
          pickTemperature(state, presetName, working, agentName, next);
        },
      }),
    }),
  );
}

function pickTemperature(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): void {
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogPrompt({
        title: `Edit ${agentName} — temperature`,
        description: () =>
          desc(
            'Enter a number 0–2, or leave blank for the provider default (typically 1.0).',
          ),
        value:
          typeof current.temperature === 'number'
            ? String(current.temperature)
            : '',
        placeholder: 'none',
        onConfirm: (value) => {
          const trimmed = value.trim();
          const next: AgentOverrideConfig = { ...current };
          if (trimmed) {
            const parsed = Number(trimmed);
            if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
              state.api.ui.toast({
                variant: 'warning',
                title: 'Invalid temperature',
                message: 'Temperature must be a number between 0 and 2.',
              });
              pickTemperature(state, presetName, working, agentName, current);
              return;
            }
            next.temperature = parsed;
          } else {
            delete next.temperature;
          }
          pickOptions(state, presetName, working, agentName, next);
        },
        onCancel: () => editPresetWorkingCopy(state, presetName, working),
      }),
    }),
  );
}

function pickOptions(
  state: ManagerState,
  presetName: string,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): void {
  const currentJson =
    current.options && typeof current.options === 'object'
      ? JSON.stringify(current.options)
      : '{}';
  state.api.ui.dialog.replace(() =>
    state.api.ui.Dialog({
      size: 'large',
      onClose: () => state.api.ui.dialog.clear(),
      children: state.api.ui.DialogPrompt({
        title: `Edit ${agentName} — options (JSON)`,
        description: () =>
          desc(
            'Provider-specific options as JSON, e.g. {"thinking":{"type":"enabled","budgetTokens":10000}}. Use {} for none.',
          ),
        value: currentJson,
        placeholder: '{}',
        onConfirm: (value) => {
          const trimmed = value.trim() || '{}';
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            state.api.ui.toast({
              variant: 'warning',
              title: 'Invalid JSON',
              message: 'Options must be valid JSON.',
            });
            pickOptions(state, presetName, working, agentName, current);
            return;
          }
          const next: AgentOverrideConfig = { ...current };
          if (Object.keys(parsed).length > 0) {
            next.options = parsed;
          } else {
            delete next.options;
          }
          // Commit back into the working preset and return to Level 2.
          const updatedAgents = setAgentOverride(
            working.agents,
            agentName,
            next,
          );
          const updatedWorking: PresetDefinition = {
            ...working,
            agents: updatedAgents,
          };
          state.api.ui.toast({
            variant: 'success',
            title: 'Agent updated',
            message: `${agentName} → ${describeOverride(next)}`,
          });
          editPresetWorkingCopy(state, presetName, updatedWorking);
        },
        onCancel: () => editPresetWorkingCopy(state, presetName, working),
      }),
    }),
  );
}

// --- formatting helpers (also used by the simple list view if needed) ---

function describePreset(
  name: string,
  allPresets: Record<string, PresetInput>,
  resolvedPreset?: Preset,
): string {
  const raw = allPresets[name];
  const normalized = raw ? normalizePreset(raw) : undefined;
  try {
    const resolved = resolvedPreset ?? resolvePreset(name, allPresets);
    const parts = Object.entries(resolved).map(
      ([agent, override]) => `${agent}: ${describeOverride(override)}`,
    );
    if (normalized?.extends) {
      return `extends: ${normalized.extends}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    return parts.length > 0 ? parts.join(', ') : '(empty)';
  } catch {
    if (normalized?.extends) {
      return `extends: ${normalized.extends} (unresolved inheritance)`;
    }
    return '(empty)';
  }
}

function describeOverride(override: AgentOverrideConfig): string {
  const bits: string[] = [];
  if (typeof override.model === 'string') {
    bits.push(override.model);
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const first = override.model[0];
    bits.push(typeof first === 'string' ? first : first.id);
  }
  if (typeof override.inheritModelFrom === 'string') {
    bits.push(`inherit=${override.inheritModelFrom}`);
  }
  if (typeof override.variant === 'string') {
    bits.push(`variant=${override.variant}`);
  }
  if (typeof override.temperature === 'number') {
    bits.push(`temp=${override.temperature}`);
  }
  if (override.options && Object.keys(override.options).length > 0) {
    bits.push('options');
  }
  if (Array.isArray(override.skills) && override.skills.length > 0) {
    bits.push(`skills=[${override.skills.join(',')}]`);
  }
  if (Array.isArray(override.skills_add) && override.skills_add.length > 0) {
    bits.push(`skills_add=[${override.skills_add.join(',')}]`);
  }
  if (
    Array.isArray(override.skills_remove) &&
    override.skills_remove.length > 0
  ) {
    bits.push(`skills_remove=[${override.skills_remove.join(',')}]`);
  }
  if (typeof override.skills_include_local === 'boolean') {
    bits.push(`skills_include_local=${override.skills_include_local}`);
  }
  if (Array.isArray(override.mcps) && override.mcps.length > 0) {
    bits.push(`mcps=[${override.mcps.join(',')}]`);
  }
  if (typeof override.prompt === 'string') {
    bits.push('prompt');
  }
  if (typeof override.orchestratorPrompt === 'string') {
    bits.push('orchestratorPrompt');
  }
  if (override.permission !== undefined) {
    bits.push('permission');
  }
  if (typeof override.displayName === 'string') {
    bits.push(`name=${override.displayName}`);
  }
  return bits.length > 0 ? bits.join(', ') : '(unset)';
}
