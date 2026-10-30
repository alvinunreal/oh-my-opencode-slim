/**
 * OpenCode v2 TUI preset manager.
 *
 * Promise-based port of the v1 three-level `/preset` manager
 * (`src/tui-preset.ts`):
 *   Level 1 — preset list (Apply / Edit / Create / Delete)
 *   Level 2 — agents in a preset (Base preset / Add / Remove / Save /
 *             Save & Apply)
 *   Level 3 — one agent's model → variant → temperature → options
 *
 * The v2 host exposes promise-based dialogs (`ui.dialog.select/prompt/confirm`)
 * instead of the v1 JSX dialog primitives, so this is a state-machine loop
 * rather than `dialog.replace`. The model list comes from the host's Solid
 * data collection (`data.location.model.list/sync`), with a guarded fallback
 * to the v2 client's `model.list({ location })` when the data layer is not
 * backed (older/reduced hosts); when neither yields models the flow toasts
 * guidance instead of failing.
 *
 * Apply explicitly chooses a scope. Global defaults and definition edits
 * persist to user config and request a refresh for future unbound roots.
 * Current-session inference bindings are owned by the server RPC, never local
 * config. Neither operation changes the root model or existing children.
 * A requested config refresh is not a confirmed watcher outcome; session
 * apply succeeds only when the RPC confirms its binding.
 *
 * UI capabilities are mirrored locally and guarded at runtime. The shared
 * RPC contract uses the official v2 plugin package; request options are mirrored.
 */
import type { AgentOverrideConfig, Preset, PresetDefinition } from '../config';
import { resolvePreset } from '../config';
import { loadPluginConfig } from '../config/loader';
import {
  applyInheritModelChoice,
  applyModelChoice,
  applyOptionsChoice,
  applyTemperatureChoice,
  applyVariantChoice,
  availableAgentNames,
  basePresetCandidates,
  buildPersistablePreset,
  describeBasePresetCandidate,
  describeBasePresetRow,
  describeOverride,
  describePreset,
  INHERITED_AGENT_PREFIX,
  inheritedAgentNames,
  isPrototypeSensitiveName,
  ownPresetValue,
  PRESET_ACTION,
  type PresetChoice,
  parseOptionsInput,
  parseTemperatureInput,
  resolveInheritedAgents,
  unwrapUserChoice,
  validateNewPresetName,
  withAgentOverride,
  withoutAgentOverride,
  wrapUserChoice,
} from '../preset-editor-domain';
import {
  deletePreset,
  findPresetDependents,
  getAllConfiguredPresets,
  getEditablePreset,
  getPresetSource,
  switchPresetOnDisk,
  wouldCreatePresetCycle,
  writePreset,
} from '../tools/preset-switch';
import { log } from '../utils/logger';
import { type SessionPresetState, sessionPresetRpc } from './preset-rpc';

// --- v2 host mirror types (subset consumed here, capability-guarded) ---

/** One `ui.dialog.select` option as consumed from the v2 host. */
export interface V2PresetDialogOption<Value> {
  title: string;
  value: Value;
  description?: string;
}

/** A `ui.dialog.select` input (v2 `DialogSelectOptions` subset). */
export interface V2PresetSelectInput<Value> {
  title: string;
  placeholder?: string;
  options: V2PresetDialogOption<Value>[];
  current?: Value;
}

/** `ui.dialog.prompt` + `ui.dialog.confirm` inputs (v2 option subsets). */
export interface V2PresetPromptInput {
  title: string;
  description?: string;
  placeholder?: string;
  value?: string;
}
export interface V2PresetConfirmInput {
  title: string;
  message: string;
  label?: { confirm?: string; cancel?: string };
}

/** v2 `ui.dialog` subset. Every method is optional: hosts that only expose
 * some of them still render the sidebar, and the manager degrades with a
 * toast instead of throwing. */
export interface V2PresetDialogApi {
  select?: <Value>(
    options: V2PresetSelectInput<Value>,
  ) => Promise<Value | undefined>;
  prompt?: (options: V2PresetPromptInput) => Promise<string | undefined>;
  confirm?: (options: V2PresetConfirmInput) => Promise<boolean | undefined>;
  alert?: (options: { title: string; message: string }) => Promise<void>;
}

/** A `ui.toast.show` input (v2 `ToastOptions` subset). */
export interface V2PresetToastInput {
  title?: string;
  message: string;
  variant?: string;
}
export interface V2PresetToastApi {
  show?: (toast: V2PresetToastInput) => void;
}

/** One model entry as returned by the host model collection (v2 `ModelInfo`
 * subset). Entries are normalized defensively at read time. */
export interface V2PresetModelInfo {
  providerID: string;
  modelID: string;
  name?: string;
  variants?: Array<{ id?: string } | string>;
}

/** v2 `LocationCollection<ModelInfo>` subset (`invalidate` is not needed). */
export interface V2PresetModelCollection {
  list: (location?: unknown) => V2PresetModelInfo[] | undefined;
  sync?: (location?: unknown) => Promise<void>;
}

/** The v2 `ui` surface the manager consumes. */
export interface V2PresetUiSurface {
  dialog?: V2PresetDialogApi;
  toast?: V2PresetToastApi;
}

/** Minimal v2 TUI manager context. `client` carries the v2 client for the
 * guarded `model.list` fallback; it is never required. `onConfigChanged` is
 * the host adapter's refresh seam (see `V2LiveRefreshResult`); the manager
 * never reloads the host agent registry itself (session/tool surfaces stay
 * frozen). */
export interface V2PresetManagerContext {
  location?: { directory: string };
  ui?: V2PresetUiSurface;
  data?: {
    location?: {
      model?: V2PresetModelCollection;
    };
  };
  client?: unknown;
  /** Live route accessor; no session on the home screen. */
  getSessionID?: () => string | undefined;
  /** Runs after a successful config write (Save / Save & Apply / Apply).
   * This is a REQUEST seam: on the supported host it asks the server-side
   * watcher to refresh the runtime profiles and re-reads the TUI sidebar
   * state, but cannot observe the server watcher's outcome. Return
   * `{ ok: false, reason }` (or reject) when the request itself failed; the
   * manager then shows the actionable reload fallback — it never claims the
   * refresh was applied. */
  onConfigChanged?: () =>
    | undefined
    | V2LiveRefreshResult
    | Promise<undefined | V2LiveRefreshResult>;
}

