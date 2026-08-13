/**
 * OpenCode v2 TUI plugin entrypoint.
 *
 * v2 loads the TUI plugin's `default.setup(context)`. This module exports a
 * `V2TuiPlugin.Definition`-shaped object (`{ id, setup }`) that:
 *
 * 1. Registers a `sidebar.content` slot rendering the OMO-Slim agent status
 *    panel — the same sidebar the v1 TUI plugin renders.
 * 2. Registers a `/preset` keymap command (palette + slash) that opens the
 *    preset manager using the v2 promise-based dialog API.
 *
 * The v1 TUI module (`src/tui.ts`) is kept for v1 hosts; this module is the
 * v2 entrypoint pointed at by the `./tui` package export.
 */

import type { JSX } from '@opentui/solid';
import { createElement, insert, setProp } from '@opentui/solid';
import {
  DEFAULT_DISABLED_AGENTS,
  SUBAGENT_NAMES,
} from '../config/constants';
import { loadPluginConfig } from '../config/loader';
import { ALL_AGENT_NAMES } from '../config/constants';
import type { AgentOverrideConfig, Preset } from '../config';
import {
  deletePreset,
  removeAgentFromPreset,
  setAgentOverride,
  switchPresetOnDisk,
  writePreset,
} from '../tools/preset-switch';
import {
  readTuiSnapshot,
  readTuiSnapshotAsync,
  type TuiSnapshot,
} from '../tui-state';
import { isPluginDisabledByEnv } from '../utils/env';
import legacyTui, {
  getContrastForeground,
  getSidebarAgentNames,
  splitSidebarModelId,
} from '../tui';

// ── Types (mirror the v2 TUI plugin contract without a build-time dep) ──

type Child = JSX.Element | string | number | null | undefined | false;

interface V2Dialog {
  show(render: () => JSX.Element, onClose?: () => void): void;
  clear(): void;
  alert(options: { title: string; message: string }): Promise<void>;
  confirm(options: {
    title: string;
    message: string;
    label?: { confirm?: string; cancel?: string };
  }): Promise<boolean | undefined>;
  prompt(options: {
    title: string;
    description?: string;
    placeholder?: string;
    value?: string;
  }): Promise<string | undefined>;
  select<Value>(options: {
    title: string;
    placeholder?: string;
    options: readonly {
      title: string;
      value: Value;
      description?: string;
      disabled?: boolean;
    }[];
    current?: Value;
  }): Promise<Value | undefined>;
}

interface V2Toast {
  show(options: {
    title?: string;
    message: string;
    variant?: 'info' | 'success' | 'warning' | 'error';
    duration?: number;
  }): void;
}

interface V2KeymapCommand {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly group?: string;
  readonly enabled?: boolean | (() => boolean);
  readonly bind?: false | string;
  readonly palette?: true;
  readonly slash?: {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly arguments?: true;
  };
  readonly run: (
    input?: string,
    event?: unknown,
  ) => void | false | Promise<void>;
}

interface V2KeymapLayer {
  readonly mode?: string;
  readonly enabled?: boolean | (() => boolean);
  readonly commands?: readonly V2KeymapCommand[];
}

interface V2Keymap {
  layer(input: () => V2KeymapLayer): void;
}

interface V2SlotInput {
  readonly sessionID: string;
}

interface V2SlotClaim {
  readonly render: (input: V2SlotInput) => JSX.Element;
  readonly append: 'app' | 'sidebar.content';
}

interface V2UI {
  readonly dialog: V2Dialog;
  readonly toast: V2Toast;
  readonly slot: (claim: V2SlotClaim) => () => void;
}

interface V2Theme {
  readonly text: {
    readonly default: unknown;
    readonly subdued: unknown;
  };
  readonly background: {
    readonly default: unknown;
    readonly action: {
      readonly primary: { readonly default: unknown };
    };
  };
  readonly border: { readonly default: unknown };
}

interface V2Storage {
  memory<Value extends object>(
    key: string,
    options: { readonly initial: Value },
  ): readonly [
    Value,
    (mutation: (draft: Value) => void) => void,
  ];
}

interface V2TuiContext {
  readonly options: Readonly<Record<string, unknown>>;
  readonly location?: { readonly directory: string };
  readonly theme: V2Theme;
  readonly ui: V2UI;
  readonly keymap: V2Keymap;
  readonly storage: V2Storage;
}

