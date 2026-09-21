import * as path from 'node:path';
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
import {
  KILL_ALL_KEYBIND,
  killAllRunningSubagents,
  killAllSummaryMessage,
} from './tui-kill';
import { openPresetManager } from './tui-preset';
import {
  readTuiSnapshot,
  readTuiSnapshotAsync,
  resolveTuiSnapshotRoot,
  snapshotSectionsEqual,
  type TuiSnapshot,
} from './tui-state';
import { isPluginDisabledByEnv } from './utils/env';
import { log } from './utils/logger';

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

type Child =
  | JSX.Element
  | string
  | number
  | null
  | undefined
  | false
  | (() => string);

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

export function resolveRouteSessionId(route: TuiRouteView): string | undefined {
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

function visibleConversationRoot(snapshot: TuiSnapshot, id?: string) {
  return id === undefined ? undefined : resolveTuiSnapshotRoot(snapshot, id);
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
  const root = visibleConversationRoot(snapshot, visibleRootID);
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

/** One clickable sidebar destination: an active subagent session. */
export interface SidebarSessionTarget {
  sessionID: string;
  agentName: string;
  alias?: string;
  model?: string;
  status?: 'busy' | 'retry';
}

export interface SidebarAgentTargets {
  agentName: string;
  sessions: SidebarSessionTarget[];
}

/**
 * Group the active subagent sessions of the visible conversation by agent
 * for the clickable sidebar. Mirrors the scoping of
 * getActiveSidebarAgentNames (#1147) with two refinements:
 * - Only sessions with a known parent link are offered as destinations:
 *   a root session running an agent directly (e.g. a top-level chat with
 *   agent=oracle) is not a subagent of this conversation.
 * - Without a visible route session there is no conversation to scope to;
 *   return no targets rather than exposing cross-conversation navigation.
 * Stable ordering: by alias (numeric suffix aware, ora-2 < ora-10), then
 * by sessionID.
 */
export function getSidebarAgentTargets(
  snapshot: TuiSnapshot,
  visibleRootID?: string,
): SidebarAgentTargets[] {
  const root = visibleConversationRoot(snapshot, visibleRootID);
  if (root === undefined) return [];
  const byAgent = new Map<string, SidebarSessionTarget[]>();
  for (const [sessionID, agentName] of Object.entries(
    snapshot.activeSessions,
  )) {
    const parent = snapshot.sessionParents[sessionID];
    if (parent === undefined) continue; // not a known subagent
    if (resolveTuiSnapshotRoot(snapshot, sessionID) !== root) continue;
    const details = snapshot.sessionDetails[sessionID];
    const list = byAgent.get(agentName) ?? [];
    list.push({
      sessionID,
      agentName,
      alias: details?.alias,
      model: details?.model,
      status: details?.status,
    });
    byAgent.set(agentName, list);
  }
  return [...byAgent.entries()].map(([agentName, sessions]) => ({
    agentName,
    sessions: disambiguateDuplicateAliases(
      sessions.sort(compareSidebarTargets),
    ),
  }));
}

/** When two sessions share an alias (nested branches), append a short id. */
function disambiguateDuplicateAliases(
  sessions: SidebarSessionTarget[],
): SidebarSessionTarget[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.alias === undefined) continue;
    counts.set(session.alias, (counts.get(session.alias) ?? 0) + 1);
  }
  return sessions.map((session) => {
    if (session.alias === undefined) return session;
    if ((counts.get(session.alias) ?? 0) < 2) return session;
    return {
      ...session,
      alias: `${session.alias} ${shortSessionID(session.sessionID)}`,
    };
  });
}

/** One clickable reusable destination: the latest reconciled session of
 * an agent in the visible conversation (sidebar green dot). */
export interface SidebarReusableTarget {
  taskID: string;
  alias: string;
  lastUsedAt: number;
}

/**
 * Latest reconciled reusable session per agent for the visible
 * conversation's sidebar dot. Mirrors the parent-scoping of
 * getSidebarAgentTargets (#1147): only entries whose parent session
 * resolves to the same conversation root as the visible session are
 * offered; without a visible session there is no conversation to scope
 * to and no dots are rendered.
 */