/** Outcome of the live-refresh REQUEST step after a config write. */
export interface V2LiveRefreshResult {
  ok: boolean;
  reason?: string;
}

// --- action sentinels (shared with the v1 manager through the domain module) ---

const ACTION_NEW_PRESET = PRESET_ACTION.NEW_PRESET;
const ACTION_ADD_AGENT = PRESET_ACTION.ADD_AGENT;
const ACTION_REMOVE_AGENT = PRESET_ACTION.REMOVE_AGENT;
const ACTION_SAVE = PRESET_ACTION.SAVE;
const ACTION_SAVE_APPLY = PRESET_ACTION.SAVE_APPLY;
const ACTION_BACK = PRESET_ACTION.BACK;
const ACTION_BASE_PRESET = PRESET_ACTION.BASE_PRESET;
const ACTION_INHERIT_MODEL = PRESET_ACTION.INHERIT_MODEL;

/** Dialog methods the manager requires; verified once at entry. */
interface RequiredDialog {
  select: NonNullable<V2PresetDialogApi['select']>;
  prompt: NonNullable<V2PresetDialogApi['prompt']>;
  confirm: NonNullable<V2PresetDialogApi['confirm']>;
}

interface ManagerRun {
  ctx: V2PresetManagerContext;
  directory: string;
  dialog: RequiredDialog;
}

type ApplyTarget =
  | { scope: 'global' }
  | { scope: 'session'; sessionID: string };

const SESSION_PRESET_READ_TIMEOUT_MS = 2_000;

/** The consumed subset of v2 RpcCallOptions; no dev-only client dependency. */
export interface V2PresetRpcCallOptions {
  readonly location?: { readonly directory?: string };
  readonly signal?: AbortSignal;
}

/** Only the server owns session bindings. Never infer them from local config.
 * Exported for the `/preset <name>` fast path, which binds the visible
 * session without the manager UI. */
export function sessionPresetClient(ctx: V2PresetManagerContext) {
  const client = ctx.client as
    | {
        rpc?: (contract: typeof sessionPresetRpc) => {
          read: (
            input: { sessionID: string },
            options: V2PresetRpcCallOptions,
          ) => Promise<SessionPresetState>;
          apply: (
            input: { sessionID: string; presetName: string },
            options: V2PresetRpcCallOptions,
          ) => Promise<SessionPresetState>;
        };
      }
    | undefined;
  if (typeof client?.rpc !== 'function') {
    throw new Error(
      'Session presets are unavailable on this server. Update the server and reconnect.',
    );
  }
  return client.rpc(sessionPresetRpc);
}

export async function readSessionPreset(
  ctx: V2PresetManagerContext,
  sessionID: string,
  directory: string,
): Promise<SessionPresetState> {
  const state = await sessionPresetClient(ctx).read(
    { sessionID },
    {
      location: { ...ctx.location, directory },
      // Bound the host request so an unavailable server cannot stall sidebar refresh.
      signal: AbortSignal.timeout(SESSION_PRESET_READ_TIMEOUT_MS),
    },
  );
  if (state.sessionID !== sessionID)
    throw new Error(
      'The server returned a different session. Reopen Presets to retry.',
    );
  return state;
}

export function sessionPresetLabel(state: SessionPresetState): string {
  return state.status === 'bound'
    ? (state.presetName ?? '(no named preset)')
    : 'Not bound';
}

function assertApplyTarget(run: ManagerRun, target: ApplyTarget): void {
  if (
    (run.ctx.location?.directory ?? run.directory) !== run.directory ||
    (target.scope === 'session' &&
      run.ctx.getSessionID?.() !== target.sessionID)
  ) {
    throw new Error('The displayed session or workspace changed.');
  }
}

async function chooseApplyTarget(
  run: ManagerRun,
  presetName: string,
  save: boolean,
): Promise<ApplyTarget | undefined> {
  const sessionID = run.ctx.getSessionID?.();
  const scope = await run.dialog.select<'session' | 'global'>({
    title: `${save ? 'Save & apply' : 'Apply'}: ${presetName}`,
    placeholder: 'Choose where to apply',
    options: [
      {
        title: 'Current session',
        value: 'session',
        description: sessionID
          ? 'Model settings for future children in this session'
          : 'Unavailable: open a session first',
      },
      {
        title: 'Global default',
        value: 'global',
        description: 'Default preset for new, unbound sessions',
      },
    ],
  });
  if (scope === undefined) return undefined;
  if (scope !== 'session' && scope !== 'global') return undefined;
  if (scope === 'session' && !sessionID) {
    toast(
      run.ctx,
      'warning',
      'Preset not applied',
      'No session is displayed. Open a session first.',
    );
    return undefined;
  }
  const target: ApplyTarget =
    scope === 'session' ? { scope, sessionID: sessionID as string } : { scope };
  const message =
    scope === 'session'
      ? `Use "${presetName}" for future children in this session? Applies model, variant, temperature, options and fallback settings.`
      : `Set "${presetName}" as the global default for new, unbound sessions? Project overrides still apply.`;
  if (
    !(await run.dialog.confirm({
      title:
        scope === 'session'
          ? 'Apply to current session?'
          : 'Change global default?',
      message: `${save ? 'Save this preset to user config, then apply it. ' : ''}${message}`,
    }))
  )
    return undefined;
  try {
    assertApplyTarget(run, target);
    if (scope === 'session') sessionPresetClient(run.ctx);
    return target;
  } catch (err) {
    toast(run.ctx, 'warning', 'Preset not applied', String(err));
    return undefined;
  }
}

interface ModelOption {
  /** Full `providerID/modelID` string used in the preset config. */
  value: string;
  title: string;
  description: string;
  /** Variant names available for this model, if any. */
  variants: string[];
}

