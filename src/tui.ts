import type {
  TuiCommand,
  TuiPlugin,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import { type ColorInput, parseColor, RGBA } from '@opentui/core';
import type { JSX } from '@opentui/solid';
import { createElement, insert, setProp } from '@opentui/solid';
import { DEFAULT_DISABLED_AGENTS, SUBAGENT_NAMES } from './config/constants';
import { loadPluginConfig } from './config/loader';
import {
  recordTmuxPane,
  removeTmuxPane,
} from './multiplexer/tmux-pane-registry';
import { openPresetManager } from './tui-preset';
import {
  readTuiSnapshot,
  readTuiSnapshotAsync,
  type TuiSnapshot,
} from './tui-state';
import { isPluginDisabledByEnv } from './utils/env';

const PLUGIN_NAME = 'oh-my-opencode-slim';
const CONFIG_WARNING_COLOR = 'orange';
const FALLBACK_SIDEBAR_AGENTS = SUBAGENT_NAMES.filter(
  (agent) =>
    agent !== 'councillor' &&
    agent !== 'council' &&
    !DEFAULT_DISABLED_AGENTS.includes(agent),
);
const BORDER = { type: 'single' };
const TMUX_PANE_HEARTBEAT_MS = 10_000;

type Child = JSX.Element | string | number | null | undefined | false;

async function readPackageVersion(): Promise<string | undefined> {
  try {
    const packageJson = (await Bun.file(
      new URL('../package.json', import.meta.url),
    ).json()) as { version?: unknown };

    return typeof packageJson.version === 'string'
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

function element(
  tag: string,
  props: Record<string, unknown>,
  children: Child[] = [],
) {
  const node = createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
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

function getTuiDirectory(api: {
  state?: { path?: { directory?: string } };
}): string {
  return api.state?.path?.directory ?? process.cwd();
}

export interface ActiveTmuxPaneRegistration {
  sessionId?: string;
  paneId?: string;
  ownerPid: number;
  lastRecordedAt: number;
}

/** Route shapes accepted by `syncTmuxPaneRegistration`: v1 `{ name, params }` and v2 `{ type, sessionID }`. */
export type TuiRouteView =
  | {
      name?: string;
      params?: { sessionID?: unknown };
    }
  | {
      type?: string;
      sessionID?: string;
    };

function resolveRouteSessionId(route: TuiRouteView): string | undefined {
  const view = route as {
    name?: string;
    params?: { sessionID?: unknown };
    type?: string;
    sessionID?: string;
  };
  if (view.name === 'session' && typeof view.params?.sessionID === 'string') {
    return view.params.sessionID;
  }
  if (view.type === 'session' && typeof view.sessionID === 'string') {
    return view.sessionID;
  }
  return undefined;
}

function clearTmuxPaneRegistration(
  registration: ActiveTmuxPaneRegistration,
): void {
  if (registration.sessionId && registration.paneId) {
    removeTmuxPane(
      registration.sessionId,
      registration.paneId,
      registration.ownerPid,
    );
  }
  registration.sessionId = undefined;
  registration.paneId = undefined;
  registration.lastRecordedAt = 0;
}

export function syncTmuxPaneRegistration(
  route: TuiRouteView,
  registration: ActiveTmuxPaneRegistration,
  now = Date.now(),
): void {
  const paneId = process.env.TMUX_PANE;
  const sessionId = resolveRouteSessionId(route);
  const unchanged =
    registration.sessionId === sessionId && registration.paneId === paneId;

  if (!paneId || !sessionId) {
    clearTmuxPaneRegistration(registration);
    return;
  }
  if (unchanged && now - registration.lastRecordedAt < TMUX_PANE_HEARTBEAT_MS) {
    return;
  }
  if (!unchanged) clearTmuxPaneRegistration(registration);

  if (recordTmuxPane(sessionId, paneId, registration.ownerPid)) {
    registration.sessionId = sessionId;
    registration.paneId = paneId;
    registration.lastRecordedAt = now;
  }
}

export function splitSidebarModelId(model: string): {
  provider?: string;
  model: string;
} {
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return { model };
  }

  return {
    provider: model.slice(0, slashIndex),
    model: model.slice(slashIndex + 1),
  };
}

export function getSidebarAgentNames(snapshot: TuiSnapshot): string[] {
  const configuredAgents = Object.keys(snapshot.agentModels);
  return configuredAgents.length > 0
    ? configuredAgents
    : FALLBACK_SIDEBAR_AGENTS;
}

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

export function getContrastForeground(
  accent: unknown,
  themeText: unknown,
  themeBackground: unknown,
): unknown {
  if (!accent) return themeText;

  let accentRgba: RGBA;
  try {
    accentRgba = parseColor(accent as ColorInput);
  } catch {
    return themeText;
  }

  // Calculate relative luminance: R, G, B are in range 0..1
  const luminance =
    0.299 * accentRgba.r + 0.587 * accentRgba.g + 0.114 * accentRgba.b;

  if (luminance > 0.5) {
    // Light accent bg -> we need a dark fg.
    // Let's use themeBackground if it exists, is resolved, and not transparent.
    if (themeBackground) {
      try {
        const bgRgba = parseColor(themeBackground as ColorInput);
        if (bgRgba.a !== 0) {
          const bgLum = 0.299 * bgRgba.r + 0.587 * bgRgba.g + 0.114 * bgRgba.b;
          if (bgLum < 0.5) {
            return themeBackground;
          }
        }
      } catch {
        // ignore and fallback
      }
    }
    return RGBA.fromInts(0, 0, 0);
  }

  // Dark accent bg -> we need a light fg.
  // Let's use themeText if it exists and is light.
  if (themeText) {
    try {
      const textRgba = parseColor(themeText as ColorInput);
      const textLum =
        0.299 * textRgba.r + 0.587 * textRgba.g + 0.114 * textRgba.b;
      if (textLum > 0.5) {
        return themeText;
      }
    } catch {
      // ignore and fallback
    }
  }

  return RGBA.fromInts(255, 255, 255);
}

function renderSidebar(
  snapshot: TuiSnapshot,
  version: string,
  theme: {
    accent: unknown;
    background: unknown;
    borderActive: unknown;
    text: unknown;
    textMuted: unknown;
  },
  configInvalid: boolean,
  compactSidebar: boolean,
): JSX.Element {
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);
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
      configStatusRow,
      box({ width: '100%', marginTop: 1 }, [
        text({ fg: theme.text }, ['Agents']),
      ]),
      ...getSidebarAgentNames(snapshot).map((agentName) => {
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

function buildConfigStatusRow(
  configInvalid: boolean,
  theme: { textMuted: unknown },
): JSX.Element | null {
  if (!configInvalid) return null;

  return box(
    {
      width: '100%',
      flexDirection: 'column',
      marginTop: 1,
      marginBottom: 1,
    },
    [
      text({ fg: CONFIG_WARNING_COLOR }, ['Config invalid']),
      text({ fg: theme.textMuted }, ['Run doctor for details']),
    ],
  );
}

function readConfigState(directory: string): {
  configInvalid: boolean;
  compactSidebar: boolean;
} {
  let configInvalid = false;
  const config = loadPluginConfig(directory, {
    silent: true,
    onWarning: (warning) => {
      // Only genuinely broken configs (parse/load/schema failures) mark the
      // sidebar invalid. Benign deprecation notices (deprecated-key) and
      // missing-preset do not, otherwise a config that loads fine would be
      // shown as "Config invalid".
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

export function readConfigInvalid(directory: string): boolean {
  return readConfigState(directory).configInvalid;
}

export function readCompactSidebar(directory: string): boolean {
  return readConfigState(directory).compactSidebar;
}

// Mirrors @opencode-ai/plugin@0.0.0-beta-17793 dist/tui/context.d.ts;
// declared locally because the pinned dep ships v1 types only.
interface V2TuiThemeTokens {
  text: { default: unknown; subdued: unknown };
  background: { default: unknown };
  border: { default: unknown };
}

interface V2TuiSlotClaim {
  append?: string;
  prepend?: string;
  before?: string;
  after?: string;
  replace?: string;
  render: (input: { sessionID: string }) => JSX.Element;
}

interface V2TuiContext {
  location?: { directory: string };
  renderer: { requestRender: () => void };
  theme: V2TuiThemeTokens;
  ui: {
    slot: (claim: V2TuiSlotClaim) => () => void;
    router: { current: () => { type?: string; sessionID?: string } };
  };
}

/** Map v2 theme tokens onto the flat shape `renderSidebar` consumes (v2 has no `accent` token). */
function v2ThemeView(theme: V2TuiThemeTokens): {
  accent: undefined;
  background: unknown;
  borderActive: unknown;
  text: unknown;
  textMuted: unknown;
} {
  return {
    accent: undefined,
    background: theme.background.default,
    borderActive: theme.border.default,
    text: theme.text.default,
    textMuted: theme.text.subdued,
  };
}

/**
 * V2 entry point: sidebar slot + refresh loop; returns cleanup.
 * `/preset` stays v1-only (`api.command` is absent on v2).
 */
async function setup(ctx: V2TuiContext): Promise<undefined | (() => void)> {
  if (isPluginDisabledByEnv()) return;

  const version = (await readPackageVersion()) ?? 'dev';
  let configDirectory = ctx.location?.directory ?? process.cwd();
  let { configInvalid, compactSidebar } = readConfigState(configDirectory);
  let snapshot = readTuiSnapshot(configDirectory);
  const tmuxRegistration: ActiveTmuxPaneRegistration = {
    ownerPid: process.pid,
    lastRecordedAt: 0,
  };
  syncTmuxPaneRegistration(ctx.ui.router.current(), tmuxRegistration);
  let disposed = false;
  const renderTimer = setInterval(async () => {
    if (disposed) return;
    try {
      const currentDirectory = ctx.location?.directory ?? process.cwd();
      syncTmuxPaneRegistration(ctx.ui.router.current(), tmuxRegistration);
      snapshot = await readTuiSnapshotAsync(currentDirectory);
      if (disposed) return;
      if (currentDirectory !== configDirectory) {
        configDirectory = currentDirectory;
        ({ configInvalid, compactSidebar } = readConfigState(configDirectory));
      }
      ctx.renderer.requestRender();
    } catch {
      // Ignore render errors; this is best-effort live status.
    }
  }, 1000);

  const disposeSlot = ctx.ui.slot({
    append: 'sidebar.content',
    render: () =>
      renderSidebar(
        snapshot,
        version,
        v2ThemeView(ctx.theme),
        configInvalid,
        compactSidebar,
      ),
  });

  return () => {
    disposed = true;
    disposeSlot();
    clearInterval(renderTimer);
    clearTmuxPaneRegistration(tmuxRegistration);
  };
}

/**
 * Build the TUI slash command for `/preset`. Registered via the legacy
 * `api.command` API (still populated in OpenCode 1.18 for v1 plugins). If the
 * API is unavailable the command is simply not registered and `/preset` is a
 * no-op.
 *
 * The command opens a three-level preset manager (list → edit → agent model)
 * implemented in `src/tui-preset.ts`. Like the built-in `/models`, it is pure
 * TUI and triggers no LLM turn.
 */
function buildPresetCommand(
  api: TuiPluginApi,
  directoryGetter: () => string,
  snapshotRef: { snapshot: TuiSnapshot },
): TuiCommand {
  return {
    title: 'Switch preset',
    value: 'preset',
    description: 'Switch agent presets at runtime (e.g. /preset cheap)',
    slash: { name: 'preset' },
    onSelect: () => {
      openPresetManager(api, directoryGetter(), snapshotRef);
    },
  };
}

/**
 * Dual contract: v1 hosts validate `{ id, tui }`, opencode2 validates
 * `{ id, setup }`; both ignore extra keys. Fixes #1002.
 */
interface TuiDualContractModule {
  id: string;
  tui: TuiPlugin;
  setup: (ctx: V2TuiContext) => Promise<undefined | (() => void)>;
}

const plugin: TuiDualContractModule = {
  id: `${PLUGIN_NAME}:tui`,
  tui: async (api, _options, meta) => {
    if (isPluginDisabledByEnv()) return;

    const version = meta.version ?? (await readPackageVersion()) ?? 'dev';
    let configDirectory = getTuiDirectory(api);
    let { configInvalid, compactSidebar } = readConfigState(configDirectory);
    let snapshot = readTuiSnapshot(configDirectory);
    const tmuxRegistration: ActiveTmuxPaneRegistration = {
      ownerPid: process.pid,
      lastRecordedAt: 0,
    };
    syncTmuxPaneRegistration(api.route.current, tmuxRegistration);
    const renderTimer = setInterval(async () => {
      try {
        const currentDirectory = getTuiDirectory(api);
        syncTmuxPaneRegistration(api.route.current, tmuxRegistration);
        snapshot = await readTuiSnapshotAsync(currentDirectory);
        if (currentDirectory !== configDirectory) {
          configDirectory = currentDirectory;
          ({ configInvalid, compactSidebar } =
            readConfigState(configDirectory));
        }
        api.renderer.requestRender();
      } catch {
        // Ignore render errors; this is best-effort live status.
      }
    }, 1000);

    api.lifecycle.onDispose(() => {
      clearInterval(renderTimer);
      clearTmuxPaneRegistration(tmuxRegistration);
    });

    api.slots.register({
      order: 900,
      slots: {
        sidebar_content() {
          return renderSidebar(
            snapshot,
            version,
            api.theme.current,
            configInvalid,
            compactSidebar,
          );
        },
      },
    });

    // `/preset` is a pure TUI slash command (like the built-in `/models`):
    // it opens a picker, switches the preset via on-disk state, and never
    // sends a message to the server or triggers an LLM turn. The legacy
    // `api.command` API is still populated in OpenCode 1.18; if it is absent
    // (e.g. a future v2-only build), registration is skipped gracefully.
    if (api.command) {
      const snapshotRef: { snapshot: TuiSnapshot } = {
        get snapshot() {
          return snapshot;
        },
        set snapshot(value: TuiSnapshot) {
          snapshot = value;
        },
      };
      const disposeCommands = api.command.register(() => [
        buildPresetCommand(api, () => configDirectory, snapshotRef),
      ]);
      api.lifecycle.onDispose(disposeCommands);
    }
  },
  setup,
};

export default plugin;
