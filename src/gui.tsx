import {
  Command,
  ComposerPill,
  type ComposerPillRow,
  type ComposerPillView,
  MenuItem,
  type MountedSession,
  Panel,
  type PanelTab,
  Plugin,
  Store,
  Style,
} from '@opencode/plugin/gui';
import { Schema } from 'effect';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from 'solid-js';
import { NativeModelPrefsIpc } from './gui-plugin/contract';
import {
  compactJson,
  type DraftBaseline,
  type DraftField,
  diffDraft,
  draftConflicts,
  type GuiSessionPresetState,
  goCapForModel,
  groupModels,
  isExplicitBindingFor,
  type ModelGroup,
  type ModelShapeLike,
  modelValue,
  sessionBinding,
  sessionStateKey,
  splitModel,
  verifyAppliedState,
  verifyResetState,
  verifySessionState,
  workspaceKey,
} from './gui-plugin/gui-domain';
import css from './gui-plugin/panel.css?inline';
import {
  type AgentEntry,
  type GoMonthlyLimits,
  type NativeModelPrefs,
  OmosConfig,
  type OverridePatch,
  type PresetInfo,
  type ResultMessage,
  SessionPreset,
  type Snapshot,
} from './gui-plugin/rpc';

const EMPTY_AGENTS: AgentEntry[] = [];
const EMPTY_ROSTER: Snapshot['roster'] = [];
const FALLBACK_PROTECTED = new Set(['orchestrator', 'councillor']);
const OPTIONS_EXAMPLE = '{"thinking":{"type":"enabled","budgetTokens":10000}}';
const SESSION_TIMEOUT_MS = 2000;
const GoPreferences = Schema.Struct({
  plan: Schema.Literals(['go', 'goPlus', 'goTeams']),
});
const GO_PLANS = [
  { id: 'go', label: 'Go' },
  { id: 'goPlus', label: 'Go Plus' },
  { id: 'goTeams', label: 'Go Teams' },
] as const;

interface ModelShape extends ModelShapeLike {
  variants?: { id: string }[];
}

interface NewPresetDraft {
  source: string;
  name: string;
  error: string;
}

interface AgentBaseline extends DraftBaseline {
  modelChain?: string[];
  inheritModelFrom?: string;
  inherited?: boolean;
  skills?: string[];
  mcps?: string[];
}

interface AgentDraft {
  name: string;
  isNew: boolean;
  context: string;
  baseline: AgentBaseline;
  model: string;
  variant: string;
  temperature: string;
  options: string;
  optionsOpen: boolean;
  moreOpen: boolean;
  modelQuery: string;
  modelPickerOpen: boolean;
  confirmRemove: boolean;
  modelReset: boolean;
}

type SessionTeamState = GuiSessionPresetState;

interface SessionReadEntry {
  status: 'loading' | 'ready' | 'unsupported' | 'error';
  state?: SessionTeamState;
  error?: string;
  updatedAt: number;
}

interface SessionCallOptions {
  location: { directory: string };
  signal: AbortSignal;
}

interface WorkspaceTarget {
  session: MountedSession;
  directory: string;
  serverID: string;
  key: string;
  client: MountedSession['server']['client'];
}

const targetFor = (
  session: MountedSession,
  directory: string,
): WorkspaceTarget => ({
  session,
  directory,
  serverID: session.server.id,
  key: workspaceKey(session.server.id, directory),
  client: session.server.client,
});

class SessionAbortedError extends Error {}
class SessionTimeoutError extends Error {
  constructor() {
    super('Session team request timed out. Try again.');
  }
}

const asResult = (value: unknown): ResultMessage => value as ResultMessage;

const agentCount = (count: number) =>
  `${count} ${count === 1 ? 'agent' : 'agents'}`;

const uniqueCopyName = (source: string, taken: Set<string>) => {
  const base = `${source}-copy`;
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index++;
  return `${base}-${index}`;
};