type ModelSelection =
  | { kind: 'inherit' }
  | { kind: 'model'; model: string; variants: string[] }
  /** No model list could be fetched → stay at Level 2 (v1 parity). */
  | { kind: 'cancel' }
  /** Dialog dismissed → close the manager. */
  | { kind: 'dismiss' };

/** The Back row shared by every dialog that offers one (options are never
 * mutated, so one instance serves every list). */
const BACK_OPTION: V2PresetDialogOption<string> = {
  title: '← Back',
  value: ACTION_BACK,
};

/** Level-2 sub-flow outcome (a replacement working copy, no change, or a
 * dismissed dialog). */
type SubFlowResult =
  | { kind: 'updated'; working: PresetDefinition }
  | { kind: 'back' }
  | { kind: 'dismiss' };

/** One option-list dialog with an appended Back row, normalized for callers. */
type BackPick =
  | { kind: 'picked'; value: string }
  | { kind: 'back' }
  | { kind: 'dismiss' };

/**
 * True when the host exposes the promise dialogs the manager needs. The
 * sidebar row stays visible but non-clickable when this returns false.
 */
export function canOpenPresetManagerV2(ctx: V2PresetManagerContext): boolean {
  const dialog = ctx.ui?.dialog;
  return (
    typeof dialog?.select === 'function' &&
    typeof dialog?.prompt === 'function' &&
    typeof dialog?.confirm === 'function'
  );
}

/** Entry point: open the preset manager at Level 1. Re-reads the config on
 * every level; never throws (failures become a warning toast). */
export async function openPresetManagerV2(
  ctx: V2PresetManagerContext,
  directory: string,
): Promise<void> {
  try {
    const dialog = ctx.ui?.dialog;
    if (!canOpenPresetManagerV2(ctx)) {
      log(
        '[v2][preset] ui.dialog select/prompt/confirm unavailable; manager disabled',
      );
      toast(
        ctx,
        'warning',
        'Preset manager unavailable',
        'This host does not expose the TUI dialog API (ui.dialog). Use /preset <name> to switch presets.',
      );
      return;
    }
    await runPresetList({
      ctx,
      directory,
      dialog: dialog as RequiredDialog,
    });
  } catch (err) {
    log('[v2][preset] manager failed', String(err));
    toast(ctx, 'warning', 'Preset manager failed', String(err));
  }
}

/** Best-effort toast; a missing surface is a no-op, a throwing one is
 * logged. */
function toast(
  ctx: V2PresetManagerContext,
  variant: string,
  title: string,
  message: string,
): void {
  try {
    ctx.ui?.toast?.show?.({ variant, title, message });
  } catch (err) {
    log('[v2][preset] toast failed', String(err));
  }
}

/** Success text for a completed config write: says the refresh was REQUESTED
 * (the TUI cannot observe the server watcher), never applied. */
export function liveRefreshSuccessMessage(
  presetName: string,
  summary: string[] = [],
): string {
  const suffix = summary.length > 0 ? ` ${summary.join('; ')}` : '';
  return `Saved preset "${presetName}". Live refresh requested.${suffix}`;
}

export function liveRefreshFailureMessage(
  presetName: string,
  reason: string,
): string {
  return `Saved preset "${presetName}" to user config, but the live refresh request failed: ${reason}. Reload OpenCode to refresh the default for new, unbound sessions.`;
}

/** Run the live-refresh seam after a successful config write and report the
 * outcome with ONE toast; never claims the refresh happened, never throws. */
async function reportConfigWrite(
  run: ManagerRun,
  presetName: string,
  title: string,
  summary: string[] = [],
): Promise<void> {
  const hook = run.ctx.onConfigChanged;
  if (typeof hook !== 'function') {
    return void toast(
      run.ctx,
      'warning',
      'Config saved — live refresh unavailable',
      liveRefreshFailureMessage(
        presetName,
        'no live refresh request path is wired',
      ),
    );
  }
  try {
    const result = await hook();
    if (result?.ok === false) {
      throw new Error(result.reason ?? 'live refresh request failed');
    }
    toast(
      run.ctx,
      'success',
      title,
      liveRefreshSuccessMessage(presetName, summary),
    );
  } catch (err) {
    log(
      '[v2][preset] config saved but the live refresh request failed',
      String(err),
    );
    toast(
      run.ctx,
      'warning',
      'Config saved — live refresh failed',
      liveRefreshFailureMessage(presetName, String(err)),
    );
  }
}

/** Level 1: preset list (apply / edit / delete / create). */
async function runPresetList(run: ManagerRun): Promise<void> {
  for (;;) {
    const config = loadPluginConfig(run.directory, {
      silent: true,
      hostFlavor: 'v2',
    });
    const allPresets = getAllConfiguredPresets(run.directory, 'v2');
    const names = Array.from(
      new Set([
        ...Object.keys(allPresets),
        ...Object.keys(config.presets ?? {}),
      ]),
    );
    const activePreset = config.preset ?? null;
    const sessionID = run.ctx.getSessionID?.();
    let sessionState: SessionPresetState | undefined;
    let sessionLabel = 'No session displayed';
    if (sessionID) {
      try {
        const state = await readSessionPreset(
          run.ctx,
          sessionID,
          run.directory,
        );
        if (run.ctx.getSessionID?.() !== sessionID) {
          sessionLabel = 'Session changed — reopen manager';
        } else {
          sessionState = state;
          sessionLabel = sessionPresetLabel(state);
          if (state.presetName && !names.includes(state.presetName))
            sessionLabel += ' (definition unavailable)';
        }
      } catch {
        sessionLabel = 'Unavailable — reopen to retry';
      }
    }

    // No presets at all: jump straight to "create" (same as v1). A cancelled
    // create closes the manager — there is nothing else to do.
    if (
      names.length === 0 &&
      !activePreset &&
      sessionState?.status !== 'bound'
    ) {
      if ((await createAndEditPreset(run)) !== 'created') return;
      continue;
    }

    const options: V2PresetDialogOption<PresetChoice>[] = names.map((name) => {
      const isProject =
        getPresetSource(run.directory, name, 'v2') === 'project';
      const tag = isProject ? ' [project - read-only]' : '';
      return {
        title: `${name}${sessionState?.status === 'bound' && name === sessionState.presetName ? ' (current session)' : ''}${name === activePreset ? ' (default)' : ''}${tag}`,
        value: wrapUserChoice(name),
        description: describePreset(name, allPresets),
      };
    });
    options.push({ title: '+ Create new preset', value: ACTION_NEW_PRESET });

    const currentPreset =
      sessionState?.status === 'bound' ? sessionState.presetName : activePreset;
    const choice = await run.dialog.select<PresetChoice>({
      title: sessionID
        ? `Presets — current session: ${sessionLabel}`
        : 'Presets',
      placeholder: 'Choose a preset',
      options,
      // Only pass `current` when it matches an option: a stale config preset
      // name must not break the host dialog.
      ...(currentPreset != null && names.includes(currentPreset)
        ? { current: wrapUserChoice(currentPreset) }
        : {}),
    });
    if (choice === undefined) return; // dismissed → close the manager

    if (choice === ACTION_NEW_PRESET) {
      if ((await createAndEditPreset(run)) === 'dismiss') return;
      continue;
    }
    if ((await showPresetActions(run, unwrapUserChoice(choice))) === 'exit') {
      return;
    }
  }
}