interface V2TuiPluginDefinition {
  readonly id: string;
  readonly setup: (
    context: V2TuiContext,
  ) => Promise<(() => void) | void> | (() => void) | void;
}

interface HybridTuiPluginDefinition extends V2TuiPluginDefinition {
  readonly tui: typeof legacyTui.tui;
}

// ── Constants ──

const PLUGIN_NAME = 'oh-my-opencode-slim';
const TUI_PLUGIN_ID = `${PLUGIN_NAME}:tui`;
const BORDER = { type: 'single' };
const FALLBACK_SIDEBAR_AGENTS = SUBAGENT_NAMES.filter(
  (agent) =>
    agent !== 'councillor' &&
    agent !== 'council' &&
    !DEFAULT_DISABLED_AGENTS.includes(agent),
);

// ── Element helpers (same pattern as v1 tui.ts) ──

function element(
  tag: string,
  props: Record<string, unknown>,
  children: Child[] = [],
): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    setProp(node, key, value);
  }
  for (const child of children) {
    insert(node, child);
  }
  return node as unknown as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[]) {
  return element('text', props, children);
}

function box(props: Record<string, unknown>, children: Child[] = []) {
  return element('box', props, children);
}

function reactiveElement(read: () => JSX.Element): JSX.Element {
  const node = createElement('box');
  setProp(node, 'width', '100%');
  insert(node, read);
  return node as unknown as JSX.Element;
}

// ── Sidebar rendering (reuses the same logic as v1 tui.ts) ──

function agentRow(
  label: string,
  model: string,
  variant: string | undefined,
  theme: { textMuted: unknown },
): JSX.Element {
  const modelParts = splitSidebarModelId(model);
  const detailRows: JSX.Element[] = [];

  function detailRow(fieldLabel: string, value: string) {
    return box({ width: '100%', flexDirection: 'row', paddingLeft: 2 }, [
      text({ fg: theme.textMuted, width: 9 }, [fieldLabel]),
      text({ fg: theme.textMuted }, [value]),
    ]);
  }

  if (modelParts.provider) {
    detailRows.push(detailRow('provider', modelParts.provider));
  }
  detailRows.push(detailRow('model', modelParts.model));
  if (variant) {
    detailRows.push(detailRow('variant', variant));
  }

  return box({ width: '100%', flexDirection: 'column', marginBottom: 1 }, [
    text({ fg: theme.textMuted }, [label]),
    ...detailRows,
  ]);
}