export function getSidebarReusableTargets(
  snapshot: TuiSnapshot,
  visibleRootID?: string,
): Map<string, SidebarReusableTarget> {
  const targets = new Map<string, SidebarReusableTarget>();
  const root = visibleConversationRoot(snapshot, visibleRootID);
  if (root === undefined) return targets;
  for (const [parentSessionID, byAgent] of Object.entries(
    snapshot.reusableByAgent,
  )) {
    if (resolveTuiSnapshotRoot(snapshot, parentSessionID) !== root) continue;
    for (const [agentName, entry] of Object.entries(byAgent)) {
      const current = targets.get(agentName);
      // Multiple parents of the same visible tree can hold the same
      // agent (nested dispatch): the dot must open the most recently
      // used entry, not whichever parent happened to be iterated last.
      if (current === undefined || entry.lastUsedAt >= current.lastUsedAt) {
        targets.set(agentName, {
          taskID: entry.taskID,
          alias: entry.alias,
          lastUsedAt: entry.lastUsedAt,
        });
      }
    }
  }
  return targets;
}

function compareSidebarTargets(
  a: SidebarSessionTarget,
  b: SidebarSessionTarget,
): number {
  if (a.alias !== undefined && b.alias !== undefined && a.alias !== b.alias) {
    return compareAliasNumeric(a.alias, b.alias);
  }
  if (a.alias !== undefined && b.alias === undefined) return -1;
  if (a.alias === undefined && b.alias !== undefined) return 1;
  return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0;
}