/** Create a preset (prompt + overwrite confirm) and open its working copy.
 * `cancelled` keeps the caller's context; `dismiss` closes the manager. */
async function createAndEditPreset(
  run: ManagerRun,
): Promise<'created' | 'cancelled' | 'dismiss'> {
  const created = await promptAndCreatePreset(run);
  if (created === undefined) return 'cancelled';
  const result = await editPresetWorkingCopy(run, created, { agents: {} });
  return result === 'dismiss' ? 'dismiss' : 'created';
}

/** Preset action menu. Dismissal returns 'exit' (close), explicit Back
 * returns 'list' — v1's onClose vs. onSelect semantics. */
async function showPresetActions(
  run: ManagerRun,
  presetName: string,
): Promise<'list' | 'exit'> {
  for (;;) {
    const isProject =
      getPresetSource(run.directory, presetName, 'v2') === 'project';
    const options: V2PresetDialogOption<string>[] = [
      { title: 'Apply preset', value: 'apply' },
      ...(isProject
        ? []
        : [
            { title: 'Edit agents', value: 'edit' },
            { title: 'Delete preset', value: 'delete' },
          ]),
      BACK_OPTION,
    ];

    const choice = await run.dialog.select<string>({
      title: `Preset: ${presetName}`,
      options,
    });
    if (choice === undefined) return 'exit';
    if (choice === ACTION_BACK) return 'list';

    switch (choice) {
      case 'apply':
        {
          const target = await chooseApplyTarget(run, presetName, false);
          if (!target) return 'exit';
          await applyPresetWithMessage(run, presetName, target);
        }
        return 'exit';
      case 'edit':
        return (await editPreset(run, presetName)) === 'dismiss'
          ? 'exit'
          : 'list';
      case 'delete': {
        const result = await confirmDeletePreset(run, presetName);
        if (result === 'dismiss') return 'exit';
        // Cancelled or blocked deletes return to this preset's action menu
        // (v1's DialogConfirm onCancel).
        if (result === 'cancelled') continue;
        return 'list';
      }
      default:
        return 'list';
    }
  }
}

/** Apply the confirmed scope; keep a committed Save distinct from an apply failure. */
async function applyPresetWithMessage(
  run: ManagerRun,
  presetName: string,
  target: ApplyTarget,
  saved = false,
): Promise<void> {
  try {
    assertApplyTarget(run, target);
    if (target.scope === 'session') {
      const state = await sessionPresetClient(run.ctx).apply(
        { sessionID: target.sessionID, presetName },
        { location: { ...run.ctx.location, directory: run.directory } },
      );
      if (
        state.sessionID !== target.sessionID ||
        state.status !== 'bound' ||
        state.presetName !== presetName
      ) {
        throw new Error(
          'Server did not confirm the requested session binding.',
        );
      }
      toast(
        run.ctx,
        'success',
        saved ? 'Preset saved & session team updated' : 'Session team updated',
        `"${presetName}" applied.`,
      );
      return;
    }
    const config = loadPluginConfig(run.directory, {
      silent: true,
      hostFlavor: 'v2',
    });
    const result = switchPresetOnDisk(run.directory, presetName, config, {
      hostFlavor: 'v2',
    });
    if (!result.ok) {
      toast(
        run.ctx,
        'warning',
        saved ? 'Preset saved — not applied' : 'Preset not applied',
        `${saved ? 'Definition saved. ' : ''}${result.message}`,
      );
      return;
    }
    await reportConfigWrite(
      run,
      presetName,
      'Global default saved',
      result.summary,
    );
  } catch (err) {
    toast(
      run.ctx,
      'warning',
      saved ? 'Preset saved — not applied' : 'Preset not applied',
      `${saved ? 'Definition saved. ' : ''}${String(err)} Reopen Presets to check ${target.scope === 'session' ? 'the session binding' : 'the default'}.`,
    );
  }
}

type DeleteResult = 'deleted' | 'cancelled' | 'dismiss';

