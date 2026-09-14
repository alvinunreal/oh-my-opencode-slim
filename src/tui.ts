import type {
  TuiCommand,
  TuiPlugin,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui';
import { type ColorInput, parseColor, RGBA } from '@opentui/core';
import type { JSX } from '@opentui/solid';
import { createElement, insert, setProp } from '@opentui/solid';
import { createSignal } from 'solid-js';
import {
  ALL_AGENT_NAMES,
  DEFAULT_DISABLED_AGENTS,
  SUBAGENT_NAMES,
} from './config/constants';
import { loadPluginConfig } from './config/loader';
import {
  recordTmuxPane,
  removeTmuxPane,
} from './multiplexer/tmux-pane-registry';
import { openPresetManager } from './tui-preset';
import {
  readTuiSnapshot,
  readTuiSnapshotAsync,
  resolveTuiSnapshotRoot,
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
const ACTIVITY_FRAME_MS = 100;
const ACTIVITY_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

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

function reactiveElement(render: () => JSX.Element): JSX.Element {
  const root = box({ width: '100%', flexDirection: 'column' });
  insert(root, render);
  return root;
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

type AgentListFn = (input?: unknown) => Promise<unknown>;

function asFunction(value: unknown): AgentListFn | undefined {
  return typeof value === 'function' ? (value as AgentListFn) : undefined;
}

function unwrapAgentList(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  const data = (response as { data?: unknown }).data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const nested = (data as { data?: unknown }).data;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function remoteAgentName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const rec = entry as { name?: unknown; id?: unknown };
  if (typeof rec.name === 'string') return rec.name;
  if (typeof rec.id === 'string') return rec.id;
  return undefined;
}

function remoteModelId(model: unknown): string | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const rec = model as {
    providerID?: unknown;
    modelID?: unknown;
    id?: unknown;
  };
  if (typeof rec.providerID !== 'string') return undefined;
  const id =
    typeof rec.modelID === 'string'
      ? rec.modelID
      : typeof rec.id === 'string'
        ? rec.id
        : undefined;
  return id ? `${rec.providerID}/${id}` : undefined;
}

function modelsFromAgentList(response: unknown): Record<string, string> {
  const models: Record<string, string> = {};
  for (const entry of unwrapAgentList(response)) {
    const name = remoteAgentName(entry);
    const model = remoteModelId(
      (entry as { model?: unknown } | undefined)?.model,
    );
    if (!name || !model) continue;
    if ((ALL_AGENT_NAMES as readonly string[]).includes(name)) {
      models[name] = model;
    }
  }
  return models;
}

/**
 * Remote-attach fallback (#1133): the server-side plugin writes
 * tui-state.json on the server's filesystem, which a remote TUI cannot
 * see, so every model renders as "pending". Resolve agent models through
 * the host SDK instead. Only fills gaps — local snapshot entries win.
 *
 * v1 TUI (`api.client`, `@opencode-ai/sdk/v2`): `app.agents({ directory })`
 * with `{ name, model: { providerID, modelID } }`.
 * v2 TUI: `agent.list({ location: { directory } })` or
 * `v2.agent.list(...)` with `{ id, model: { providerID, id } }`.
 */
export async function fetchRemoteAgentModels(
  client: unknown,
  directory: string,
): Promise<Record<string, string>> {
  const rec = client as
    | {
        app?: { agents?: unknown };
        agent?: { list?: unknown };
        v2?: { agent?: { list?: unknown } };
      }
    | undefined;
  if (!rec) return {};

  try {
    const v1Agents = asFunction(rec.app?.agents);
    if (v1Agents) {
      return modelsFromAgentList(await v1Agents.call(rec.app, { directory }));
    }
    const v2Receiver = rec.agent ?? rec.v2?.agent;
    const v2List = asFunction(v2Receiver?.list);
    if (!v2List) return {};
    return modelsFromAgentList(
      await v2List.call(v2Receiver, { location: { directory } }),
    );
  } catch {
    return {};
  }
}

/** Local snapshot entries win; remote fills empty/missing agent models (#1133). */
export function applyRemoteAgentModels(
  snapshot: TuiSnapshot,
  remote: Record<string, string>,
): TuiSnapshot {
  if (Object.keys(remote).length === 0) return snapshot;
  return {
    ...snapshot,
    agentModels: { ...remote, ...snapshot.agentModels },
  };
}

const REMOTE_RETRY_MS = 5_000;

interface RemoteModelCache {
  directory?: string;
  models?: Record<string, string>;
  at?: number;
}

async function hydrateRemoteModels(
  snapshot: TuiSnapshot,
  client: unknown,
  directory: string,
  cache: RemoteModelCache,
): Promise<TuiSnapshot> {
  if (Object.keys(snapshot.agentModels).length > 0) return snapshot;
  const now = Date.now();
  const cached =
    cache.directory === directory && cache.models !== undefined
      ? cache.models
      : undefined;
  const cacheFresh =
    cached !== undefined &&
    (Object.keys(cached).length > 0 ||
      (cache.at !== undefined && now - cache.at < REMOTE_RETRY_MS));
  if (cached !== undefined && cacheFresh) {
    return applyRemoteAgentModels(snapshot, cached);
  }
  const models = await fetchRemoteAgentModels(client, directory);
  cache.directory = directory;
  cache.models = models;
  cache.at = now;
  return applyRemoteAgentModels(snapshot, models);
}

/** Skip overlapping sidebar refreshes so a slow host fetch cannot pile up. */
export function createSerializedRefresh(run: () => Promise<void>): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    void run()
      .catch(() => {
        // Ignore render errors; this is best-effort live status.
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

/** Drop a refresh whose directory changed while the host fetch was in flight. */
export function isRefreshCurrent(
  startedDirectory: string,
  currentDirectory: string,
): boolean {
  return startedDirectory === currentDirectory;
}

export function getActiveSidebarAgentNames(
  snapshot: TuiSnapshot,
  visibleRootID?: string,
): ReadonlySet<string> {
  const names = new Set<string>();
  // Both sides resolve against the same persistent sessionParents index:
  // the visible route session (possibly a child) to its root, and every
  // active session to its root. This keeps spinners scoped to the
  // conversation this window is viewing (#1147) — shared v2 daemons record
  // every window's subagents from one process, so only the session tree
  // can separate them — and a late-learned link re-roots both sides
  // consistently. Without a visible session (home route) keep the union.
  const root =
    visibleRootID === undefined
      ? undefined
      : resolveTuiSnapshotRoot(snapshot, visibleRootID);
  for (const [sessionID, agentName] of Object.entries(
    snapshot.activeSessions,
  )) {
    if (
      root === undefined ||
      resolveTuiSnapshotRoot(snapshot, sessionID) === root
    ) {
      names.add(agentName);
    }
  }
  return names;
}

export function getSidebarActivityIndicator(
  active: boolean,
  now = Date.now(),
): string {
  if (!active) return ' ';
  const frame = Math.floor(now / ACTIVITY_FRAME_MS) % ACTIVITY_FRAMES.length;
  return ACTIVITY_FRAMES[frame];
}

interface AgentRowTheme {
  accent: unknown;
  text: unknown;
  textMuted: unknown;
}

function activityIndicator(
  active: boolean,
  now: number,
  theme: AgentRowTheme,
): JSX.Element {
  return text(
    {
      fg: active ? (theme.accent ?? theme.text) : theme.textMuted,
      width: 2,
    },
    [getSidebarActivityIndicator(active, now)],
  );
}

function agentRow(
  label: string,
  model: string,
  variant: string | undefined,
  active: boolean,
  now: number,
  theme: AgentRowTheme,
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
    box({ width: '100%', flexDirection: 'row' }, [
      text({ fg: theme.textMuted, width: 14 }, [label]),
      activityIndicator(active, now, theme),
    ]),
    ...detailRows,
  ]);
}

function compactAgentRow(
  label: string,
  model: string,
  _variant: string | undefined,
  active: boolean,
  now: number,
  theme: AgentRowTheme,
): JSX.Element {
  const modelName = splitSidebarModelId(model).model;
  return box(
    {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    [
      box({ width: 16, flexShrink: 0, flexDirection: 'row' }, [
        text({ fg: theme.textMuted, width: 14 }, [label]),
        activityIndicator(active, now, theme),
      ]),
      text(
        {
          fg: theme.textMuted,
          wrapMode: 'none',
          truncate: true,
          flexShrink: 1,
        },
        [modelName],
      ),
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
  now = Date.now(),
  visibleRootID?: string,
): JSX.Element {
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);
  const activeAgents = getActiveSidebarAgentNames(snapshot, visibleRootID);
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
        const active = activeAgents.has(agentName);
        if (compactSidebar) {
          return compactAgentRow(agentName, model, variant, active, now, theme);
        }
        return agentRow(agentName, model, variant, active, now, theme);
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

// Mirrors the OpenCode v2 TUI context surface (dist/tui/context.d.ts);
// declared locally because the pinned @opencode-ai/plugin dep ships v1
// types only.
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
  client?: unknown;
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
  const [snapshot, setSnapshot] = createSignal(
    readTuiSnapshot(configDirectory),
  );
  const [animationNow, setAnimationNow] = createSignal(Date.now());
  const tmuxRegistration: ActiveTmuxPaneRegistration = {
    ownerPid: process.pid,
    lastRecordedAt: 0,
  };
  syncTmuxPaneRegistration(ctx.ui.router.current(), tmuxRegistration);
  let disposed = false;
  const remoteCache: RemoteModelCache = {};
  const refreshSidebar = async () => {
    if (disposed) return;
    const currentDirectory = ctx.location?.directory ?? process.cwd();
    syncTmuxPaneRegistration(ctx.ui.router.current(), tmuxRegistration);
    let nextSnapshot = await readTuiSnapshotAsync(currentDirectory);
    if (disposed) return;
    if (currentDirectory !== configDirectory) {
      configDirectory = currentDirectory;
      ({ configInvalid, compactSidebar } = readConfigState(configDirectory));
    }
    nextSnapshot = await hydrateRemoteModels(
      nextSnapshot,
      ctx.client,
      currentDirectory,
      remoteCache,
    );
    if (disposed) return;
    if (
      !isRefreshCurrent(
        currentDirectory,
        ctx.location?.directory ?? process.cwd(),
      )
    ) {
      return;
    }
    setSnapshot(nextSnapshot);
    ctx.renderer.requestRender();
  };
  const scheduleRefresh = createSerializedRefresh(refreshSidebar);
  scheduleRefresh();
  const renderTimer = setInterval(scheduleRefresh, 1000);
  const animationTimer = setInterval(() => {
    // Same scoping as the render: hidden foreign-conversation activity
    // must not keep this window's sidebar rerendering every frame.
    if (
      !disposed &&
      getActiveSidebarAgentNames(snapshot(), visibleSession()).size > 0
    ) {
      setAnimationNow(Date.now());
    }
  }, ACTIVITY_FRAME_MS);

  const visibleSession = () => resolveRouteSessionId(ctx.ui.router.current());

  const disposeSlot = ctx.ui.slot({
    append: 'sidebar.content',
    render: () =>
      reactiveElement(() =>
        renderSidebar(
          snapshot(),
          version,
          v2ThemeView(ctx.theme),
          configInvalid,
          compactSidebar,
          animationNow(),
          visibleSession(),
        ),
      ),
  });

  return () => {
    disposed = true;
    disposeSlot();
    clearInterval(renderTimer);
    clearInterval(animationTimer);
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
    const [snapshot, setSnapshot] = createSignal(
      readTuiSnapshot(configDirectory),
    );
    const [animationNow, setAnimationNow] = createSignal(Date.now());
    const tmuxRegistration: ActiveTmuxPaneRegistration = {
      ownerPid: process.pid,
      lastRecordedAt: 0,
    };
    syncTmuxPaneRegistration(api.route.current, tmuxRegistration);
    const remoteCache: RemoteModelCache = {};
    const refreshSidebar = async () => {
      const currentDirectory = getTuiDirectory(api);
      syncTmuxPaneRegistration(api.route.current, tmuxRegistration);
      let nextSnapshot = await readTuiSnapshotAsync(currentDirectory);
      if (currentDirectory !== configDirectory) {
        configDirectory = currentDirectory;
        ({ configInvalid, compactSidebar } = readConfigState(configDirectory));
      }
      nextSnapshot = await hydrateRemoteModels(
        nextSnapshot,
        (api as { client?: unknown }).client,
        currentDirectory,
        remoteCache,
      );
      if (!isRefreshCurrent(currentDirectory, getTuiDirectory(api))) return;
      setSnapshot(nextSnapshot);
      api.renderer.requestRender();
    };
    const scheduleRefresh = createSerializedRefresh(refreshSidebar);
    scheduleRefresh();
    const renderTimer = setInterval(scheduleRefresh, 1000);
    const animationTimer = setInterval(() => {
      // Same scoping as the render: hidden foreign-conversation activity
      // must not keep this window's sidebar rerendering every frame.
      if (
        getActiveSidebarAgentNames(
          snapshot(),
          resolveRouteSessionId(api.route.current),
        ).size > 0
      ) {
        setAnimationNow(Date.now());
      }
    }, ACTIVITY_FRAME_MS);

    api.lifecycle.onDispose(() => {
      clearInterval(renderTimer);
      clearInterval(animationTimer);
      clearTmuxPaneRegistration(tmuxRegistration);
    });

    api.slots.register({
      order: 900,
      slots: {
        sidebar_content() {
          return reactiveElement(() =>
            renderSidebar(
              snapshot(),
              version,
              api.theme.current,
              configInvalid,
              compactSidebar,
              animationNow(),
              resolveRouteSessionId(api.route.current),
            ),
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
          return snapshot();
        },
        set snapshot(value: TuiSnapshot) {
          setSnapshot(value);
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