/** Natural sort for alias counters: ora-2 sorts before ora-10. */
export function compareAliasNumeric(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) {
    return Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Short distinctive id fallback when a session has no board alias. */
export function shortSessionID(sessionID: string): string {
  return sessionID.length > 8 ? sessionID.slice(-8) : sessionID;
}

/**
 * Per-window sidebar interaction state. `navigate` is feature-detected at
 * startup: without it the sidebar renders informatively (no handlers).
 * Expansion state is local to this window and never persisted.
 */
export interface SidebarInteraction {
  navigate?: (sessionID: string) => void;
  expandedAgents: () => ReadonlySet<string>;
  toggleAgent: (agentName: string) => void;
  /** Reset expansion when the project directory or visible root changes. */
  syncScope: (directory: string, rootID: string | undefined) => void;
  /** True when this TUI has a non-empty text selection (skip click). */
  hasSelectedText?: () => boolean;
}

export function createSidebarInteraction(
  navigate: ((sessionID: string) => void) | undefined,
  hasSelectedText?: () => boolean,
): SidebarInteraction {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  let lastDirectory: string | undefined;
  let lastRootID: string | undefined;
  return {
    navigate,
    hasSelectedText,
    expandedAgents: expanded,
    toggleAgent: (agentName: string) => {
      setExpanded((prev: ReadonlySet<string>) => {
        const next = new Set<string>(prev);
        if (next.has(agentName)) next.delete(agentName);
        else next.add(agentName);
        return next;
      });
    },
    syncScope: (directory, rootID) => {
      if (
        lastDirectory !== undefined &&
        (lastDirectory !== directory || lastRootID !== rootID)
      ) {
        setExpanded(new Set<string>());
      }
      lastDirectory = directory;
      lastRootID = rootID;
    },
  };
}

/** Build a guarded navigation callback from a raw route navigate fn. */
export function makeRouteNavigator(
  owner: object | undefined,
  methodName: 'navigate',
  v2Shape: boolean,
): ((sessionID: string) => void) | undefined {
  if (owner === undefined) return undefined;
  const raw = (owner as Record<string, unknown>)[methodName];
  if (typeof raw !== 'function') return undefined;
  return (sessionID) => {
    try {
      if (v2Shape) {
        (raw as (route: { type: string; sessionID: string }) => void).call(
          owner,
          { type: 'session', sessionID },
        );
      } else {
        (raw as (name: string, params?: Record<string, unknown>) => void).call(
          owner,
          'session',
          { sessionID },
        );
      }
    } catch {
      // Navigation is best-effort; never break the sidebar on a host error.
    }
  };
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
  background?: unknown;
  backgroundElement?: unknown;
  success?: unknown;
  warning?: unknown;
  hover?: unknown;
}

const STATUS_ACTIVE_COLOR = '#22c55e';
const STATUS_RETRY_COLOR = '#f59e0b';
const STATUS_COLUMN_WIDTH = 8;

function hasPrimarySelection(hasSelectedText?: () => boolean): boolean {
  try {
    return hasSelectedText?.() === true;
  } catch {
    return false;
  }
}

function shouldActivateRow(
  event: { button?: number } | undefined,
  hasSelectedText?: () => boolean,
): boolean {
  if (event?.button !== undefined && event.button !== 0) return false;
  return !hasPrimarySelection(hasSelectedText);
}

export function selectionGuard(renderer: {
  getSelection?: () => unknown;
}): () => boolean {
  return () => {
    const selection = renderer.getSelection?.();
    if (selection === null || selection === undefined) return false;
    if (typeof selection !== 'object') return false;
    const getSelectedText = (selection as { getSelectedText?: unknown })
      .getSelectedText;
    if (typeof getSelectedText !== 'function') return false;
    const text = (getSelectedText as () => unknown).call(selection);
    return typeof text === 'string' && text.length > 0;
  };
}

export function resolveHoverBackground(theme: {
  background?: unknown;
  backgroundElement?: unknown;
  text?: unknown;
  hover?: unknown;
}): unknown {
  if (theme.hover !== undefined && theme.hover !== null) return theme.hover;
  if (
    theme.backgroundElement !== undefined &&
    theme.backgroundElement !== null
  ) {
    return theme.backgroundElement;
  }
  try {
    const bg = parseColor((theme.background ?? '#111111') as ColorInput);
    const fg = parseColor((theme.text ?? '#ffffff') as ColorInput);
    return RGBA.fromValues(
      bg.r * 0.82 + fg.r * 0.18,
      bg.g * 0.82 + fg.g * 0.18,
      bg.b * 0.82 + fg.b * 0.18,
      bg.a,
    );
  } catch {
    return '#2a2a2a';
  }
}

type HoverPaintTarget = {
  node: { bg?: unknown; backgroundColor?: unknown };
  hasBg: boolean;
  hasBackgroundColor: boolean;
  bg: unknown;
  backgroundColor: unknown;
};

type HoverRowRenderable = {
  backgroundColor?: unknown;
  bg?: unknown;
  getChildren?: () => unknown[];
  screenX: number;
  screenY: number;
  width: number;
  height: number;
};

function collectHoverPaintTargets(
  node: unknown,
  acc: HoverPaintTarget[],
): void {
  if (!node || typeof node !== 'object') return;
  const rec = node as HoverRowRenderable;
  const hasBg = 'bg' in rec;
  const hasBackgroundColor = 'backgroundColor' in rec;
  if (hasBg || hasBackgroundColor) {
    acc.push({
      node: rec,
      hasBg,
      hasBackgroundColor,
      bg: rec.bg,
      backgroundColor: rec.backgroundColor,
    });
  }
  const children = rec.getChildren?.();
  if (!Array.isArray(children)) return;
  for (const child of children) collectHoverPaintTargets(child, acc);
}

function isPointerInsideRow(
  row: HoverRowRenderable,
  event?: { x?: number; y?: number },
): boolean {
  if (event?.x === undefined || event?.y === undefined) return false;
  return (
    event.x >= row.screenX &&
    event.x < row.screenX + row.width &&
    event.y >= row.screenY &&
    event.y < row.screenY + row.height
  );
}

/**
 * Mutate a stable row's background in place. Must not read a Solid
 * signal: rebuilding the row between press and release drops the click.
 *
 * OpenTUI hit-tests the leaf (usually the text child). `out`/`over` then
 * bubble. Ignore `out` while the pointer is still inside this row so
 * moving between alias/model/status does not flicker, and paint both the
 * box fill and descendant text `bg` so the whole line lights up.
 */
function decorateInteractiveRow(
  node: JSX.Element,
  opts: {
    hoverBackground: unknown;
    onActivate?: () => void;
    hasSelectedText?: () => boolean;
  },
): JSX.Element {
  const row = node as unknown as HoverRowRenderable;
  const painted: HoverPaintTarget[] = [];
  collectHoverPaintTargets(row, painted);

  const applyHover = (active: boolean): void => {
    for (const target of painted) {
      if (target.hasBackgroundColor) {
        target.node.backgroundColor = active
          ? opts.hoverBackground
          : target.backgroundColor;
      }
      if (target.hasBg) {
        target.node.bg = active ? opts.hoverBackground : target.bg;
      }
    }
  };

  setProp(node as never, 'onMouseOver', () => {
    applyHover(true);
  });
  setProp(node as never, 'onMouseOut', (event?: { x?: number; y?: number }) => {
    if (isPointerInsideRow(row, event)) return;
    applyHover(false);
  });
  if (opts.onActivate) {
    setProp(node as never, 'onMouseUp', (event?: { button?: number }) => {
      if (!shouldActivateRow(event, opts.hasSelectedText)) return;
      opts.onActivate?.();
    });
  }
  return node;
}

function sessionStatusView(
  status: SidebarSessionTarget['status'],
  theme: AgentRowTheme,
): { label: string; color: unknown } {
  if (status === 'retry') {
    return { label: 'retrying', color: theme.warning ?? STATUS_RETRY_COLOR };
  }
  return { label: 'active', color: theme.success ?? STATUS_ACTIVE_COLOR };
}

function activityIndicator(
  active: boolean,
  now: () => number,
  theme: AgentRowTheme,
): JSX.Element {
  // Nested reactive leaf: only this glyph re-renders on the 100 ms
  // animation tick. Rebuilding the clickable parent on every frame
  // would drop the mouse target between press and release.
  return text(
    {
      fg: active ? (theme.accent ?? theme.text) : theme.textMuted,
      width: 2,
    },
    active ? [() => getSidebarActivityIndicator(true, now())] : [' '],
  );
}

/** Visual-only history glyph. Click/hover belong to the row. */
function historyDot(): JSX.Element {
  return text(
    {
      // Emerald: softer than theme.success, distinct from running-state green.
      fg: '#34d399',
      width: 2,
      selectable: false,
    },
    // ✦ over ●/◈: its ink sits in the mid-cell band, so the glyph optically
    // centers against the agent label, and its narrow waist reads as spaced
    // from the name without inserting a cell of whitespace (margins are
    // whole-cell in this layout: no sub-cell nudging exists).
    ['✦'],
  );
}

function agentRow(
  label: string,
  model: string,
  variant: string | undefined,
  active: boolean,
  now: () => number,
  theme: AgentRowTheme,
  sessionCount?: number,
  expanded = false,
  onClick?: () => void,
  hoverBackground?: unknown,
  hasSelectedText?: () => boolean,
  showHistoryDot?: boolean,
): JSX.Element {
  const modelParts = splitSidebarModelId(model);
  const detailRows: JSX.Element[] = [];

  function detailRow(fieldLabel: string, value: string) {
    return box(
      {
        width: '100%',
        flexDirection: 'row',
        paddingLeft: 2,
        shouldFill: false,
      },
      [
        text({ fg: theme.textMuted, width: 9 }, [fieldLabel]),
        text({ fg: theme.textMuted }, [value]),
      ],
    );
  }

  if (modelParts.provider) {
    detailRows.push(detailRow('provider', modelParts.provider));
  }
  detailRows.push(detailRow('model', modelParts.model));
  if (variant) {
    detailRows.push(detailRow('variant', variant));
  }

  const header = box(
    {
      width: '100%',
      flexDirection: 'row',
      shouldFill: true,
    },
    [
      text(
        {
          fg: theme.textMuted,
          wrapMode: 'none',
          truncate: true,
          flexShrink: 1,
        },
        [label],
      ),
      ...(showHistoryDot ? [historyDot()] : []),
      activityIndicator(active, now, theme),
      ...(sessionCount !== undefined && sessionCount > 1
        ? [
            text({ fg: theme.textMuted, width: 4 }, [expanded ? ' ▴' : ' ▾']),
            text({ fg: theme.textMuted }, [`${sessionCount}`]),
          ]
        : []),
    ],
  );
  decorateInteractiveRow(header, {
    hoverBackground: hoverBackground ?? resolveHoverBackground(theme),
    onActivate: onClick,
    hasSelectedText,
  });

  return box(
    {
      width: '100%',
      flexDirection: 'column',
      marginBottom: 1,
      shouldFill: false,
    },
    [header, ...detailRows],
  );
}

function compactAgentRow(
  label: string,
  model: string,
  _variant: string | undefined,
  active: boolean,
  now: () => number,
  theme: AgentRowTheme,
  sessionCount?: number,
  expanded = false,
  onClick?: () => void,
  hoverBackground?: unknown,
  hasSelectedText?: () => boolean,
  showHistoryDot?: boolean,
): JSX.Element {
  const modelName = splitSidebarModelId(model).model;
  const row = box(
    {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
      shouldFill: true,
    },
    [
      box(
        {
          width: 16,
          flexShrink: 0,
          flexDirection: 'row',
          shouldFill: false,
        },
        [
          text(
            {
              fg: theme.textMuted,
              wrapMode: 'none',
              truncate: true,
              flexShrink: 1,
            },
            [label],
          ),
          ...(showHistoryDot ? [historyDot()] : []),
          box({ flexGrow: 1, shouldFill: false }),
          activityIndicator(active, now, theme),
        ],
      ),
      box({ flexDirection: 'row', flexGrow: 1, shouldFill: false }),
      text(
        {
          fg: theme.textMuted,
          wrapMode: 'none',
          truncate: true,
          flexShrink: 1,
        },
        [
          sessionCount !== undefined && sessionCount > 1
            ? `${expanded ? '▴' : '▾'}${sessionCount} ${modelName}`
            : modelName,
        ],
      ),
    ],
  );
  return decorateInteractiveRow(row, {
    hoverBackground: hoverBackground ?? resolveHoverBackground(theme),
    onActivate: onClick,
    hasSelectedText,
  });
}

/**
 * One expanded subagent destination: `ora-1  model  status`.
 * Hover mutates this box in place so the click target survives ticks.
 */
function sessionTargetRow(
  target: SidebarSessionTarget,
  theme: AgentRowTheme,
  onActivate: () => void,
  hoverBackground: unknown,
  hasSelectedText?: () => boolean,
): JSX.Element {
  const label = target.alias ?? shortSessionID(target.sessionID);
  const status = sessionStatusView(target.status, theme);
  const modelName = target.model
    ? splitSidebarModelId(target.model).model
    : '—';
  const row = box(
    {
      width: '100%',
      flexDirection: 'row',
      paddingLeft: 2,
      columnGap: 1,
      shouldFill: true,
    },
    [
      text(
        {
          fg: theme.textMuted,
          flexShrink: 0,
          wrapMode: 'none',
        },
        [label],
      ),
      text(
        {
          fg: theme.textMuted,
          wrapMode: 'none',
          truncate: true,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        },
        [modelName],
      ),
      text(
        {
          fg: status.color,
          width: STATUS_COLUMN_WIDTH,
          flexShrink: 0,
          wrapMode: 'none',
        },
        [status.label],
      ),
    ],
  );
  return decorateInteractiveRow(row, {
    hoverBackground,
    onActivate,
    hasSelectedText,
  });
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
    backgroundElement?: unknown;
    success?: unknown;
    warning?: unknown;
    hover?: unknown;
  },
  configInvalid: boolean,
  compactSidebar: boolean,
  now: () => number = Date.now,
  visibleRootID?: string,
  interaction?: SidebarInteraction,
): JSX.Element {
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);
  const activeAgents = getActiveSidebarAgentNames(snapshot, visibleRootID);
  const targetsByAgent = new Map(
    getSidebarAgentTargets(snapshot, visibleRootID).map((group) => [
      group.agentName,
      group.sessions,
    ]),
  );
  // Green dot (#1197 follow-up): only rendered when clickable — a dot
  // without navigation would be dead pixels (decision: no navigate, no
  // dot, no handler).
  const navigate = interaction?.navigate;
  const reusableByAgent =
    navigate === undefined
      ? new Map<string, SidebarReusableTarget>()
      : getSidebarReusableTargets(snapshot, visibleRootID);
  const expandedAgents = interaction?.expandedAgents() ?? new Set<string>();
  const hoverBackground = resolveHoverBackground(theme);
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
      ...getSidebarAgentNames(snapshot).flatMap((agentName) => {
        const model = snapshot.agentModels[agentName] ?? 'pending';
        const variant = snapshot.agentVariants[agentName];
        const active = activeAgents.has(agentName);
        const sessions = targetsByAgent.get(agentName) ?? [];
        const reusable = reusableByAgent.get(agentName);
        // History is idle-only: while this agent has live sessions, #1197
        // owns the row (navigate the live one / expand N). The dot and
        // idle-row click appear only when nothing is running.
        const history =
          sessions.length === 0 && reusable !== undefined
            ? reusable
            : undefined;
        const clickable =
          interaction?.navigate !== undefined &&
          (sessions.length > 0 || history !== undefined);
        const expanded =
          sessions.length > 1 && clickable && expandedAgents.has(agentName);
        const onAgentClick = clickable
          ? () => {
              if (sessions.length === 1) {
                interaction?.navigate?.(sessions[0].sessionID);
              } else if (sessions.length > 1) {
                interaction?.toggleAgent(agentName);
              } else if (history !== undefined) {
                interaction?.navigate?.(history.taskID);
              }
            }
          : undefined;
        const agentRowEl = compactSidebar
          ? compactAgentRow(
              agentName,
              model,
              variant,
              active,
              now,
              theme,
              clickable ? sessions.length : undefined,
              expanded,
              onAgentClick,
              hoverBackground,
              interaction?.hasSelectedText,
              history !== undefined,
            )
          : agentRow(
              agentName,
              model,
              variant,
              active,
              now,
              theme,
              clickable ? sessions.length : undefined,
              expanded,
              onAgentClick,
              hoverBackground,
              interaction?.hasSelectedText,
              history !== undefined,
            );
        if (!expanded) return [agentRowEl];
        return [
          agentRowEl,
          ...sessions.map((target) =>
            sessionTargetRow(
              target,
              theme,
              () => interaction?.navigate?.(target.sessionID),
              hoverBackground,
              interaction?.hasSelectedText,
            ),
          ),
        ];
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

const DEFAULT_SIDEBAR_SLOT_ORDER = 900;

/** Extract the spec string from a plugin-list entry: `"spec"` or `[spec, options]`. */
function pluginSpecOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return undefined;
}

/**
 * Position slim's sidebar section according to its index in the host's
 * effective plugin list (`tuiConfig.plugin`): index 0 → 110 (right after
 * the host's context section, above most third-party plugins), each later
 * index one band of 100 later. This only moves slim's own slot; other
 * plugins retain their own order, and no relative ordering with them is
 * guaranteed. v1 hosts only — the v2 slot claim API has no order
 * parameter. When the spec is absent or the list is unavailable, the
 * historic default (900) applies.
 */
export function resolveSidebarSlotOrder(
  pluginList: unknown,
  pluginName: string,
): number {
  if (!Array.isArray(pluginList)) return DEFAULT_SIDEBAR_SLOT_ORDER;
  const index = pluginList.findIndex((entry) => {
    const spec = pluginSpecOf(entry);
    if (spec === undefined) return false;
    if (spec === pluginName) return true;
    if (spec.startsWith('file://')) {
      // Filesystem checkout: match by exact path or basename. A trailing
      // slash is tolerated; directory names are taken literally.
      const stripped = spec.replace(/^file:\/\//, '');
      return stripped === pluginName || path.basename(stripped) === pluginName;
    }
    if (path.isAbsolute(spec)) {
      // Plain local path, as the installer writes for source installs.
      return path.basename(spec) === pluginName;
    }
    // npm spec: strip a trailing @version (never contains a slash). A
    // scoped package (@scope/name) is a different package and must not
    // match by basename.
    const stripped = spec.replace(/@[^/]*$/, '');
    if (stripped.startsWith('@')) return false;
    return stripped === pluginName;
  });
  if (index === -1) return DEFAULT_SIDEBAR_SLOT_ORDER;
  return 110 + index * 100;
}

// Mirrors the OpenCode v2 TUI context surface (dist/tui/context.d.ts);
// declared locally because the pinned @opencode-ai/plugin dep ships v1
// types only.
interface V2TuiThemeTokens {
  text: { default: unknown; subdued: unknown };
  background: { default: unknown };
  border: { default: unknown };
  /** Optional semantic tokens; v2 hosts may omit them. */
  success?: unknown;
  warning?: unknown;
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
  renderer: { requestRender: () => void; getSelection?: () => unknown };
  theme: V2TuiThemeTokens;
  ui: {
    slot: (claim: V2TuiSlotClaim) => () => void;
    router: {
      current: () => { type?: string; sessionID?: string };
      /** Optional navigation capability; absent on hosts that don't expose it. */
      navigate?: (route: { type: string; sessionID: string }) => void;
    };
  };
}

/** Map v2 theme tokens onto the flat shape `renderSidebar` consumes (v2 has no `accent` token). */
function v2ThemeView(theme: V2TuiThemeTokens): {
  accent: undefined;
  background: unknown;
  borderActive: unknown;
  text: unknown;
  textMuted: unknown;
  success?: unknown;
  warning?: unknown;
} {
  return {
    accent: undefined,
    background: theme.background.default,
    borderActive: theme.border.default,
    text: theme.text.default,
    textMuted: theme.text.subdued,
    ...(theme.success !== undefined ? { success: theme.success } : {}),
    ...(theme.warning !== undefined ? { warning: theme.warning } : {}),
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
    const directoryChanged = currentDirectory !== configDirectory;
    if (directoryChanged) {
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
    if (!directoryChanged && snapshotSectionsEqual(nextSnapshot, snapshot())) {
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

  // Clickable sidebar: navigation is optional on v2 hosts (feature-detected
  // at startup); without it the sidebar renders informatively.
  const interaction = createSidebarInteraction(
    makeRouteNavigator(ctx.ui.router, 'navigate', true),
    selectionGuard(ctx.renderer),
  );

  const disposeSlot = ctx.ui.slot({
    append: 'sidebar.content',
    render: () =>
      reactiveElement(() => {
        const visible = visibleSession();
        const currentSnapshot = snapshot();
        interaction.syncScope(
          configDirectory,
          visible === undefined
            ? undefined
            : resolveTuiSnapshotRoot(currentSnapshot, visible),
        );
        return renderSidebar(
          currentSnapshot,
          version,
          v2ThemeView(ctx.theme),
          configInvalid,
          compactSidebar,
          animationNow,
          visible,
          interaction,
        );
      }),
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
 * Build the TUI slash command for `/killall`. Same legacy `api.command`
 * registration as `/preset`: pure TUI entry point, no picker and no
 * confirmation — it is an emergency escape hatch. The actual work is the
 * shared helper in `src/tui-kill.ts`; post-kill reconciliation rides the
 * existing idle pipeline.
 */
function buildKillAllCommand(
  api: TuiPluginApi,
  directoryGetter: () => string,
  snapshotGetter: () => TuiSnapshot,
): TuiCommand {
  return {
    title: 'OMO: kill all running subagents',
    value: 'omo.kill_all',
    description: 'Abort every running subagent of this conversation',
    slash: { name: 'killall' },
    keybind: KILL_ALL_KEYBIND,
    onSelect: () => {
      void killAllRunningSubagents(
        (api as { client?: unknown }).client,
        snapshotGetter(),
        resolveRouteSessionId(api.route.current),
        directoryGetter(),
      )
        .then((result) => {
          api.ui.toast({
            variant: result.failed > 0 ? 'warning' : 'info',
            message: killAllSummaryMessage(result),
          });
        })
        .catch((error) => {
          log('[tui-kill] kill-all flow failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
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
      const directoryChanged = currentDirectory !== configDirectory;
      if (directoryChanged) {
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
      if (
        !directoryChanged &&
        snapshotSectionsEqual(nextSnapshot, snapshot())
      ) {
        return;
      }
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

    // Clickable sidebar: v1 hosts always expose api.route.navigate.
    const interaction = createSidebarInteraction(
      makeRouteNavigator(api.route, 'navigate', false),
      selectionGuard(api.renderer),
    );

    api.slots.register({
      order: resolveSidebarSlotOrder(api.tuiConfig?.plugin, PLUGIN_NAME),
      slots: {
        sidebar_content() {
          return reactiveElement(() => {
            const visible = resolveRouteSessionId(api.route.current);
            const currentSnapshot = snapshot();
            interaction.syncScope(
              configDirectory,
              visible === undefined
                ? undefined
                : resolveTuiSnapshotRoot(currentSnapshot, visible),
            );
            return renderSidebar(
              currentSnapshot,
              version,
              api.theme.current,
              configInvalid,
              compactSidebar,
              animationNow,
              visible,
              interaction,
            );
          });
        },
      },
    });

    // `/preset` is a pure TUI slash command (like the built-in `/models`):
    // it opens a picker, switches the preset via on-disk state, and never
    // sends a message to the server or triggers an LLM turn. The legacy
    // `api.command` API is still populated in OpenCode 1.18; if it is absent
    // (e.g. a future v2-only build), registration is skipped gracefully.
    // `/killall` (+ alt+w) rides the same registration: it only
    // resolves visible-conversation targets from the snapshot and aborts
    // them via the shared helper.
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
        buildKillAllCommand(
          api,
          () => configDirectory,
          () => snapshot(),
        ),
      ]);
      api.lifecycle.onDispose(disposeCommands);
    }
  },
  setup,
};

export default plugin;