function compactAgentRow(
  label: string,
  model: string,
  _variant: string | undefined,
  theme: { textMuted: unknown },
): JSX.Element {
  const modelName = splitSidebarModelId(model).model;
  return box(
    {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    [
      text({ fg: theme.textMuted, width: 14 }, [label]),
      text({ fg: theme.textMuted }, [modelName]),
    ],
  );
}

function buildConfigStatusRow(
  configInvalid: boolean,
  theme: { textMuted: unknown },
): JSX.Element | null {
  if (!configInvalid) return null;
  return box({ width: '100%', marginTop: 1 }, [
    text({ fg: 'orange' }, ['⚠ Config invalid — check oh-my-opencode-slim.jsonc']),
  ]);
}

function readConfigState(directory: string): {
  configInvalid: boolean;
  compactSidebar: boolean;
} {
  let configInvalid = false;
  const config = loadPluginConfig(directory, {
    silent: true,
    onWarning: (warning) => {
      if (
        warning.kind === 'invalid-json' ||
        warning.kind === 'invalid-schema' ||
        warning.kind === 'read-error'
      ) {
        configInvalid = true;
      }
    },
  });
  const compactSidebar = config.compactSidebar ?? true;
  return { configInvalid, compactSidebar };
}

function renderSidebar(
  snapshot: TuiSnapshot,
  version: string,
  resolvedTheme: V2Theme,
  configInvalid: boolean,
  compactSidebar: boolean,
): JSX.Element {
  const theme = {
    accent: resolvedTheme.background.action.primary.default,
    background: resolvedTheme.background.default,
    borderActive: resolvedTheme.border.default,
    text: resolvedTheme.text.default,
    textMuted: resolvedTheme.text.subdued,
  };
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);
  const agents = getSidebarAgentNames(snapshot);
  return box(
    {
      width: '100%',
      flexDirection: 'column',
      border: BORDER,
      borderColor: theme.borderActive,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
    },
    [
      box(
        {
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
        [
          box(
            { paddingLeft: 1, paddingRight: 1, backgroundColor: theme.accent },
            [
              text(
                {
                  fg: getContrastForeground(
                    theme.accent,
                    theme.text,
                    theme.background,
                  ),
                },
                ['OMO-Slim'],
              ),
            ],
          ),
          text({ fg: theme.textMuted }, [`v${version}`]),
        ],
      ),
      ...(configStatusRow ? [configStatusRow] : []),
      box({ width: '100%', marginTop: 1 }, [
        text({ fg: theme.text }, ['Agents']),
      ]),
      ...agents.map((agentName) => {
        const model = snapshot.agentModels[agentName] ?? 'pending';
        const variant = snapshot.agentVariants[agentName];
        if (compactSidebar) {
          return compactAgentRow(agentName, model, variant, theme);
        }
        return agentRow(agentName, model, variant, theme);
      }),
    ],
  );
}

// ── Preset manager (v2 promise-based dialog API) ──

const ACTION_NEW_PRESET = '__omo_new_preset__';
const ACTION_ADD_AGENT = '__omo_add_agent__';
const ACTION_BACK = '__omo_back__';

function describePreset(preset: Preset): string {
  const parts = Object.entries(preset).map(
    ([agent, override]) => `${agent}: ${describeOverride(override)}`,
  );
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}

function describeOverride(override: AgentOverrideConfig): string {
  const bits: string[] = [];
  if (typeof override.model === 'string') {
    bits.push(override.model);
  } else if (Array.isArray(override.model) && override.model.length > 0) {
    const first = override.model[0];
    bits.push(typeof first === 'string' ? first : first.id);
  }
  if (typeof override.variant === 'string')
    bits.push(`variant=${override.variant}`);
  if (typeof override.temperature === 'number')
    bits.push(`temp=${override.temperature}`);
  if (override.options && Object.keys(override.options).length > 0)
    bits.push('options');
  return bits.length > 0 ? bits.join(', ') : '(unset)';
}

interface V2PresetManager {
  ui: V2UI;
  directory: string;
}

async function showPresetList(state: V2PresetManager): Promise<void> {
  const config = loadPluginConfig(state.directory, { silent: true });
  const presets = config.presets ?? {};
  const names = Object.keys(presets);
  const activePreset = config.preset ?? null;

  if (names.length === 0 && !activePreset) {
    await promptAndCreatePreset(state);
    return;
  }

  const options: { title: string; value: string; description?: string }[] = names.map((name) => ({
    title: name === activePreset ? `${name} (active)` : name,
    value: name,
    description: describePreset(presets[name]),
  }));
  options.push({ title: '+ Create new preset', value: ACTION_NEW_PRESET });

  const selected = await state.ui.dialog.select<string>({
    title: 'Presets',
    placeholder: 'Select a preset to apply or edit',
    options,
  });

  if (selected === undefined) return;
  if (selected === ACTION_NEW_PRESET) {
    await promptAndCreatePreset(state);
    return;
  }
  await showPresetActions(state, selected);
}

async function showPresetActions(
  state: V2PresetManager,
  presetName: string,
): Promise<void> {
  const selected = await state.ui.dialog.select<string>({
    title: `Preset: ${presetName}`,
    options: [
      { title: 'Apply preset (reload to take effect)', value: 'apply' },
      { title: 'Edit agents', value: 'edit' },
      { title: 'Delete preset', value: 'delete' },
      { title: '← Back', value: ACTION_BACK },
    ],
  });

  if (selected === undefined) return;
  switch (selected) {
    case 'apply':
      await applyPreset(state, presetName);
      break;
    case 'edit':
      await editPreset(state, presetName);
      break;
    case 'delete':
      await confirmDeletePreset(state, presetName);
      break;
    default:
      await showPresetList(state);
  }
}

async function applyPreset(
  state: V2PresetManager,
  presetName: string,
): Promise<void> {
  const config = loadPluginConfig(state.directory, { silent: true });
  const result = switchPresetOnDisk(state.directory, presetName, config);
  state.ui.dialog.clear();
  state.ui.toast.show({
    variant: result.ok ? 'success' : 'warning',
    title: result.ok ? 'Preset saved' : 'Preset switch failed',
    message: result.ok
      ? `Saved preset "${presetName}". Start a new conversation (or reload OpenCode) to use it. ${result.summary.join('; ')}`
      : result.message,
  });
}

async function confirmDeletePreset(
  state: V2PresetManager,
  presetName: string,
): Promise<void> {
  const confirmed = await state.ui.dialog.confirm({
    title: 'Delete preset',
    message: `Delete preset "${presetName}"? This cannot be undone.`,
  });
  if (!confirmed) {
    await showPresetActions(state, presetName);
    return;
  }
  const ok = deletePreset(state.directory, presetName);
  state.ui.dialog.clear();
  state.ui.toast.show({
    variant: ok ? 'success' : 'warning',
    title: ok ? 'Preset deleted' : 'Delete failed',
    message: ok
      ? `Deleted preset "${presetName}".`
      : `Could not delete preset "${presetName}".`,
  });
}

async function promptAndCreatePreset(
  state: V2PresetManager,
): Promise<void> {
  const name = await state.ui.dialog.prompt({
    title: 'Create new preset',
    placeholder: 'preset-name',
  });
  if (name === undefined) {
    await showPresetList(state);
    return;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    await showPresetList(state);
    return;
  }
  if (/\s/.test(trimmed)) {
    state.ui.toast.show({
      variant: 'warning',
      title: 'Invalid name',
      message: 'Preset names cannot contain spaces.',
    });
    await showPresetList(state);
    return;
  }
  const config = loadPluginConfig(state.directory, { silent: true });
  const presets = config.presets ?? {};
  if (presets[trimmed]) {
    const overwrite = await state.ui.dialog.confirm({
      title: 'Preset exists',
      message: `A preset named "${trimmed}" already exists. Overwrite it with a new empty preset?`,
    });
    if (!overwrite) {
      await showPresetList(state);
      return;
    }
  }
  const ok = writePreset(state.directory, trimmed, {});
  state.ui.toast.show({
    variant: ok ? 'success' : 'warning',
    title: ok ? 'Preset created' : 'Create failed',
    message: ok
      ? `Created empty preset "${trimmed}". Use Edit agents to add agents.`
      : `Could not create preset "${trimmed}".`,
  });
  await showPresetActions(state, trimmed);
}

async function editPreset(
  state: V2PresetManager,
  presetName: string,
): Promise<void> {
  const config = loadPluginConfig(state.directory, { silent: true });
  const working = structuredClone(config.presets?.[presetName] ?? {}) as Preset;

  const options: { title: string; value: string; description?: string }[] = Object.keys(working).map((agent) => ({
    title: agent,
    value: agent,
    description: describeOverride(working[agent]),
  }));
  options.push({ title: '+ Add agent', value: ACTION_ADD_AGENT });
  options.push({ title: '← Back', value: ACTION_BACK });

  const selected = await state.ui.dialog.select<string>({
    title: `Edit preset: ${presetName}`,
    options,
  });

  if (selected === undefined) return;
  if (selected === ACTION_BACK) {
    await showPresetActions(state, presetName);
    return;
  }
  if (selected === ACTION_ADD_AGENT) {
    await addAgentToPreset(state, presetName, working);
    return;
  }
  await editAgentInPreset(state, presetName, working, selected);
}

async function addAgentToPreset(
  state: V2PresetManager,
  presetName: string,
  working: Preset,
): Promise<void> {
  const available = ALL_AGENT_NAMES.filter((a) => !working[a]);
  if (available.length === 0) {
    state.ui.toast.show({
      variant: 'info',
      title: 'No agents left',
      message: 'All known agents are already in this preset.',
    });
    await editPreset(state, presetName);
    return;
  }
  const options = available.map((a) => ({ title: a, value: a }));
  const selected = await state.ui.dialog.select<string>({
    title: 'Add agent',
    options,
  });
  if (selected === undefined) {
    await editPreset(state, presetName);
    return;
  }
  // Initialize with defaults and recurse into editAgentInPreset for model selection.
  const updated = setAgentOverride(working, selected, {});
  await editAgentInPreset(state, presetName, updated, selected);
}

async function editAgentInPreset(
  state: V2PresetManager,
  presetName: string,
  working: Preset,
  agentName: string,
): Promise<void> {
  const current = working[agentName] ?? {};
  const selected = await state.ui.dialog.select<string>({
    title: `Edit ${agentName}`,
    options: [
      { title: 'Model', value: 'model', description: describeOverride(current) },
      { title: 'Remove agent', value: 'remove' },
      { title: '← Back', value: ACTION_BACK },
    ],
  });
  if (selected === undefined) return;
  if (selected === ACTION_BACK) {
    await editPreset(state, presetName);
    return;
  }
  if (selected === 'remove') {
    const next = removeAgentFromPreset(working, agentName);
    const ok = writePreset(state.directory, presetName, next);
    state.ui.toast.show({
      variant: ok ? 'success' : 'warning',
      title: ok ? 'Agent removed' : 'Save failed',
      message: ok
        ? `Removed ${agentName} from preset.`
        : `Could not write preset "${presetName}" to the config file.`,
    });
    if (ok) await editPreset(state, presetName);
    else await editAgentInPreset(state, presetName, working, agentName);
    return;
  }
  if (selected === 'model') {
    const model = await state.ui.dialog.prompt({
      title: `Edit ${agentName} — model`,
      description: 'Enter provider/model (e.g. anthropic/claude-sonnet-4)',
      placeholder: 'provider/model',
      value: typeof current.model === 'string' ? current.model : '',
    });
    if (model === undefined) {
      await editAgentInPreset(state, presetName, working, agentName);
      return;
    }
    const trimmed = model.trim();
    const next: AgentOverrideConfig = { ...current };
    if (trimmed) next.model = trimmed;
    else delete next.model;
    const updated = setAgentOverride(working, agentName, next);
    const ok = writePreset(state.directory, presetName, updated);
    state.ui.toast.show({
      variant: ok ? 'success' : 'warning',
      title: ok ? 'Agent updated' : 'Save failed',
      message: ok
        ? `${agentName} → ${describeOverride(next)}`
        : `Could not write preset "${presetName}".`,
    });
    if (ok) await editPreset(state, presetName);
    else await editAgentInPreset(state, presetName, working, agentName);
    return;
  }
}

async function openPresetManager(state: V2PresetManager): Promise<void> {
  await showPresetList(state);
}

// ── Plugin definition ──

async function readPackageVersion(): Promise<string | undefined> {
  try {
    const packageJson = (await Bun.file(
      new URL('../../package.json', import.meta.url),
    ).json()) as { version?: unknown };
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

function getDirectory(context: V2TuiContext): string {
  return context.location?.directory ?? process.cwd();
}

const plugin: HybridTuiPluginDefinition = {
  id: TUI_PLUGIN_ID,
  setup: async (context: V2TuiContext) => {
    if (isPluginDisabledByEnv()) return;

    const version = (await readPackageVersion()) ?? 'dev';
    const initialDirectory = getDirectory(context);
    const initialConfig = readConfigState(initialDirectory);
    const [view, setView] = context.storage.memory(
      'oh-my-opencode-slim.v2.sidebar',
      {
        initial: {
          directory: initialDirectory,
          snapshot: readTuiSnapshot(initialDirectory),
          ...initialConfig,
        },
      },
    );

    const renderTimer = setInterval(async () => {
      try {
        const directory = getDirectory(context);
        const snapshot = await readTuiSnapshotAsync(directory);
        const config = readConfigState(directory);
        setView((draft) => {
          draft.directory = directory;
          draft.snapshot = snapshot;
          draft.configInvalid = config.configInvalid;
          draft.compactSidebar = config.compactSidebar;
        });
      } catch {
        // Ignore render errors; this is best-effort live status.
      }
    }, 1000);

    const removeSlot = context.ui.slot({
      append: 'sidebar.content',
      render: () =>
        reactiveElement(() =>
          renderSidebar(
            view.snapshot,
            version,
            context.theme,
            view.configInvalid,
            view.compactSidebar,
          ),
        ),
    });

    // Keymap layers need a Solid owner; the app slot provides one.
    const removeCommands = context.ui.slot({
      append: 'app',
      render: () => {
        context.keymap.layer(() => ({
          mode: 'global',
          commands: [
            {
              id: `${PLUGIN_NAME}.preset`,
              title: 'Switch preset',
              description: 'Switch agent presets at runtime (e.g. /preset cheap)',
              palette: true,
              slash: { name: 'preset' },
              run: async () => {
                await openPresetManager({
                  ui: context.ui,
                  directory: getDirectory(context),
                });
              },
            },
          ],
        }));
        return null;
      },
    });

    return () => {
      clearInterval(renderTimer);
      try {
        removeSlot();
        removeCommands();
      } catch {
        // Presentation cleanup is best effort.
      }
    };
  },
  tui: legacyTui.tui,
};

export default plugin;