async function confirmDeletePreset(
  run: ManagerRun,
  presetName: string,
): Promise<DeleteResult> {
  if (isPrototypeSensitiveName(presetName)) {
    toast(
      run.ctx,
      'warning',
      'Preset is view-only',
      `Preset "${presetName}" collides with a JavaScript object property name and can only be applied, never edited or deleted.`,
    );
    return 'cancelled';
  }
  if (getPresetSource(run.directory, presetName, 'v2') === 'project') {
    toast(
      run.ctx,
      'warning',
      'Cannot delete preset',
      `Preset "${presetName}" is defined in project config (.opencode) and cannot be deleted here. Remove it from .opencode/oh-my-opencode-slim.jsonc directly.`,
    );
    return 'cancelled';
  }

  const dependents = findPresetDependents(
    presetName,
    getAllConfiguredPresets(run.directory, 'v2'),
  );
  if (dependents.length > 0) {
    toast(
      run.ctx,
      'warning',
      'Cannot delete preset',
      `Cannot delete "${presetName}" because other preset(s) extend it: ${dependents.join(', ')}. Change their base preset first.`,
    );
    return 'cancelled';
  }

  const confirmed = await run.dialog.confirm({
    title: 'Delete preset',
    message: `Delete preset "${presetName}"? This cannot be undone.`,
  });
  // Dismissal closes the manager; explicit Cancel returns to this preset's
  // action menu (v1's onClose vs. onCancel).
  if (confirmed === undefined) return 'dismiss';
  if (confirmed !== true) return 'cancelled';

  const ok = deletePreset(run.directory, presetName, 'v2');
  toast(
    run.ctx,
    ok ? 'success' : 'warning',
    ok ? 'Preset deleted' : 'Delete failed',
    ok
      ? `Deleted preset "${presetName}".`
      : `Could not delete "${presetName}" (it may have dependents or not exist in the user config file).`,
  );
  return 'deleted';
}

async function promptAndCreatePreset(
  run: ManagerRun,
): Promise<string | undefined> {
  for (;;) {
    const value = await run.dialog.prompt({
      title: 'Create new preset',
      placeholder: 'preset-name',
    });
    if (value === undefined) return undefined;
    const name = value.trim();
    const invalid = validateNewPresetName(name);
    if (invalid) {
      // An empty submit is a cancel; anything else re-prompts with the reason.
      if (!name) return undefined;
      toast(run.ctx, 'warning', 'Invalid name', invalid);
      continue;
    }
    // Check for a name collision before opening an empty working copy, to
    // avoid silently overwriting an existing preset on save.
    const allPresets = getAllConfiguredPresets(run.directory, 'v2');
    if (Object.hasOwn(allPresets, name)) {
      if (getPresetSource(run.directory, name, 'v2') === 'project') {
        toast(
          run.ctx,
          'warning',
          'Preset already exists',
          `A preset named "${name}" is already defined in project config (.opencode) and cannot be overwritten here.`,
        );
        continue;
      }
      const overwrite = await run.dialog.confirm({
        title: 'Preset exists',
        message: `A preset named "${name}" already exists. Overwrite it with a new empty preset?`,
      });
      if (overwrite !== true) continue;
    }
    return name;
  }
}

type Level2Result = 'back' | 'dismiss';

async function editPreset(
  run: ManagerRun,
  presetName: string,
): Promise<Level2Result> {
  if (isPrototypeSensitiveName(presetName)) {
    toast(
      run.ctx,
      'warning',
      'Preset is view-only',
      `Preset "${presetName}" collides with a JavaScript object property name and can only be applied, never edited.`,
    );
    return 'back';
  }
  if (getPresetSource(run.directory, presetName, 'v2') === 'project') {
    toast(
      run.ctx,
      'warning',
      'Preset is read-only',
      `Preset "${presetName}" is defined in project config (.opencode) and cannot be edited from the preset manager. Edit .opencode/oh-my-opencode-slim.jsonc directly.`,
    );
    return 'back';
  }

  // Edit the local delta directly so inherited agents are not materialized
  // into the working copy. Snapshot the on-disk definition as the merge
  // base so a config change behind the editor surfaces a conflict instead
  // of being clobbered (v1 `presetEditBases` parity).
  const editable = getEditablePreset(run.directory, presetName, 'v2');
  const editBase = structuredClone(editable);
  return editPresetWorkingCopy(
    run,
    presetName,
    {
      extends: editable.extends,
      agents: { ...editable.agents },
      marketplace: editable.marketplace,
    },
    editBase,
  );
}

/** Rows for a preset's local (non-inherited) agent overrides. */
function agentOptions(agents: Preset): V2PresetDialogOption<PresetChoice>[] {
  return Object.keys(agents).map((name) => ({
    title: name,
    value: wrapUserChoice(name),
    description: describeOverride(agents[name]),
  }));
}

/** One option-list dialog with an appended Back row. */
async function pickWithBack(
  run: ManagerRun,
  input: Omit<V2PresetSelectInput<PresetChoice>, 'options'>,
  options: V2PresetDialogOption<PresetChoice>[],
): Promise<BackPick> {
  options.push(BACK_OPTION);
  const choice = await run.dialog.select<PresetChoice>({
    ...input,
    options,
  });
  if (choice === undefined) return { kind: 'dismiss' };
  if (choice === ACTION_BACK) return { kind: 'back' };
  return { kind: 'picked', value: unwrapUserChoice(choice) };
}

/** Level 2: working copy of one preset's local agents. `editBase` is the
 * on-disk snapshot from when the editor opened (undefined for brand-new
 * presets); a mutable baseline is kept for the session and refreshed after
 * every successful plain Save (v1 `presetEditBases` parity), so a second
 * Save never conflicts with the editor's own first write. `marketplace`
 * rides along untouched — agent sub-flows only spread/replace
 * `extends`/`agents`. */
