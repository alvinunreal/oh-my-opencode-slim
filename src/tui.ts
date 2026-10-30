import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { MultiplexerConfigSchema, type MultiplexerType } from './config/schema';
import {
  type PluginConfigSnapshot,
  readPluginConfigSnapshot,
} from './config/snapshot';
import { isCommandEnabled } from './hooks/command-hook-utils';
import {
  createOnceGate,
  logHostUnsupported,
  PLUGIN_LOG_SINK,
} from './multiplexer/client/diagnostics';
import {
  createTuiPaneWiring,
  initClientLogging,
  type LoadedPaneConfig,
  paneConfigOf,
  type TuiPaneWiring,
} from './multiplexer/client/tui-wiring';
import {
  buildV2PaneWiringOptions,
  describeV2HostMode,
  detectV2HostMode,
} from './multiplexer/client/v2-host';
import {
  KILL_ALL_KEYBIND,
  killAllRunningSubagents,
  killAllSummaryMessage,
} from './tui-kill';
import { fetchModelNameMap, openPresetManager } from './tui-preset';
import {
  readTuiSnapshot,
  readTuiSnapshotAsync,
  resolveTuiSnapshotRoot,
  snapshotSectionsEqual,
  type TuiSnapshot,
} from './tui-state';
import { isPluginDisabledByEnv } from './utils/env';
import { log } from './utils/logger';
import { findOwnedPackageJson } from './utils/package-root';
import {
  notifyConfigChanged,
  registerConfigChangeListener,
} from './v2/config-change-coordinator';
import {
  canOpenPresetManagerV2,
  openPresetManagerV2,
  readSessionPreset,
  sessionPresetLabel,
  type V2PresetManagerContext,
  type V2PresetUiSurface,
} from './v2/preset-manager';
import type { SessionPresetState } from './v2/preset-rpc';
import { createTeamDisplayIdentity } from './v2/team-display';

const PLUGIN_NAME = 'oh-my-opencode-slim';
const CONFIG_WARNING_COLOR = 'orange';
/**
 * Council agents are internal orchestration surfaces: `council`,
 * `councillor`, and the dynamic `councillor-<name>` agents (v3 registry
 * writes them into `snapshot.agentModels`). They must never appear as
 * sidebar rows (#1672).
 */
function isCouncilSidebarAgent(agent: string): boolean {
  return (
    agent === 'council' ||
    agent === 'councillor' ||
    agent.startsWith('councillor-')
  );
}

const FALLBACK_SIDEBAR_AGENTS = SUBAGENT_NAMES.filter(
  (agent) =>
    !isCouncilSidebarAgent(agent) && !DEFAULT_DISABLED_AGENTS.includes(agent),
);
const BORDER = { type: 'single' };
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

/** Once-per-process gate for the v2-host multiplexer diagnostic (NFR-6). */
const v2HostUnsupportedGate = createOnceGate();

/**
 * Standalone and invalid v2 hosts cannot create panes (NFR-6): a multiplexer
 * configured there is ignored. Records that at most once per process so the
 * disabled feature is self-explaining instead of silently dropping config;
 * callers re-run it whenever the config is (re)read.
 */
function warnV2HostUnsupportedMultiplexer(
  configuredType: MultiplexerType,
  detail: { mode: string; reason?: string },
): void {
  if (configuredType === 'none') return;
  if (!v2HostUnsupportedGate('v2-host-unsupported')) return;
  initClientLogging();
  logHostUnsupported(PLUGIN_LOG_SINK, configuredType, detail);
}

type Child =
  | JSX.Element
  | string
  | number
  | null
  | undefined
  | false
  | (() => string);