const errorText = (cause: unknown): string => {
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
const isUnsupportedSessionRpc = (cause: unknown) => {
  const text = errorText(cause).toLowerCase();
  if (!text) return false;
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

const callWithSessionTimeout = async <T,>(
  directory: string,
  call: (options: SessionCallOptions) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal?.aborted) throw new SessionAbortedError();
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SESSION_TIMEOUT_MS);
  try {
    return await call({ location: { directory }, signal: controller.signal });
  } catch (cause) {
    if (signal?.aborted) throw new SessionAbortedError();
    if (timedOut) throw new SessionTimeoutError();
    throw cause;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
};

const readSessionTeam = (
  session: MountedSession,
  directory: string,
  signal?: AbortSignal,
): Promise<SessionTeamState> =>
  callWithSessionTimeout(
    directory,
    (options) =>
      session.server.client
        .rpc(SessionPreset)
        .read({ sessionID: session.id }, options),
    signal,
  ).then((value) => verifySessionState(value, session.id));

const applySessionTeam = (
  session: MountedSession,
  directory: string,
  presetName: string,
): Promise<SessionTeamState> =>
  callWithSessionTimeout(directory, (options) =>
    session.server.client
      .rpc(SessionPreset)
      .apply({ sessionID: session.id, presetName }, options),
  ).then((value) => verifyAppliedState(value, session.id, presetName));

const unbindSessionTeam = (
  session: MountedSession,
  directory: string,
): Promise<SessionTeamState> =>
  callWithSessionTimeout(directory, (options) =>
    session.server.client
      .rpc(SessionPreset)
      .unbind({ sessionID: session.id }, options),
  ).then((value) => verifyResetState(value, session.id));

/**
 * GUI part. `setup` runs in every desktop window, `main` once in the
 * Electron main process. The whole editor lives in the side panel: no
 * dialogs, no model/preset picker overlays.
 */
export default Plugin.define({
  stores: {
    goPreferences: Store.global(GoPreferences, { plan: 'go' }),
  },
  i18n: {
    en: {
      'panel.title': 'OMOS Presets',
      'panel.subtitle': 'oh-my-opencode-slim',
      'panel.loading': 'Reading config…',
      'panel.loadingHint': 'Looking for your OMOS presets.',
      'panel.error.title': 'Could not read OMOS config',
      'panel.retry': 'Try again',
      'panel.new': 'New',
      'panel.refresh': 'Refresh config',
      'panel.active': 'default',
      'panel.presets': 'Presets',
      'panel.deletePreset': 'Delete',
      'panel.delete.title': 'Delete “{{name}}”?',
      'panel.delete.confirm': 'Delete',
      'panel.cancel': 'Cancel',
      'panel.save': 'Save',
      'panel.saveOverride': 'Save override',
      'panel.presetOnly': 'Preset only',
      'panel.saveScope':
        'Saves to “{{name}}”. Apply the preset separately to update a session team.',
      'panel.inspectHint':
        'Select a preset to inspect or edit. This does not change your session or default.',
      'panel.inspected': 'Inspecting',
      'panel.changeModel': 'Change model',
      'panel.closeModels': 'Done choosing',
      'panel.modelResults': '{{count}} models',
      'panel.go.plan': 'Show caps for',
      'panel.go.planHint':
        'Display plan only; not detected from your account. Defaults to Go.',
      'panel.go.note': 'Monthly caps, not remaining usage',
      'panel.go.allowance':
        'Published monthly allowance for {{plan}}. Not remaining usage.',
      'panel.go.loading': 'Reading published caps…',
      'panel.go.unavailable': 'Monthly caps unavailable',
      'panel.go.source': 'OpenCode docs',
      'panel.go.cached': 'cached',
      'panel.updateForSession': 'Update session team',
      'panel.apply': 'Apply',
      'panel.notActive': 'Not the saved default',
      'panel.applyNeedsOverride': 'Add an override to apply.',
      'panel.readOnlyHint': 'Read-only — use New → Duplicate.',
      'panel.readOnlyProject':
        'A project config overrides this preset — use New → Duplicate.',
      'panel.readOnlyToast':
        'Project presets are read-only. Use New → Duplicate to edit this preset.',
      'panel.activeMissingNamed':
        'Default preset “{{name}}” is not in your config.',
      'panel.banner.env':
        'OH_MY_OPENCODE_SLIM_PRESET is set. It overrides the default until you unset it.',
      'panel.banner.envNamed':
        'OH_MY_OPENCODE_SLIM_PRESET is set to “{{name}}”. It overrides the default until you unset it.',
      'panel.banner.missing':
        'OMOS config not found. Create or apply a preset to write one.',
      'panel.tab.workbench': 'Presets & Agents',
      'panel.tab.roster': 'Global Roster',
      'panel.newPreset': 'New preset',
      'panel.create.blank': 'Blank preset',
      'panel.create.copyGroup': 'Duplicate from',
      'panel.create.copyDesc': 'Copies every agent from “{{name}}”.',
      'panel.create.blankDesc': 'Starts with no agent overrides.',
      'panel.create.name': 'Preset name',
      'panel.create.namePlaceholder': 'my-preset',
      'panel.create.submit': 'Create preset',
      'panel.duplicateNamed': 'Duplicate “{{name}}”',
      'panel.error.nameRequired': 'Enter a preset name.',
      'panel.error.noSpaces': 'Preset names cannot contain spaces.',
      'panel.error.exists': 'A preset named “{{name}}” already exists.',
      'panel.error.noModels':
        'No models available. Check provider authentication first.',
      'panel.error.modelMissing':
        'That model is no longer available. Choose another model.',
      'panel.error.noTarget': 'Open a workspace session first.',
      'panel.configUnavailable.title':
        'Config editing is unavailable on this server',
      'panel.configUnavailable.desc':
        "This server doesn't expose the OMOS config RPC. Update OMOS on that server or open a session on a supported server. Nothing was written locally.",
      'panel.draft.conflict':
        'The stored override changed while you were editing. Reload the latest values or discard your changes.',
      'panel.draft.reload': 'Reload',
      'panel.draft.discard': 'Discard',
      'panel.agents': 'Agents',
      'panel.overrides': '{{count}} of {{total}} agents in this preset',
      'panel.add': 'Add',
      'panel.allAdded': 'All added',
      'panel.addAgentTitle': 'Add agent',
      'panel.noAgents': 'No agent overrides yet',
      'panel.noAgentsHint':
        'Add an agent to pin its model, variant, temperature, or options.',
      'panel.noAgentsReadOnly': 'Use New → Duplicate to edit this preset.',
      'panel.empty.title': 'No presets yet',
      'panel.empty.desc':
        'Create a preset to pin models and options for each agent.',
      'panel.empty.action': 'Create preset',
      'panel.disabled': 'disabled',
      'panel.disabledHint': 'Disabled globally in the roster.',
      'panel.presetDefault': 'Preset default',
      'panel.setModel': 'Set model',
      'panel.editAgent': 'Edit model and options',
      'panel.editor.title': 'Edit {{name}}',
      'panel.editor.new': 'New override · {{name}}',
      'panel.model': 'Model',
      'panel.searchModels': 'Search models',
      'panel.loadingModels': 'Loading models…',
      'panel.noModelsMatch': 'No models match “{{query}}”.',
      'panel.modelUnavailable': 'Current model is unavailable. Pick another.',
      'panel.variant': 'Variant',
      'panel.variantDefault': 'Default',
      'panel.noVariants': 'No variants for this model.',
      'panel.temperature': 'Temperature',
      'panel.temperature.placeholder': '0.0 – 2.0',
      'panel.temperature.invalid': 'Enter a number between 0 and 2.',
      'panel.clear': 'Clear',
      'panel.options': 'Options JSON',
      'panel.options.desc':
        'Options are passed to the provider for this agent.',
      'panel.options.invalid': 'Enter a valid JSON object.',
      'panel.addOptions': 'Add options',
      'panel.editOptions': 'Edit options',
      'panel.hideOptions': 'Hide options',
      'panel.skills': 'Skills',
      'panel.mcps': 'MCPs',
      'panel.extends': 'Extends',
      'panel.inherited': 'Inherited',
      'panel.inheritsFrom': 'Inherits {{name}}',
      'panel.inheritedHint':
        'This agent comes from a base preset. Saving here creates a local override.',
      'panel.inheritHint':
        'Inherits its model from {{name}}. Pick a model to override it.',
      'panel.inheritHintDefault':
        'Inherits the default model. Pick a model to override it.',
      'panel.useInheritedModel': 'Use inherited/default model',
      'panel.usingInheritedModel':
        'This override will use the inherited/default model when saved.',
      'panel.modelChainWarning':
        'This agent uses a fallback chain: {{chain}}. Picking a model replaces it with one model.',
      'panel.removeAgent': 'Remove from preset',
      'panel.remove.title': 'Remove {{name}}?',
      'panel.remove.confirm': 'Remove',
      'panel.roster.title': 'Global roster',
      'panel.roster.desc':
        'Disabled agents are skipped in every preset. This setting applies across the whole workspace.',
      'panel.roster.primary': 'primary',
      'panel.roster.primaryHint': 'Primary agent',
      'panel.protected': 'Always enabled (protected)',
      'panel.openPanel': 'Open side panel…',
      'panel.switchTitle': 'OMOS session team',
      'panel.scope.default': 'Default',
      'panel.scope.defaultHint':
        'Saved user default for new sessions. Project and environment defaults still take precedence.',
      'panel.scope.session': 'This session',
      'panel.scope.savedDefault': 'Saved',
      'panel.scope.hint':
        "Binds this preset to the current session's future child agents only. It does not change the saved default.",
      'panel.scope.boundHint':
        'This session is bound to this preset. Apply it again after edits to update its team.',
      'panel.scope.globalTitle': 'Saved default: {{name}}',
      'panel.scope.projectTitle': 'Project default: {{name}}',
      'panel.scope.envTitle': 'Environment default: {{name}}',
      'panel.none': 'none',
      'panel.useForSession': 'Use for this session',
      'panel.setDefault': 'Set default',
      'panel.session.loading': 'Reading…',
      'panel.session.locationUnknown': 'Waiting for workspace…',
      'panel.session.none': 'Not set',
      'panel.session.unsupported': 'Unavailable',
      'panel.session.error': 'Could not read',
      'panel.session.unsupportedHint':
        'Session team controls need a newer OMOS. Config editing still works.',
      'panel.session.errorHint': "Could not read this session's team.",
      'panel.session.updating': 'Updating session team…',
      'panel.session.unbinding': 'Unbinding session…',
      'panel.session.unboundTitle': 'Session unbound',
      'panel.session.unbound':
        'Future child agents follow the effective default again.',
      'panel.session.resetTitle': 'Session reset',
      'panel.session.reset':
        'Future child agents follow the effective default team again.',
      'panel.session.unbindUnsupported':
        "This OMOS version can't reset a session team. Apply another preset to change it.",
      'panel.defaultTeam': 'Default team',
      'panel.session.unchanged':
        'Session team updated for future child agents. Conversation model unchanged.',
      'panel.session.unsupportedToast':
        'Session team controls are unavailable in this OMOS version.',
      'panel.default.unchanged':
        'Default saved. Existing session teams are unchanged.',
      'panel.default.saving': 'Saving default “{{name}}”…',
      'panel.pill.title': 'OMOS preset',
      'panel.pill.bound': 'Preset: {{name}}',
      'panel.pill.unbound': 'Preset: not set',
      'panel.pill.reading': 'Preset: reading…',
      'panel.pill.unsupported': 'Preset: unavailable',
      'panel.pill.error': 'Preset: unreadable',
      'panel.pill.retry': 'Retry session team read',
      'panel.invalid': 'invalid',
      'panel.settings': 'Settings',
      'panel.settings.go': 'Go monthly caps',
      'panel.settings.planHint':
        "Which plan's published caps to show. This does not detect your subscription.",
      'panel.presetLabel': 'Preset',
      'panel.deleteRow': 'Delete preset',
      'panel.deleteConfirmShort': 'Delete?',
      'panel.deleted': 'Deleted',
      'panel.undo': 'Undo',
      'panel.restorePending': 'Restore before closing this menu',
      'panel.sessionToggle': 'Use for this session only',
      'panel.defaultToggle': 'Default preset',
      'panel.default.clearing': 'Clearing default…',
      'panel.default.cleared':
        'Default cleared. Project or environment defaults still apply.',
      'panel.sessionNoUnbind':
        "OMOS can't unbind a session team. Pick another preset to change it.",
      'panel.defaultLabel': 'Default',
      'panel.sessionLabel': 'Session',
      'panel.closeMenu': 'Close menu',
      'panel.more': 'More settings',
      'panel.less': 'Fewer settings',
      'panel.inheritToggle': 'Use inherited/default model',
      'panel.favorites': 'Favorites',
      'panel.recent': 'Recent',
      'panel.source.env': 'env',
      'panel.source.project': 'project',
      'panel.source.global': 'global',
      'command.refresh': 'OMOS: refresh config',
      'command.open': 'OMOS: open preset panel',
      'menu.open': 'OMOS Presets',
    },
  },
  setup(ctx) {
    ctx.add(Style, css);
    const ui = ctx.ui;

    const [snapshots, setSnapshots] = createSignal<Record<string, Snapshot>>(
      {},
    );
    const [snapshotErrors, setSnapshotErrors] = createSignal<
      Record<string, string>
    >({});
    const [snapshotUnsupported, setSnapshotUnsupported] = createSignal<
      Record<string, boolean>
    >({});
    const [snapshotLoading, setSnapshotLoading] = createSignal<
      Record<string, boolean>
    >({});
    const [activeDirectory, setActiveDirectory] = createSignal('');
    const [activeServerID, setActiveServerID] = createSignal('');
    const [versions, setVersions] = createSignal<Record<string, string>>({});

    const [sessionReads, setSessionReads] = createSignal<
      Record<string, SessionReadEntry>
    >({});
    const [unbindUnsupported, setUnbindUnsupported] = createSignal<
      Record<string, boolean>
    >({});
    const [busy, setBusy] = createSignal(false);
    const [editTarget, setEditTarget] = createSignal('');
    const [tab, setTab] = createSignal<'workbench' | 'roster'>('workbench');
    const [bodyEl, setBodyEl] = createSignal<HTMLDivElement>();

    /**
     * Opaque popover surface sampled from the app's own theme: walk up from
     * the panel until an ancestor paints a background, so menus match the
     * host instead of hardcoded colors. Falls back per appearance mode.
     */
    const popoverBase = () => {
      const mode = ctx.appearance.mode();
      let node: HTMLElement | null = bodyEl() ?? null;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const match = bg.match(/rgba?\(([^)]+)\)/);
        if (match) {
          const parts = match[1]
            .split(',')
            .map((value) => Number.parseFloat(value));
          const alpha = parts.length > 3 ? parts[3] : 1;
          if (Number.isFinite(alpha) && alpha >= 0.85) return bg;
        }
        node = node.parentElement;
      }
      return mode === 'dark' ? '#1c1f26' : '#ffffff';
    };

    const [newPreset, setNewPreset] = createSignal<NewPresetDraft | null>(null);
    const [addOpen, setAddOpen] = createSignal(false);
    const [agentDraft, setAgentDraft] = createSignal<AgentDraft | null>(null);
    const [newMenuOpen, setNewMenuOpen] = createSignal(false);
    const [presetMenuOpen, setPresetMenuOpen] = createSignal(false);
    const [settingsOpen, setSettingsOpen] = createSignal(false);
    type StagedDelete = { name: string; target: WorkspaceTarget };
    const [pendingDeletes, setPendingDeletes] = createSignal<StagedDelete[]>(
      [],
    );
    const [deleteConfirmName, setDeleteConfirmName] = createSignal<
      string | null
    >(null);

    const [modelList, setModelList] = createSignal<ModelShape[]>([]);
    const [modelsLoadingKey, setModelsLoadingKey] = createSignal('');
    const [modelsError, setModelsError] = createSignal('');
    const [goLimitsByServer, setGoLimitsByServer] = createSignal<
      Record<string, GoMonthlyLimits>
    >({});
    const [goLimitsLoadingServer, setGoLimitsLoadingServer] = createSignal('');
    const [nativePrefs, setNativePrefs] = createSignal<NativeModelPrefs>();
    let nativePrefsAt = 0;
    let nativePrefsLoading = false;
    const goLimitsAt = new Map<string, number>();
    const goLimitsInflight = new Set<string>();
    const modelsCache = new Map<string, ModelShape[]>();
    const modelsSeq = new Map<string, number>();

    const snapshotSeq = new Map<string, number>();
    const snapshotInflight = new Map<string, Promise<void>>();
    const snapshotQueued = new Set<string>();
    const sessionSeq = new Map<string, number>();
    const sessionInflight = new Set<string>();

    let panelSession: MountedSession | undefined;

    const activeKey = () => workspaceKey(activeServerID(), activeDirectory());
    const currentTarget = (): WorkspaceTarget | undefined => {
      // Resolve the routed session at action time. `panelSession` is only a
      // fallback for a panel that is still mounting before the route updates.
      const session = ctx.sessions.current() ?? panelSession;
      const directory = session?.location?.directory;
      if (!session || !directory) return undefined;
      return targetFor(session, directory);
    };
    const panelTarget = (): WorkspaceTarget | undefined => {
      const directory = panelSession?.location?.directory;
      if (!panelSession || !directory) return undefined;
      return targetFor(panelSession, directory);
    };

    const scrollTop = () => {
      const element = bodyEl();
      if (element) element.scrollTop = 0;
    };

    const switchTab = (next: 'workbench' | 'roster') => {
      setTab(next);
      setAddOpen(false);
      setAgentDraft(null);
      // A staged preset deletion must commit when its menu is hidden.
      if (presetMenuOpen()) closePresetMenu();
      scrollTop();
    };

    async function fetchSnapshot(target: WorkspaceTarget): Promise<Snapshot> {
      // The RPC runs on the session's own server. `ctx.client` is always the
      // local Desktop sidecar, so using it here would silently read/write the
      // wrong machine for a remote session.
      const value = await target.client
        .rpc(OmosConfig)
        .getSnapshot(
          { directory: target.directory },
          { location: { directory: target.directory } },
        );
      return value as unknown as Snapshot;
    }

    function reconcileEditTarget(next: Snapshot) {
      const current = editTarget();
      const keep = Boolean(
        current && next.presets.some((preset) => preset.name === current),
      );
      if (!keep) {
        setAddOpen(false);
        setAgentDraft(null);
        setNewPreset(null);
      }
      setEditTarget(
        keep ? current : next.preset || next.presets[0]?.name || '',
      );
    }

    function resetWorkspaceView(key: string) {
      setNewPreset(null);
      setAddOpen(false);
      setAgentDraft(null);
      setModelsError('');
      setModelList([]);
      const cached = snapshots()[key];
      setEditTarget(
        cached ? cached.preset || cached.presets[0]?.name || '' : '',
      );
    }

    async function requestSnapshot(
      target: WorkspaceTarget,
      force = false,
    ): Promise<void> {
      const key = target.key;
      if (!force) {
        if (snapshots()[key]) return;
        const running = snapshotInflight.get(key);
        if (running) return running;
      }
      const seq = (snapshotSeq.get(key) ?? 0) + 1;
      snapshotSeq.set(key, seq);
      setSnapshotLoading((previous) => ({ ...previous, [key]: true }));
      const pending = (async () => {
        try {
          const next = await fetchSnapshot(target);
          if (snapshotSeq.get(key) !== seq) return;
          setSnapshots((previous) => ({ ...previous, [key]: next }));
          setSnapshotErrors((previous) => {
            if (!(key in previous)) return previous;
            const updated = { ...previous };
            delete updated[key];
            return updated;
          });
          setSnapshotUnsupported((previous) => {
            if (!(key in previous)) return previous;
            const updated = { ...previous };
            delete updated[key];
            return updated;
          });
          if (next.omosVersion) {
            setVersions((previous) => ({
              ...previous,
              [target.serverID]: next.omosVersion as string,
            }));
          }
          if (activeKey() === key) reconcileEditTarget(next);
        } catch (cause) {
          if (snapshotSeq.get(key) !== seq) return;
          setSnapshotErrors((previous) => ({
            ...previous,
            [key]: errorText(cause),
          }));
          if (isUnsupportedSessionRpc(cause)) {
            setSnapshotUnsupported((previous) => ({
              ...previous,
              [key]: true,
            }));
          }
        } finally {
          if (snapshotSeq.get(key) === seq) {
            setSnapshotLoading((previous) => ({ ...previous, [key]: false }));
          }
        }
      })();
      snapshotInflight.set(key, pending);
      try {
        await pending;
      } finally {
        if (snapshotInflight.get(key) === pending) snapshotInflight.delete(key);
      }
    }

    const ensureSnapshot = (target: WorkspaceTarget) => {
      const key = target.key;
      if (
        snapshots()[key] ||
        snapshotLoading()[key] ||
        snapshotErrors()[key] ||
        snapshotInflight.has(key) ||
        snapshotQueued.has(key)
      ) {
        return;
      }
      snapshotQueued.add(key);
      queueMicrotask(() => {
        snapshotQueued.delete(key);
        void requestSnapshot(target);
      });
    };

    const sessionScopeKey = (session: MountedSession, directory: string) =>
      sessionStateKey(session.server.id, directory, session.id);

    const dropSessionEntry = (key: string, seq: number) => {
      if (sessionSeq.get(key) !== seq) return;
      setSessionReads((previous) => {
        if (!(key in previous)) return previous;
        const updated = { ...previous };
        delete updated[key];
        return updated;
      });
    };

    async function requestSessionRead(
      session: MountedSession,
      directory: string,
      options: { force?: boolean; signal?: AbortSignal } = {},
    ): Promise<SessionReadEntry | undefined> {
      if (options.signal?.aborted) return undefined;
      const key = sessionScopeKey(session, directory);
      const existing = sessionReads()[key];
      if (!options.force) {
        if (existing) return existing;
        if (sessionInflight.has(key)) return undefined;
      }
      const seq = (sessionSeq.get(key) ?? 0) + 1;
      sessionSeq.set(key, seq);
      setSessionReads((previous) => ({
        ...previous,
        [key]: { status: 'loading', updatedAt: Date.now() },
      }));
      sessionInflight.add(key);
      try {
        const state = await readSessionTeam(session, directory, options.signal);
        if (options.signal?.aborted) {
          dropSessionEntry(key, seq);
          return undefined;
        }
        if (sessionSeq.get(key) !== seq) return undefined;
        const entry: SessionReadEntry = {
          status: 'ready',
          state,
          updatedAt: Date.now(),
        };
        setSessionReads((previous) => ({ ...previous, [key]: entry }));
        return entry;
      } catch (cause) {
        if (cause instanceof SessionAbortedError || options.signal?.aborted) {
          dropSessionEntry(key, seq);
          return undefined;
        }
        if (sessionSeq.get(key) !== seq) return undefined;
        const entry: SessionReadEntry =
          cause instanceof SessionTimeoutError
            ? { status: 'error', error: cause.message, updatedAt: Date.now() }
            : isUnsupportedSessionRpc(cause)
              ? {
                  status: 'unsupported',
                  error: errorText(cause),
                  updatedAt: Date.now(),
                }
              : {
                  status: 'error',
                  error: errorText(cause),
                  updatedAt: Date.now(),
                };
        setSessionReads((previous) => ({ ...previous, [key]: entry }));
        return entry;
      } finally {
        sessionInflight.delete(key);
      }
    }

    const ensureSessionRead = (session: MountedSession, directory: string) => {
      const key = sessionScopeKey(session, directory);
      if (sessionReads()[key] || sessionInflight.has(key)) return;
      sessionInflight.add(key);
      queueMicrotask(() => {
        if (sessionReads()[key]) {
          sessionInflight.delete(key);
          return;
        }
        // Release the queue reservation before requestSessionRead checks it.
        sessionInflight.delete(key);
        void requestSessionRead(session, directory).finally(() =>
          sessionInflight.delete(key),
        );
      });
    };

    function storeSessionTeam(
      session: MountedSession,
      directory: string,
      state: SessionTeamState,
    ) {
      const key = sessionScopeKey(session, directory);
      sessionSeq.set(key, (sessionSeq.get(key) ?? 0) + 1);
      setSessionReads((previous) => ({
        ...previous,
        [key]: { status: 'ready', state, updatedAt: Date.now() },
      }));
    }

    function markSessionUnsupported(
      session: MountedSession,
      directory: string,
      cause: unknown,
    ) {
      const key = sessionScopeKey(session, directory);
      sessionSeq.set(key, (sessionSeq.get(key) ?? 0) + 1);
      setSessionReads((previous) => ({
        ...previous,
        [key]: {
          status: 'unsupported',
          error: errorText(cause),
          updatedAt: Date.now(),
        },
      }));
    }

    function refreshPanelSessionRead(target: WorkspaceTarget) {
      if (
        panelSession &&
        panelSession.server.id === target.serverID &&
        panelSession.location?.directory === target.directory
      ) {
        void requestSessionRead(panelSession, target.directory, {
          force: true,
        });
      }
    }

    const activeSnapshot = () => snapshots()[activeKey()];
    const activeError = () => snapshotErrors()[activeKey()] ?? '';
    const activeUnsupported = () => snapshotUnsupported()[activeKey()] ?? false;

    const roster = () => activeSnapshot()?.roster ?? EMPTY_ROSTER;
    const rosterOrder = createMemo(() => {
      const order = new Map<string, number>();
      roster().forEach((entry, index) => {
        order.set(entry.name, index);
      });
      return order;
    });

    const isProtectedAgent = (name: string) => {
      const entries = roster();
      if (entries.length === 0) return FALLBACK_PROTECTED.has(name);
      return entries.find((entry) => entry.name === name)?.protected ?? false;
    };

    const presetEditable = (preset?: PresetInfo) => Boolean(preset?.editable);

    /**
     * The host toast title truncates long text, so split a message into a
     * short title and a description. The description carries the full copy.
     */
    const toastText = (message: string) => {
      const clean = message.replace(/\s+/g, ' ').trim();
      const sentence = clean.match(/^(.{1,45}?[.!?])\s/);
      if (sentence) {
        return { title: sentence[1], description: clean };
      }
      if (clean.length > 45) {
        const cut = clean.slice(0, 45);
        const at = cut.lastIndexOf(' ');
        const index = at > 24 ? at : 45;
        return {
          title: `${clean.slice(0, index).trim()}…`,
          description: clean,
        };
      }
      return { title: clean, description: clean };
    };

    const notify = (
      variant: 'default' | 'success' | 'error',
      message: string,
      extra?: {
        persistent?: boolean;
        actions?: { label: string; run(): void }[];
      },
    ) => ctx.toast.show({ variant, ...toastText(message), ...extra });

    const useForSession = async (
      presetName: string,
      session: MountedSession,
      directory: string,
    ): Promise<boolean> => {
      if (busy() || !presetName || !directory) return false;
      const target = targetFor(session, directory);
      const preset = snapshots()[target.key]?.presets.find(
        (candidate) => candidate.name === presetName,
      );
      if (!preset || preset.validationError) return false;
      setBusy(true);
      const pending = ctx.toast.show({
        variant: 'loading',
        title: ctx.t('panel.session.updating'),
        persistent: true,
      });
      try {
        const state = await applySessionTeam(session, directory, presetName);
        storeSessionTeam(session, directory, state);
        pending.dismiss();
        ctx.toast.show({
          variant: 'success',
          title: ctx.t('panel.session.unchanged'),
        });
        return true;
      } catch (cause) {
        pending.dismiss();
        if (cause instanceof SessionAbortedError) return false;
        if (cause instanceof SessionTimeoutError) {
          notify('error', cause.message);
        } else if (isUnsupportedSessionRpc(cause)) {
          markSessionUnsupported(session, directory, cause);
          notify('error', ctx.t('panel.session.unsupportedToast'));
        } else {
          notify('error', errorText(cause));
        }
        return false;
      } finally {
        setBusy(false);
      }
    };

    const unbindForSession = async (
      session: MountedSession,
      directory: string,
    ): Promise<boolean> => {
      if (busy() || !directory) return false;
      const key = sessionScopeKey(session, directory);
      setBusy(true);
      const pending = ctx.toast.show({
        variant: 'loading',
        title: ctx.t('panel.session.unbinding'),
        persistent: true,
      });
      try {
        const state = await unbindSessionTeam(session, directory);
        storeSessionTeam(session, directory, state);
        setUnbindUnsupported((previous) => {
          if (!(key in previous)) return previous;
          const updated = { ...previous };
          delete updated[key];
          return updated;
        });
        pending.dismiss();
        const reset = state.status === 'bound';
        ctx.toast.show({
          variant: 'success',
          title: ctx.t(
            reset ? 'panel.session.resetTitle' : 'panel.session.unboundTitle',
          ),
          description: ctx.t(
            reset ? 'panel.session.reset' : 'panel.session.unbound',
          ),
        });
        return true;
      } catch (cause) {
        pending.dismiss();
        if (cause instanceof SessionAbortedError) return false;
        if (isUnsupportedSessionRpc(cause)) {
          // An older host without unbind can still read and apply. Keep the
          // read state and surface a reset-only limitation instead of marking
          // the whole session-team surface unsupported.
          setUnbindUnsupported((previous) => ({ ...previous, [key]: true }));
          notify('error', ctx.t('panel.session.unbindUnsupported'));
        } else {
          notify('error', errorText(cause));
        }
        return false;
      } finally {
        setBusy(false);
      }
    };

    const run = async (
      label: string,
      action: (target: WorkspaceTarget) => Promise<string>,
      options?: { success?: string; target?: WorkspaceTarget },
    ): Promise<boolean> => {
      if (busy()) return false;
      const target = options?.target ?? currentTarget();
      if (!target) {
        notify('error', ctx.t('panel.error.noTarget'));
        return false;
      }
      const capture = target;
      setBusy(true);
      const pending = ctx.toast.show({
        variant: 'loading',
        title: label,
        persistent: true,
      });
      try {
        const message = await action(capture);
        pending.dismiss();
        notify('success', options?.success ?? message);
        await requestSnapshot(capture, true);
        refreshPanelSessionRead(capture);
        return true;
      } catch (cause) {
        pending.dismiss();
        if (isUnsupportedSessionRpc(cause)) {
          setSnapshotUnsupported((previous) => ({
            ...previous,
            [capture.key]: true,
          }));
          notify('error', ctx.t('panel.configUnavailable.title'));
        } else {
          notify(
            'error',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        return false;
      } finally {
        setBusy(false);
      }
    };

    const useAsDefault = async (
      presetName: string,
      target: WorkspaceTarget,
    ): Promise<boolean> => {
      if (!presetName || !target.directory) return false;
      const preset = snapshots()[target.key]?.presets.find(
        (candidate) => candidate.name === presetName,
      );
      if (!preset || preset.validationError) return false;
      return run(
        ctx.t('panel.default.saving', { name: presetName }),
        async (actionTarget) => {
          const result = asResult(
            await actionTarget.client
              .rpc(OmosConfig)
              .switchPreset(
                { name: presetName, directory: actionTarget.directory },
                { location: { directory: actionTarget.directory } },
              ),
          );
          if (!result.ok) throw new Error(result.message);
          return result.message;
        },
        { success: ctx.t('panel.default.unchanged'), target },
      );
    };

    const clearDefault = async (target: WorkspaceTarget): Promise<boolean> => {
      if (!target.directory) return false;
      return run(
        ctx.t('panel.default.clearing'),
        async (actionTarget) => {
          const result = asResult(
            await actionTarget.client
              .rpc(OmosConfig)
              .clearPresetDefault(
                { directory: actionTarget.directory },
                { location: { directory: actionTarget.directory } },
              ),
          );
          if (!result.ok) throw new Error(result.message);
          return ctx.t('panel.default.cleared');
        },
        { target },
      );
    };

    const hardRefresh = async (target = currentTarget()) => {
      if (!target || busy()) return;
      setBusy(true);
      try {
        modelsCache.delete(target.key);
        modelsSeq.set(target.key, (modelsSeq.get(target.key) ?? 0) + 1);
        setModelsLoadingKey((current) =>
          current === target.key ? '' : current,
        );
        setModelList([]);
        setModelsError('');
        await requestSnapshot(target, true);
        if (agentDraft()) void loadModels(target);
      } finally {
        setBusy(false);
      }
    };

    const defaultPreset = createMemo(() => {
      const current = activeSnapshot();
      if (!current) return undefined;
      return current.presets.find((preset) => preset.name === current.preset);
    });

    const currentPreset = createMemo(() => {
      const current = activeSnapshot();
      if (!current) return undefined;
      return current.presets.find((preset) => preset.name === editTarget());
    });

    const readOnlyHint = () => {
      const preset = currentPreset();
      if (preset?.inUserConfig && !presetEditable(preset)) {
        return ctx.t('panel.readOnlyProject');
      }
      return ctx.t('panel.readOnlyHint');
    };

    const currentAgents = createMemo(() => {
      const agents = currentPreset()?.agents ?? EMPTY_AGENTS;
      const order = rosterOrder();
      return [...agents].sort((left, right) => {
        const leftRank = order.get(left.name) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = order.get(right.name) ?? Number.MAX_SAFE_INTEGER;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return left.name.localeCompare(right.name);
      });
    });

    const missingAgents = createMemo(() => {
      const taken = new Set(currentAgents().map((agent) => agent.name));
      return roster().filter((entry) => !taken.has(entry.name));
    });

    const canEditCurrent = () => presetEditable(currentPreset());

    const canApplyPreset = (preset?: PresetInfo) =>
      Boolean(preset && !preset.validationError);

    const isAgentDisabled = (name: string) =>
      !isProtectedAgent(name) &&
      (activeSnapshot()?.disabledAgents.includes(name) ?? false);

    const enabledCount = () =>
      roster().filter(
        (entry) => entry.protected || !isAgentDisabled(entry.name),
      ).length;

    const versionLabel = () => {
      const value = versions()[activeServerID()] ?? '';
      return value ? `v${value.replace(/^v/i, '')}` : '';
    };

    const defaultScopeTitle = () => {
      const state = activeSnapshot();
      if (!state) return '';
      const parts: string[] = [];
      if (state.globalPreset) {
        parts.push(
          ctx.t('panel.scope.globalTitle', { name: state.globalPreset }),
        );
      }
      if (state.projectPreset) {
        parts.push(
          ctx.t('panel.scope.projectTitle', { name: state.projectPreset }),
        );
      }
      if (state.envPreset) {
        parts.push(ctx.t('panel.scope.envTitle', { name: state.envPreset }));
      }
      return parts.join('\n');
    };

    const toastReadOnly = () => notify('default', ctx.t('panel.readOnlyToast'));

    const selectPreset = (name: string) => {
      setEditTarget(name);
      setAddOpen(false);
      setAgentDraft(null);
      setNewPreset(null);
      setDeleteConfirmName(null);
    };

    const toggleAdd = () => {
      if (!canEditCurrent()) {
        toastReadOnly();
        return;
      }
      setAgentDraft(null);
      setNewPreset(null);
      setAddOpen((open) => !open);
    };

    const startNewPreset = (source: string) => {
      if (busy()) return;
      if (activeUnsupported()) {
        notify('error', ctx.t('panel.configUnavailable.title'));
        return;
      }
      setAgentDraft(null);
      setAddOpen(false);
      setNewMenuOpen(false);
      const taken = new Set(
        activeSnapshot()?.presets.map((preset) => preset.name) ?? [],
      );
      setNewPreset({
        source,
        name: source ? uniqueCopyName(source, taken) : '',
        error: '',
      });
      setTab('workbench');
      scrollTop();
    };

    const submitNewPreset = async () => {
      const draft = newPreset();
      if (!draft || busy()) return;
      const name = draft.name.trim();
      if (!name) {
        setNewPreset({ ...draft, error: ctx.t('panel.error.nameRequired') });
        return;
      }
      if (/\s/.test(name)) {
        setNewPreset({ ...draft, error: ctx.t('panel.error.noSpaces') });
        return;
      }
      if (activeSnapshot()?.presets.some((preset) => preset.name === name)) {
        setNewPreset({
          ...draft,
          error: ctx.t('panel.error.exists', { name }),
        });
        return;
      }
      const target = panelTarget();
      if (!target) {
        notify('error', ctx.t('panel.error.noTarget'));
        return;
      }
      const created = await run(
        `Creating "${name}"…`,
        async (actionTarget) => {
          const result = asResult(
            await actionTarget.client.rpc(OmosConfig).createPreset(
              {
                name,
                ...(draft.source ? { copyFrom: draft.source } : {}),
                directory: actionTarget.directory,
              },
              { location: { directory: actionTarget.directory } },
            ),
          );
          if (!result.ok) throw new Error(result.message);
          return result.message;
        },
        { target },
      );
      if (created && activeKey() === target.key) {
        setNewPreset(null);
        setEditTarget(name);
        setTab('workbench');
        scrollTop();
      }
    };

    // Deletions in the preset menu stay undoable until the menu closes; the
    // RPC only runs then, so Undo needs no restore payload. Each stage
    // captures its own workspace target: the staging session/server, so a
    // workspace switch can never redirect the queued deletions.
    const stagePresetDelete = (name: string) => {
      if (busy()) return;
      const target = panelTarget() ?? currentTarget();
      if (!target) {
        notify('error', ctx.t('panel.error.noTarget'));
        return;
      }
      setDeleteConfirmName(null);
      setPendingDeletes((entries) =>
        entries.some(
          (entry) => entry.name === name && entry.target.key === target.key,
        )
          ? entries
          : [...entries, { name, target }],
      );
      if (editTarget() === name) {
        const remaining = (activeSnapshot()?.presets ?? []).filter(
          (preset) =>
            preset.name !== name &&
            !pendingDeletes().some((entry) => entry.name === preset.name),
        );
        setEditTarget(remaining[0]?.name ?? '');
        setAgentDraft(null);
        setAddOpen(false);
      }
    };

    const undoPresetDelete = (name: string) => {
      setPendingDeletes((entries) =>
        entries.filter((entry) => entry.name !== name),
      );
      setDeleteConfirmName(null);
    };

    const commitPendingDeletes = async () => {
      const entries = pendingDeletes();
      if (entries.length === 0) return;
      setPendingDeletes([]);
      setDeleteConfirmName(null);
      const refreshed = new Set<string>();
      for (const { name, target } of entries) {
        try {
          const result = asResult(
            await target.client.rpc(OmosConfig).deletePreset(
              {
                name,
                ...(target.directory ? { directory: target.directory } : {}),
              },
              target.directory
                ? { location: { directory: target.directory } }
                : undefined,
            ),
          );
          if (!result.ok) notify('error', result.message);
        } catch (cause) {
          if (isUnsupportedSessionRpc(cause)) {
            setSnapshotUnsupported((previous) => ({
              ...previous,
              [target.key]: true,
            }));
            notify('error', ctx.t('panel.configUnavailable.title'));
          } else {
            notify('error', errorText(cause));
          }
        }
        if (target.directory && !refreshed.has(target.key)) {
          refreshed.add(target.key);
          await requestSnapshot(target, true);
        }
      }
    };

    const closePresetMenu = () => {
      setPresetMenuOpen(false);
      void commitPendingDeletes();
    };

    const closeMenus = () => {
      setNewMenuOpen(false);
      setSettingsOpen(false);
      if (presetMenuOpen()) closePresetMenu();
    };

    // Escape and outside clicks close the header popovers. The preset menu's
    // pending deletions commit on close, as its Undo only lives while open.
    createEffect(() => {
      const anyOpen = newMenuOpen() || presetMenuOpen() || settingsOpen();
      if (!anyOpen) return;
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') closeMenus();
      };
      const onPointer = (event: PointerEvent) => {
        const target = event.target as HTMLElement | null;
        if (
          target?.closest('.omos-popover') ||
          target?.closest('.omos-head-actions') ||
          target?.closest('.omos-preset-trigger')
        )
          return;
        closeMenus();
      };
      document.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onPointer, true);
      onCleanup(() => {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointerdown', onPointer, true);
      });
    });
    onCleanup(() => {
      // Queued deletions carry their own target; commit regardless of the
      // session the panel happens to be routed to now.
      void commitPendingDeletes();
    });

    const setOverride = (
      agent: string,
      patch: OverridePatch,
      label: string,
      target = panelTarget(),
    ) => {
      const preset = editTarget();
      if (!preset || !target || !canEditCurrent())
        return Promise.resolve(false);
      return run(
        label,
        async (actionTarget) => {
          const result = asResult(
            await actionTarget.client.rpc(OmosConfig).setAgentOverride(
              {
                preset,
                agent,
                patch,
                directory: actionTarget.directory,
              },
              { location: { directory: actionTarget.directory } },
            ),
          );
          if (!result.ok) throw new Error(result.message);
          return result.message;
        },
        { target },
      );
    };

    const toggleAgent = (
      agent: string,
      disabled: boolean,
      target = panelTarget(),
    ) => {
      if (isProtectedAgent(agent)) return;
      return run(
        `${disabled ? 'Disabling' : 'Enabling'} ${agent}…`,
        async (actionTarget) => {
          const result = asResult(
            await actionTarget.client.rpc(OmosConfig).setAgentDisabled(
              {
                agent,
                disabled,
                directory: actionTarget.directory,
              },
              { location: { directory: actionTarget.directory } },
            ),
          );
          if (!result.ok) throw new Error(result.message);
          return result.message;
        },
        { target },
      );
    };

    const loadModels = async (target = panelTarget()) => {
      if (!target) return;
      const cached = modelsCache.get(target.key);
      if (cached && cached.length > 0) {
        if (activeKey() === target.key) {
          setModelList(cached);
          setModelsError('');
        }
        return;
      }
      if (modelsLoadingKey() === target.key) return;
      const seq = (modelsSeq.get(target.key) ?? 0) + 1;
      modelsSeq.set(target.key, seq);
      setModelsLoadingKey(target.key);
      if (activeKey() === target.key) setModelsError('');
      try {
        const response = (await target.client.model.list({
          location: { directory: target.directory },
        })) as unknown as {
          data?: ModelShape[];
        };
        const list = (response.data ?? []).filter(
          (model) => model.providerID && model.id,
        );
        if (modelsSeq.get(target.key) !== seq) return;
        if (list.length > 0) modelsCache.set(target.key, list);
        if (activeKey() === target.key) {
          setModelList(list);
          if (list.length === 0) setModelsError(ctx.t('panel.error.noModels'));
        }
      } catch (cause) {
        if (modelsSeq.get(target.key) !== seq) return;
        if (activeKey() === target.key) {
          setModelsError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      } finally {
        if (modelsSeq.get(target.key) === seq) {
          setModelsLoadingKey((current) =>
            current === target.key ? '' : current,
          );
        }
      }
    };

    const modelsLoading = () => modelsLoadingKey() === activeKey();

    const patchDraft = (patch: Partial<AgentDraft>) => {
      setAgentDraft((draft) => (draft ? { ...draft, ...patch } : draft));
    };

    const startAgentEdit = (name: string, isNew: boolean) => {
      if (busy()) return;
      if (!canEditCurrent()) {
        toastReadOnly();
        return;
      }
      const target = panelTarget();
      if (!target) {
        notify('error', ctx.t('panel.error.noTarget'));
        return;
      }
      const entry = isNew
        ? undefined
        : currentPreset()?.agents.find((agent) => agent.name === name);
      if (!isNew && !entry) return;
      const baseline: AgentBaseline = {
        model: entry?.model ?? '',
        variant: entry?.variant ?? '',
        ...(entry?.temperature !== undefined
          ? { temperature: entry.temperature }
          : {}),
        ...(entry?.optionsJson !== undefined
          ? { optionsJson: entry.optionsJson }
          : {}),
        ...(entry?.modelChain ? { modelChain: [...entry.modelChain] } : {}),
        ...(entry?.inheritModelFrom
          ? { inheritModelFrom: entry.inheritModelFrom }
          : {}),
        inherited: entry?.inherited ?? false,
        ...(entry?.skills ? { skills: [...entry.skills] } : {}),
        ...(entry?.mcps ? { mcps: [...entry.mcps] } : {}),
      };
      setNewPreset(null);
      setAddOpen(false);
      setAgentDraft({
        name,
        isNew,
        context: target.key,
        baseline,
        model: baseline.model,
        variant: baseline.variant,
        temperature:
          baseline.temperature !== undefined
            ? String(baseline.temperature)
            : '',
        options: compactJson(baseline.optionsJson ?? ''),
        optionsOpen: Boolean(baseline.optionsJson),
        moreOpen: false,
        modelQuery: '',
        modelPickerOpen: isNew,
        confirmRemove: false,
        modelReset: false,
      });
      void loadModels(target);
    };

    const toggleAgentEdit = (name: string) => {
      if (agentDraft()?.name === name && !agentDraft()?.isNew) {
        setAgentDraft(null);
        return;
      }
      startAgentEdit(name, false);
    };

    const draftOriginal = createMemo(() => {
      const draft = agentDraft();
      if (!draft || draft.isNew) return undefined;
      return draft.baseline;
    });

    const draftVariants = createMemo(() => {
      const value = agentDraft()?.model;
      if (!value) return [] as string[];
      const model = modelList().find(
        (candidate) => modelValue(candidate) === value,
      );
      return (model?.variants ?? [])
        .map((variant) => variant.id)
        .filter(Boolean);
    });

    const draftModelFound = createMemo(() => {
      const value = agentDraft()?.model;
      if (!value) return false;
      return modelList().some((model) => modelValue(model) === value);
    });

    const modelGroups = createMemo((): ModelGroup<ModelShape>[] => {
      const prefs = nativePrefs()?.status === 'ok' ? nativePrefs() : undefined;
      return groupModels(modelList(), {
        query: agentDraft()?.modelQuery ?? '',
        favorites: prefs?.favorites,
        recent: prefs?.recent,
      });
    });

    const modelGroupLabel = (group: ModelGroup<ModelShape>) => {
      if (group.kind === 'favorites') return ctx.t('panel.favorites');
      if (group.kind === 'recent') return ctx.t('panel.recent');
      return group.provider;
    };

    // Native favorites/recents change rarely; read them when the picker opens,
    // at most once a minute. They belong to the Desktop machine, so the window
    // asks its main process instead of whichever server the session uses.
    createEffect(
      on(
        () => Boolean(agentDraft()?.modelPickerOpen),
        (open) => {
          if (!open || nativePrefsLoading || Date.now() < nativePrefsAt) return;
          nativePrefsAt = Date.now() + 60_000;
          nativePrefsLoading = true;
          void ctx
            .main(NativeModelPrefsIpc)
            .read()
            .then((value) => setNativePrefs(value as NativeModelPrefs))
            .catch(() => {})
            .finally(() => {
              nativePrefsLoading = false;
            });
        },
      ),
    );

    const goRelevant = createMemo(() => {
      if (settingsOpen()) return true;
      const draft = agentDraft();
      if (
        draft &&
        (splitModel(draft.model).provider === 'opencode-go' ||
          (draft.modelPickerOpen &&
            modelGroups().some((group) =>
              group.models.some((model) => model.providerID === 'opencode-go'),
            )))
      ) {
        return true;
      }
      // Agent rows show their cap collapsed, so fetch when the list has Go models.
      return currentAgents().some(
        (agent) => splitModel(agent.model).provider === 'opencode-go',
      );
    });

    // Recheck only when a relevant surface opens (or rows first render), never
    // typing, plan changes or a timer. HTTP revalidation/backoff stay in the
    // target server's own cache. Limits are cached per server so switching tabs
    // can never show one machine's caps for another.
    createEffect(
      on(
        () =>
          [
            Boolean(agentDraft()?.name),
            Boolean(agentDraft()?.modelPickerOpen),
            modelList().length > 0,
            settingsOpen(),
            currentAgents().length > 0,
            activeKey(),
          ] as const,
        () => {
          const target = currentTarget();
          if (!target) return;
          const serverID = target.serverID;
          if (
            !goRelevant() ||
            goLimitsInflight.has(serverID) ||
            Date.now() < (goLimitsAt.get(serverID) ?? 0)
          ) {
            return;
          }
          goLimitsAt.set(serverID, Date.now() + 6 * 60 * 60 * 1000);
          goLimitsInflight.add(serverID);
          setGoLimitsLoadingServer(serverID);
          void target.client
            .rpc(OmosConfig)
            .getGoMonthlyLimits(
              {},
              { location: { directory: target.directory } },
            )
            .then((value) => {
              const limits = value as unknown as GoMonthlyLimits;
              setGoLimitsByServer((previous) => ({
                ...previous,
                [serverID]: limits,
              }));
              goLimitsAt.set(
                serverID,
                Date.now() +
                  (limits.status === 'fresh'
                    ? 24 * 60 * 60 * 1000
                    : limits.status === 'stale'
                      ? 60 * 1000
                      : 6 * 60 * 60 * 1000),
              );
            })
            .catch(() => {
              // Published allowances are optional; model selection must always work.
            })
            .finally(() => {
              goLimitsInflight.delete(serverID);
              setGoLimitsLoadingServer((current) =>
                current === serverID ? '' : current,
              );
            });
        },
      ),
    );

    const goLimits = () => goLimitsByServer()[activeServerID()];
    const goLimitsLoading = () => goLimitsLoadingServer() === activeServerID();

    const goPlanLabel = () =>
      (
        GO_PLANS.find(
          (plan) => plan.id === ctx.stores.goPreferences.value.plan,
        ) ?? GO_PLANS[0]
      ).label;
    const goAllowance = (model: ModelShape) =>
      goCapForModel(
        goLimits()?.rows,
        ctx.stores.goPreferences.value.plan,
        modelValue(model),
      );
    const goCapLabel = (model: ModelShape) => {
      const allowance = goAllowance(model);
      return allowance.startsWith('$') ? `${allowance}/mo cap` : allowance;
    };
    /** Short cap for collapsed agent rows, matched by the stored model string. */
    const capForModel = (value?: string) =>
      goCapForModel(
        goLimits()?.rows,
        ctx.stores.goPreferences.value.plan,
        value,
      );
    const capShort = (value?: string) => {
      const allowance = capForModel(value);
      return allowance.startsWith('$') ? `${allowance}/mo` : allowance;
    };
    const goAllowanceHint = () =>
      ctx.t('panel.go.allowance', { plan: goPlanLabel() });
    const goSourceLabel = () => {
      const limits = goLimits();
      const date = limits?.updatedAt ? new Date(limits.updatedAt) : undefined;
      return [
        ctx.t('panel.go.source'),
        date && Number.isFinite(date.getTime())
          ? date.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })
          : '',
        limits?.status === 'stale' ? ctx.t('panel.go.cached') : '',
      ]
        .filter(Boolean)
        .join(' · ');
    };

    const modelPickerKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && agentDraft()?.modelPickerOpen) {
        event.preventDefault();
        event.stopPropagation();
        patchDraft({ modelPickerOpen: false });
        const root = event.currentTarget as HTMLElement;
        root.querySelector<HTMLButtonElement>('.omos-model-summary')?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const root = event.currentTarget as HTMLElement;
      const buttons = [
        ...root.querySelectorAll<HTMLButtonElement>(
          '.omos-model-option:not(:disabled)',
        ),
      ];
      if (!buttons.length) return;
      const target = event.target as HTMLElement;
      if (!target.matches('input, .omos-model-option')) return;
      event.preventDefault();
      const current = buttons.indexOf(target as HTMLButtonElement);
      const index =
        current < 0
          ? event.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length;
      buttons[index]?.focus();
    };

    const temperatureInvalid = createMemo(() => {
      const raw = agentDraft()?.temperature.trim() ?? '';
      if (!raw) return false;
      const value = Number(raw);
      return !Number.isFinite(value) || value < 0 || value > 2;
    });

    const optionsInvalid = createMemo(() => {
      const raw = agentDraft()?.options.trim() ?? '';
      if (!raw) return false;
      try {
        const parsed: unknown = JSON.parse(raw);
        return (
          typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
        );
      } catch {
        return true;
      }
    });

    const draftLatest = createMemo(() => {
      const draft = agentDraft();
      if (!draft) return undefined;
      return currentPreset()?.agents.find((agent) => agent.name === draft.name);
    });

    const draftDiff = createMemo(() => {
      const draft = agentDraft();
      if (!draft) return undefined;
      return diffDraft(draft.baseline, draft);
    });

    const draftDirty = () => Boolean(draftDiff()?.dirty);

    const draftConflict = createMemo(() => {
      const draft = agentDraft();
      const diff = draftDiff();
      if (!draft || !diff) {
        return {
          hasConflict: false,
          removed: false,
          fields: [] as DraftField[],
        };
      }
      const latest = draftLatest();
      // A new override has no persisted record yet; its absence is expected.
      if (draft.isNew && !latest) {
        return {
          hasConflict: false,
          removed: false,
          fields: [] as DraftField[],
        };
      }
      return draftConflicts(draft.baseline, latest, diff.fields);
    });

    const draftCanSave = () =>
      draftDirty() &&
      !draftConflict().hasConflict &&
      !temperatureInvalid() &&
      !optionsInvalid() &&
      !busy() &&
      canEditCurrent();

    const reloadDraftFromLatest = () => {
      const draft = agentDraft();
      const latest = draftLatest();
      if (!draft) return;
      if (!latest) {
        setAgentDraft(null);
        return;
      }
      const baseline: AgentBaseline = {
        model: latest.model ?? '',
        variant: latest.variant ?? '',
        ...(latest.temperature !== undefined
          ? { temperature: latest.temperature }
          : {}),
        ...(latest.optionsJson !== undefined
          ? { optionsJson: latest.optionsJson }
          : {}),
        ...(latest.modelChain ? { modelChain: [...latest.modelChain] } : {}),
        ...(latest.inheritModelFrom
          ? { inheritModelFrom: latest.inheritModelFrom }
          : {}),
        inherited: latest.inherited,
        ...(latest.skills ? { skills: [...latest.skills] } : {}),
        ...(latest.mcps ? { mcps: [...latest.mcps] } : {}),
      };
      setAgentDraft({
        ...draft,
        baseline,
        model: baseline.model,
        variant: baseline.variant,
        temperature:
          baseline.temperature !== undefined
            ? String(baseline.temperature)
            : '',
        options: compactJson(baseline.optionsJson ?? ''),
        optionsOpen: Boolean(baseline.optionsJson),
        modelReset: false,
        modelPickerOpen: false,
        modelQuery: '',
        confirmRemove: false,
      });
    };

    const saveAgentDraft = async () => {
      const draft = agentDraft();
      const diff = draftDiff();
      if (!draft || !diff || !draftCanSave()) return;
      const patch: OverridePatch = diff.patch;
      if (Object.keys(patch).length === 0) {
        setAgentDraft(null);
        return;
      }
      const target = panelTarget();
      if (!target || target.key !== draft.context) {
        setAgentDraft(null);
        notify('error', ctx.t('panel.error.noTarget'));
        return;
      }
      const saved = await setOverride(
        draft.name,
        patch,
        `Saving ${draft.name}…`,
        target,
      );
      if (saved && activeKey() === draft.context) setAgentDraft(null);
    };

    const chooseModel = (value: string) => {
      const draft = agentDraft();
      if (!draft) return;
      const model = modelList().find(
        (candidate) => modelValue(candidate) === value,
      );
      const variants = (model?.variants ?? [])
        .map((variant) => variant.id)
        .filter(Boolean);
      patchDraft({
        model: value,
        modelReset: false,
        modelPickerOpen: false,
        modelQuery: '',
        variant: variants.includes(draft.variant) ? draft.variant : '',
      });
    };

    const removeDraftAgent = async () => {
      const draft = agentDraft();
      const preset = currentPreset();
      if (!draft || draft.isNew || !preset || busy() || !canEditCurrent())
        return;
      const target = panelTarget();
      if (!target || target.key !== draft.context) {
        setAgentDraft(null);
        notify('error', ctx.t('panel.error.noTarget'));
        return;
      }
      const removed = await run(
        `Removing ${draft.name}…`,
        async (actionTarget) => {
          const result = asResult(
            await actionTarget.client.rpc(OmosConfig).removeAgent(
              {
                preset: preset.name,
                agent: draft.name,
                directory: actionTarget.directory,
              },
              { location: { directory: actionTarget.directory } },
            ),
          );
          if (!result.ok) throw new Error(result.message);
          return result.message;
        },
        { target },
      );
      if (removed && activeKey() === draft.context) setAgentDraft(null);
    };

    const editorOptionsLabel = () => {
      const draft = agentDraft();
      if (!draft) return ctx.t('panel.addOptions');
      if (draft.optionsOpen) return ctx.t('panel.hideOptions');
      return draft.options.trim()
        ? ctx.t('panel.editOptions')
        : ctx.t('panel.addOptions');
    };

    const renderAgentEditor = () => {
      const draft = agentDraft;
      const original = draftOriginal;
      const variants = draftVariants;
      const groups = modelGroups;
      const modelFound = draftModelFound;
      const tempBad = temperatureInvalid;
      const optionsBad = optionsInvalid;
      const chain = () => original()?.modelChain ?? [];
      /** Slider position: 0 is "Default", 1..n map to the model's variants. */
      const variantIndex = () => {
        const list = variants();
        if (!list.length) return 0;
        const current = draft()?.variant ?? '';
        const index = list.indexOf(current);
        return index < 0 ? 0 : index + 1;
      };

      return (
        <>
          <Show when={!draft()?.isNew && original()?.inherited}>
            <div class="omos-field-hint">{ctx.t('panel.inheritedHint')}</div>
          </Show>

          <section
            class="omos-model-picker"
            aria-label={ctx.t('panel.editor.title', {
              name: draft()?.name ?? '',
            })}
            onKeyDown={modelPickerKey}
          >
            <div class="omos-field omos-model-field">
              <div class="omos-field-label">{ctx.t('panel.model')}</div>
              <div class="omos-model-anchor">
                <button
                  type="button"
                  class="omos-model-summary"
                  aria-expanded={draft()?.modelPickerOpen}
                  aria-label={`${ctx.t('panel.changeModel')}: ${draft()?.model || ctx.t('panel.presetDefault')}`}
                  disabled={busy()}
                  onClick={() =>
                    patchDraft({ modelPickerOpen: !draft()?.modelPickerOpen })
                  }
                >
                  <span class="omos-model-summary-text">
                    <span class="omos-model-summary-name">
                      {splitModel(draft()?.model).model ||
                        ctx.t('panel.presetDefault')}
                    </span>
                    <span class="omos-model-summary-provider">
                      {splitModel(draft()?.model).provider ||
                        ctx.t('panel.useInheritedModel')}
                    </span>
                  </span>
                  <span
                    class="omos-agent-caret"
                    classList={{ 'is-open': draft()?.modelPickerOpen }}
                  >
                    <ui.Icon name="chevron-down" size="small" />
                  </span>
                </button>
                <Show when={draft()?.modelPickerOpen}>
                  <section
                    class="omos-popover omos-model-menu"
                    data-mode={ctx.appearance.mode()}
                    aria-label={ctx.t('panel.searchModels')}
                  >
                    <div class="omos-model-search">
                      <ui.TextInput
                        type="search"
                        value={draft()?.modelQuery ?? ''}
                        onInput={(value) => patchDraft({ modelQuery: value })}
                        label={ctx.t('panel.searchModels')}
                        placeholder={ctx.t('panel.searchModels')}
                        class="omos-model-search-input"
                        autofocus
                        disabled={busy()}
                      />
                      <div class="omos-model-results">
                        {ctx.t('panel.modelResults', {
                          count: String(
                            groups().reduce(
                              (total, group) => total + group.models.length,
                              0,
                            ),
                          ),
                        })}
                      </div>
                    </div>
                    <div class="omos-model-list">
                      <Show
                        when={modelsLoading()}
                        fallback={
                          <Show
                            when={!modelsError()}
                            fallback={
                              <div class="omos-editor-state is-error">
                                <span>{modelsError()}</span>
                                <ui.Button
                                  variant="ghost"
                                  size="small"
                                  onClick={() => void loadModels()}
                                >
                                  {ctx.t('panel.retry')}
                                </ui.Button>
                              </div>
                            }
                          >
                            <Show
                              when={groups().length > 0}
                              fallback={
                                <div class="omos-editor-state">
                                  {modelList().length === 0
                                    ? ctx.t('panel.error.noModels')
                                    : ctx.t('panel.noModelsMatch', {
                                        query: draft()?.modelQuery ?? '',
                                      })}
                                </div>
                              }
                            >
                              <For each={groups()}>
                                {(group) => (
                                  <div class="omos-model-group">
                                    <div class="omos-model-provider">
                                      {modelGroupLabel(group)}
                                    </div>
                                    <For each={group.models}>
                                      {(model) => {
                                        const value = modelValue(model);
                                        return (
                                          <button
                                            type="button"
                                            class="omos-model-option"
                                            classList={{
                                              'is-current':
                                                draft()?.model === value,
                                            }}
                                            aria-pressed={
                                              draft()?.model === value
                                            }
                                            title={[
                                              value,
                                              goAllowance(model)
                                                ? `${goAllowance(model)} — ${goAllowanceHint()}`
                                                : '',
                                            ]
                                              .filter(Boolean)
                                              .join('\n')}
                                            disabled={busy()}
                                            onClick={(event) => {
                                              const picker =
                                                event.currentTarget.closest(
                                                  '.omos-model-picker',
                                                );
                                              chooseModel(value);
                                              picker
                                                ?.querySelector<HTMLButtonElement>(
                                                  '.omos-model-summary',
                                                )
                                                ?.focus();
                                            }}
                                          >
                                            <span class="omos-model-option-name">
                                              {model.name ?? model.id}
                                            </span>
                                            <Show when={goAllowance(model)}>
                                              <span
                                                class="omos-model-cap"
                                                title={`${goAllowance(model)} — ${goAllowanceHint()}`}
                                              >
                                                {goCapLabel(model)}
                                              </span>
                                            </Show>
                                            <Show
                                              when={draft()?.model === value}
                                            >
                                              <ui.Icon
                                                name="check"
                                                size="small"
                                                class="omos-model-check"
                                              />
                                            </Show>
                                          </button>
                                        );
                                      }}
                                    </For>
                                  </div>
                                )}
                              </For>
                            </Show>
                          </Show>
                        }
                      >
                        <div class="omos-editor-state">
                          <ui.Loader size="small" />
                          <span>{ctx.t('panel.loadingModels')}</span>
                        </div>
                      </Show>
                    </div>
                    <button
                      type="button"
                      class="omos-model-close"
                      onClick={(event) => {
                        const picker =
                          event.currentTarget.closest('.omos-model-picker');
                        patchDraft({ modelPickerOpen: false });
                        picker
                          ?.querySelector<HTMLButtonElement>(
                            '.omos-model-summary',
                          )
                          ?.focus();
                      }}
                    >
                      {ctx.t('panel.closeModels')}
                    </button>
                  </section>
                </Show>
              </div>
              <Show
                when={
                  !draft()?.isNew &&
                  !draft()?.model &&
                  (original()?.inherited || original()?.inheritModelFrom)
                }
              >
                <div class="omos-field-hint">
                  {original()?.inheritModelFrom
                    ? ctx.t('panel.inheritHint', {
                        name: original()?.inheritModelFrom ?? '',
                      })
                    : ctx.t('panel.inheritHintDefault')}
                </div>
              </Show>
              <Show when={!draft()?.isNew}>
                <div
                  class="omos-model-inherit"
                  title={ctx.t('panel.inheritToggle')}
                >
                  <span aria-hidden="true">{ctx.t('panel.inheritToggle')}</span>
                  <ui.Switch
                    checked={!draft()?.model}
                    label={ctx.t('panel.inheritToggle')}
                    hideLabel
                    disabled={busy()}
                    onChange={(next) => {
                      if (next) {
                        patchDraft({
                          model: '',
                          modelReset: true,
                          modelPickerOpen: false,
                          modelQuery: '',
                        });
                      } else {
                        patchDraft({ modelPickerOpen: true });
                      }
                    }}
                  />
                </div>
              </Show>
              <Show
                when={
                  !modelsLoading() &&
                  modelList().length > 0 &&
                  Boolean(draft()?.model) &&
                  !modelFound()
                }
              >
                <div class="omos-field-hint is-warn">
                  {ctx.t('panel.modelUnavailable')}
                </div>
              </Show>
              <Show when={chain().length > 1 && !draft()?.modelReset}>
                <div class="omos-field-hint is-warn">
                  {ctx.t('panel.modelChainWarning', {
                    chain: chain().join(' → '),
                  })}
                </div>
              </Show>
            </div>
          </section>

          <Show when={draft()?.model && !modelsLoading() && modelFound()}>
            <div class="omos-field">
              <div class="omos-field-label-row">
                <span class="omos-field-label">{ctx.t('panel.variant')}</span>
                <span class="omos-variant-value">
                  {draft()?.variant || ctx.t('panel.variantDefault')}
                </span>
              </div>
              <Show
                when={variants().length > 0}
                fallback={
                  <div class="omos-field-hint">{ctx.t('panel.noVariants')}</div>
                }
              >
                <div
                  class="omos-range"
                  style={{
                    '--omos-range-fill': `${variants().length ? (variantIndex() / variants().length) * 100 : 0}%`,
                  }}
                >
                  <input
                    type="range"
                    class="omos-variant-slider"
                    min="0"
                    max={variants().length}
                    step="1"
                    value={variantIndex()}
                    aria-label={ctx.t('panel.variant')}
                    aria-valuetext={
                      draft()?.variant || ctx.t('panel.variantDefault')
                    }
                    disabled={busy()}
                    onInput={(event) => {
                      const index = Number(event.currentTarget.value);
                      patchDraft({
                        variant:
                          index <= 0 ? '' : (variants()[index - 1] ?? ''),
                      });
                    }}
                  />
                  <div class="omos-range-dots" aria-hidden="true">
                    <For each={Array.from({ length: variants().length + 1 })}>
                      {(_entry, index) => (
                        <span
                          classList={{ 'is-filled': index() <= variantIndex() }}
                          style={{
                            left: `calc(8px + (100% - 16px) * ${index() / variants().length})`,
                          }}
                        />
                      )}
                    </For>
                  </div>
                </div>
                <div class="omos-variant-ticks" aria-hidden="true">
                  <span>{ctx.t('panel.variantDefault')}</span>
                  <span>{variants()[variants().length - 1]}</span>
                </div>
              </Show>
            </div>
          </Show>

          <ui.Button
            variant="ghost"
            size="small"
            icon={draft()?.moreOpen ? 'chevron-down' : 'chevron-right'}
            class="omos-more-toggle"
            aria-expanded={draft()?.moreOpen}
            onClick={() => patchDraft({ moreOpen: !draft()?.moreOpen })}
          >
            {ctx.t(draft()?.moreOpen ? 'panel.less' : 'panel.more')}
          </ui.Button>

          <Show when={draft()?.moreOpen}>
            <div class="omos-field-row">
              <div class="omos-field omos-field-grow">
                <div class="omos-field-label">{ctx.t('panel.temperature')}</div>
                <ui.TextInput
                  value={draft()?.temperature ?? ''}
                  onInput={(value) => patchDraft({ temperature: value })}
                  label={ctx.t('panel.temperature')}
                  placeholder={ctx.t('panel.temperature.placeholder')}
                  invalid={tempBad()}
                  disabled={busy()}
                  class="omos-temp-input"
                />
              </div>
              <Show when={(draft()?.temperature.trim().length ?? 0) > 0}>
                <ui.Button
                  variant="ghost"
                  size="small"
                  disabled={busy()}
                  onClick={() => patchDraft({ temperature: '' })}
                >
                  {ctx.t('panel.clear')}
                </ui.Button>
              </Show>
            </div>
            <Show when={tempBad()}>
              <div class="omos-field-error">
                {ctx.t('panel.temperature.invalid')}
              </div>
            </Show>

            <div class="omos-field">
              <div class="omos-editor-section-head">
                <span class="omos-field-label">{ctx.t('panel.options')}</span>
                <ui.Button
                  variant="ghost"
                  size="small"
                  disabled={busy()}
                  onClick={() =>
                    patchDraft({ optionsOpen: !agentDraft()?.optionsOpen })
                  }
                >
                  {editorOptionsLabel()}
                </ui.Button>
              </div>
              <Show when={draft()?.optionsOpen}>
                <textarea
                  class="omos-json-editor"
                  classList={{ 'is-invalid': optionsBad() }}
                  value={draft()?.options ?? ''}
                  placeholder={OPTIONS_EXAMPLE}
                  aria-label={ctx.t('panel.options')}
                  spellcheck={false}
                  disabled={busy()}
                  onInput={(event) =>
                    patchDraft({ options: event.currentTarget.value })
                  }
                />
                <div
                  class="omos-field-hint"
                  classList={{ 'is-error': optionsBad() }}
                >
                  {optionsBad()
                    ? ctx.t('panel.options.invalid')
                    : ctx.t('panel.options.desc')}
                </div>
              </Show>
              <Show when={!draft()?.optionsOpen && optionsBad()}>
                <div class="omos-field-hint is-error">
                  {ctx.t('panel.options.invalid')}
                </div>
              </Show>
            </div>

            <Show when={original()?.skills?.length || original()?.mcps?.length}>
              <div class="omos-editor-meta">
                <Show when={original()?.skills?.length}>
                  <span
                    class="omos-tag is-static"
                    title={original()?.skills?.join(', ')}
                  >
                    <span class="k">{ctx.t('panel.skills')}</span>
                    <span class="v">{original()?.skills?.length}</span>
                  </span>
                </Show>
                <Show when={original()?.mcps?.length}>
                  <span
                    class="omos-tag is-static"
                    title={original()?.mcps?.join(', ')}
                  >
                    <span class="k">{ctx.t('panel.mcps')}</span>
                    <span class="v">{original()?.mcps?.length}</span>
                  </span>
                </Show>
              </div>
            </Show>

            <Show when={!draft()?.isNew}>
              <Show
                when={!draft()?.confirmRemove}
                fallback={
                  <div class="omos-confirm-row is-danger">
                    <span class="omos-confirm-text">
                      {ctx.t('panel.remove.title', {
                        name: draft()?.name ?? '',
                      })}
                    </span>
                    <ui.Button
                      variant="ghost"
                      size="small"
                      disabled={busy()}
                      onClick={() => patchDraft({ confirmRemove: false })}
                    >
                      {ctx.t('panel.cancel')}
                    </ui.Button>
                    <ui.Button
                      variant="danger"
                      size="small"
                      disabled={busy()}
                      onClick={() => void removeDraftAgent()}
                    >
                      {ctx.t('panel.remove.confirm')}
                    </ui.Button>
                  </div>
                }
              >
                <ui.Button
                  variant="ghost"
                  size="small"
                  icon="outline-trash"
                  class="omos-remove-btn"
                  disabled={busy()}
                  onClick={() => patchDraft({ confirmRemove: true })}
                >
                  {ctx.t('panel.removeAgent')}
                </ui.Button>
              </Show>
            </Show>
          </Show>

          <Show when={draftConflict().hasConflict}>
            <div class="omos-confirm-row is-danger">
              <span class="omos-confirm-text" role="alert">
                {ctx.t('panel.draft.conflict')}
              </span>
              <ui.Button
                variant="ghost"
                size="small"
                disabled={busy()}
                onClick={reloadDraftFromLatest}
              >
                {ctx.t('panel.draft.reload')}
              </ui.Button>
              <ui.Button
                variant="ghost"
                size="small"
                disabled={busy()}
                onClick={() => setAgentDraft(null)}
              >
                {ctx.t('panel.draft.discard')}
              </ui.Button>
            </div>
          </Show>

          <div class="omos-editor-footer">
            <span
              class="omos-save-scope"
              title={ctx.t('panel.saveScope', { name: editTarget() })}
            >
              {ctx.t('panel.presetOnly')}
            </span>
            <div class="omos-editor-actions">
              <ui.Button
                variant="ghost"
                size="small"
                disabled={busy()}
                onClick={() => setAgentDraft(null)}
              >
                {ctx.t('panel.cancel')}
              </ui.Button>
              <Show when={draftDirty()}>
                <ui.Button
                  variant="contrast"
                  size="small"
                  busy={busy()}
                  disabled={!draftCanSave()}
                  onClick={() => void saveAgentDraft()}
                >
                  {ctx.t('panel.saveOverride')}
                </ui.Button>
              </Show>
            </div>
          </div>
        </>
      );
    };

    const newPresetSourceHint = () => {
      const draft = newPreset();
      if (!draft) return '';
      return draft.source
        ? ctx.t('panel.create.copyDesc', { name: draft.source })
        : ctx.t('panel.create.blankDesc');
    };

    ctx.add(
      Command,
      (): Command => ({
        id: 'refresh',
        title: ctx.t('command.refresh'),
        run: () => void hardRefresh(),
      }),
    );

    ctx.add(
      Command,
      (): Command => ({
        id: 'open',
        title: ctx.t('command.open'),
        run: () => {
          const session = ctx.sessions.current();
          if (session) ctx.layout.open(`${ctx.id}:main`, session);
        },
      }),
    );

    /**
     * Switch the panel's workspace as one unit. Any staged deletion belongs to
     * the workspace that was open, so commit it before the target changes; the
     * draft closes because its baseline belongs to the old workspace/preset.
     */
    function enterWorkspace(
      session: MountedSession,
      directory: string,
    ): { key: string; changed: boolean } {
      const key = workspaceKey(session.server.id, directory);
      const changed = activeKey() !== key;
      if (changed) {
        // Hidden staged deletions still commit against their own captured
        // workspace target before the panel reroutes.
        void commitPendingDeletes();
        setPresetMenuOpen(false);
        setNewMenuOpen(false);
        setSettingsOpen(false);
        setDeleteConfirmName(null);
        setActiveServerID(session.server.id);
        setActiveDirectory(directory);
        resetWorkspaceView(key);
      }
      panelSession = session;
      return { key, changed };
    }

    const mainTab: PanelTab = {
      id: 'main',
      get title() {
        return ctx.t('panel.title');
      },
      closable: 'compact',
      fallback: true,
    };

    ctx.add(Panel, {
      id: 'main',
      region: 'side',
      list: (input) => (input.open.includes('main') ? [mainTab] : []),
      focus: (input) => {
        const directory = input.session.location?.directory;
        if (!directory) return;
        const { key, changed } = enterWorkspace(input.session, directory);
        const target = targetFor(input.session, directory);
        void requestSnapshot(target, Boolean(snapshots()[key]) || changed);
        void requestSessionRead(input.session, directory, { force: true });
      },
      render: (props) => {
        createEffect(() => {
          const session = props.session;
          const directory = session.location?.directory;
          // Track the server identity as well: switching a tab to the same
          // workspace on another machine must reset the draft and caches.
          const serverID = session.server.id;
          untrack(() => {
            if (!directory) {
              panelSession = session;
              return;
            }
            const { key, changed } = enterWorkspace(session, directory);
            const target = targetFor(session, directory);
            const controller = new AbortController();
            onCleanup(() => {
              controller.abort();
              if (panelSession === session) panelSession = undefined;
            });
            if (serverID !== target.serverID) return;
            void requestSnapshot(target, changed || Boolean(snapshots()[key]));
            void requestSessionRead(session, directory, {
              force: true,
              signal: controller.signal,
            });
          });
        });

        const panelDirectory = () => props.session.location?.directory ?? '';
        const panelKey = () =>
          panelDirectory()
            ? workspaceKey(props.session.server.id, panelDirectory())
            : '';
        const panelContextReady = () =>
          Boolean(activeSnapshot()) &&
          panelDirectory().length > 0 &&
          activeKey() === panelKey();
        const panelError = () =>
          activeKey() === panelKey() ? activeError() : '';
        const panelConfigUnsupported = () =>
          activeKey() === panelKey() ? activeUnsupported() : false;
        const panelSessionKey = () => {
          const directory = panelDirectory();
          return directory ? sessionScopeKey(props.session, directory) : '';
        };
        const panelRead = () => {
          const key = panelSessionKey();
          return key ? sessionReads()[key] : undefined;
        };
        const panelBinding = () => {
          const read = panelRead();
          return read?.status === 'ready' && read.state
            ? sessionBinding(read.state)
            : undefined;
        };
        const panelUnbindUnsupported = () => {
          const key = panelSessionKey();
          return key ? Boolean(unbindUnsupported()[key]) : false;
        };
        const sessionReady = () => panelRead()?.status === 'ready';
        const sessionStatusText = () => {
          if (!panelDirectory()) return ctx.t('panel.session.locationUnknown');
          const read = panelRead();
          if (!read || read.status === 'loading')
            return ctx.t('panel.session.loading');
          if (read.status === 'unsupported')
            return ctx.t('panel.session.unsupported');
          if (read.status === 'error') return ctx.t('panel.session.error');
          const binding = panelBinding();
          if (!binding || binding.kind === 'none')
            return ctx.t('panel.session.none');
          if (binding.kind === 'default-team') {
            return binding.presetName ?? ctx.t('panel.defaultTeam');
          }
          return binding.presetName;
        };
        const retryPanelSession = () => {
          const directory = panelDirectory();
          if (directory)
            void requestSessionRead(props.session, directory, { force: true });
        };

        return (
          <div class="omos-panel" style={{ '--omos-pop-bg': popoverBase() }}>
            <Show when={busy()}>
              <div class="omos-progress" aria-hidden="true">
                <span />
              </div>
            </Show>

            <header class="omos-head">
              <div class="omos-brand" aria-hidden="true">
                <ui.Icon name="sliders" size="small" />
              </div>
              <div class="omos-title-wrap">
                <div class="omos-title-line">
                  <h1 class="omos-title">{ctx.t('panel.title')}</h1>
                  <Show when={versionLabel()}>
                    <span class="omos-version" title="oh-my-opencode-slim">
                      {versionLabel()}
                    </span>
                  </Show>
                </div>
                <div class="omos-subtitle">{ctx.t('panel.subtitle')}</div>
              </div>
              <div class="omos-head-actions">
                <div class="omos-menu-anchor">
                  <ui.Button
                    variant="ghost"
                    size="small"
                    icon="plus-small"
                    class="omos-new-btn"
                    aria-expanded={newMenuOpen()}
                    disabled={
                      busy() || !panelContextReady() || panelConfigUnsupported()
                    }
                    onClick={() => {
                      if (presetMenuOpen()) closePresetMenu();
                      setSettingsOpen(false);
                      setNewMenuOpen((open) => !open);
                    }}
                  >
                    {ctx.t('panel.new')}
                  </ui.Button>
                  <Show when={newMenuOpen()}>
                    <div
                      class="omos-popover omos-new-menu"
                      data-mode={ctx.appearance.mode()}
                      role="menu"
                      aria-label={ctx.t('panel.new')}
                    >
                      <button
                        type="button"
                        class="omos-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          startNewPreset('');
                        }}
                      >
                        <ui.Icon name="plus-small" size="small" />
                        <span>{ctx.t('panel.create.blank')}</span>
                      </button>
                      <Show when={currentPreset()}>
                        {(preset) => (
                          <button
                            type="button"
                            class="omos-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setNewMenuOpen(false);
                              startNewPreset(preset().name);
                            }}
                          >
                            <ui.Icon name="copy" size="small" />
                            <span>
                              {ctx.t('panel.duplicateNamed', {
                                name: preset().name,
                              })}
                            </span>
                          </button>
                        )}
                      </Show>
                      <Show
                        when={(activeSnapshot()?.presets ?? []).filter(
                          (preset) => preset.name !== currentPreset()?.name,
                        )}
                      >
                        {(others) => (
                          <>
                            <div class="omos-menu-group">
                              {ctx.t('panel.create.copyGroup')}
                            </div>
                            <For each={others()}>
                              {(preset) => (
                                <button
                                  type="button"
                                  class="omos-menu-item"
                                  role="menuitem"
                                  onClick={() => {
                                    setNewMenuOpen(false);
                                    startNewPreset(preset.name);
                                  }}
                                >
                                  <ui.Icon name="copy" size="small" />
                                  <span class="omos-menu-item-name">
                                    {preset.name}
                                  </span>
                                </button>
                              )}
                            </For>
                          </>
                        )}
                      </Show>
                    </div>
                  </Show>
                </div>
                <div class="omos-menu-anchor">
                  <ui.Tooltip value={ctx.t('panel.settings')}>
                    <ui.IconButton
                      icon="settings-gear"
                      label={ctx.t('panel.settings')}
                      size="small"
                      aria-expanded={settingsOpen()}
                      onClick={() => {
                        setNewMenuOpen(false);
                        if (presetMenuOpen()) closePresetMenu();
                        setSettingsOpen((open) => !open);
                      }}
                    />
                  </ui.Tooltip>
                  <Show when={settingsOpen()}>
                    <div
                      class="omos-popover omos-settings-menu"
                      data-mode={ctx.appearance.mode()}
                    >
                      <div class="omos-menu-group">
                        {ctx.t('panel.settings.go')}
                      </div>
                      <div
                        class="omos-segmented omos-go-plans"
                        role="toolbar"
                        aria-label={ctx.t('panel.go.plan')}
                        title={ctx.t('panel.settings.planHint')}
                      >
                        <For each={GO_PLANS}>
                          {(plan) => (
                            <button
                              type="button"
                              class="omos-segment"
                              classList={{
                                'is-selected':
                                  ctx.stores.goPreferences.value.plan ===
                                  plan.id,
                              }}
                              aria-pressed={
                                ctx.stores.goPreferences.value.plan === plan.id
                              }
                              onClick={() =>
                                ctx.stores.goPreferences.set({ plan: plan.id })
                              }
                            >
                              {plan.label}
                            </button>
                          )}
                        </For>
                      </div>
                      <div class="omos-go-note">{ctx.t('panel.go.note')}</div>
                      <Show
                        when={!goLimitsLoading()}
                        fallback={
                          <div class="omos-go-note">
                            {ctx.t('panel.go.loading')}
                          </div>
                        }
                      >
                        <Show
                          when={goLimits()?.rows.length}
                          fallback={
                            <div class="omos-go-note">
                              {ctx.t('panel.go.unavailable')}
                            </div>
                          }
                        >
                          <button
                            type="button"
                            class="omos-go-source"
                            title={goLimits()?.updatedAt}
                            onClick={() => {
                              const url = goLimits()?.sourceURL;
                              if (url) ctx.system.openExternal(url);
                            }}
                          >
                            {goSourceLabel()}{' '}
                            <ui.Icon
                              name="square-arrow-top-right"
                              size="small"
                              class="omos-go-source-icon"
                            />
                          </button>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                </div>
                <ui.Tooltip value={ctx.t('panel.refresh')}>
                  <ui.IconButton
                    icon="refresh"
                    label={ctx.t('panel.refresh')}
                    size="small"
                    busy={busy()}
                    onClick={() => {
                      const directory = panelDirectory();
                      if (directory) {
                        void hardRefresh(targetFor(props.session, directory));
                      }
                    }}
                  />
                </ui.Tooltip>
              </div>
            </header>

            <div
              class="omos-body"
              ref={(element) => {
                setBodyEl(element);
              }}
            >
              <Show
                when={
                  panelContextReady() && !panelConfigUnsupported()
                    ? activeSnapshot()
                    : undefined
                }
                fallback={
                  <Show
                    when={panelConfigUnsupported()}
                    fallback={
                      <Show
                        when={panelError()}
                        fallback={
                          <div class="omos-state">
                            <ui.Loader size="large" />
                            <div class="omos-state-title">
                              {ctx.t('panel.loading')}
                            </div>
                            <p>{ctx.t('panel.loadingHint')}</p>
                          </div>
                        }
                      >
                        <div class="omos-state is-error">
                          <span class="omos-state-icon">
                            <ui.Icon name="circle-exclamation" size="large" />
                          </span>
                          <div class="omos-state-title">
                            {ctx.t('panel.error.title')}
                          </div>
                          <p>{panelError()}</p>
                          <ui.Button
                            size="small"
                            disabled={busy()}
                            onClick={() => {
                              const directory = panelDirectory();
                              if (directory) {
                                void hardRefresh(
                                  targetFor(props.session, directory),
                                );
                              }
                            }}
                          >
                            {ctx.t('panel.retry')}
                          </ui.Button>
                        </div>
                      </Show>
                    }
                  >
                    <div class="omos-state is-error">
                      <span class="omos-state-icon">
                        <ui.Icon name="circle-exclamation" size="large" />
                      </span>
                      <div class="omos-state-title">
                        {ctx.t('panel.configUnavailable.title')}
                      </div>
                      <p>{ctx.t('panel.configUnavailable.desc')}</p>
                      <ui.Button
                        size="small"
                        disabled={busy()}
                        onClick={() => {
                          const directory = panelDirectory();
                          if (directory) {
                            void hardRefresh(
                              targetFor(props.session, directory),
                            );
                          }
                        }}
                      >
                        {ctx.t('panel.retry')}
                      </ui.Button>
                    </div>
                  </Show>
                }
              >
                {(state) => (
                  <>
                    <Show
                      when={
                        state().envOverride ||
                        !state().found ||
                        Boolean(panelError()) ||
                        state().warnings.length > 0
                      }
                    >
                      <div class="omos-notices">
                        <Show
                          when={
                            state().envOverride || Boolean(state().envPreset)
                          }
                        >
                          <div class="omos-notice is-warn">
                            <ui.Icon
                              name="warning"
                              size="small"
                              class="omos-notice-icon"
                            />
                            <span>
                              {state().envPreset
                                ? ctx.t('panel.banner.envNamed', {
                                    name: state().envPreset,
                                  })
                                : ctx.t('panel.banner.env')}
                            </span>
                          </div>
                        </Show>
                        <Show when={!state().found}>
                          <div
                            class="omos-notice is-info"
                            title={state().projectConfigPaths.join('\n')}
                          >
                            <ui.Icon
                              name="info"
                              size="small"
                              class="omos-notice-icon"
                            />
                            <span>
                              {ctx.t('panel.banner.missing')}
                              <Show when={state().configPath}>
                                <code class="omos-path">
                                  {state().configPath}
                                </code>
                              </Show>
                            </span>
                          </div>
                        </Show>
                        <For each={state().warnings}>
                          {(warning) => (
                            <div class="omos-notice is-warn">
                              <ui.Icon
                                name="warning"
                                size="small"
                                class="omos-notice-icon"
                              />
                              <span>{warning}</span>
                            </div>
                          )}
                        </For>
                        <Show when={panelError()}>
                          <div class="omos-notice is-danger">
                            <ui.Icon
                              name="circle-exclamation"
                              size="small"
                              class="omos-notice-icon"
                            />
                            <span>{panelError()}</span>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <div
                      class="omos-tabs"
                      role="tablist"
                      aria-label={ctx.t('panel.title')}
                      onKeyDown={(event) => {
                        if (
                          event.key !== 'ArrowLeft' &&
                          event.key !== 'ArrowRight'
                        ) {
                          return;
                        }
                        event.preventDefault();
                        const next =
                          tab() === 'workbench' ? 'roster' : 'workbench';
                        switchTab(next);
                        const root = event.currentTarget;
                        queueMicrotask(() => {
                          root
                            .querySelector<HTMLButtonElement>(
                              `#omos-tab-${next}`,
                            )
                            ?.focus();
                        });
                      }}
                    >
                      <button
                        type="button"
                        role="tab"
                        id="omos-tab-workbench"
                        aria-selected={tab() === 'workbench'}
                        aria-controls="omos-workbench"
                        tabIndex={tab() === 'workbench' ? 0 : -1}
                        class="omos-tab"
                        classList={{ 'is-active': tab() === 'workbench' }}
                        onClick={() => switchTab('workbench')}
                      >
                        <ui.Icon
                          name="sliders"
                          size="small"
                          class="omos-tab-icon"
                        />
                        <span>{ctx.t('panel.tab.workbench')}</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="omos-tab-roster"
                        aria-selected={tab() === 'roster'}
                        aria-controls="omos-roster"
                        tabIndex={tab() === 'roster' ? 0 : -1}
                        class="omos-tab"
                        classList={{ 'is-active': tab() === 'roster' }}
                        onClick={() => switchTab('roster')}
                      >
                        <ui.Icon
                          name="providers"
                          size="small"
                          class="omos-tab-icon"
                        />
                        <span>{ctx.t('panel.tab.roster')}</span>
                      </button>
                    </div>

                    <Show
                      when={tab() === 'workbench'}
                      fallback={
                        <div
                          class="omos-roster"
                          id="omos-roster"
                          role="tabpanel"
                          aria-labelledby="omos-tab-roster"
                        >
                          <div class="omos-roster-intro">
                            <span class="omos-intro-icon">
                              <ui.Icon name="providers" size="normal" />
                            </span>
                            <div>
                              <div class="omos-intro-title">
                                {ctx.t('panel.roster.title')}
                              </div>
                              <p>{ctx.t('panel.roster.desc')}</p>
                            </div>
                          </div>
                          <div class="omos-roster-summary">
                            <span>
                              <strong>{enabledCount()}</strong> of{' '}
                              {roster().length} enabled
                            </span>
                            <span class="omos-muted">Global setting</span>
                          </div>
                          <div class="omos-roster-list">
                            <For each={state().roster}>
                              {(agent) => {
                                const protectedAgent = () => agent.protected;
                                const enabled = () =>
                                  !isAgentDisabled(agent.name);
                                return (
                                  <div
                                    class="omos-roster-row"
                                    classList={{
                                      'is-protected': protectedAgent(),
                                      'is-off': !protectedAgent() && !enabled(),
                                    }}
                                  >
                                    <div class="omos-roster-main">
                                      <div class="omos-roster-name">
                                        <span>{agent.name}</span>
                                        <Show when={agent.primary}>
                                          <span
                                            class="omos-mini-tag"
                                            title={ctx.t(
                                              'panel.roster.primaryHint',
                                            )}
                                          >
                                            {ctx.t('panel.roster.primary')}
                                          </span>
                                        </Show>
                                      </div>
                                      <div
                                        class="omos-roster-role"
                                        title={agent.description}
                                      >
                                        {agent.description}
                                      </div>
                                    </div>
                                    <div class="omos-roster-toggle">
                                      <Show
                                        when={!protectedAgent()}
                                        fallback={
                                          <span
                                            class="omos-lock-chip"
                                            title={ctx.t('panel.protected')}
                                          >
                                            <ui.Icon name="lock" size="small" />
                                          </span>
                                        }
                                      >
                                        <ui.Switch
                                          checked={enabled()}
                                          onChange={(next) =>
                                            void toggleAgent(agent.name, !next)
                                          }
                                          label={agent.name}
                                          hideLabel
                                          disabled={busy()}
                                        />
                                      </Show>
                                    </div>
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </div>
                      }
                    >
                      <div
                        class="omos-workbench"
                        id="omos-workbench"
                        role="tabpanel"
                        aria-labelledby="omos-tab-workbench"
                      >
                        <Show when={newPreset()}>
                          <div class="omos-new-preset">
                            <div class="omos-new-preset-head">
                              <span class="omos-label">
                                {ctx.t('panel.newPreset')}
                              </span>
                            </div>
                            <div class="omos-new-preset-hint">
                              {newPresetSourceHint()}
                            </div>
                            <ui.TextInput
                              value={newPreset()?.name ?? ''}
                              onInput={(value) =>
                                setNewPreset((draft) =>
                                  draft
                                    ? { ...draft, name: value, error: '' }
                                    : draft,
                                )
                              }
                              label={ctx.t('panel.create.name')}
                              placeholder={ctx.t(
                                'panel.create.namePlaceholder',
                              )}
                              autofocus
                              invalid={Boolean(newPreset()?.error)}
                              disabled={busy()}
                              onSubmit={() => void submitNewPreset()}
                            />
                            <Show when={newPreset()?.error}>
                              <div class="omos-field-error">
                                {newPreset()?.error}
                              </div>
                            </Show>
                            <div class="omos-form-actions">
                              <ui.Button
                                variant="ghost"
                                size="small"
                                disabled={busy()}
                                onClick={() => setNewPreset(null)}
                              >
                                {ctx.t('panel.cancel')}
                              </ui.Button>
                              <ui.Button
                                variant="contrast"
                                size="small"
                                disabled={busy()}
                                onClick={() => void submitNewPreset()}
                              >
                                {ctx.t('panel.create.submit')}
                              </ui.Button>
                            </div>
                          </div>
                        </Show>

                        <Show
                          when={state().presets.length > 0}
                          fallback={
                            <div class="omos-empty">
                              <span class="omos-empty-icon">
                                <ui.Icon name="plus" size="large" />
                              </span>
                              <div class="omos-empty-title">
                                {ctx.t('panel.empty.title')}
                              </div>
                              <p>{ctx.t('panel.empty.desc')}</p>
                              <ui.Button
                                variant="contrast"
                                size="small"
                                icon="plus-small"
                                disabled={busy()}
                                onClick={() => startNewPreset('')}
                              >
                                {ctx.t('panel.empty.action')}
                              </ui.Button>
                            </div>
                          }
                        >
                          <section
                            class="omos-presets"
                            classList={{ 'is-menu-open': presetMenuOpen() }}
                            aria-label={ctx.t('panel.presets')}
                          >
                            <div class="omos-preset-select">
                              <span
                                class="omos-label"
                                title={ctx.t('panel.inspectHint')}
                              >
                                {ctx.t('panel.presetLabel')}
                              </span>
                              <button
                                type="button"
                                class="omos-preset-trigger"
                                aria-expanded={presetMenuOpen()}
                                disabled={busy()}
                                title={
                                  state().presets.find(
                                    (preset) => preset.name === editTarget(),
                                  )?.description || undefined
                                }
                                onClick={() => {
                                  setNewMenuOpen(false);
                                  setSettingsOpen(false);
                                  if (presetMenuOpen()) closePresetMenu();
                                  else setPresetMenuOpen(true);
                                }}
                              >
                                <span class="omos-preset-trigger-name">
                                  {editTarget() || ctx.t('panel.none')}
                                </span>
                                <Show when={state().preset === editTarget()}>
                                  <span
                                    class="omos-chip-dot"
                                    aria-hidden="true"
                                  />
                                </Show>
                                <Show
                                  when={
                                    currentPreset() &&
                                    !presetEditable(currentPreset())
                                  }
                                >
                                  <ui.Icon
                                    name="lock"
                                    size="small"
                                    class="omos-preset-lock-icon"
                                  />
                                </Show>
                                <span
                                  class="omos-agent-caret"
                                  classList={{ 'is-open': presetMenuOpen() }}
                                >
                                  <ui.Icon name="chevron-down" size="small" />
                                </span>
                              </button>

                              <Show when={presetMenuOpen()}>
                                <section
                                  class="omos-popover omos-preset-menu"
                                  data-mode={ctx.appearance.mode()}
                                  aria-label={ctx.t('panel.presets')}
                                >
                                  <div class="omos-menu-head">
                                    <span>{ctx.t('panel.presets')}</span>
                                    <ui.IconButton
                                      icon="close-small"
                                      label={ctx.t('panel.closeMenu')}
                                      size="small"
                                      onClick={closePresetMenu}
                                    />
                                  </div>
                                  <For each={state().presets}>
                                    {(preset) => {
                                      const isDefault = () =>
                                        state().preset === preset.name;
                                      const selected = () =>
                                        editTarget() === preset.name;
                                      const staged = () =>
                                        pendingDeletes().some(
                                          (entry) => entry.name === preset.name,
                                        );
                                      const confirming = () =>
                                        deleteConfirmName() === preset.name;
                                      return (
                                        <div
                                          class="omos-menu-row"
                                          classList={{
                                            'is-selected': selected(),
                                            'is-deleted': staged(),
                                          }}
                                        >
                                          <Show
                                            when={!staged()}
                                            fallback={
                                              <div class="omos-menu-undo">
                                                <span
                                                  class="omos-menu-undo-text"
                                                  title={ctx.t(
                                                    'panel.restorePending',
                                                  )}
                                                >
                                                  <ui.Icon
                                                    name="outline-trash"
                                                    size="small"
                                                  />
                                                  <span>
                                                    {ctx.t('panel.deleted')}:{' '}
                                                    {preset.name}
                                                  </span>
                                                </span>
                                                <ui.Button
                                                  variant="ghost"
                                                  size="small"
                                                  onClick={() =>
                                                    undoPresetDelete(
                                                      preset.name,
                                                    )
                                                  }
                                                >
                                                  {ctx.t('panel.undo')}
                                                </ui.Button>
                                              </div>
                                            }
                                          >
                                            <button
                                              type="button"
                                              aria-current={
                                                selected() ? 'true' : undefined
                                              }
                                              class="omos-menu-select"
                                              title={[
                                                preset.description,
                                                isDefault()
                                                  ? ctx.t('panel.active')
                                                  : '',
                                                !presetEditable(preset)
                                                  ? ctx.t('panel.readOnlyHint')
                                                  : '',
                                              ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                              onClick={() => {
                                                selectPreset(preset.name);
                                                closePresetMenu();
                                                scrollTop();
                                              }}
                                            >
                                              <span class="omos-menu-check">
                                                <Show when={selected()}>
                                                  <ui.Icon
                                                    name="check"
                                                    size="small"
                                                  />
                                                </Show>
                                              </span>
                                              <span class="omos-menu-name">
                                                {preset.name}
                                              </span>
                                              <Show when={isDefault()}>
                                                <span class="omos-chip-active">
                                                  {ctx.t('panel.active')}
                                                </span>
                                              </Show>
                                              <Show
                                                when={!presetEditable(preset)}
                                              >
                                                <ui.Icon
                                                  name="lock"
                                                  size="small"
                                                  class="omos-preset-lock-icon"
                                                />
                                              </Show>
                                            </button>
                                            <Show
                                              when={
                                                presetEditable(preset) &&
                                                preset.inUserConfig
                                              }
                                            >
                                              <Show
                                                when={confirming()}
                                                fallback={
                                                  <ui.Tooltip
                                                    value={ctx.t(
                                                      'panel.deleteRow',
                                                    )}
                                                  >
                                                    <ui.IconButton
                                                      icon="trash"
                                                      label={ctx.t(
                                                        'panel.deleteRow',
                                                      )}
                                                      size="small"
                                                      class="omos-menu-trash"
                                                      onClick={() =>
                                                        setDeleteConfirmName(
                                                          preset.name,
                                                        )
                                                      }
                                                    />
                                                  </ui.Tooltip>
                                                }
                                              >
                                                <div class="omos-menu-confirm">
                                                  <ui.Button
                                                    variant="danger"
                                                    size="small"
                                                    onClick={() =>
                                                      stagePresetDelete(
                                                        preset.name,
                                                      )
                                                    }
                                                  >
                                                    {ctx.t(
                                                      'panel.deleteConfirmShort',
                                                    )}
                                                  </ui.Button>
                                                  <ui.IconButton
                                                    icon="close-small"
                                                    label={ctx.t(
                                                      'panel.cancel',
                                                    )}
                                                    size="small"
                                                    onClick={() =>
                                                      setDeleteConfirmName(null)
                                                    }
                                                  />
                                                </div>
                                              </Show>
                                            </Show>
                                          </Show>
                                        </div>
                                      );
                                    }}
                                  </For>
                                </section>
                              </Show>
                            </div>

                            <Show when={currentPreset()}>
                              {(preset) => (
                                <>
                                  <Show when={preset().extends.length > 0}>
                                    <div class="omos-preset-extends">
                                      <span class="omos-preset-extends-key">
                                        {ctx.t('panel.extends')}
                                      </span>
                                      <span
                                        class="omos-preset-extends-value"
                                        title={preset().extends.join(', ')}
                                      >
                                        {preset().extends.join(', ')}
                                      </span>
                                    </div>
                                  </Show>

                                  <Show when={preset().validationError}>
                                    <div class="omos-field-error">
                                      {preset().validationError}
                                    </div>
                                  </Show>

                                  <div class="omos-scope">
                                    <div class="omos-scope-line">
                                      <span
                                        class="omos-scope-chip"
                                        title={defaultScopeTitle()}
                                      >
                                        {ctx.t('panel.defaultLabel')}
                                        <strong>
                                          {state().preset ||
                                            ctx.t('panel.none')}
                                        </strong>
                                      </span>
                                      <Show when={state().envPreset}>
                                        <span
                                          class="omos-mini-tag is-warn"
                                          title={ctx.t('panel.scope.envTitle', {
                                            name: state().envPreset,
                                          })}
                                        >
                                          {ctx.t('panel.source.env')}
                                        </span>
                                      </Show>
                                      <Show when={state().projectPreset}>
                                        <span
                                          class="omos-mini-tag"
                                          title={ctx.t(
                                            'panel.scope.projectTitle',
                                            {
                                              name: state().projectPreset,
                                            },
                                          )}
                                        >
                                          {ctx.t('panel.source.project')}
                                        </span>
                                      </Show>
                                      <span
                                        class="omos-scope-chip"
                                        classList={{
                                          'is-warn':
                                            panelRead()?.status ===
                                              'unsupported' ||
                                            panelRead()?.status === 'error',
                                        }}
                                      >
                                        {ctx.t('panel.sessionLabel')}
                                        <strong>{sessionStatusText()}</strong>
                                      </span>
                                    </div>
                                    <div class="omos-scope-controls">
                                      <div
                                        class="omos-scope-toggle"
                                        title={ctx.t('panel.scope.defaultHint')}
                                      >
                                        <span aria-hidden="true">
                                          {ctx.t('panel.defaultToggle')}
                                        </span>
                                        <ui.Switch
                                          checked={
                                            Boolean(state().globalPreset) &&
                                            state().globalPreset ===
                                              preset().name
                                          }
                                          onChange={(next) => {
                                            const directory = panelDirectory();
                                            if (busy() || !directory) return;
                                            const target = targetFor(
                                              props.session,
                                              directory,
                                            );
                                            if (next)
                                              void useAsDefault(
                                                preset().name,
                                                target,
                                              );
                                            else void clearDefault(target);
                                          }}
                                          label={ctx.t('panel.defaultToggle')}
                                          hideLabel
                                          disabled={
                                            busy() ||
                                            !panelDirectory() ||
                                            (state().globalPreset !==
                                              preset().name &&
                                              !canApplyPreset(preset()))
                                          }
                                        />
                                      </div>
                                      <div
                                        class="omos-scope-toggle"
                                        title={ctx.t('panel.scope.hint')}
                                      >
                                        <span aria-hidden="true">
                                          {ctx.t('panel.sessionToggle')}
                                        </span>
                                        <ui.Switch
                                          checked={isExplicitBindingFor(
                                            panelRead()?.state,
                                            preset().name,
                                          )}
                                          onChange={(next) => {
                                            const directory = panelDirectory();
                                            if (busy() || !directory) return;
                                            const explicit =
                                              isExplicitBindingFor(
                                                panelRead()?.state,
                                                preset().name,
                                              );
                                            if (!next) {
                                              if (!explicit) return;
                                              if (panelUnbindUnsupported()) {
                                                notify(
                                                  'error',
                                                  ctx.t(
                                                    'panel.session.unbindUnsupported',
                                                  ),
                                                );
                                                return;
                                              }
                                              void unbindForSession(
                                                props.session,
                                                directory,
                                              );
                                              return;
                                            }
                                            if (explicit) return;
                                            void useForSession(
                                              preset().name,
                                              props.session,
                                              directory,
                                            );
                                          }}
                                          label={ctx.t('panel.sessionToggle')}
                                          hideLabel
                                          disabled={
                                            busy() ||
                                            !panelDirectory() ||
                                            !canApplyPreset(preset()) ||
                                            !sessionReady() ||
                                            (panelUnbindUnsupported() &&
                                              isExplicitBindingFor(
                                                panelRead()?.state,
                                                preset().name,
                                              ))
                                          }
                                        />
                                      </div>
                                    </div>
                                    <Show
                                      when={
                                        panelRead()?.status === 'unsupported'
                                      }
                                    >
                                      <div class="omos-field-hint is-warn">
                                        {ctx.t('panel.session.unsupportedHint')}
                                      </div>
                                    </Show>
                                    <Show when={panelUnbindUnsupported()}>
                                      <div class="omos-field-hint is-warn">
                                        {ctx.t(
                                          'panel.session.unbindUnsupported',
                                        )}
                                      </div>
                                    </Show>
                                    <Show
                                      when={panelRead()?.status === 'error'}
                                    >
                                      <div class="omos-scope-error">
                                        <span class="omos-field-hint is-error">
                                          {panelRead()?.error ||
                                            ctx.t('panel.session.errorHint')}
                                        </span>
                                        <ui.Button
                                          variant="ghost"
                                          size="small"
                                          disabled={busy() || !panelDirectory()}
                                          onClick={retryPanelSession}
                                        >
                                          {ctx.t('panel.retry')}
                                        </ui.Button>
                                      </div>
                                    </Show>
                                  </div>

                                  <Show
                                    when={
                                      currentPreset()?.inUserConfig &&
                                      !presetEditable(currentPreset())
                                    }
                                  >
                                    <div class="omos-presets-foot is-warn">
                                      <ui.Icon
                                        name="lock"
                                        size="small"
                                        class="omos-foot-icon"
                                      />
                                      <span class="omos-presets-hint">
                                        {ctx.t('panel.readOnlyProject')}
                                      </span>
                                    </div>
                                  </Show>
                                  <Show
                                    when={
                                      !presetEditable(currentPreset()) &&
                                      !currentPreset()?.inUserConfig
                                    }
                                  >
                                    <div class="omos-presets-foot is-warn">
                                      <ui.Icon
                                        name="lock"
                                        size="small"
                                        class="omos-foot-icon"
                                      />
                                      <span class="omos-presets-hint">
                                        {ctx.t('panel.readOnlyHint')}
                                      </span>
                                    </div>
                                  </Show>
                                  <Show
                                    when={state().preset && !defaultPreset()}
                                  >
                                    <div class="omos-presets-foot is-warn">
                                      <ui.Icon
                                        name="warning"
                                        size="small"
                                        class="omos-foot-icon"
                                      />
                                      <span class="omos-presets-hint">
                                        {ctx.t('panel.activeMissingNamed', {
                                          name: state().preset,
                                        })}
                                      </span>
                                    </div>
                                  </Show>
                                </>
                              )}
                            </Show>
                          </section>
                        </Show>

                        <Show when={state().presets.length > 0}>
                          <div class="omos-agents">
                            <div class="omos-section-head">
                              <div class="omos-section-title">
                                <span class="omos-label">
                                  {ctx.t('panel.agents')}
                                </span>
                                <span
                                  class="omos-section-count"
                                  title={ctx.t('panel.overrides', {
                                    count: String(currentAgents().length),
                                    total: String(roster().length),
                                  })}
                                >
                                  {currentAgents().length} / {roster().length}
                                </span>
                              </div>
                              <ui.Button
                                variant="ghost"
                                size="small"
                                icon="plus-small"
                                class="omos-add-btn"
                                disabled={
                                  busy() ||
                                  !canEditCurrent() ||
                                  missingAgents().length === 0
                                }
                                onClick={toggleAdd}
                              >
                                {missingAgents().length === 0
                                  ? ctx.t('panel.allAdded')
                                  : ctx.t('panel.add')}
                              </ui.Button>
                            </div>

                            <Show when={addOpen() && canEditCurrent()}>
                              <div class="omos-add-picker">
                                <div class="omos-add-picker-head">
                                  <span class="omos-label">
                                    {ctx.t('panel.addAgentTitle')}
                                  </span>
                                  <ui.Button
                                    variant="ghost"
                                    size="small"
                                    onClick={() => setAddOpen(false)}
                                  >
                                    {ctx.t('panel.cancel')}
                                  </ui.Button>
                                </div>
                                <div class="omos-add-picker-list">
                                  <For each={missingAgents()}>
                                    {(entry) => (
                                      <button
                                        type="button"
                                        class="omos-add-option"
                                        title={`${entry.name} — ${entry.description}`}
                                        disabled={busy()}
                                        onClick={() =>
                                          startAgentEdit(entry.name, true)
                                        }
                                      >
                                        <span class="omos-add-option-name">
                                          {entry.name}
                                        </span>
                                        <span class="omos-add-option-role">
                                          {entry.description}
                                        </span>
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </div>
                            </Show>

                            <Show when={agentDraft()?.isNew}>
                              <div class="omos-agent-editor is-new">
                                {renderAgentEditor()}
                              </div>
                            </Show>

                            <Show
                              when={currentAgents().length > 0}
                              fallback={
                                <Show when={!agentDraft()?.isNew}>
                                  <Show when={currentPreset()}>
                                    <div class="omos-empty-agents">
                                      <ui.Icon name="models" size="normal" />
                                      <div class="omos-empty-agents-title">
                                        {ctx.t('panel.noAgents')}
                                      </div>
                                      <div class="omos-empty-agents-hint">
                                        {canEditCurrent()
                                          ? ctx.t('panel.noAgentsHint')
                                          : readOnlyHint()}
                                      </div>
                                    </div>
                                  </Show>
                                </Show>
                              }
                            >
                              <div class="omos-agent-list">
                                <For each={currentAgents()}>
                                  {(agent) => {
                                    const model = splitModel(agent.model);
                                    const disabledGlobally = isAgentDisabled(
                                      agent.name,
                                    );
                                    const chainCount =
                                      agent.modelChain?.length ?? 0;
                                    const open = () => {
                                      const draft = agentDraft();
                                      return (
                                        draft?.name === agent.name &&
                                        !draft.isNew
                                      );
                                    };
                                    const rowAction = () =>
                                      canEditCurrent()
                                        ? ctx.t('panel.editAgent')
                                        : readOnlyHint();
                                    return (
                                      <div
                                        class="omos-agent-block"
                                        classList={{ 'is-open': open() }}
                                      >
                                        <button
                                          type="button"
                                          class="omos-agent-row"
                                          disabled={busy()}
                                          aria-expanded={open()}
                                          title={`${agent.name}${
                                            agent.model
                                              ? ` · ${agent.model}`
                                              : ''
                                          }${
                                            chainCount > 1
                                              ? ` · ${agent.modelChain?.join(' → ')}`
                                              : ''
                                          } — ${rowAction()}`}
                                          aria-label={`${agent.name}${
                                            agent.model
                                              ? `, ${agent.model}`
                                              : ''
                                          }. ${rowAction()}`}
                                          onClick={() =>
                                            toggleAgentEdit(agent.name)
                                          }
                                        >
                                          <span class="omos-agent-name">
                                            {agent.name}
                                          </span>
                                          <Show when={agent.inherited}>
                                            <span
                                              class="omos-agent-inherited"
                                              title={ctx.t(
                                                'panel.inheritedHint',
                                              )}
                                            >
                                              <ui.Icon
                                                name="link"
                                                size="small"
                                              />
                                            </span>
                                          </Show>
                                          <Show when={disabledGlobally}>
                                            <span
                                              class="omos-mini-tag is-warn"
                                              title={ctx.t(
                                                'panel.disabledHint',
                                              )}
                                            >
                                              {ctx.t('panel.disabled')}
                                            </span>
                                          </Show>
                                          <span
                                            class="omos-agent-model"
                                            classList={{
                                              'is-empty': !agent.model,
                                            }}
                                          >
                                            <Show
                                              when={agent.model}
                                              fallback={
                                                <Show
                                                  when={
                                                    agent.inherited ||
                                                    agent.inheritModelFrom
                                                  }
                                                  fallback={
                                                    <>
                                                      <ui.Icon
                                                        name={
                                                          canEditCurrent()
                                                            ? 'plus-small'
                                                            : 'models'
                                                        }
                                                        size="small"
                                                        class="omos-agent-model-icon"
                                                      />
                                                      <span>
                                                        {canEditCurrent()
                                                          ? ctx.t(
                                                              'panel.setModel',
                                                            )
                                                          : ctx.t(
                                                              'panel.presetDefault',
                                                            )}
                                                      </span>
                                                    </>
                                                  }
                                                >
                                                  <ui.Icon
                                                    name="link"
                                                    size="small"
                                                    class="omos-agent-model-icon"
                                                  />
                                                  <span>
                                                    {agent.inheritModelFrom
                                                      ? ctx.t(
                                                          'panel.inheritsFrom',
                                                          {
                                                            name: agent.inheritModelFrom,
                                                          },
                                                        )
                                                      : ctx.t(
                                                          'panel.inherited',
                                                        )}
                                                  </span>
                                                </Show>
                                              }
                                            >
                                              <Show when={model.provider}>
                                                <span
                                                  class="omos-agent-provider"
                                                  title={model.provider}
                                                >
                                                  {model.provider}
                                                </span>
                                                <span
                                                  class="omos-agent-sep"
                                                  aria-hidden="true"
                                                >
                                                  ·
                                                </span>
                                              </Show>
                                              <span
                                                class="omos-agent-model-name"
                                                title={agent.model}
                                              >
                                                {model.model}
                                              </span>
                                              <Show when={agent.variant}>
                                                <span
                                                  class="omos-agent-variant"
                                                  title={ctx.t('panel.variant')}
                                                >
                                                  {agent.variant}
                                                </span>
                                              </Show>
                                              <Show
                                                when={capForModel(agent.model)}
                                              >
                                                <span
                                                  class="omos-agent-cap"
                                                  title={`${capShort(agent.model)} — ${goAllowanceHint()}`}
                                                >
                                                  {capShort(agent.model)}
                                                </span>
                                              </Show>
                                              <Show when={chainCount > 1}>
                                                <span
                                                  class="omos-mini-tag omos-agent-chain"
                                                  title={agent.modelChain?.join(
                                                    ' → ',
                                                  )}
                                                >
                                                  +{chainCount - 1}
                                                </span>
                                              </Show>
                                            </Show>
                                          </span>
                                          <span
                                            class="omos-agent-caret"
                                            classList={{ 'is-open': open() }}
                                          >
                                            <ui.Icon
                                              name={
                                                canEditCurrent()
                                                  ? 'chevron-down'
                                                  : 'lock'
                                              }
                                              size="small"
                                            />
                                          </span>
                                        </button>

                                        <Show when={open()}>
                                          <div class="omos-agent-editor">
                                            {renderAgentEditor()}
                                          </div>
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        );
      },
    });

    ctx.add(ComposerPill, {
      id: 'preset',
      order: -10,
      show: (input): ComposerPillView | undefined => {
        const session = input.session;
        const directory = session.location?.directory;
        if (!directory) return undefined;

        const key = sessionScopeKey(session, directory);
        const reads = sessionReads();
        const knownSnapshots = snapshots();
        const snapshot =
          knownSnapshots[workspaceKey(session.server.id, directory)];
        const read = reads[key];

        ensureSnapshot(targetFor(session, directory));
        ensureSessionRead(session, directory);

        const state = read?.status === 'ready' ? read.state : undefined;
        const binding = state ? sessionBinding(state) : undefined;
        const boundName =
          binding?.kind === 'preset'
            ? binding.presetName
            : binding?.kind === 'default-team'
              ? (binding.presetName ?? ctx.t('panel.defaultTeam'))
              : null;
        const label =
          !read || read.status === 'loading'
            ? ctx.t('panel.pill.reading')
            : read.status === 'unsupported'
              ? ctx.t('panel.pill.unsupported')
              : read.status === 'error'
                ? ctx.t('panel.pill.error')
                : boundName
                  ? ctx.t('panel.pill.bound', { name: boundName })
                  : ctx.t('panel.pill.unbound');
        const tone =
          read?.status === 'unsupported' || read?.status === 'error'
            ? ('warning' as const)
            : binding && binding.kind !== 'none'
              ? ('success' as const)
              : undefined;

        const rows: ComposerPillRow[] = [];
        if (snapshot) {
          if (state) {
            for (const preset of snapshot.presets) {
              const invalid = Boolean(preset.validationError);
              const isBound = isExplicitBindingFor(state, preset.name);
              rows.push({
                id: `preset:${preset.name}`,
                label: preset.name,
                icon: isBound ? 'circle-check' : 'sliders',
                tone: isBound ? 'success' : invalid ? 'danger' : undefined,
                detail: invalid
                  ? ctx.t('panel.invalid')
                  : agentCount(preset.agents.length),
                ...(invalid
                  ? {}
                  : {
                      run: () =>
                        void useForSession(preset.name, session, directory),
                    }),
              });
            }
          }
        }
        if (read?.status === 'error') {
          rows.push({
            id: '__retry__',
            label: ctx.t('panel.pill.retry'),
            icon: 'refresh',
            run: () =>
              void requestSessionRead(session, directory, { force: true }),
          });
        }
        rows.push({
          id: '__open_panel__',
          label: ctx.t('panel.openPanel'),
          icon: 'settings-gear',
          run: () => ctx.layout.open(`${ctx.id}:main`, session),
        });

        return {
          icon: 'sliders',
          label,
          tone,
          title: ctx.t('panel.pill.title'),
          rows,
        };
      },
    });

    ctx.add(MenuItem, (): MenuItem => {
      const session = ctx.sessions.current();
      return {
        menu: 'session.panel',
        id: 'open',
        title: ctx.t('menu.open'),
        icon: 'sliders',
        opened:
          !!session && ctx.layout.state(`${ctx.id}:main`, session) !== 'closed',
        run: () => {
          const current = ctx.sessions.current();
          if (current) ctx.layout.open(`${ctx.id}:main`, current);
        },
      };
    });

    const initialSession = ctx.sessions.current();
    const initialDirectory = initialSession?.location?.directory;
    if (initialSession && initialDirectory) {
      panelSession = initialSession;
      setActiveServerID(initialSession.server.id);
      setActiveDirectory(initialDirectory);
      void requestSnapshot(targetFor(initialSession, initialDirectory));
    }
  },
  async main(ctx) {
    ctx.log.write('info', 'omos-gui main process started');
    // Main-process only: the reader touches Electron's userData path and the
    // Desktop sqlite file. Never import it into the window path or ask a
    // session's server to read the Desktop machine's filesystem.
    const { createNativeModelPrefsReader } = await import(
      './gui-plugin/native-model-prefs'
    );
    const reader = createNativeModelPrefsReader();
    ctx.provide(NativeModelPrefsIpc, {
      read: () => reader.get(),
    });
  },
});