async function editPresetWorkingCopy(
  run: ManagerRun,
  presetName: string,
  initial: PresetDefinition,
  editBase?: PresetDefinition,
): Promise<Level2Result> {
  let working = initial;
  let baseline = editBase;
  for (;;) {
    const choice = await run.dialog.select<PresetChoice>({
      title: `Edit preset: ${presetName}`,
      options: buildWorkingOptions(run, presetName, working),
    });
    if (choice === undefined) return 'dismiss';

    if (typeof choice === 'string') {
      if (choice === ACTION_BASE_PRESET) {
        const result = await pickBasePreset(run, presetName, working);
        if (result.kind === 'dismiss') return 'dismiss';
        if (result.kind === 'updated') working = result.working;
        continue;
      }
      if (choice.startsWith(INHERITED_AGENT_PREFIX)) {
        const agentName = choice.slice(INHERITED_AGENT_PREFIX.length);
        toast(
          run.ctx,
          'info',
          'Inherited agent',
          `"${agentName}" is inherited from base preset "${working.extends}". Use "+ Add agent" to override it locally.`,
        );
        continue;
      }
      if (choice === ACTION_ADD_AGENT || choice === ACTION_REMOVE_AGENT) {
        const result =
          choice === ACTION_ADD_AGENT
            ? await addAgent(run, working)
            : await removeAgent(run, working);
        if (result.kind === 'dismiss') return 'dismiss';
        if (result.kind === 'updated') working = result.working;
        continue;
      }
      if (choice === ACTION_SAVE) {
        const saved = await savePreset(
          run,
          presetName,
          working,
          false,
          baseline,
        );
        if (saved.ok) baseline = saved.baseline;
        continue;
      }
      if (choice === ACTION_SAVE_APPLY) {
        const target = await chooseApplyTarget(run, presetName, true);
        if (!target) continue;
        try {
          assertApplyTarget(run, target);
        } catch (err) {
          toast(run.ctx, 'warning', 'Preset not applied', String(err));
          continue;
        }
        const saved = await savePreset(
          run,
          presetName,
          working,
          true,
          baseline,
        );
        if (saved.ok) {
          baseline = saved.baseline;
          await applyPresetWithMessage(run, presetName, target, true);
          return 'back';
        }
        toast(
          run.ctx,
          'warning',
          'Save failed',
          `Could not write preset "${presetName}" to the config file.`,
        );
        continue;
      }
      if (choice === ACTION_BACK) return 'back';
    }
    // Anything else names a local agent (wrapped value or plain string).
    const edited = await editAgent(run, working, unwrapUserChoice(choice));
    if (edited.kind === 'dismiss') return 'dismiss';
    if (edited.kind === 'updated') working = edited.working;
  }
}

function buildWorkingOptions(
  run: ManagerRun,
  presetName: string,
  working: PresetDefinition,
): V2PresetDialogOption<PresetChoice>[] {
  const { inheritedAgents, error } = resolveInheritedAgents(
    presetName,
    working,
    getAllConfiguredPresets(run.directory, 'v2'),
    wouldCreatePresetCycle,
  );

  const options: V2PresetDialogOption<PresetChoice>[] = [
    {
      title: `Base preset: ${working.extends ?? '(none)'}`,
      value: ACTION_BASE_PRESET,
      description: describeBasePresetRow(working, error),
    },
    ...agentOptions(working.agents),
  ];

  if (working.extends && !error) {
    for (const name of inheritedAgentNames(working, inheritedAgents)) {
      options.push({
        title: `${name} (inherited from ${working.extends})`,
        value: `${INHERITED_AGENT_PREFIX}${name}`,
        description: describeOverride(inheritedAgents[name]),
      });
    }
  }

  options.push(
    { title: '+ Add agent', value: ACTION_ADD_AGENT },
    { title: '− Remove agent', value: ACTION_REMOVE_AGENT },
    { title: '💾 Save', value: ACTION_SAVE },
    { title: '💾 Save & Apply', value: ACTION_SAVE_APPLY },
    BACK_OPTION,
  );
  return options;
}

/** Base-preset picker: excludes self and every cycle-forming candidate. */
async function pickBasePreset(
  run: ManagerRun,
  presetName: string,
  working: PresetDefinition,
): Promise<SubFlowResult> {
  const allPresets = getAllConfiguredPresets(run.directory, 'v2');
  const options: V2PresetDialogOption<PresetChoice>[] = [
    {
      title: '(none) — No base preset',
      value: '',
      description: 'Standalone preset without inherited configuration',
    },
  ];

  for (const candidate of basePresetCandidates(
    presetName,
    allPresets,
    wouldCreatePresetCycle,
  )) {
    options.push({
      title:
        candidate === working.extends
          ? `${candidate} (current base)`
          : candidate,
      value: wrapUserChoice(candidate),
      description: describeBasePresetCandidate(candidate, allPresets),
    });
  }

  const picked = await pickWithBack(
    run,
    {
      title: `Base preset for "${presetName}"`,
      placeholder: 'Select a base preset',
      current: working.extends ? wrapUserChoice(working.extends) : '',
    },
    options,
  );
  if (picked.kind !== 'picked') return picked;

  const nextExtends = picked.value || undefined;
  toast(
    run.ctx,
    'success',
    'Base preset updated',
    nextExtends
      ? `Base preset set to "${nextExtends}".`
      : 'Base preset cleared.',
  );
  return { kind: 'updated', working: { ...working, extends: nextExtends } };
}

async function addAgent(
  run: ManagerRun,
  working: PresetDefinition,
): Promise<SubFlowResult> {
  const available = availableAgentNames(Object.keys(working.agents));
  if (available.length === 0) {
    toast(
      run.ctx,
      'info',
      'No agents left',
      'All known agents are already in this preset.',
    );
    return { kind: 'back' };
  }

  // Hint only; a failed resolution must not block adding agents.
  const inheritedAgents = working.extends
    ? resolveBaseAgents(run, working.extends)
    : {};

  const options: V2PresetDialogOption<PresetChoice>[] = available.map(
    (name) => ({
      title: name,
      value: wrapUserChoice(name),
      ...(inheritedAgents[name]
        ? {
            description: `Overrides inherited (${describeOverride(inheritedAgents[name])})`,
          }
        : {}),
    }),
  );
  const picked = await pickWithBack(run, { title: 'Add agent' }, options);
  if (picked.kind !== 'picked') return picked;

  // Add the agent with an empty override, then jump to Level 3 (v1 parity).
  const next: PresetDefinition = {
    ...working,
    agents: withAgentOverride(working.agents, picked.value, {}),
  };
  const edited = await editAgent(run, next, picked.value);
  if (edited.kind === 'dismiss') return { kind: 'dismiss' };
  // Cancelled at a prompt: keep the (soon stripped) empty override, as v1
  // returned to Level 2 with the newly added agent selected.
  return {
    kind: 'updated',
    working: edited.kind === 'updated' ? edited.working : next,
  };
}

