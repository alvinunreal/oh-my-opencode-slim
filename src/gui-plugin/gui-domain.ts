/**
 * Pure GUI domain helpers shared by the Desktop panel and its tests.
 *
 * Keep this module free of Solid, host SDK, filesystem and network imports: the
 * panel routes state through these functions, and bun:test drives the same
 * functions without a GUI host.
 */

export type SessionSelection = 'explicit' | 'default';

export interface SessionTeamLike {
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  inheritance: Record<string, 'session' | 'orchestrator'>;
}

export interface GuiSessionPresetState {
  sessionID: string;
  status: 'bound' | 'unbound';
  presetName: string | null;
  affects: 'future-children-only';
  selection: SessionSelection;
  team?: SessionTeamLike;
}

export type SessionBinding =
  | { kind: 'none' }
  | { kind: 'default-team'; presetName: string | null }
  | { kind: 'preset'; presetName: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Verify the session-preset response without assuming the host already emits
 * the optional `selection` field. A missing field is the legacy explicit
 * binding; bound responses may legitimately carry `presetName: null` for the
 * default team.
 */
export function verifySessionState(
  value: unknown,
  sessionID: string,
): GuiSessionPresetState {
  if (!isRecord(value)) {
    throw new Error('The session team response was empty.');
  }
  if (value.sessionID !== sessionID) {
    throw new Error('The session team response did not match this session.');
  }
  if (value.affects !== 'future-children-only') {
    throw new Error('The session team response had an unexpected scope.');
  }
  if (value.status !== 'bound' && value.status !== 'unbound') {
    throw new Error('The session team response had an unknown status.');
  }
  const selection = value.selection;
  if (
    selection !== undefined &&
    selection !== 'explicit' &&
    selection !== 'default'
  ) {
    throw new Error('The session team response had an unknown selection.');
  }
  if (value.status === 'bound') {
    if (
      value.presetName !== null &&
      (typeof value.presetName !== 'string' || value.presetName.length === 0)
    ) {
      throw new Error('The session team response is missing its preset.');
    }
  } else if (value.presetName !== null) {
    throw new Error('The session team response is inconsistent.');
  }
  const team = value.team;
  if (team !== undefined && !isRecord(team)) {
    throw new Error('The session team response had an invalid team.');
  }
  return {
    sessionID,
    status: value.status,
    presetName: value.presetName as string | null,
    affects: 'future-children-only',
    selection: selection === 'default' ? 'default' : 'explicit',
    ...(team === undefined ? {} : { team: team as unknown as SessionTeamLike }),
  };
}

export function sessionBinding(state: GuiSessionPresetState): SessionBinding {
  if (state.status === 'unbound') return { kind: 'none' };
  if (state.selection === 'default' || state.presetName === null) {
    return { kind: 'default-team', presetName: state.presetName };
  }
  return { kind: 'preset', presetName: state.presetName };
}

/** A toggle is on only for an explicit binding to the selected preset. */
export function isExplicitBindingFor(
  state: GuiSessionPresetState | undefined,
  presetName: string,
): boolean {
  if (state?.status !== 'bound') return false;
  return (
    state.selection === 'explicit' &&
    typeof state.presetName === 'string' &&
    state.presetName === presetName
  );
}

/** Apply must answer with an explicit binding to the requested preset. */
export function verifyAppliedState(
  value: unknown,
  sessionID: string,
  presetName: string,
): GuiSessionPresetState {
  const state = verifySessionState(value, sessionID);
  if (
    state.status !== 'bound' ||
    state.selection !== 'explicit' ||
    state.presetName !== presetName
  ) {
    throw new Error('OMOS did not bind the session team to that preset.');
  }
  return state;
}

/**
 * An unbind may now answer either a genuine unbound state or the bound default
 * team (selection "default", with or without a default preset name). No record
 * deletion is part of this contract.
 */
export function verifyResetState(
  value: unknown,
  sessionID: string,
): GuiSessionPresetState {
  const state = verifySessionState(value, sessionID);
  if (state.status === 'bound' && state.selection !== 'default') {
    throw new Error('OMOS did not reset the session team.');
  }
  return state;
}

export const compactJson = (raw: string) => {
  if (!raw) return '';
  try {
    const encoded = JSON.stringify(JSON.parse(raw));
    return encoded ?? raw;
  } catch {
    return raw;
  }
};

export interface ModelShapeLike {
  id: string;
  providerID: string;
  name?: string;
  variants?: { id: string }[];
}

export type ModelGroupKind = 'favorites' | 'recent' | 'provider';

export interface ModelGroup<T extends ModelShapeLike = ModelShapeLike> {
  kind: ModelGroupKind;
  provider: string;
  models: T[];
}

export const modelValue = (model: Pick<ModelShapeLike, 'id' | 'providerID'>) =>
  `${model.providerID}/${model.id}`;

export const splitModel = (value?: string) => {
  if (!value) return { provider: '', model: '' };
  const slash = value.indexOf('/');
  if (slash <= 0) return { provider: '', model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
};

/**
 * Group the model list exactly once per model: native favorites first, then
 * recents that are not favorites, then provider groups. Favorites/recents are
 * only folded in while the search box is empty. Unknown stored ids are ignored.
 */
export function groupModels<T extends ModelShapeLike>(
  models: readonly T[],
  options: {
    query?: string;
    favorites?: readonly string[];
    recent?: readonly string[];
  } = {},
): ModelGroup<T>[] {
  const query = options.query ?? '';
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (model: T) => {
    if (terms.length === 0) return true;
    const haystack =
      `${model.providerID} ${model.id} ${model.name ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const ordered: T[] = [];
  const byValue = new Map<string, T>();
  for (const model of models) {
    const value = modelValue(model);
    if (byValue.has(value) || !matches(model)) continue;
    byValue.set(value, model);
    ordered.push(model);
  }
  const pick = (values: readonly string[] = []) => {
    if (terms.length > 0) return [] as T[];
    const seen = new Set<string>();
    const result: T[] = [];
    for (const value of values) {
      if (seen.has(value)) continue;
      const model = byValue.get(value);
      if (!model) continue;
      seen.add(value);
      result.push(model);
    }
    return result;
  };
  const favorites = pick(options.favorites);
  const favoriteValues = new Set(favorites.map(modelValue));
  const recent = pick(options.recent).filter(
    (model) => !favoriteValues.has(modelValue(model)),
  );
  const recentValues = new Set(recent.map(modelValue));
  const groups = new Map<string, T[]>();
  for (const model of ordered) {
    const value = modelValue(model);
    if (favoriteValues.has(value) || recentValues.has(value)) continue;
    const list = groups.get(model.providerID) ?? [];
    list.push(model);
    groups.set(model.providerID, list);
  }
  return [
    ...(favorites.length > 0
      ? [
          {
            kind: 'favorites' as const,
            provider: 'favorites',
            models: favorites,
          },
        ]
      : []),
    ...(recent.length > 0
      ? [{ kind: 'recent' as const, provider: 'recent', models: recent }]
      : []),
    ...[...groups].map(([provider, grouped]) => ({
      kind: 'provider' as const,
      provider,
      models: grouped,
    })),
  ];
}

export type GoPlan = 'go' | 'goPlus' | 'goTeams';

export interface GoMonthlyLimitRowLike {
  modelID: string;
  go: string;
  goPlus: string;
  goTeams: string;
}

/** Published caps belong only to the opencode-go provider. */
export function goCapForModel(
  rows: readonly GoMonthlyLimitRowLike[] | undefined,
  plan: GoPlan,
  value: string | undefined,
): string {
  if (!value) return '';
  const parts = splitModel(value);
  if (parts.provider !== 'opencode-go') return '';
  return rows?.find((row) => row.modelID === parts.model)?.[plan] ?? '';
}

export interface DraftBaseline {
  model: string;
  variant: string;
  temperature?: number;
  optionsJson?: string;
}

export interface DraftFields {
  model: string;
  variant: string;
  temperature: string;
  options: string;
  modelReset?: boolean;
}

export type DraftField = 'model' | 'variant' | 'temperature' | 'options';

export interface DraftPatch {
  model?: string;
  variant?: string;
  temperature?: number;
  clearTemperature?: boolean;
  optionsJson?: string;
}

export interface DraftDiff {
  dirty: boolean;
  fields: DraftField[];
  patch: DraftPatch;
}

const baselineTemperature = (baseline: DraftBaseline) =>
  baseline.temperature !== undefined ? String(baseline.temperature) : '';

/**
 * Diff the user's fields against the immutable baseline captured when the
 * editor opened. The current snapshot is deliberately not an input: unrelated
 * external edits must never be written back.
 */
export function diffDraft(
  baseline: DraftBaseline,
  draft: DraftFields,
): DraftDiff {
  const fields: DraftField[] = [];
  const patch: DraftPatch = {};
  if (draft.modelReset) {
    if (baseline.model !== '') {
      patch.model = '';
      fields.push('model');
    }
  } else if (draft.model !== baseline.model) {
    patch.model = draft.model;
    fields.push('model');
  }
  if (draft.variant !== baseline.variant) {
    patch.variant = draft.variant;
    fields.push('variant');
  }
  const temperature = draft.temperature.trim();
  if (temperature !== baselineTemperature(baseline)) {
    if (temperature) {
      patch.temperature = Number(temperature);
    } else if (baseline.temperature !== undefined) {
      patch.clearTemperature = true;
    }
    fields.push('temperature');
  }
  const options = compactJson(draft.options);
  if (options !== compactJson(baseline.optionsJson ?? '')) {
    patch.optionsJson = options;
    fields.push('options');
  }
  return { dirty: fields.length > 0, fields, patch };
}

export interface PersistedEdit {
  model?: string | null;
  variant?: string | null;
  temperature?: number | null;
  optionsJson?: string | null;
}

export interface DraftConflict {
  hasConflict: boolean;
  removed: boolean;
  fields: DraftField[];
}

/**
 * A save is unsafe only when the latest persisted value of a field the user
 * changed no longer matches the baseline they started from. Unrelated fields
 * may change freely.
 */
export function draftConflicts(
  baseline: DraftBaseline,
  latest: PersistedEdit | undefined,
  dirtyFields: readonly DraftField[],
): DraftConflict {
  if (dirtyFields.length === 0) {
    return { hasConflict: false, removed: false, fields: [] };
  }
  if (!latest) {
    return { hasConflict: true, removed: true, fields: [...dirtyFields] };
  }
  const changed = dirtyFields.filter((field) => {
    if (field === 'model') return (latest.model ?? '') !== baseline.model;
    if (field === 'variant') return (latest.variant ?? '') !== baseline.variant;
    if (field === 'temperature') {
      return (
        (latest.temperature ?? undefined) !==
        (baseline.temperature ?? undefined)
      );
    }
    return (
      compactJson(latest.optionsJson ?? '') !==
      compactJson(baseline.optionsJson ?? '')
    );
  });
  return {
    hasConflict: changed.length > 0,
    removed: false,
    fields: changed,
  };
}

/** Workspace identity used by every snapshot, model cache and session read. */
export function workspaceKey(serverID: string, directory: string): string {
  return `${serverID}\u0000${directory}`;
}

export function sessionStateKey(
  serverID: string,
  directory: string,
  sessionID: string,
): string {
  return `${workspaceKey(serverID, directory)}\u0000${sessionID}`;
}

export const errorText = (cause: unknown): string => {
  if (cause instanceof Error) {
    const nested =
      cause.cause !== undefined && cause.cause !== cause
        ? errorText(cause.cause)
        : '';
    return nested && !cause.message.includes(nested)
      ? `${cause.message}: ${nested}`
      : cause.message;
  }
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', '_tag', 'code']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
};

/**
 * An old OMOS build answers an unknown RPC with a not-found style error. Only
 * those errors become a config-only UI. Timeouts, aborts, transport failures,
 * and missing sessions stay errors, so they are never silently treated as
 * "this version does not support session teams".
 */
const HOST_MISSING_RPC_TYPES = new Set([
  'rpc.unavailable',
  'rpc.method_not_found',
]);

/** The host's typed RPC error (`{ type, message }`), possibly wrapped in `cause`. */
const hostRpcErrorType = (cause: unknown, depth = 0): string | undefined => {
  if (!cause || typeof cause !== 'object' || depth > 4) return undefined;
  const record = cause as Record<string, unknown>;
  if (typeof record.type === 'string') return record.type;
  return hostRpcErrorType(record.cause, depth + 1);
};

export const isUnsupportedSessionRpc = (cause: unknown) => {
  const type = hostRpcErrorType(cause);
  if (type && HOST_MISSING_RPC_TYPES.has(type)) return true;
  const text = errorText(cause).toLowerCase();
  if (!text) return false;
  // The host's own wording for an unregistered contract or method. Checked
  // first: the contract id itself contains "session".
  if (/^rpc is unavailable: |^unknown rpc method: /.test(text)) return true;
  if (
    /(timed? ?out|abort|network|fetch|connect|econn|enotfound|401|403|500|502|503)/.test(
      text,
    )
  ) {
    return false;
  }
  if (/session/.test(text) && /(not[ _-]?found|unknown|missing)/.test(text))
    return false;
  if (
    /method[ _-]?not[ _-]?found|not[ _-]?registered|unimplemented/.test(text)
  ) {
    return true;
  }
  return /(?:unknown|not found|not registered|unsupported|not supported|no such|missing).*(?:rpc|method|procedure|endpoint|handler|route|request)|(?:rpc|method|procedure|endpoint|handler|route|request).*(?:unknown|not found|not registered|unsupported|not supported|no such|missing)|(?:^|\D)404(?:\D|$)|(?:^|\D)405(?:\D|$)/.test(
    text,
  );
};