async function readPackageVersion(): Promise<string | undefined> {
  return findOwnedPackageJson(fileURLToPath(import.meta.url), PLUGIN_NAME)
    ?.version;
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

/** Route shapes accepted by the sidebar: v1 `{ name, params }` and v2 `{ type, sessionID }`. */
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

/**
 * Resolves the project scope for panes owned by the displayed conversation.
 *
 * A TUI can be launched from one directory while resuming a session created
 * in another. `state.path.directory` keeps the launch scope in that case,
 * while the selected session retains the directory its children inherit.
 * Prefer that session directory so multiplexer event filtering, status reads,
 * and spawned attach panes all use the same scope as the displayed session.
 */
export function resolveTuiPaneDirectory(api: {
  route?: { current?: TuiRouteView };
  state?: {
    path?: { directory?: string };
    session?: {
      get?: (sessionID: string) => { directory?: unknown } | undefined;
    };
  };
}): string {
  const fallback = getTuiDirectory(api);
  const sessionID = api.route?.current
    ? resolveRouteSessionId(api.route.current)
    : undefined;
  if (!sessionID) return fallback;

  try {
    const directory = api.state?.session?.get?.(sessionID)?.directory;
    return typeof directory === 'string' && directory.length > 0
      ? directory
      : fallback;
  } catch {
    return fallback;
  }
}

/** Route-scoped pane context, shared by initial wiring and subsequent events. */
export function paneWiringOptions(
  api: Parameters<typeof resolveTuiPaneDirectory>[0] & {
    route: { current: TuiRouteView };
  },
) {
  const getDirectory = () => resolveTuiPaneDirectory(api);
  return {
    directory: getDirectory(),
    getDirectory,
    getDisplayedSessionId: () => resolveRouteSessionId(api.route.current),
  };
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
  const configuredAgents = Object.keys(snapshot.agentModels).filter(
    (agent) => !isCouncilSidebarAgent(agent),
  );
  return configuredAgents.length > 0
    ? configuredAgents
    : FALLBACK_SIDEBAR_AGENTS;
}

type AgentListFn = (
  input?: unknown,
  options?: { signal: AbortSignal },
) => Promise<unknown>;

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
  scheduleTimeout: (callback: () => void, delay: number) => () => void = (
    callback,
    delay,
  ) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
): Promise<Record<string, string>> {
  const rec = client as
    | {
        app?: { agents?: unknown };
        agent?: { list?: unknown };
        v2?: { agent?: { list?: unknown } };
      }
    | undefined;
  if (!rec) return {};

  const v1Agents = asFunction(rec.app?.agents);
  const v2Receiver = rec.agent ?? rec.v2?.agent;
  const receiver = v1Agents ? rec.app : v2Receiver;
  const list = v1Agents ?? asFunction(v2Receiver?.list);
  if (!list) return {};
  const controller = new AbortController();
  let cancelTimeout: (() => void) | undefined;
  try {
    const timeout = new Promise<unknown>((resolve) => {
      cancelTimeout = scheduleTimeout(() => {
        controller.abort();
        resolve([]);
      }, 2_000);
    });
    const request = list.call(
      receiver,
      v1Agents ? { directory } : { location: { directory } },
      { signal: controller.signal },
    );
    return modelsFromAgentList(await Promise.race([request, timeout]));
  } catch {
    return {};
  } finally {
    cancelTimeout?.();
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

const MODEL_NAMES_TTL_MS = 60_000;

const MODEL_NAMES_FETCH_TIMEOUT_MS = 2_000;

export interface ModelNamesCache {
  directory?: string;
  names: ReadonlyMap<string, string>;
  at?: number;
}

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

/**
 * TTL-cached provider/model display-name map for the sidebar. Falls back
 * silently to the previous (possibly empty) map on fetch failure — the
 * sidebar polls forever, so failures must never toast or throw.
 */
export async function hydrateModelNames(
  client: unknown,
  directory: string,
  cache: ModelNamesCache,
  now: () => number = Date.now,
  timeoutMs: number = MODEL_NAMES_FETCH_TIMEOUT_MS,
): Promise<ReadonlyMap<string, string>> {
  const cached =
    cache.directory === directory &&
    (cache.names.size > 0 ||
      (cache.at !== undefined && now() - cache.at < MODEL_NAMES_TTL_MS))
      ? cache.names
      : undefined;
  if (
    cached !== undefined &&
    cache.at !== undefined &&
    now() - cache.at < MODEL_NAMES_TTL_MS
  ) {
    return cached;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const names = await Promise.race([
      fetchModelNameMap({ client }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('model names fetch timed out')),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    cache.directory = directory;
    cache.names = new Map(Object.entries(names));
    cache.at = now();
  } catch (err) {
    // Rate-limit retries via TTL. Keep last-known names only when the failed
    // fetch is for the same directory; a directory switch must not inherit
    // the previous project's labels.
    log('[v2][tui] model name fetch failed', String(err));
    if (cache.directory !== directory) {
      cache.names = new Map();
    }
    cache.directory = directory;
    cache.at = now();
  }
  return cache.names;
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
  for (const [parentID, byAgent] of Object.entries(snapshot.reusableByAgent)) {
    if (
      root !== undefined &&
      resolveTuiSnapshotRoot(snapshot, parentID) !== root
    ) {
      continue;
    }
    for (const [agentName, entries] of Object.entries(byAgent)) {
      // The projection prepends running jobs ahead of terminal history.
      if (entries[0]?.running === true) {
        names.add(agentName);
      }
    }
  }
  return names;
}

/** One clickable sidebar destination: an active subagent session. */
export interface SidebarSessionTarget {
  sessionID: string;
  agentName: string;
  alias?: string;
  status?: 'busy' | 'retry' | 'reusable' | 'stopped';
  /**
   * 1-based position among the active sessions of the same agent sharing
   * this session's parent scope. Present only when that scope runs more
   * than one: parallel same-agent dispatches read as siblings, not nesting.
   */
  siblingOrdinal?: number;
  /** Active same-agent sibling count of this session's parent scope. */
  siblingTotal?: number;
  /**
   * Display name of the intermediate parent when this row is nested
   * depth-2 (its parent is itself a managed child session, e.g. a
   * specialist rather than the orchestrator). Human-facing only.
   */
  viaParent?: string;
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
      status: details?.status,
    });
    byAgent.set(agentName, list);
  }
  return [...byAgent.entries()].map(([agentName, sessions]) => ({
    agentName,
    sessions: disambiguateDuplicateAliases(
      annotateSiblingAttribution(
        snapshot,
        sessions.sort(compareSidebarTargets),
      ),
    ),
  }));
}

/**
 * Sibling attribution for parallel same-agent dispatches (human-facing
 * display only; never injected into model context). Within one agent
 * group, ACTIVE sessions sharing a parent scope get 1-based ordinals when
 * that scope runs more than one ("explorer 1/2"), and a session whose
 * parent is itself a managed child session (depth-2 nesting, e.g.
 * dispatched by a specialist rather than the orchestrator) gets a
 * "via <parent>" marker so true nesting stays visibly distinct from
 * sibling dispatch. Terminal history rows never join a sibling count.
 */
function annotateSiblingAttribution(
  snapshot: TuiSnapshot,
  sessions: SidebarSessionTarget[],
): SidebarSessionTarget[] {
  const isActive = (session: SidebarSessionTarget): boolean =>
    session.status !== 'reusable' && session.status !== 'stopped';
  const totals = new Map<string, number>();
  for (const session of sessions) {
    if (!isActive(session)) continue;
    const parent = snapshot.sessionParents[session.sessionID];
    if (parent !== undefined) totals.set(parent, (totals.get(parent) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  return sessions.map((session) => {
    const parent = snapshot.sessionParents[session.sessionID];
    const next: SidebarSessionTarget = { ...session };
    delete next.siblingOrdinal;
    delete next.siblingTotal;
    delete next.viaParent;
    if (parent === undefined) return next;
    const total = totals.get(parent);
    if (isActive(session) && total !== undefined && total > 1) {
      const ordinal = (ordinals.get(parent) ?? 0) + 1;
      ordinals.set(parent, ordinal);
      next.siblingOrdinal = ordinal;
      next.siblingTotal = total;
    }
    const grandparent = snapshot.sessionParents[parent];
    if (grandparent !== undefined && grandparent !== parent) {
      // Same display name the parent's own row uses: live board alias, else
      // the board alias from the grandparent's reusable list (the parent may
      // be idle by the time the child row renders), else the short id suffix
      // (already the distinguishing tail, never the shared prefix).
      const boardAlias = Object.values(
        snapshot.reusableByAgent[grandparent] ?? {},
      )
        .flat()
        .find((entry) => entry.taskID === parent)?.alias;
      next.viaParent =
        snapshot.sessionDetails[parent]?.alias ??
        boardAlias ??
        shortSessionID(parent);
    }
    return next;
  });
}

/** "1/2" sibling ordinal plus the depth-2 "via <parent>" nesting marker,
 * joined for the sidebar row annotation. Undefined when neither applies. */
export function sidebarSiblingAnnotation(
  target: SidebarSessionTarget,
): string | undefined {
  const parts = [
    target.siblingOrdinal !== undefined && target.siblingTotal !== undefined
      ? `${target.siblingOrdinal}/${target.siblingTotal}`
      : undefined,
    target.viaParent !== undefined ? `via ${target.viaParent}` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(' ') : undefined;
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

/** One clickable reusable destination of an agent in the visible conversation. */
export interface SidebarReusableTarget {
  taskID: string;
  alias: string;
  completedAt?: number;
  lastUsedAt?: number;
  running?: true;
  stopped?: true;
}

/**
 * Reusable sessions per agent for the visible conversation. Mirrors the
 * parent-scoping of
 * getSidebarAgentTargets (#1147): only entries whose parent session
 * resolves to the same conversation root as the visible session are
 * offered; without a visible session there is no conversation to scope
 * to and no reusable destinations are rendered.
 */
export function getSidebarReusableTargets(
  snapshot: TuiSnapshot,
  visibleRootID?: string,
): Map<string, SidebarReusableTarget[]> {
  const targets = new Map<string, SidebarReusableTarget[]>();
  const root = visibleConversationRoot(snapshot, visibleRootID);
  if (root === undefined) return targets;
  for (const [parentSessionID, byAgent] of Object.entries(
    snapshot.reusableByAgent,
  )) {
    if (resolveTuiSnapshotRoot(snapshot, parentSessionID) !== root) continue;
    for (const [agentName, entries] of Object.entries(byAgent)) {
      const current = targets.get(agentName) ?? [];
      const byTaskID = new Map(current.map((entry) => [entry.taskID, entry]));
      for (const entry of entries) {
        const candidate: SidebarReusableTarget = {
          taskID: entry.taskID,
          alias: entry.alias,
          ...(entry.running === true ? { running: true as const } : {}),
          ...(entry.terminalState === 'stopped'
            ? { stopped: true as const }
            : {}),
          ...(entry.completedAt !== undefined
            ? { completedAt: entry.completedAt }
            : {}),
          ...(entry.lastUsedAt !== undefined
            ? { lastUsedAt: entry.lastUsedAt }
            : {}),
        };
        const existing = byTaskID.get(entry.taskID);
        if (
          existing === undefined ||
          reusableRecency(candidate) > reusableRecency(existing)
        ) {
          byTaskID.set(entry.taskID, candidate);
        }
      }
      const merged = [...byTaskID.values()];
      targets.set(agentName, merged);
    }
  }
  for (const entries of targets.values()) {
    entries.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      if (a.running) return 0;
      return (
        reusableRecency(b) - reusableRecency(a) ||
        b.taskID.localeCompare(a.taskID)
      );
    });
  }
  return targets;
}

function reusableRecency(target: SidebarReusableTarget): number {
  return Math.max(target.lastUsedAt ?? 0, target.completedAt ?? 0);
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
  isOpen: () => boolean;
  toggleOpen: () => void;
  expandedAgents: () => ReadonlySet<string>;
  toggleAgent: (agentName: string) => void;
  /** Reset expansion when the project directory or visible root changes. */
  syncScope: (directory: string, rootID: string | undefined) => void;
  /** True when this TUI has a non-empty text selection (skip click). */
  hasSelectedText?: () => boolean;
}

/**
 * The active preset row rendered below the header/config status block and
 * above the agent list. `onActivate` is present only when the host can open
 * the preset manager (v2 dialogs); without it the row is informational-only.
 */
export interface SidebarPresetRow {
  name: string;
  /** V2-only: server-owned inference binding for future children, not a model. */
  sessionLabel?: string;
  onActivate?: () => void;
}

export function createSidebarInteraction(
  navigate: ((sessionID: string) => void) | undefined,
  hasSelectedText?: () => boolean,
): SidebarInteraction {
  const [open, setOpen] = createSignal(true);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  let lastDirectory: string | undefined;
  let lastRootID: string | undefined;
  return {
    navigate,
    hasSelectedText,
    isOpen: open,
    toggleOpen: () => setOpen((value: boolean) => !value),
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

export function getSidebarActivityIndicator(now = Date.now()): string {
  const frame = Math.floor(now / ACTIVITY_FRAME_MS) % ACTIVITY_FRAMES.length;
  return ACTIVITY_FRAMES[frame];
}

interface AgentRowTheme {
  accent: unknown;
  text: unknown;
  textMuted: unknown;
  agentColors?: readonly unknown[];
  primary?: unknown;
  secondary?: unknown;
  info?: unknown;
  background?: unknown;
  backgroundElement?: unknown;
  success?: unknown;
  warning?: unknown;
  hover?: unknown;
}

const STATUS_ACTIVE_COLOR = '#22c55e';
const STATUS_RETRY_COLOR = '#f59e0b';

function agentColor(agentName: string, theme: AgentRowTheme): unknown {
  const categorical = theme.agentColors?.filter((color) => color !== undefined);
  const palette = categorical?.length
    ? categorical
    : [theme.primary, theme.secondary, theme.accent, theme.info].filter(
        (color) => color !== undefined,
      );
  if (palette.length === 0) return theme.textMuted;

  let hash = 0;
  for (let index = 0; index < agentName.length; index += 1) {
    hash = (hash * 31 + agentName.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length];
}

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
    /** Skip hover painting (e.g. static headers) while keeping activation. */
    paintHover?: boolean;
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

  if (opts.paintHover !== false) {
    setProp(node as never, 'onMouseOver', () => {
      applyHover(true);
    });
    setProp(
      node as never,
      'onMouseOut',
      (event?: { x?: number; y?: number }) => {
        if (isPointerInsideRow(row, event)) return;
        applyHover(false);
      },
    );
  }
  if (opts.onActivate) {
    setProp(node as never, 'onMouseUp', (event?: { button?: number }) => {
      if (!shouldActivateRow(event, opts.hasSelectedText)) return;
      opts.onActivate?.();
    });
  }
  return node;
}

export const STATUS_DOT_GLYPH = '•';
export const STATUS_STOPPED_GLYPH = '⚰';

function statusDot(
  active: boolean,
  hasHistory: boolean,
  now: () => number,
  theme: AgentRowTheme,
): JSX.Element {
  return text(
    {
      fg: active
        ? (theme.success ?? STATUS_ACTIVE_COLOR)
        : hasHistory
          ? '#60a5fa'
          : theme.textMuted,
      width: 2,
    },
    active
      ? [() => `${getSidebarActivityIndicator(now())} `]
      : [hasHistory ? '✦ ' : `${STATUS_DOT_GLYPH} `],
  );
}

interface AgentRowOptions {
  label: string;
  agentName: string;
  model: string;
  modelName?: string;
  variant?: string;
  active: boolean;
  now: () => number;
  theme: AgentRowTheme;
  sessionCount?: number;
  expanded: boolean;
  annotation?: string;
  onClick?: () => void;
  hoverBackground?: unknown;
  hasSelectedText?: () => boolean;
  hasHistory: boolean;
}

function agentHeaderCells({
  agentName,
  label,
  active,
  now,
  theme,
  sessionCount,
  expanded,
  annotation,
  hasHistory,
}: AgentRowOptions): JSX.Element[] {
  const color = agentColor(agentName, theme);
  return [
    statusDot(active, hasHistory, now, theme),
    text(
      {
        fg: color,
        wrapMode: 'none',
        truncate: true,
        flexShrink: 1,
      },
      [label],
    ),
    ...(annotation !== undefined
      ? [
          text(
            {
              fg: theme.textMuted,
              flexShrink: 1,
              wrapMode: 'none',
              truncate: true,
            },
            [` ${annotation}`],
          ),
        ]
      : []),
    ...(sessionCount !== undefined && sessionCount > 1
      ? [
          text({ fg: theme.textMuted, wrapMode: 'none', flexShrink: 0 }, [
            ` ${expanded ? '▾' : '▸'}${sessionCount}`,
          ]),
        ]
      : []),
  ];
}

function agentRow(options: AgentRowOptions): JSX.Element {
  const {
    model,
    modelName,
    variant,
    theme,
    onClick,
    hoverBackground,
    hasSelectedText,
  } = options;
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
  if (modelName && modelName !== modelParts.model) {
    detailRows.push(detailRow('name', modelName));
  }
  if (variant) {
    detailRows.push(detailRow('variant', variant));
  }

  const header = box(
    {
      width: '100%',
      flexDirection: 'row',
      shouldFill: true,
    },
    agentHeaderCells(options),
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

function compactAgentRow(options: AgentRowOptions): JSX.Element {
  const { model, modelName, theme, onClick, hoverBackground, hasSelectedText } =
    options;
  const displayedModel = modelName ?? splitSidebarModelId(model).model;
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
          width: options.annotation !== undefined ? 24 : 16,
          flexShrink: 0,
          flexDirection: 'row',
          shouldFill: false,
        },
        [...agentHeaderCells(options), box({ flexGrow: 1, shouldFill: false })],
      ),
      box({ flexDirection: 'row', flexGrow: 1, shouldFill: false }),
      text(
        {
          fg: agentColor(options.agentName, theme),
          wrapMode: 'none',
          truncate: true,
          flexShrink: 1,
          marginLeft: 1,
        },
        [displayedModel],
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
 * One expanded subagent destination: a fixed-width status indicator and alias.
 * Hover mutates this box in place so the click target survives ticks.
 */
function sessionTargetRow(
  target: SidebarSessionTarget,
  theme: AgentRowTheme,
  now: () => number,
  onActivate: () => void,
  hoverBackground: unknown,
  hasSelectedText?: () => boolean,
): JSX.Element {
  const label = target.alias ?? shortSessionID(target.sessionID);
  const annotation = sidebarSiblingAnnotation(target);
  const reusable = target.status === 'reusable';
  const stopped = target.status === 'stopped';
  const indicatorColor =
    reusable || stopped
      ? theme.textMuted
      : target.status === 'retry'
        ? (theme.warning ?? STATUS_RETRY_COLOR)
        : (theme.success ?? STATUS_ACTIVE_COLOR);
  const row = box(
    {
      width: '100%',
      flexDirection: 'row',
      paddingLeft: 2,
      shouldFill: true,
    },
    [
      text(
        {
          fg: indicatorColor,
          width: 2,
          flexShrink: 0,
          wrapMode: 'none',
        },
        [
          reusable
            ? `${STATUS_DOT_GLYPH} `
            : stopped
              ? `${STATUS_STOPPED_GLYPH} `
              : () => `${getSidebarActivityIndicator(now())} `,
        ],
      ),
      text(
        {
          fg: theme.textMuted,
          flexShrink: 0,
          wrapMode: 'none',
        },
        [label],
      ),
      ...(annotation !== undefined
        ? [
            text(
              {
                fg: theme.textMuted,
                flexShrink: 1,
                wrapMode: 'none',
                truncate: true,
              },
              [` ${annotation}`],
            ),
          ]
        : []),
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

function projectSidebarSessionModels(
  snapshot: TuiSnapshot,
  visibleSessionID?: string,
): TuiSnapshot {
  if (!snapshot.sessionModels) return snapshot;
  const agentModels = { ...snapshot.agentModels };
  const agentVariants = { ...snapshot.agentVariants };
  const root =
    visibleSessionID && resolveTuiSnapshotRoot(snapshot, visibleSessionID);
  for (const [sessionID, agents] of Object.entries(snapshot.sessionModels)) {
    if (!root || resolveTuiSnapshotRoot(snapshot, sessionID) !== root) continue;
    if (
      sessionID !== root &&
      !Object.hasOwn(snapshot.activeSessions, sessionID)
    )
      continue;
    for (const [agent, observation] of Object.entries(agents)) {
      agentModels[agent] = observation.model;
      if (observation.variant === undefined) delete agentVariants[agent];
      else agentVariants[agent] = observation.variant;
    }
  }
  return { ...snapshot, agentModels, agentVariants, sessionModels: undefined };
}

/** Window-local projection; never writes the directory-wide snapshot. */
export function projectSidebarTeam(
  snapshot: TuiSnapshot,
  state?: SessionPresetState,
): TuiSnapshot {
  // Older backends omit team; retain their existing sidebar behavior.
  const team = state?.team;
  if (!team) return snapshot;
  const { canonicalName, projectValues } = createTeamDisplayIdentity(
    snapshot.agentDisplayNames,
  );
  const models = projectValues(team.agentModels);
  const variants = projectValues(team.agentVariants);
  const inherited = projectValues(team.inheritance);
  // Applying a team preset does not change the main agent's live model.
  const rootModel = projectValues(snapshot.agentModels).orchestrator;
  const rootVariant = projectValues(snapshot.agentVariants).orchestrator;
  if (rootVariant === undefined) delete variants.orchestrator;
  else variants.orchestrator = rootVariant;
  const names = new Set(
    [
      ...getSidebarAgentNames(snapshot),
      ...Object.keys(team.agentModels),
      ...Object.keys(team.inheritance),
    ].map(canonicalName),
  );
  if (rootModel === undefined) names.delete('orchestrator');
  return {
    ...snapshot,
    agentModels: Object.fromEntries(
      [...names].map((name) => [
        name,
        name === 'orchestrator'
          ? (rootModel ?? 'Unknown')
          : inherited[name]
            ? `Inherits ${inherited[name]}`
            : (models[name] ?? 'Unknown'),
      ]),
    ),
    agentVariants: variants,
    activeSessions: Object.fromEntries(
      Object.entries(snapshot.activeSessions).map(([sessionID, name]) => [
        sessionID,
        canonicalName(name),
      ]),
    ),
    reusableByAgent: Object.fromEntries(
      Object.entries(snapshot.reusableByAgent).map(([parentID, byAgent]) => {
        const canonical = new Map<string, (typeof byAgent)[string]>();
        for (const [name, entries] of Object.entries(byAgent)) {
          const key = canonicalName(name);
          canonical.set(key, [...(canonical.get(key) ?? []), ...entries]);
        }
        return [
          parentID,
          Object.fromEntries(
            [...canonical].map(([name, entries]) => [
              name,
              // Activity readers expect running entries before history.
              entries.sort(
                (a, b) =>
                  Number(b.running === true) - Number(a.running === true),
              ),
            ]),
          ),
        ];
      }),
    ),
  };
}

export function renderSidebar(
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
    agentColors?: readonly unknown[];
    primary?: unknown;
    secondary?: unknown;
    info?: unknown;
  },
  configInvalid: boolean,
  compactSidebar: boolean,
  now: () => number = Date.now,
  visibleRootID?: string,
  interaction?: SidebarInteraction,
  presetRow?: SidebarPresetRow,
  modelNames?: ReadonlyMap<string, string>,
): JSX.Element {
  const configStatusRow = buildConfigStatusRow(configInvalid, theme);
  const presetHoverBackground = resolveHoverBackground({
    background: theme.background,
    text: theme.text,
    hover: theme.hover,
  });
  const presetRowEl = presetRow
    ? buildPresetRow(
        presetRow,
        theme,
        presetHoverBackground,
        interaction?.hasSelectedText,
      )
    : null;
  const activeAgents = getActiveSidebarAgentNames(snapshot, visibleRootID);
  const targetsByAgent = new Map(
    getSidebarAgentTargets(snapshot, visibleRootID).map((group) => [
      group.agentName,
      group.sessions,
    ]),
  );
  // History marker (#1197 follow-up): only rendered when clickable — a
  // marker without navigation would be dead pixels (no navigate, no marker).
  const navigate = interaction?.navigate;
  const reusableByAgent =
    navigate === undefined
      ? new Map<string, SidebarReusableTarget[]>()
      : getSidebarReusableTargets(snapshot, visibleRootID);
  const expandedAgents = interaction?.expandedAgents() ?? new Set<string>();
  const sidebarOpen = interaction?.isOpen() ?? true;
  // Sidebar rows sit on backgroundElement; using that same surface for hover
  // produces no visible change. Resolve from the page colors, as for presets.
  const hoverBackground = resolveHoverBackground({
    background: theme.background,
    text: theme.text,
    hover: theme.hover,
  });
  const header = box(
    {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    [
      box({ flexDirection: 'row', alignItems: 'center' }, [
        text({ fg: theme.text, width: 2 }, [sidebarOpen ? '▼ ' : '▶ ']),
        box({ paddingRight: 1, backgroundColor: theme.accent }, [
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
        ]),
      ]),
      text({ fg: theme.textMuted }, [`v${version}`]),
    ],
  );
  decorateInteractiveRow(header, {
    hoverBackground,
    onActivate: interaction?.toggleOpen,
    hasSelectedText: interaction?.hasSelectedText,
    paintHover: false,
  });
  return box(
    {
      width: '100%',
      flexDirection: 'column',
      border: BORDER,
      borderColor: theme.borderActive,
      paddingTop: 1,
      paddingBottom: 1,
      paddingRight: 1,
    },
    [
      header,
      ...(sidebarOpen ? [configStatusRow, presetRowEl] : []),
      ...(sidebarOpen
        ? getSidebarAgentNames(snapshot).flatMap((agentName) => {
            const model = snapshot.agentModels[agentName] ?? 'pending';
            const variant = snapshot.agentVariants[agentName];
            const active = activeAgents.has(agentName);
            const sessions = targetsByAgent.get(agentName) ?? [];
            const reusable = reusableByAgent.get(agentName) ?? [];
            const seenSessionIDs = new Set(
              sessions.map((target) => target.sessionID),
            );
            const reusableTargets = reusable
              .filter((target) => !seenSessionIDs.has(target.taskID))
              .map(
                (target): SidebarSessionTarget => ({
                  sessionID: target.taskID,
                  agentName,
                  alias: target.alias,
                  status:
                    target.running === true
                      ? 'busy'
                      : target.stopped === true
                        ? 'stopped'
                        : 'reusable',
                }),
              );
            const mergedTargets = [...sessions, ...reusableTargets];
            const history = reusableTargets.some(
              (target) =>
                target.status === 'reusable' || target.status === 'stopped',
            );
            const clickable =
              interaction?.navigate !== undefined && mergedTargets.length > 0;
            const expanded =
              mergedTargets.length > 1 &&
              clickable &&
              expandedAgents.has(agentName);
            // Only annotate when the rows are actually rendered: a collapsed
            // agent row never reaches sessionTargetRow, so computing the
            // sibling/via annotation there is wasted work on every tick.
            const allTargets = expanded
              ? annotateSiblingAttribution(snapshot, mergedTargets)
              : mergedTargets;
            const onAgentClick = clickable
              ? () => {
                  if (allTargets.length === 1) {
                    interaction?.navigate?.(allTargets[0].sessionID);
                  } else if (allTargets.length > 1) {
                    interaction?.toggleAgent(agentName);
                  }
                }
              : undefined;
            const singleAnnotation =
              !expanded && mergedTargets.length === 1 && sessions.length === 1
                ? sidebarSiblingAnnotation(sessions[0])
                : undefined;
            const rowOptions: AgentRowOptions = {
              // Label only: every lookup below stays keyed by the canonical
              // agent ID so models, activity, expansion and history keep
              // resolving.
              label: snapshot.agentDisplayNames?.[agentName] || agentName,
              agentName,
              model,
              modelName: modelNames?.get(model),
              variant,
              active,
              now,
              theme,
              sessionCount: clickable ? allTargets.length : undefined,
              expanded,
              onClick: onAgentClick,
              hoverBackground,
              hasSelectedText: interaction?.hasSelectedText,
              hasHistory: !active && history,
            };
            rowOptions.annotation = singleAnnotation;
            const agentRowEl = compactSidebar
              ? compactAgentRow(rowOptions)
              : agentRow(rowOptions);
            if (!expanded) return [agentRowEl];
            return [
              agentRowEl,
              ...allTargets.map((target) =>
                sessionTargetRow(
                  target,
                  theme,
                  now,
                  () => interaction?.navigate?.(target.sessionID),
                  hoverBackground,
                  interaction?.hasSelectedText,
                ),
              ),
            ];
          })
        : []),
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

function resolveMultiplexerType(value: unknown): MultiplexerType {
  const parsed = MultiplexerConfigSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data.type : 'none';
}

/**
 * Active-preset row. With `onActivate` it behaves like the agent rows
 * (same hover/click decoration); without one it is a muted, informational
 * line — capability detection happens in the v2 setup, never here.
 */
export function buildPresetRow(
  presetRow: SidebarPresetRow,
  theme: { text: unknown; textMuted: unknown },
  hoverBackground: unknown,
  hasSelectedText?: () => boolean,
): JSX.Element {
  const clickable = presetRow.onActivate !== undefined;
  const row = box(
    {
      width: '100%',
      flexDirection: 'row',
      marginTop: 1,
      columnGap: 1,
      ...(clickable ? { shouldFill: true } : {}),
    },
    [
      text(
        {
          fg: theme.textMuted,
          width: presetRow.sessionLabel === undefined ? 6 : 7,
        },
        [presetRow.sessionLabel === undefined ? 'Preset' : 'Default'],
      ),
      text(
        {
          fg: clickable ? theme.text : theme.textMuted,
          wrapMode: 'none',
          truncate: true,
          flexShrink: 1,
        },
        [presetRow.name],
      ),
      ...(clickable
        ? [text({ fg: theme.textMuted, flexShrink: 0 }, ['▸'])]
        : []),
    ],
  );
  const content =
    presetRow.sessionLabel === undefined
      ? row
      : box({ width: '100%', flexDirection: 'column' }, [
          row,
          text({ fg: theme.textMuted, wrapMode: 'none', truncate: true }, [
            `Session team snapshot: ${presetRow.sessionLabel}`,
          ]),
        ]);
  if (!clickable) return content;
  return decorateInteractiveRow(content, {
    // Sidebar rows sit on backgroundElement, so using that color as the
    // hover fill leaves this row visually unchanged. Use the normal hover
    // color when the host provides one, otherwise derive a visible fill from
    // the page background and text colors.
    hoverBackground,
    onActivate: presetRow.onActivate,
    hasSelectedText,
  });
}

/**
 * Ambient "a newer release exists" badge for the v2 `sidebar.footer` slot
 * (see `./v2/update-notice`). The toast is transient; this line is the trace
 * that survives being missed, so it stays muted, single-row and unselectable
 * — it must never wrap, grow the sidebar, or compete with the agent rows.
 */
export function renderUpdateBadge(latest: string, color: unknown): JSX.Element {
  return box({ flexDirection: 'row', flexShrink: 0 }, [
    text({ fg: color, wrapMode: 'none', selectable: false }, [
      `OMO ↑${latest}`,
    ]),
  ]);
}

export interface SidebarConfigState {
  configInvalid: boolean;
  compactSidebar: boolean;
  multiplexerType: MultiplexerType;
  /** Active preset name (`config.preset`), undefined when unset. */
  presetName?: string;
}

/**
 * Every config-derived gate the TUI entry points need, derived from ONE
 * shared `readPluginConfigSnapshot` read. Replaces the per-concern reads
 * (`isTuiEnabled`, `isSidebarEnabled`, `disabledCommandsFor`,
 * `readConfigState`) that each parsed the whole config layer stack
 * independently.
 */
export interface TuiGatesSnapshot extends SidebarConfigState {
  tuiEnabled: boolean;
  sidebarEnabled: boolean;
  disabledCommands: ReadonlySet<string>;
  disabledHooks: ReadonlySet<string>;
}

/**
 * Gates paired with the identity of the shared snapshot they were derived
 * from. The snapshot fingerprint is the poll-time identity: unchanged ⇒ the
 * same inputs produced the gates, so a tick re-reads cheaply
 * (discovery + stats only) and reuses the derived gates. `readFailed` marks
 * a thrown read (fail-open gates); such an outcome is never adopted as the
 * new baseline.
 */
export interface TuiGatesRead {
  gates: TuiGatesSnapshot;
  /** Snapshot identity; empty for a failed/unseeded read. */
  fingerprint: string;
  /** Pane-wiring admission config from the same snapshot. */
  paneConfig: LoadedPaneConfig | undefined;
  /** True only when the shared read threw (fail-open gates were returned). */
  readFailed: boolean;
}

/**
 * Fail-open defaults for a config read that throws: the TUI and sidebar
 * survive, and the remaining fields read as though the config layer stack
 * parsed without any effective value (matching the per-concern reads this
 * replaces).
 */
function failOpenTuiGates(): TuiGatesSnapshot {
  return {
    tuiEnabled: true,
    sidebarEnabled: true,
    configInvalid: false,
    compactSidebar: true,
    multiplexerType: 'none',
    presetName: undefined,
    disabledCommands: new Set(),
    disabledHooks: new Set(),
  };
}

/**
 * Only genuinely broken configs (parse/load/schema failures) mark the
 * sidebar invalid. Benign missing-preset notices do not, otherwise a config
 * that loads fine would be shown as "Config invalid".
 */
function warningsMakeConfigInvalid(
  warnings: readonly { kind: string }[],
): boolean {
  return warnings.some(
    (warning) =>
      warning.kind === 'invalid-json' ||
      warning.kind === 'invalid-schema' ||
      warning.kind === 'read-error',
  );
}

/** Derive every gate from one snapshot. Pure; no file access. */
function deriveTuiGates(snapshot: PluginConfigSnapshot): TuiGatesSnapshot {
  const config = snapshot.config;
  return {
    tuiEnabled: config.tui !== false,
    sidebarEnabled: config.sidebar !== false,
    configInvalid: warningsMakeConfigInvalid(snapshot.warnings),
    compactSidebar: config.compactSidebar ?? true,
    multiplexerType: resolveMultiplexerType(config.multiplexer),
    ...(typeof config.preset === 'string' && config.preset.length > 0
      ? { presetName: config.preset }
      : {}),
    disabledCommands: new Set(config.disabled_commands ?? []),
    disabledHooks: new Set(config.disabled_hooks ?? []),
  };
}

/** Pane-wiring admission config derived from the same snapshot. */
function paneConfigFromSnapshot(
  snapshot: PluginConfigSnapshot,
): LoadedPaneConfig {
  return paneConfigOf(
    snapshot.config,
    warningsMakeConfigInvalid(snapshot.warnings),
  );
}

/**
 * Gates plus pane-wiring admission, derived from one shared snapshot read.
 * Fail-open on a thrown read: the TUI and sidebar survive, command gating
 * fails open, and the result is not adopted as the poll baseline.
 */
export function readTuiGates(
  directory: string,
  hostFlavor?: string,
  fresh = false,
): TuiGatesRead {
  try {
    const snapshot = readPluginConfigSnapshot(directory, { hostFlavor, fresh });
    return {
      gates: deriveTuiGates(snapshot),
      fingerprint: snapshot.fingerprint,
      paneConfig: paneConfigFromSnapshot(snapshot),
      readFailed: false,
    };
  } catch (err) {
    log('[tui] tui config read failed; keeping TUI and sidebar', String(err));
    return {
      gates: failOpenTuiGates(),
      fingerprint: '',
      paneConfig: undefined,
      readFailed: true,
    };
  }
}

/**
 * Load the TUI gates through the shared cached read. The snapshot module
 * dedupes unchanged reads (discovery + stats only), so repeated calls cost
 * one cheap identity revalidation instead of a full layer-stack parse.
 * Fail-open on a thrown read.
 */
export function loadTuiGates(
  directory: string,
  hostFlavor?: string,
): TuiGatesSnapshot {
  return readTuiGates(directory, hostFlavor).gates;
}

/** Project the gates onto the sidebar runtime's config-state view. */
function configStateOfGates(gates: TuiGatesSnapshot): SidebarConfigState {
  return {
    configInvalid: gates.configInvalid,
    compactSidebar: gates.compactSidebar,
    multiplexerType: gates.multiplexerType,
    presetName: gates.presetName,
  };
}

export function readConfigState(
  directory: string,
  hostFlavor?: string,
): SidebarConfigState {
  return configStateOfGates(loadTuiGates(directory, hostFlavor));
}

/**
 * Surface a broken config without replacing config-backed rows with the
 * loader's fallback defaults. Once the file is valid again, the fresh state
 * atomically replaces the retained values.
 */
export function retainLastGoodConfigState(
  current: SidebarConfigState,
  next: SidebarConfigState,
): SidebarConfigState {
  return next.configInvalid
    ? { ...current, configInvalid: true }
    : { ...next, configInvalid: false };
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
  categorical?: readonly Record<
    100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
    unknown
  >[];
  hue?: {
    interactive: Record<
      100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900,
      unknown
    >;
  };
  text: {
    base?: unknown;
    muted?: unknown;
    default?: unknown;
    subdued?: unknown;
    feedback?: {
      success?: { base: unknown };
      warning?: { base: unknown };
    };
  };
  background: { base?: unknown; default?: unknown; raised?: { base: unknown } };
  border: { base?: unknown; default?: unknown };
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

interface V2TuiContext extends V2PresetManagerContext {
  location?: { directory: string };
  client?: unknown;
  data?: V2PresetManagerContext['data'] & {
    on?: (type: string, handler: (event: unknown) => void) => unknown;
    session?: {
      get?: (
        sessionID: string,
      ) => { parentID?: unknown; agent?: unknown } | undefined;
    };
  };
  renderer: { requestRender: () => void; getSelection?: () => unknown };
  theme: V2TuiThemeTokens;
  ui: V2PresetUiSurface & {
    slot: (claim: V2TuiSlotClaim) => () => void;
    router: {
      current: () => { type?: string; sessionID?: string };
      /** Optional navigation capability; absent on hosts that don't expose it. */
      navigate?: (route: { type: string; sessionID: string }) => void;
    };
    model?: {
      /** The prompt's selected model; variant undefined = model default. */
      current?: () =>
        | { providerID: string; modelID: string; variant?: string }
        | undefined;
    };
  };
}

/** Map v2 theme tokens onto the flat shape `renderSidebar` consumes (v2 has no `accent` token). */
function v2ThemeView(theme: V2TuiThemeTokens): {
  accent: unknown;
  background: unknown;
  backgroundElement: unknown;
  borderActive: unknown;
  text: unknown;
  textMuted: unknown;
  success?: unknown;
  warning?: unknown;
  agentColors: readonly unknown[];
} {
  return {
    accent: theme.hue?.interactive[200],
    background: theme.background.base ?? theme.background.default,
    backgroundElement:
      theme.background.raised?.base ??
      theme.background.base ??
      theme.background.default,
    borderActive: theme.border.base ?? theme.border.default,
    text: theme.text.base ?? theme.text.default,
    textMuted: theme.text.muted ?? theme.text.subdued,
    success: theme.text.feedback?.success?.base ?? theme.success,
    warning: theme.text.feedback?.warning?.base ?? theme.warning,
    agentColors: theme.categorical?.map((scale) => scale[500]) ?? [],
  };
}

interface SidebarRuntimeAdapter {
  hostFlavor?: string;
  version: string;
  getDirectory: () => string;
  getVisibleSession: () => string | undefined;
  client?: unknown;
  renderer: { requestRender: () => void; getSelection?: () => unknown };
  theme: () => Parameters<typeof renderSidebar>[2];
  navigate?: (sessionID: string) => void;
  registerSlot: (render: () => JSX.Element) => undefined | (() => void);
  subscribeConfigChanges?: (
    directory: string,
    listener: () => { ok: boolean; reason?: string } | undefined,
  ) => () => void;
  getPresetRow?: (
    directory: string,
    presetName?: string,
    sessionLabel?: string,
  ) => SidebarPresetRow | undefined;
  readSessionPreset?: (
    directory: string,
    sessionID: string,
  ) => Promise<SessionPresetState>;
  /** Reports the effective `multiplexer.type` (and the admission config from
   * the same read) so the caller can keep the pane wiring in sync. */
  onMultiplexerConfig?: (
    type: MultiplexerType,
    paneConfig?: LoadedPaneConfig,
  ) => void;
  /** v2 hosts only: the prompt's live selected model while the visible
   * route is a root orchestrator session. Overlays the sidebar's
   * orchestrator row so the picker's choice shows before the first turn
   * on the new model commits it to tui-state. */
  getSelectedRootModel?: () =>
    | { model: string; variant?: string | undefined }
    | undefined;
}

/** Shape `readTuiSnapshot` returns for an empty/missing state file. */
const EMPTY_TUI_SNAPSHOT: TuiSnapshot = {
  version: 1,
  updatedAt: 0,
  agentModels: {},
  agentVariants: {},
  agentDisplayNames: {},
  activeSessions: {},
  activityPids: {},
  sessionParents: {},
  sessionDetails: {},
  reusableByAgent: {},
  reusableOwners: {},
};

/**
 * Resolve the live picker selection that may overlay the orchestrator row.
 *
 * Gate 1 — route: only a session route yields a sessionID; the home
 * screen's selection belongs to a session that does not exist yet.
 * Gate 2 — session shape: child sessions (parentID) own their own agent
 * rows, and a root session under another primary agent is not the
 * plugin's orchestrator row.
 * Gate 3 — selection shape: the host's picker payload must carry usable
 * providerID/modelID strings.
 */
export function resolveSelectedRootModel(input: {
  route: { type?: string; sessionID?: string } | undefined;
  sessionInfo?: { parentID?: unknown; agent?: unknown } | undefined;
  selected?:
    | { providerID?: unknown; modelID?: unknown; variant?: unknown }
    | undefined;
}): { model: string; variant?: string | undefined } | undefined {
  const sessionID = input.route
    ? resolveRouteSessionId(input.route)
    : undefined;
  if (!sessionID) return undefined;
  const info = input.sessionInfo;
  if (!info || info.parentID) return undefined;
  if (typeof info.agent === 'string' && info.agent !== 'orchestrator') {
    return undefined;
  }
  const selected = input.selected;
  if (
    !selected ||
    typeof selected.providerID !== 'string' ||
    !selected.providerID ||
    typeof selected.modelID !== 'string' ||
    !selected.modelID
  ) {
    return undefined;
  }
  return {
    model: `${selected.providerID}/${selected.modelID}`,
    ...(typeof selected.variant === 'string' && selected.variant
      ? { variant: selected.variant }
      : {}),
  };
}

/**
 * Overlay the host picker's live selected model onto the orchestrator row.
 *
 * v2 defers `session.switchModel` until the next prompt commits it, so the
 * server-side projection (tui-state) lags one turn behind the picker. This
 * TUI-side overlay closes that window for root orchestrator sessions — the
 * one row whose model the user just changed with their own hands. Returns
 * the input snapshot (reference-equal) when there is nothing to change, so
 * unchanged overlays never trip the snapshot change check.
 */
export function overlaySelectedRootModel(
  snapshot: TuiSnapshot,
  selected: { model: string; variant?: string | undefined } | undefined,
): TuiSnapshot {
  if (!selected?.model) return snapshot;
  if (snapshot.agentModels.orchestrator === undefined) return snapshot;
  if (
    snapshot.agentModels.orchestrator === selected.model &&
    snapshot.agentVariants.orchestrator === (selected.variant ?? undefined)
  ) {
    return snapshot;
  }
  const agentVariants = { ...snapshot.agentVariants };
  if (typeof selected.variant === 'string' && selected.variant) {
    agentVariants.orchestrator = selected.variant;
  } else {
    delete agentVariants.orchestrator;
  }
  return {
    ...snapshot,
    agentModels: { ...snapshot.agentModels, orchestrator: selected.model },
    agentVariants,
  };
}

/** One refresh/animation/interaction lifecycle for both host slot contracts. */
function createSidebarRuntime(
  adapter: SidebarRuntimeAdapter,
  initial?: TuiGatesRead,
) {
  let configDirectory = adapter.getDirectory();
  let gatesRead = initial ?? readTuiGates(configDirectory, adapter.hostFlavor);
  const sidebarEnabled = gatesRead.gates.sidebarEnabled;
  let { configInvalid, compactSidebar, multiplexerType, presetName } =
    configStateOfGates(gatesRead.gates);
  adapter.onMultiplexerConfig?.(multiplexerType, gatesRead.paneConfig);
  const applyConfigState = (fresh = false): boolean => {
    const read = readTuiGates(configDirectory, adapter.hostFlavor, fresh);
    if (read.readFailed) return false;
    if (
      !fresh &&
      read.fingerprint === gatesRead.fingerprint &&
      read.gates.configInvalid === gatesRead.gates.configInvalid
    ) {
      return false;
    }
    gatesRead = read;
    const next = retainLastGoodConfigState(
      { configInvalid, compactSidebar, multiplexerType, presetName },
      configStateOfGates(read.gates),
    );
    const changed =
      next.configInvalid !== configInvalid ||
      next.compactSidebar !== compactSidebar ||
      next.multiplexerType !== multiplexerType ||
      next.presetName !== presetName;
    if (changed) {
      configInvalid = next.configInvalid;
      compactSidebar = next.compactSidebar;
      multiplexerType = next.multiplexerType;
      presetName = next.presetName;
      adapter.onMultiplexerConfig?.(multiplexerType, gatesRead.paneConfig);
    }
    return changed;
  };
  const [snapshot, setSnapshot] = createSignal(
    sidebarEnabled ? readTuiSnapshot(configDirectory) : EMPTY_TUI_SNAPSHOT,
  );
  const [animationNow, setAnimationNow] = createSignal(Date.now());
  const [sessionPreset, setSessionPreset] = createSignal<{
    directory: string;
    sessionID: string;
    label: string;
    state?: SessionPresetState;
  }>();
  let disposed = false;
  let unregisterConfigListener = () => {};
  const remoteCache: RemoteModelCache = {};
  const modelNamesCache: ModelNamesCache = { names: new Map() };
  const [modelNames, setModelNames] = createSignal<ReadonlyMap<string, string>>(
    modelNamesCache.names,
  );
  const refreshSidebar = async () => {
    if (disposed) return;
    if (!sidebarEnabled) return;
    const currentDirectory = adapter.getDirectory();
    const currentSession = adapter.getVisibleSession();
    let nextSnapshot = await readTuiSnapshotAsync(currentDirectory);
    if (disposed) return;
    const directoryChanged = currentDirectory !== configDirectory;
    let stateChanged = false;
    if (directoryChanged) {
      configDirectory = currentDirectory;
      gatesRead = readTuiGates(configDirectory, adapter.hostFlavor);
      ({ configInvalid, compactSidebar, multiplexerType, presetName } =
        configStateOfGates(gatesRead.gates));
      adapter.onMultiplexerConfig?.(multiplexerType, gatesRead.paneConfig);
      // Never carry one project's last-good config state into another.
      bindConfigListener();
      stateChanged = true;
    }
    // Revalidate config identity on every poll; unchanged files reuse the
    // shared parsed snapshot, while external edits still surface promptly.
    if (!directoryChanged) {
      try {
        stateChanged = applyConfigState();
      } catch (err) {
        log('[v2][tui] config state read failed', String(err));
      }
    }
    nextSnapshot = await hydrateRemoteModels(
      nextSnapshot,
      adapter.client,
      currentDirectory,
      remoteCache,
    );
    if (disposed) return;
    // Fold the live picker selection in BEFORE the change check so a new
    // selection triggers requestRender on this poll (server-side state only
    // learns the switch when the next prompt commits it).
    nextSnapshot = overlaySelectedRootModel(
      nextSnapshot,
      adapter.getSelectedRootModel?.(),
    );
    const namesBefore = modelNamesCache.names;
    await hydrateModelNames(adapter.client, currentDirectory, modelNamesCache);
    if (!isRefreshCurrent(currentDirectory, adapter.getDirectory())) {
      return;
    }
    if (modelNamesCache.names !== namesBefore) {
      setModelNames(modelNamesCache.names);
    }
    if (adapter.readSessionPreset && currentSession) {
      let label: string;
      let state: SessionPresetState | undefined;
      try {
        state = await adapter.readSessionPreset(
          currentDirectory,
          currentSession,
        );
        label = sessionPresetLabel(state);
      } catch {
        label = 'Unavailable';
      }
      if (
        disposed ||
        currentDirectory !== adapter.getDirectory() ||
        currentSession !== adapter.getVisibleSession()
      )
        return;
      const previous = sessionPreset();
      if (
        previous?.directory !== currentDirectory ||
        previous?.sessionID !== currentSession ||
        previous?.label !== label ||
        JSON.stringify(previous?.state) !== JSON.stringify(state)
      ) {
        setSessionPreset({
          directory: currentDirectory,
          sessionID: currentSession,
          label,
          state,
        });
        stateChanged = true;
      }
    }
    const snapshotChanged =
      directoryChanged || !snapshotSectionsEqual(nextSnapshot, snapshot());
    if (!snapshotChanged && !stateChanged) {
      return;
    }
    if (snapshotChanged) {
      setSnapshot(nextSnapshot);
    }
    if (!disposed) adapter.renderer.requestRender();
  };
  const interaction = createSidebarInteraction(
    adapter.navigate,
    selectionGuard(adapter.renderer),
  );
  const scheduleRefresh = createSerializedRefresh(refreshSidebar);
  const bindConfigListener = () => {
    unregisterConfigListener();
    if (!adapter.subscribeConfigChanges) return;
    unregisterConfigListener = adapter.subscribeConfigChanges(
      configDirectory,
      () => {
        let changed = false;
        try {
          changed = applyConfigState(true);
        } catch (err) {
          log('[v2][tui] config state read failed', String(err));
          return { ok: false, reason: String(err) };
        }
        if (changed && sidebarEnabled) {
          adapter.renderer.requestRender();
          scheduleRefresh();
        }
        return { ok: true };
      },
    );
  };
  // The config listener also carries `multiplexer.type` changes to the pane
  // wiring (onMultiplexerConfig), so it stays bound with the sidebar off.
  bindConfigListener();
  if (sidebarEnabled) scheduleRefresh();
  const rawRefreshMs = Number(process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS);
  // Test hook: shrink/override both poll intervals. Guarded so a bad value
  // cannot spin the timer (setInterval clamps non-positive delays to ~1ms).
  const envRefreshMs =
    Number.isFinite(rawRefreshMs) && rawRefreshMs >= 10
      ? rawRefreshMs
      : undefined;
  // Fast path (sidebar on): the poll drives sidebar rendering (snapshot +
  // config-backed rows) and stays at 1s. Slow path (sidebar off): the poll
  // only re-reads plugin config — still how external file edits to
  // `multiplexer.type` reach the pane wiring, so it stays alive but drops
  // to 5s.
  const pollConfigOnly = () => {
    try {
      applyConfigState();
    } catch (err) {
      log('[tui] config state read failed', String(err));
    }
  };
  const renderTimer = setInterval(
    sidebarEnabled ? scheduleRefresh : pollConfigOnly,
    sidebarEnabled ? (envRefreshMs ?? 1000) : (envRefreshMs ?? 5000),
  );
  const animationTimer = sidebarEnabled
    ? setInterval(() => {
        if (
          !disposed &&
          getActiveSidebarAgentNames(snapshot(), adapter.getVisibleSession())
            .size > 0
        ) {
          setAnimationNow(Date.now());
        }
      }, ACTIVITY_FRAME_MS)
    : undefined;

  const disposeSlot = sidebarEnabled
    ? adapter.registerSlot(() =>
        reactiveElement(() => {
          const visible = adapter.getVisibleSession();
          const currentSnapshot = snapshot();
          const projection = sessionPreset();
          const isCurrentProjection =
            projection?.directory === adapter.getDirectory() &&
            projection.sessionID === visible;
          const sessionLabel = !adapter.readSessionPreset
            ? undefined
            : visible === undefined
              ? 'No session displayed'
              : isCurrentProjection
                ? projection.label
                : 'Loading…';
          interaction.syncScope(
            configDirectory,
            visible === undefined
              ? undefined
              : resolveTuiSnapshotRoot(currentSnapshot, visible),
          );
          return renderSidebar(
            overlaySelectedRootModel(
              projectSidebarTeam(
                projectSidebarSessionModels(currentSnapshot, visible),
                isCurrentProjection ? projection.state : undefined,
              ),
              adapter.getSelectedRootModel?.(),
            ),
            adapter.version,
            adapter.theme(),
            configInvalid,
            compactSidebar,
            animationNow,
            visible,
            interaction,
            adapter.getPresetRow?.(configDirectory, presetName, sessionLabel),
            modelNames(),
          );
        }),
      )
    : undefined;

  return {
    getDirectory: () => configDirectory,
    getPaneConfig: () => gatesRead.paneConfig,
    getSnapshot: snapshot,
    setSnapshot,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unregisterConfigListener();
      disposeSlot?.();
      if (renderTimer !== undefined) clearInterval(renderTimer);
      if (animationTimer !== undefined) clearInterval(animationTimer);
    },
  };
}

/** V2 slot adapter; `/preset` remains registered by src/v2/tui.ts. */
async function setup(
  ctx: V2TuiContext,
  initial?: TuiGatesRead,
): Promise<undefined | (() => void)> {
  if (isPluginDisabledByEnv()) return;
  const gatesRead =
    initial ?? readTuiGates(ctx.location?.directory ?? process.cwd(), 'v2');
  if (!gatesRead.gates.tuiEnabled) {
    // `tui: false` master switch: register nothing. Reached only when this
    // internal setup is invoked directly; the composed v2 entry
    // (src/v2/tui.ts) checks the same switch before calling in.
    log('[tui] tui disabled by config (tui: false); registering nothing');
    return;
  }
  const presetManagerCtx = (directory: string): V2TuiContext => {
    const augmented = Object.create(ctx as object) as V2TuiContext;
    augmented.onConfigChanged = () =>
      notifyConfigChanged(directory, 'preset-manager');
    augmented.getSessionID = () =>
      resolveRouteSessionId(ctx.ui.router.current());
    return augmented;
  };
  // Tracks the runtime's effective `multiplexer.type` (onMultiplexerConfig).
  let multiplexerType: MultiplexerType = 'none';
  // Client-side pane lifecycle: the v2 host adapter classifies this process's
  // access mode (shared service / explicit server / standalone) and supplies
  // the lifecycle seams. Standalone and malformed modes cannot host panes —
  // their private server has no joinable address — so they get the
  // once-per-process diagnostic (pointing at the native-surface fallback)
  // instead of a wiring. The mode is constant per process, which keeps the
  // diagnostic well-defined across directory changes.
  const v2HostMode = detectV2HostMode(process.argv);
  let hostFailureDetail: { mode: string; reason?: string } | null =
    v2HostMode.mode === 'standalone' || v2HostMode.mode === 'invalid'
      ? describeV2HostMode(v2HostMode)
      : null;
  let paneWiring: TuiPaneWiring | null = null;
  let paneWiringSetting: string | null = null;
  let currentPaneConfig = gatesRead.paneConfig;
  // Set by the setup teardown. A config-triggered rebuild can be waiting on
  // the host or the reachability probe when the TUI closes; this flag makes
  // such a rebuild self-dispose instead of going live after teardown.
  let paneWiringClosed = false;
  const disposePaneWiring = async (): Promise<void> => {
    const stale = paneWiring;
    if (stale === null) return;
    paneWiring = null;
    paneWiringSetting = null;
    await stale.dispose().catch(() => {
      // Best-effort teardown; pane leftovers fall to the FR-8 sweep.
    });
  };
  const createPaneWiring = async (): Promise<void> => {
    try {
      const paneHost = await buildV2PaneWiringOptions({
        location: ctx.location,
        client: ctx.client,
        data: ctx.data,
        ui: ctx.ui,
        env: process.env,
        argv: process.argv,
      });
      if (paneHost.options !== null) {
        const wiring = await createTuiPaneWiring({
          ...paneHost.options,
          client: ctx.client,
          paneConfig: currentPaneConfig,
        });
        if (paneWiringClosed) {
          await wiring.dispose().catch(() => {
            // Best-effort teardown; pane leftovers fall to the FR-8 sweep.
          });
          return;
        }
        paneWiring = wiring;
        paneWiringSetting = multiplexerType;
      } else {
        hostFailureDetail = describeV2HostMode(paneHost.mode);
      }
    } catch (error) {
      log('[pane-lifecycle] v2 wiring failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  /**
   * v2 hosts hot-reload config, so the pane wiring must follow the effective
   * `multiplexer.type` (FR-9) for the whole process lifetime: disabling
   * disposes the wiring, enabling or switching adapters rebuilds it, and an
   * unchanged setting keeps it (its directory accessor follows the route).
   * Rebuilds are serialized; every run re-reads the latest state.
   */
  let paneWiringSync: Promise<void> = Promise.resolve();
  const reconcilePaneWiring = (): Promise<void> => {
    paneWiringSync = paneWiringSync
      .then(async () => {
        if (paneWiringClosed) return;
        if (hostFailureDetail !== null || multiplexerType === 'none') {
          await disposePaneWiring();
          return;
        }
        if (paneWiring !== null && paneWiringSetting === multiplexerType)
          return;
        await disposePaneWiring();
        await createPaneWiring();
      })
      .catch((error) => {
        log('[pane-lifecycle] v2 wiring reconcile failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return paneWiringSync;
  };
  const warnPaneUnsupported = () => {
    if (hostFailureDetail === null) return;
    warnV2HostUnsupportedMultiplexer(multiplexerType, hostFailureDetail);
  };
  const version = (await readPackageVersion()) ?? 'dev';
  const runtime = createSidebarRuntime(
    {
      version,
      hostFlavor: 'v2',
      getDirectory: () => ctx.location?.directory ?? process.cwd(),
      getVisibleSession: () => resolveRouteSessionId(ctx.ui.router.current()),
      getSelectedRootModel: () => {
        const route = ctx.ui.router.current();
        const sessionID = resolveRouteSessionId(route);
        return resolveSelectedRootModel({
          route,
          sessionInfo: sessionID
            ? ctx.data?.session?.get?.(sessionID)
            : undefined,
          selected: ctx.ui.model?.current?.(),
        });
      },
      client: ctx.client,
      renderer: ctx.renderer,
      theme: () => v2ThemeView(ctx.theme),
      navigate: makeRouteNavigator(ctx.ui.router, 'navigate', true),
      registerSlot: (render) =>
        ctx.ui.slot({ append: 'sidebar.content', render }),
      subscribeConfigChanges: (directory, listener) =>
        registerConfigChangeListener(directory, listener),
      onMultiplexerConfig: (type, paneConfig) => {
        multiplexerType = type;
        currentPaneConfig = paneConfig;
        warnPaneUnsupported();
        void reconcilePaneWiring();
      },
      readSessionPreset: (directory, sessionID) =>
        readSessionPreset(ctx, sessionID, directory),
      getPresetRow: (directory, presetName, sessionLabel) => {
        const name = presetName ?? '(none)';
        if (!canOpenPresetManagerV2(ctx)) return { name, sessionLabel };
        return {
          name,
          sessionLabel,
          onActivate: () => {
            const currentDirectory = ctx.location?.directory ?? directory;
            void openPresetManagerV2(
              presetManagerCtx(currentDirectory),
              currentDirectory,
            );
          },
        };
      },
    },
    gatesRead,
  );
  currentPaneConfig = runtime.getPaneConfig();
  // The runtime reports the initial setting synchronously; let the first
  // wiring settle before setup returns.
  await paneWiringSync;

  return () => {
    paneWiringClosed = true;
    runtime.dispose();
    // Release what is live now (the wiring's unsubscribe loop runs
    // synchronously), then settle any in-flight rebuild: it self-disposes
    // when it sees `paneWiringClosed`, so a wiring created during the
    // teardown window cannot outlive the TUI.
    void disposePaneWiring();
    void (async () => {
      await paneWiringSync;
      await disposePaneWiring();
    })();
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
    description: 'Switch agent presets at runtime',
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
  setup: (
    ctx: V2TuiContext,
    initial?: TuiGatesRead,
  ) => Promise<undefined | (() => void)>;
}

const plugin: TuiDualContractModule = {
  id: `${PLUGIN_NAME}:tui`,
  tui: async (api, _options, meta) => {
    if (isPluginDisabledByEnv()) return;
    const gatesRead = readTuiGates(getTuiDirectory(api));
    if (!gatesRead.gates.tuiEnabled) {
      // `tui: false` master switch: the TUI entry registers nothing — no
      // sidebar runtime, no commands, no pane wiring. Server-side features
      // are untouched.
      log('[tui] tui disabled by config (tui: false); registering nothing');
      return;
    }

    const runtime = createSidebarRuntime(
      {
        version: meta.version ?? (await readPackageVersion()) ?? 'dev',
        getDirectory: () => getTuiDirectory(api),
        getVisibleSession: () => resolveRouteSessionId(api.route.current),
        client: (api as { client?: unknown }).client,
        renderer: api.renderer,
        theme: () => api.theme.current,
        navigate: makeRouteNavigator(api.route, 'navigate', false),
        registerSlot: (render) => {
          api.slots.register({
            order: resolveSidebarSlotOrder(api.tuiConfig?.plugin, PLUGIN_NAME),
            slots: { sidebar_content: render },
          });
          return undefined;
        },
      },
      gatesRead,
    );
    api.lifecycle.onDispose(runtime.dispose);

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
          return runtime.getSnapshot();
        },
        set snapshot(value: TuiSnapshot) {
          runtime.setSnapshot(value);
        },
      };
      // Both commands follow `disabled_commands` exactly like every other
      // plugin command: a disabled command is not registered anywhere.
      const disabledCommands = gatesRead.gates.disabledCommands;
      const commands: TuiCommand[] = [];
      if (isCommandEnabled('preset', { disabledCommands })) {
        commands.push(
          buildPresetCommand(api, runtime.getDirectory, snapshotRef),
        );
      }
      if (isCommandEnabled('killall', { disabledCommands })) {
        commands.push(
          buildKillAllCommand(api, runtime.getDirectory, runtime.getSnapshot),
        );
      }
      const disposeCommands = api.command.register(() => commands);
      api.lifecycle.onDispose(disposeCommands);
    }

    // Client-side pane lifecycle (v1; the v2 `setup()` wires its own). The
    // wiring owns admission, config, log init, serverUrl reflection and the
    // event projection; disposal closes this client's panes best-effort.
    const paneWiring = await createTuiPaneWiring({
      ...paneWiringOptions(api),
      eventBus: api.event,
      client: (api as { client?: unknown }).client,
      env: process.env,
      paneConfig: gatesRead.paneConfig,
    });
    api.lifecycle.onDispose(() => paneWiring.dispose());
  },
  setup,
};

export default plugin;