async function removeAgent(
  run: ManagerRun,
  working: PresetDefinition,
): Promise<SubFlowResult> {
  if (Object.keys(working.agents).length === 0) {
    toast(
      run.ctx,
      'info',
      'No agents',
      working.extends
        ? 'This preset has no local agent overrides to remove.'
        : 'This preset has no agents to remove.',
    );
    return { kind: 'back' };
  }

  const picked = await pickWithBack(
    run,
    { title: 'Remove agent' },
    agentOptions(working.agents),
  );
  if (picked.kind !== 'picked') return picked;

  toast(
    run.ctx,
    'success',
    'Agent removed',
    `Removed ${picked.value} from preset.`,
  );
  return {
    kind: 'updated',
    working: {
      ...working,
      agents: withoutAgentOverride(working.agents, picked.value),
    },
  };
}

/** Persist the working copy: strips empty overrides, preserves local
 * `extends`/`marketplace`, and reports one toast (unless `silent` — Save &
 * Apply reports once through `applyPresetWithMessage`). When `editBase` is
 * present the write merges against it, so a preset deleted or changed on
 * disk while the editor was open fails instead of clobbering. On success
 * the baseline is refreshed from the committed definition and the working
 * copy is synchronized to that merged result (v1 parity), so a later Save
 * from the same editor never conflicts with its own earlier write. */
async function savePreset(
  run: ManagerRun,
  presetName: string,
  working: PresetDefinition,
  silent = false,
  editBase?: PresetDefinition,
): Promise<{ ok: boolean; baseline?: PresetDefinition }> {
  const ok = writePreset(
    run.directory,
    presetName,
    buildPersistablePreset(working),
    editBase ? { mergeChangesFrom: editBase } : {},
  );
  if (!ok) {
    if (!silent) {
      toast(
        run.ctx,
        'warning',
        'Save failed',
        `Could not write preset "${presetName}" to the config file.`,
      );
    }
    return { ok: false };
  }
  const committed = getEditablePreset(run.directory, presetName, 'v2');
  const baseline = structuredClone(committed);
  working.extends = committed.extends;
  working.agents = structuredClone(committed.agents);
  working.marketplace = structuredClone(committed.marketplace);
  if (!silent) {
    await reportConfigWrite(run, presetName, 'Preset saved');
  }
  return { ok: true, baseline };
}

type EditAgentResult =
  | { kind: 'updated'; working: PresetDefinition }
  /** A prompt (temperature/options) was cancelled → stay at Level 2. */
  | { kind: 'cancel' }
  /** A selection dialog was dismissed → close the manager. */
  | { kind: 'dismiss' };

/** Level 3: edit one agent's override (model → variant → temperature →
 * options) and commit it back into the working preset. Browser dismissal
 * closes the manager; prompt cancellation returns to Level 2 (v1 parity). */
async function editAgent(
  run: ManagerRun,
  working: PresetDefinition,
  agentName: string,
): Promise<EditAgentResult> {
  const current = working.agents[agentName] ?? {};

  const selection = await pickModel(run, working, agentName, current);
  if (selection.kind === 'dismiss') return { kind: 'dismiss' };
  if (selection.kind === 'cancel') return { kind: 'cancel' };

  let next: AgentOverrideConfig = { ...current };
  if (selection.kind === 'inherit') {
    next = applyInheritModelChoice(next);
  } else {
    next = applyModelChoice(next, selection.model, selection.variants);
    // Skip the variant step when the model exposes no variants (v1 parity).
    if (selection.variants.length > 0) {
      const variant = await pickVariant(
        run,
        agentName,
        next,
        selection.variants,
      );
      if (variant.kind === 'dismiss') return { kind: 'dismiss' };
      next = variant.value;
    }
  }

  const temperature = await pickTemperature(run, agentName, next);
  if (!temperature) return { kind: 'cancel' };
  const options = await pickOptions(run, agentName, temperature);
  if (!options) return { kind: 'cancel' };

  toast(
    run.ctx,
    'success',
    'Agent updated',
    `${agentName} → ${describeOverride(options)}`,
  );
  return {
    kind: 'updated',
    working: {
      ...working,
      agents: withAgentOverride(working.agents, agentName, options),
    },
  };
}

/** The base preset's resolved agents; `{}` when it cannot be resolved
 * (description-only use — must not block the flow). */
function resolveBaseAgents(run: ManagerRun, base: string): Preset {
  try {
    return resolvePreset(base, getAllConfiguredPresets(run.directory, 'v2'));
  } catch {
    return {};
  }
}

/** The model ref `agentName` inherits from `base`, as `provider/model`. */
function inheritedModelRef(
  run: ManagerRun,
  base: string,
  agentName: string,
): string {
  const model = ownPresetValue(resolveBaseAgents(run, base), agentName)?.model;
  const first = Array.isArray(model) ? model[0] : model;
  return typeof first === 'string' ? first : (first?.id ?? '');
}

async function pickModel(
  run: ManagerRun,
  working: PresetDefinition,
  agentName: string,
  current: AgentOverrideConfig,
): Promise<ModelSelection> {
  const options = await fetchModelOptions(run);
  if (options.length === 0) {
    toast(
      run.ctx,
      'warning',
      'No models available',
      'Could not retrieve the model list. You can edit the preset config file manually.',
    );
    return { kind: 'cancel' };
  }

  const selectOptions: V2PresetDialogOption<PresetChoice>[] = options.map(
    (option) => ({
      title: option.title,
      value: wrapUserChoice(option.value),
      description: option.description,
    }),
  );

  if (working.extends) {
    const baseModel = inheritedModelRef(run, working.extends, agentName);
    selectOptions.unshift({
      title: '(inherit from base) — No local model override',
      value: ACTION_INHERIT_MODEL,
      description: baseModel
        ? `Inherit "${baseModel}" from "${working.extends}"`
        : `Inherit model from base preset "${working.extends}"`,
    });
  }

  // Only pass `current` when it matches an existing option: the host dialog
  // must never receive a non-existent current value.
  const currentModel =
    typeof current.model === 'string'
      ? options.find((option) => option.value === current.model)?.value
      : undefined;
  const currentChoice =
    working.extends && current.model === undefined
      ? ACTION_INHERIT_MODEL
      : currentModel
        ? wrapUserChoice(currentModel)
        : undefined;

  const choice = await run.dialog.select<PresetChoice>({
    title: `Edit ${agentName} — model`,
    placeholder: 'Search models',
    options: selectOptions,
    ...(currentChoice !== undefined ? { current: currentChoice } : {}),
  });
  // Model dialogs have no Back option: a dismissal closes the manager.
  if (choice === undefined) return { kind: 'dismiss' };
  if (choice === ACTION_INHERIT_MODEL) return { kind: 'inherit' };

  const model = unwrapUserChoice(choice);
  return {
    kind: 'model',
    model,
    variants: options.find((option) => option.value === model)?.variants ?? [],
  };
}

async function pickVariant(
  run: ManagerRun,
  agentName: string,
  current: AgentOverrideConfig,
  availableVariants: string[],
): Promise<
  { kind: 'value'; value: AgentOverrideConfig } | { kind: 'dismiss' }
> {
  const options: V2PresetDialogOption<PresetChoice>[] = [
    { title: 'none', value: '', description: 'no variant' },
    ...availableVariants.map((variant) => ({
      title: variant,
      value: wrapUserChoice(variant),
    })),
  ];

  const choice = await run.dialog.select<PresetChoice>({
    title: `Edit ${agentName} — variant (thinking strength)`,
    current:
      typeof current.variant === 'string' && current.variant
        ? wrapUserChoice(current.variant)
        : '',
    options,
  });
  // Variant dialogs have no Back option: a dismissal closes the manager.
  if (choice === undefined) return { kind: 'dismiss' };
  return {
    kind: 'value',
    value: applyVariantChoice(current, unwrapUserChoice(choice) || undefined),
  };
}

/** Level-3 temperature prompt: re-prompts on invalid input, blank clears. */
async function pickTemperature(
  run: ManagerRun,
  agentName: string,
  current: AgentOverrideConfig,
): Promise<AgentOverrideConfig | undefined> {
  for (;;) {
    const value = await run.dialog.prompt({
      title: `Edit ${agentName} — temperature`,
      description:
        'Enter a number 0–2, or leave blank for the provider default (typically 1.0).',
      placeholder: 'none',
      value:
        typeof current.temperature === 'number'
          ? String(current.temperature)
          : '',
    });
    if (value === undefined) return undefined;

    const parsed = parseTemperatureInput(value);
    if (!parsed.ok) {
      toast(run.ctx, 'warning', 'Invalid temperature', parsed.message);
      continue;
    }
    return applyTemperatureChoice(current, parsed.temperature);
  }
}

/** Level-3 options prompt: re-prompts on invalid JSON, `{}` clears. */
async function pickOptions(
  run: ManagerRun,
  agentName: string,
  current: AgentOverrideConfig,
): Promise<AgentOverrideConfig | undefined> {
  const currentJson =
    current.options && typeof current.options === 'object'
      ? JSON.stringify(current.options)
      : '{}';

  for (;;) {
    const value = await run.dialog.prompt({
      title: `Edit ${agentName} — options (JSON)`,
      description:
        'Provider-specific options as JSON, e.g. {"thinking":{"type":"enabled","budgetTokens":10000}}. Use {} for none.',
      value: currentJson,
      placeholder: '{}',
    });
    if (value === undefined) return undefined;

    const parsed = parseOptionsInput(value);
    if (!parsed.ok) {
      toast(run.ctx, 'warning', 'Invalid options', parsed.message);
      continue;
    }
    return applyOptionsChoice(current, parsed.options);
  }
}

/** Fetch the model list through the host data layer, then the guarded
 * `client.model.list({ location })` fallback. Every step is
 * capability-guarded; no surface yields an empty list and the caller toasts
 * guidance. */
async function fetchModelOptions(run: ManagerRun): Promise<ModelOption[]> {
  const location = run.ctx.location ?? { directory: run.directory };

  const collection = run.ctx.data?.location?.model;
  let entries: unknown[] | undefined;
  if (typeof collection?.list === 'function') {
    entries = collection.list(location);
    if ((!entries || entries.length === 0) && collection.sync) {
      // The v2 data collections hydrate lazily: `list` returns undefined
      // until a `sync` for the location has completed. Hosts that already
      // hydrated return data directly, so sync only on a miss.
      try {
        await collection.sync(location);
        entries = collection.list(location);
      } catch (err) {
        log('[v2][preset] model collection sync failed', String(err));
      }
    }
  }

  if (!entries || entries.length === 0) {
    const client = run.ctx.client as
      | {
          model?: {
            list?: (input: { location?: unknown }) => Promise<unknown>;
          };
        }
      | undefined;
    if (typeof client?.model?.list === 'function') {
      try {
        const response = await client.model.list.call(client.model, {
          location,
        });
        if (Array.isArray(response)) {
          entries = response;
        } else {
          const data = (response as { data?: unknown } | undefined)?.data;
          if (Array.isArray(data)) entries = data;
        }
      } catch (err) {
        log('[v2][preset] client model list failed', String(err));
      }
    }
  }

  const options: ModelOption[] = [];
  for (const entry of entries ?? []) {
    const option = normalizeModelOption(entry);
    if (option) options.push(option);
  }
  return options;
}

/** Defensive normalization of one host model entry; unusable entries are
 * dropped rather than crashing the picker. */
export function normalizeModelOption(entry: unknown): ModelOption | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const rec = entry as {
    providerID?: unknown;
    modelID?: unknown;
    id?: unknown;
    name?: unknown;
    variants?: unknown;
  };
  const providerID =
    typeof rec.providerID === 'string' ? rec.providerID : undefined;
  const modelID =
    typeof rec.modelID === 'string'
      ? rec.modelID
      : typeof rec.id === 'string'
        ? rec.id
        : undefined;
  if (!providerID || !modelID) return undefined;

  const variants = (Array.isArray(rec.variants) ? rec.variants : []).flatMap(
    (variant) => {
      if (typeof variant === 'string') return [variant];
      const id = (variant as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' ? [id] : [];
    },
  );

  return {
    value: `${providerID}/${modelID}`,
    title:
      typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : modelID,
    description: providerID,
    variants,
  };
}
