import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  notifyConfigChanged,
  registerConfigChangeListener,
} from './config-change-coordinator';
import {
  openPresetManagerV2,
  type V2PresetManagerContext,
  type V2PresetSelectInput,
} from './preset-manager';
import { makeTestEnv } from './test-fixtures';

let env: ReturnType<typeof makeTestEnv>;

beforeEach(() => {
  env = makeTestEnv('omos-v2pm');
});

afterEach(() => env.restore());

function readUserConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(env.userConfigPath, 'utf-8')) as Record<
    string,
    unknown
  >;
}

// --- scripted dialog port ---------------------------------------------------

interface ToastCapture {
  title?: string;
  message: string;
  variant?: string;
}

/** A user value wrapped by the manager to avoid action-sentinel collisions. */
type WrappedChoice = { user: string };
type StubSelectValue = string | WrappedChoice;
type SelectCall = V2PresetSelectInput<StubSelectValue>;

interface PromptCall {
  title: string;
  description?: string;
  placeholder?: string;
  value?: string;
}

interface StubOptions {
  selects?: Array<StubSelectValue | undefined>;
  prompts?: Array<string | undefined>;
  confirms?: Array<boolean | undefined>;
  models?: unknown[];
  /** When true, `list()` returns undefined until `sync()` has run. */
  lazyModels?: boolean;
  withData?: boolean;
  withClient?: boolean;
  /** When false, `ui.dialog` is omitted (toast stays). */
  withDialogs?: boolean;
  /**
   * Test seam forwarded to the manager context. `null` omits the seam
   * entirely (no live refresh available); the default resolves ok.
   */
  onConfigChanged?: (() => void | Promise<void>) | null;
}

/** Dialog/toast stub over a temp config dir; every call is captured. */
function makeStub(options: StubOptions = {}) {
  const selects = [...(options.selects ?? [])];
  const prompts = [...(options.prompts ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const models = options.models ?? [];
  const toasts: ToastCapture[] = [];
  const selectCalls: SelectCall[] = [];
  const promptCalls: PromptCall[] = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const counts = { sync: 0, reload: 0 };
  let synced = !options.lazyModels;

  const dialog = {
    select: async (args: SelectCall) => {
      selectCalls.push(args);
      return selects.shift();
    },
    prompt: async (args: PromptCall) => {
      promptCalls.push(args);
      return prompts.shift();
    },
    confirm: async (args: { title: string; message: string }) => {
      confirmCalls.push(args);
      return confirms.shift();
    },
  };
  const model = {
    list: () => (synced ? models : undefined),
    sync: async () => {
      counts.sync += 1;
      synced = true;
    },
  };
  const onConfigChanged =
    options.onConfigChanged === null
      ? undefined
      : (options.onConfigChanged ??
        (() => {
          counts.reload += 1;
        }));
  const ctx = {
    location: { directory: env.projectDir },
    ui: {
      dialog: options.withDialogs === false ? undefined : dialog,
      toast: {
        show: (toast: ToastCapture) => {
          toasts.push(toast);
        },
      },
    },
    data: options.withData === false ? undefined : { location: { model } },
    client: options.withClient
      ? { model: { list: async () => ({ data: models }) } }
      : undefined,
    onConfigChanged,
  };

  return {
    ctx: ctx as unknown as V2PresetManagerContext,
    toasts,
    selectCalls,
    promptCalls,
    confirmCalls,
    syncCalls: () => counts.sync,
    reloadCalls: () => counts.reload,
  };
}

type Stub = ReturnType<typeof makeStub>;

const selectValues = (call: SelectCall | undefined): StubSelectValue[] =>
  (call?.options ?? []).map((option) => option.value);
const selectTitles = (stub: Stub) => stub.selectCalls.map((call) => call.title);
const toastVariants = (stub: Stub) => stub.toasts.map((toast) => toast.variant);
const toastTitles = (stub: Stub) => stub.toasts.map((toast) => toast.title);
const lastToast = (stub: Stub) => stub.toasts[stub.toasts.length - 1];
const lastMessage = (stub: Stub) => lastToast(stub)?.message ?? '';
/** Select values of the first dialog whose title contains `match`. */
const callValues = (stub: Stub, match: string) =>
  selectValues(stub.selectCalls.find((call) => call.title.includes(match)));
/** Title of `value` among the options of the first dialog matching `match`. */
const optionTitle = (stub: Stub, match: string, value: StubSelectValue) =>
  (
    stub.selectCalls.find((call) => call.title.includes(match))?.options ?? []
  ).find((option) => option.value === value)?.title;

/** The last toast must carry `variant` and mention every token. */
function expectToast(stub: Stub, variant: string, ...tokens: string[]): void {
  expect(lastToast(stub)?.variant).toBe(variant);
  for (const token of tokens) {
    expect(lastMessage(stub)).toContain(token);
  }
}

/** The `presets` record of a user config (never undefined for tests). */
const presets = (config: Record<string, unknown>) =>
  (config.presets ?? {}) as Record<string, Record<string, unknown>>;

/** The orchestrator override read back from `presets[preset]` (or `{}`). */
function agentOverride(
  config: Record<string, unknown>,
  preset: string,
): Record<string, unknown> {
  return presets(config)[preset]?.orchestrator ?? {};
}

/** Writes the user config, then runs the manager over the temp project. */
async function run(config: Record<string, unknown>, options: StubOptions = {}) {
  env.writeUserConfig(config);
  const stub = makeStub(options);
  await openPresetManagerV2(stub.ctx, env.projectDir);
  return stub;
}

// --- shared fixtures --------------------------------------------------------

const SONNET_OVERRIDE = {
  orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
};
const GPT5_MINI_OVERRIDE = {
  orchestrator: { model: 'openai/gpt-5-mini' },
};
/** Preset `balanced` (active for the switch tests) is the SONNET override. */
const BALANCED = { presets: { balanced: SONNET_OVERRIDE } };
const SWITCH = {
  preset: 'balanced',
  presets: { balanced: SONNET_OVERRIDE, cheap: GPT5_MINI_OVERRIDE },
};
const CHEAP_ONLY = { presets: { cheap: GPT5_MINI_OVERRIDE } };
const P_CONFIG = { presets: { p: SONNET_OVERRIDE } };
const ORACLE_MINI = { oracle: { model: 'openai/gpt-5-mini' } };
const USER_P = { presets: { userP: ORACLE_MINI } };
const PROJECT_PRESETS = { presets: { proj: SONNET_OVERRIDE } };
const GPT5_MODEL = { providerID: 'openai', modelID: 'gpt-5', name: 'GPT-5' };
const SONNET_MODEL = {
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-5',
  name: 'Claude Sonnet 4.5',
};

/** Edit `preset` → orchestrator → gpt-5 → save, then dismiss. */
const saveTrail = (preset = 'p'): StubSelectValue[] => [
  preset,
  'edit',
  'orchestrator',
  'openai/gpt-5',
  '__omo_save__',
  undefined,
];

/** Edit `preset` → orchestrator → `model` → Back, then dismiss. */
const backTrail = (preset: string, model: string): StubSelectValue[] => [
  preset,
  'edit',
  'orchestrator',
  model,
  '__omo_back__',
  undefined,
];

/** Create → add `agent` on `model` (with optional variant) → save → back. */
const createTrail = (
  agent: string,
  model: string,
  variant?: string,
): StubSelectValue[] => [
  '__omo_new_preset__',
  '__omo_add_agent__',
  agent,
  model,
  ...(variant ? [variant] : []),
  '__omo_save__',
  '__omo_back__',
  undefined,
];

const BALANCED_SAVE_APPLY_TRAIL = [
  'balanced',
  'edit',
  '__omo_save_apply__',
  'global',
];

describe('preset apply scopes', () => {
  test('same-name session reapply uses the server and leaves user config untouched', async () => {
    env.writeUserConfig(SWITCH);
    const before = fs.readFileSync(env.userConfigPath, 'utf-8');
    const stub = makeStub({
      selects: ['balanced', 'apply', 'session'],
      confirms: [true],
    });
    const calls: unknown[] = [];
    stub.ctx.getSessionID = () => 'root-1';
    stub.ctx.client = {
      rpc: (contract: { id: string }) => {
        expect(contract.id).toBe('oh-my-opencode-slim.session-preset.v2');
        return {
          read: async () => ({
            sessionID: 'root-1',
            status: 'bound',
            presetName: 'balanced',
            affects: 'future-delegations',
          }),
          apply: async (input: unknown, options: unknown) => {
            calls.push({ input, options });
            return {
              sessionID: 'root-1',
              status: 'bound',
              presetName: 'balanced',
              affects: 'future-delegations',
            };
          },
        };
      },
    };
    await openPresetManagerV2(stub.ctx, env.projectDir);
    expect(calls).toEqual([
      {
        input: { sessionID: 'root-1', presetName: 'balanced' },
        options: {
          location: { directory: env.projectDir },
          signal: expect.any(AbortSignal),
        },
      },
    ]);
    expect(stub.selectCalls[0].placeholder).toContain(
      'Default: balanced · Session: balanced',
    );
    expect(stub.selectCalls[0].options[0].description).toContain(
      'saved models',
    );
    expect(stub.confirmCalls[0].message).toContain('Inference settings only');
    expectToast(
      stub,
      'success',
      'new and resumed delegations',
      'Current model, already-admitted work and global default unchanged',
    );
    expect(fs.readFileSync(env.userConfigPath, 'utf-8')).toBe(before);
    expect(stub.reloadCalls()).toBe(0);
  });

  test('cancelled scope or confirmation, home and missing RPC never save or fall back to global', async () => {
    for (const scenario of [
      'scope-cancel',
      'confirm-cancel',
      'home',
      'no-rpc',
      'route-change',
    ]) {
      env.writeUserConfig(SWITCH);
      const before = fs.readFileSync(env.userConfigPath, 'utf-8');
      const stub = makeStub({
        models: [GPT5_MODEL],
        selects: [
          'balanced',
          'edit',
          'orchestrator',
          'openai/gpt-5',
          '__omo_save_apply__',
          scenario === 'scope-cancel' ? undefined : 'session',
        ],
        prompts: ['', '{}'],
        confirms: [scenario !== 'confirm-cancel'],
      });
      let current = scenario === 'home' ? undefined : 'root-1';
      stub.ctx.getSessionID = () => current;
      if (scenario === 'route-change') {
        const dialog = stub.ctx.ui?.dialog;
        if (!dialog) throw new Error('Missing test dialog');
        dialog.confirm = async () => {
          current = 'root-2';
          return true;
        };
      }
      await openPresetManagerV2(stub.ctx, env.projectDir);
      expect(fs.readFileSync(env.userConfigPath, 'utf-8')).toBe(before);
      expect(stub.reloadCalls()).toBe(0);
      if (scenario === 'scope-cancel' || scenario === 'confirm-cancel') {
        expect(toastTitles(stub)).toEqual(['Agent updated']);
      } else {
        expect(lastToast(stub)?.title).toBe('Preset not applied');
      }
    }
  });

  test('session Apply errors remain unconfirmed, including a lost reply after commit', async () => {
    for (const reason of [
      'Preset not found',
      'Session preset storage write failed',
      'Request timed out',
      'Connection lost',
    ]) {
      env.writeUserConfig(SWITCH);
      const stub = makeStub({
        selects: ['cheap', 'apply', 'session'],
        confirms: [true],
      });
      stub.ctx.getSessionID = () => 'root-1';
      let committed = false;
      let applies = 0;
      stub.ctx.client = {
        rpc: () => ({
          read: async () => ({
            sessionID: 'root-1',
            status: committed ? 'bound' : 'unbound',
            presetName: committed ? 'cheap' : null,
          }),
          apply: async () => {
            applies++;
            committed =
              reason === 'Request timed out' || reason === 'Connection lost';
            throw new Error(reason);
          },
        }),
      };
      await openPresetManagerV2(stub.ctx, env.projectDir);
      expectToast(stub, 'warning', reason, 'Global default unchanged');
      expect(lastToast(stub)?.title).toBe('Apply not confirmed');
      expectToast(
        stub,
        'warning',
        'Reopen Presets to check the session state.',
      );
      expect(readUserConfig()).toEqual(SWITCH);
      expect(stub.reloadCalls()).toBe(0);
      if (committed) {
        await openPresetManagerV2(stub.ctx, env.projectDir);
        expect(stub.selectCalls.at(-1)?.placeholder).toContain(
          'Session: cheap',
        );
        expect(applies).toBe(1);
      }
    }
  });

  test('Save & Apply distinguishes the committed save from an unconfirmed Apply', async () => {
    env.writeUserConfig(SWITCH);
    const stub = makeStub({
      models: [GPT5_MODEL],
      selects: [
        'balanced',
        'edit',
        'orchestrator',
        'openai/gpt-5',
        '__omo_save_apply__',
        'session',
      ],
      prompts: ['', '{}'],
      confirms: [true],
    });
    let applies = 0;
    stub.ctx.getSessionID = () => 'root-1';
    stub.ctx.client = {
      rpc: () => ({
        read: async () => ({
          sessionID: 'root-1',
          status: 'bound',
          presetName: 'balanced',
        }),
        apply: async () => {
          applies++;
          expect(agentOverride(readUserConfig(), 'balanced').model).toBe(
            'openai/gpt-5',
          );
          throw new Error('Request timed out');
        },
      }),
    };
    await openPresetManagerV2(stub.ctx, env.projectDir);
    expect(applies).toBe(1);
    expect(readUserConfig().preset).toBe('balanced');
    expect(lastToast(stub)?.title).toBe('Preset saved — apply not confirmed');
    expectToast(
      stub,
      'warning',
      'Definition saved',
      'Request timed out',
      'Global default unchanged',
      'Reopen Presets to check the session state.',
    );
  });
});

/** One scripted run: seed config (and project config), then trace the result. */
interface FlowCase {
  name: string;
  config?: Record<string, unknown>;
  project?: Record<string, unknown>;
  options: StubOptions;
  check: (stub: Stub) => void;
}

describe('openPresetManagerV2', () => {
  const cases: FlowCase[] = [
    {
      name: 'applies a preset from the list and exits',
      config: SWITCH,
      options: { selects: ['cheap', 'apply', 'global'], confirms: [true] },
      check: (stub) => {
        expect(stub.selectCalls[0]?.title).toBe('Presets');
        expect(stub.selectCalls[0]?.current).toBe('balanced');
        expect(selectValues(stub.selectCalls[0])).toEqual([
          'balanced',
          'cheap',
          '__omo_new_preset__',
        ]);
        expect(stub.selectCalls[0]?.options?.[0]?.title).toContain('(default)');
        expect(stub.selectCalls[1]?.title).toContain('cheap');
        expect(stub.confirmCalls).toHaveLength(1);
        expect(stub.toasts).toHaveLength(1);
        expectToast(
          stub,
          'success',
          'Saved preset "cheap"',
          'Live refresh requested',
          'orchestrator → model: openai/gpt-5-mini',
        );
        // Persistence, the requested live refresh, and never a reload claim.
        expect(stub.reloadCalls()).toBe(1);
        expect(lastMessage(stub)).not.toContain('Reload OpenCode');
        expect(readUserConfig()).toEqual({ ...SWITCH, preset: 'cheap' });
      },
    },
    {
      name: 'creates a preset, configures an agent at Level 3, and saves expected JSON',
      options: {
        models: [
          { ...SONNET_MODEL, variants: [{ id: 'thinking' }, { id: 'low' }] },
        ],
        selects: createTrail(
          'oracle',
          'anthropic/claude-sonnet-4-5',
          'thinking',
        ),
        prompts: ['custom', '0.5', '{"thinking":{"type":"enabled"}}'],
      },
      check: (stub) => {
        expect(stub.promptCalls[0]?.title).toBe('Create new preset');
        expect(callValues(stub, 'Edit oracle — model')).toEqual([
          'anthropic/claude-sonnet-4-5',
        ]);
        // Variant list comes from the host model entry.
        expect(callValues(stub, 'variant')).toEqual(['', 'thinking', 'low']);
        expect(toastVariants(stub)).toEqual(['success', 'success']);
        expect(readUserConfig().presets).toEqual({
          balanced: SONNET_OVERRIDE,
          custom: {
            oracle: {
              model: 'anthropic/claude-sonnet-4-5',
              variant: 'thinking',
              temperature: 0.5,
              options: { thinking: { type: 'enabled' } },
            },
          },
        });
      },
    },
    {
      name: 'save & apply persists the preset name and toasts the switch result',
      options: { selects: BALANCED_SAVE_APPLY_TRAIL, confirms: [true] },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Preset: balanced',
          'Edit preset: balanced',
          'Save & apply: balanced',
          'Presets',
        ]);
        expectToast(
          stub,
          'success',
          'Saved preset "balanced"',
          'Live refresh requested',
        );
        // Save & Apply notifies the refresh seam exactly once.
        expect(stub.reloadCalls()).toBe(1);
        expect(readUserConfig()).toEqual({ ...BALANCED, preset: 'balanced' });
      },
    },
    {
      name: 'blocks deleting a preset with dependents',
      config: {
        presets: {
          base: SONNET_OVERRIDE,
          child: { extends: 'base', agents: {} },
        },
      },
      options: { selects: ['base', 'delete'] },
      check: (stub) => {
        // The blocked delete returns to the actions dialog; the next
        // dismissal closes the manager.
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Preset: base',
          'Preset: base',
        ]);
        expect(stub.confirmCalls).toHaveLength(0);
        expectToast(stub, 'warning', 'extend it: child');
        expect(presets(readUserConfig()).base).toBeDefined();
      },
    },
    {
      name: 'confirms deletion and removes the preset',
      config: CHEAP_ONLY,
      options: { selects: ['cheap', 'delete'], confirms: [true] },
      check: (stub) => {
        expect(stub.confirmCalls).toHaveLength(1);
        expectToast(stub, 'success', '"cheap"');
        expect(presets(readUserConfig()).cheap).toBeUndefined();
      },
    },
    {
      name: 'project presets are tagged and offer no edit/delete actions',
      config: { ...USER_P, preset: 'proj' },
      project: PROJECT_PRESETS,
      options: { selects: ['proj', '__omo_back__', undefined] },
      check: (stub) => {
        expect(optionTitle(stub, 'Presets', 'proj')).toContain('read-only');
        expect(stub.selectCalls[1]?.title).toContain('proj');
        expect(selectValues(stub.selectCalls[1])).toEqual([
          'apply',
          '__omo_back__',
        ]);
        expect(readUserConfig()).toEqual({ ...USER_P, preset: 'proj' });
      },
    },
    {
      name: 'rejects creating a preset whose name is a project preset',
      config: USER_P,
      project: PROJECT_PRESETS,
      options: {
        selects: ['__omo_new_preset__', undefined],
        prompts: ['proj', undefined],
      },
      check: (stub) => {
        expectToast(
          stub,
          'warning',
          'already defined in project config (.opencode)',
        );
        expect(readUserConfig()).toEqual(USER_P);
      },
    },
    {
      name: 'prevents inheritance cycles in the base preset picker',
      config: {
        presets: {
          baseA: SONNET_OVERRIDE,
          baseB: ORACLE_MINI,
          child: {
            extends: 'baseA',
            agents: { explorer: { model: 'openai/gpt-5-mini' } },
          },
          grand: { extends: 'child', agents: {} },
        },
      },
      options: {
        selects: [
          'child',
          'edit',
          '__omo_base_preset__',
          'baseB',
          '__omo_back__',
          undefined,
        ],
      },
      check: (stub) => {
        const base = stub.selectCalls.find((c) =>
          c.title.includes('Base preset'),
        );
        expect(base?.title).toContain('"child"');
        expect(selectValues(base)).toEqual([
          '',
          'baseA',
          'baseB',
          '__omo_back__',
        ]);
        // Self and cycle-forming candidates are excluded.
        expect(selectValues(base)).not.toContain('child');
        expect(selectValues(base)).not.toContain('grand');
        expect(optionTitle(stub, 'Base preset', 'baseA')).toContain(
          'current base',
        );
        expect(stub.toasts.some((t) => t.message.includes('baseB'))).toBe(true);
      },
    },
    {
      name: 'warns when the host cannot open dialogs',
      config: {},
      options: { withDialogs: false },
      check: (stub) => {
        expect(stub.toasts).toHaveLength(1);
        expectToast(stub, 'warning', 'Dialogs unavailable');
      },
    },
    {
      name: 'switching to a variant-less model clears the old variant',
      config: {
        presets: {
          p: {
            orchestrator: {
              model: 'anthropic/claude-sonnet-4-5',
              variant: 'thinking',
            },
          },
        },
      },
      options: {
        models: [
          { ...SONNET_MODEL, variants: [{ id: 'thinking' }] },
          GPT5_MODEL,
        ],
        selects: saveTrail(),
        prompts: ['', '{}'],
      },
      check: (stub) => {
        // The variant picker is skipped entirely for a variant-less model.
        expect(stub.selectCalls.some((c) => c.title.includes('variant'))).toBe(
          false,
        );
        expect(toastVariants(stub)).toEqual(['success', 'success']);
        expect(readUserConfig()).toEqual({
          presets: { p: { orchestrator: { model: 'openai/gpt-5' } } },
        });
      },
    },
    {
      name: 'rejects reserved and prototype-sensitive names at creation',
      options: {
        selects: ['__omo_new_preset__', '__omo_back__', undefined],
        prompts: ['__omo_new_preset__', '__proto__', 'constructor', 'clean'],
      },
      check: (stub) => {
        const invalid = stub.toasts.filter((t) => t.title === 'Invalid name');
        expect(invalid).toHaveLength(3);
        expect(invalid[0]?.message).toContain('"__omo_"');
        expect(invalid[1]?.message).toContain('"__proto__"');
        expect(invalid[2]?.message).toContain('"constructor"');
        expect(stub.promptCalls).toHaveLength(4);
        // The clean name opened an empty working copy at Level 2.
        expect(stub.selectCalls[1]?.title).toContain('clean');
      },
    },
    {
      name: 'a preset named like an action sentinel stays selectable and applicable',
      config: { presets: { __omo_new_preset__: SONNET_OVERRIDE } },
      options: {
        selects: [{ user: '__omo_new_preset__' }, 'apply', 'global'],
        confirms: [true],
      },
      check: (stub) => {
        // The preset option carries a wrapped value while the create action
        // keeps the raw sentinel, so neither shadows the other.
        expect(selectValues(stub.selectCalls[0])).toEqual([
          { user: '__omo_new_preset__' },
          '__omo_new_preset__',
        ]);
        expect(stub.selectCalls[1]?.title).toContain('__omo_new_preset__');
        expectToast(stub, 'success', '"__omo_new_preset__"');
        expect(readUserConfig().preset).toBe('__omo_new_preset__');
      },
    },
    {
      name: 'creates over an existing user preset after overwrite confirmation',
      options: {
        models: [GPT5_MODEL],
        selects: createTrail('orchestrator', 'openai/gpt-5'),
        prompts: ['balanced', '0.7', '{}'],
        confirms: [true],
      },
      check: (stub) => {
        expect(stub.confirmCalls).toHaveLength(1);
        expect(stub.confirmCalls[0]?.message).toContain('"balanced"');
        expect(presets(readUserConfig()).balanced).toEqual({
          orchestrator: { model: 'openai/gpt-5', temperature: 0.7 },
        });
      },
    },
    {
      name: 'declining the overwrite confirmation re-prompts for a name',
      options: {
        selects: ['__omo_new_preset__', '__omo_back__', undefined],
        prompts: ['balanced', 'fresh'],
        confirms: [false],
      },
      check: (stub) => {
        expect(stub.promptCalls).toHaveLength(2);
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Edit preset: fresh',
          'Presets',
        ]);
      },
    },
    {
      name: 'save writes a structured definition and strips empty overrides',
      config: {
        presets: {
          base: SONNET_OVERRIDE,
          p: {
            extends: 'base',
            agents: { explorer: { model: 'openai/gpt-5-mini' } },
          },
        },
      },
      options: {
        models: [GPT5_MODEL],
        selects: [
          'p',
          'edit',
          '__omo_add_agent__',
          'oracle',
          'openai/gpt-5',
          '__omo_save__',
          undefined,
        ],
        // Cancelling the temperature prompt keeps the empty override in the
        // working copy; Save must strip it.
        prompts: [undefined],
      },
      check: () => {
        expect(presets(readUserConfig()).p).toEqual({
          extends: 'base',
          agents: { explorer: { model: 'openai/gpt-5-mini' } },
        });
      },
    },
    {
      name: 'saves preserve unrelated config keys',
      config: {
        preset: 'balanced',
        disabled_agents: ['oracle'],
        model: 'anthropic/claude-sonnet-4-5',
        presets: {
          balanced: SONNET_OVERRIDE,
          other: { explorer: { model: 'openai/gpt-5-mini' } },
        },
      },
      options: {
        models: [GPT5_MODEL],
        selects: saveTrail('balanced'),
        prompts: ['', '{}'],
      },
      check: () => {
        expect(readUserConfig()).toEqual({
          preset: 'balanced',
          disabled_agents: ['oracle'],
          model: 'anthropic/claude-sonnet-4-5',
          presets: {
            balanced: { orchestrator: { model: 'openai/gpt-5' } },
            other: { explorer: { model: 'openai/gpt-5-mini' } },
          },
        });
      },
    },

    // --- dismissal / Back matrix --------------------------------------------

    {
      name: 'dismissing Level 1 closes the manager',
      options: { selects: [undefined] },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual(['Presets']);
        expect(stub.toasts).toEqual([]);
        // Cancel leaves the config untouched.
        expect(readUserConfig()).toEqual(BALANCED);
      },
    },
    {
      name: 'dismissing the preset actions dialog closes the manager',
      options: { selects: ['balanced', undefined] },
      check: (stub) => {
        // No Level 1 re-prompt: dismissal exits the manager entirely.
        expect(selectTitles(stub)).toEqual(['Presets', 'Preset: balanced']);
        expect(stub.toasts).toEqual([]);
        expect(readUserConfig().preset).toBeUndefined();
      },
    },
    {
      name: 'Back from the actions dialog returns to the preset list',
      options: { selects: ['balanced', '__omo_back__', undefined] },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Preset: balanced',
          'Presets',
        ]);
      },
    },
    {
      name: 'delete-confirm cancel returns to the preset action dialog',
      config: CHEAP_ONLY,
      options: {
        selects: ['cheap', 'delete', '__omo_back__', undefined],
        confirms: [false],
      },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Preset: cheap',
          'Preset: cheap',
          'Presets',
        ]);
        expect(stub.confirmCalls).toHaveLength(1);
        expect(readUserConfig().presets).toEqual({
          cheap: GPT5_MINI_OVERRIDE,
        });
      },
    },
    {
      name: 'dismissing the delete confirmation closes the manager',
      config: CHEAP_ONLY,
      options: { selects: ['cheap', 'delete'], confirms: [undefined] },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual(['Presets', 'Preset: cheap']);
        expect(stub.toasts).toEqual([]);
      },
    },
    {
      name: 'dismissing Level 2 closes the manager',
      options: { selects: ['balanced', 'edit', undefined] },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Preset: balanced',
          'Edit preset: balanced',
        ]);
      },
    },
    {
      name: 'dismissing the model picker closes the manager',
      options: {
        models: [GPT5_MODEL],
        selects: ['balanced', 'edit', 'orchestrator', undefined],
      },
      check: (stub) => {
        expect(selectTitles(stub)).toEqual([
          'Presets',
          'Preset: balanced',
          'Edit preset: balanced',
          'Edit orchestrator — model',
        ]);
      },
    },

    // --- model-resolution matrix: no list / lazy sync / client fallback -----

    {
      name: 'guides instead of failing when the host exposes no model list',
      options: {
        withData: false,
        selects: ['balanced', 'edit', 'orchestrator'],
      },
      check: (stub) => {
        expectToast(stub, 'warning', 'model list');
        expect(readUserConfig()).toEqual(BALANCED);
      },
    },
    {
      name: 'syncs the model collection when list() has not hydrated yet',
      options: {
        lazyModels: true,
        models: [SONNET_MODEL],
        selects: backTrail('balanced', 'anthropic/claude-sonnet-4-5'),
        prompts: ['', '{}'],
      },
      check: (stub) => {
        expect(stub.syncCalls()).toBe(1);
        expect(callValues(stub, 'Edit orchestrator — model')).toEqual([
          'anthropic/claude-sonnet-4-5',
        ]);
      },
    },
    {
      name: 'falls back to the v2 client model list',
      options: {
        withData: false,
        withClient: true,
        models: [GPT5_MODEL],
        selects: backTrail('balanced', 'openai/gpt-5'),
        prompts: ['', '{}'],
      },
      check: (stub) => {
        expect(callValues(stub, 'Edit orchestrator — model')).toEqual([
          'openai/gpt-5',
        ]);
      },
    },

    // --- invalid-input matrix: Level-3 prompts re-prompt, blank clears ------

    {
      name: 'invalid level-3 input toasts and re-prompts; blank clears fields',
      config: {
        presets: {
          p: { orchestrator: { temperature: 0.5, options: { a: 1 } } },
        },
      },
      options: {
        models: [GPT5_MODEL],
        selects: saveTrail(),
        prompts: ['3', '', 'not json', '{}'],
      },
      check: (stub) => {
        const titles = stub.promptCalls.map((c) => c.title);
        expect(titles[0]).toContain('temperature');
        expect(titles.filter((t) => t.includes('temperature'))).toHaveLength(2);
        expect(titles.filter((t) => t.includes('options'))).toHaveLength(2);
        expect(toastTitles(stub)).toContain('Invalid temperature');
        expect(toastTitles(stub)).toContain('Invalid options');
        expect(agentOverride(readUserConfig(), 'p')).toEqual({
          model: 'openai/gpt-5',
        });
      },
    },
    {
      name: 'rejects JSON arrays and null for options instead of clearing them',
      config: {
        presets: {
          p: { orchestrator: { model: 'openai/gpt-5', options: { a: 1 } } },
        },
      },
      options: {
        models: [GPT5_MODEL],
        selects: saveTrail(),
        prompts: ['', '[1,2]', 'null', '{"b":2}'],
      },
      check: (stub) => {
        const invalid = stub.toasts.filter(
          (t) => t.title === 'Invalid options',
        );
        expect(invalid).toHaveLength(2);
        expect(invalid[0]?.message).toContain('JSON object');
        expect(invalid[1]?.message).toContain('JSON object');
        expect(agentOverride(readUserConfig(), 'p').options).toEqual({ b: 2 });
      },
    },
  ];

  for (const { name, config = BALANCED, project, options, check } of cases) {
    test(name, async () => {
      if (project) env.writeProjectConfig(project);
      check(await run(config, options));
    });
  }
});

describe('preset manager config refresh', () => {
  /** Let the fire-and-forget refresh notification settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('plain Save triggers the config refresh once', async () => {
    let changed = 0;
    await run(P_CONFIG, {
      models: [GPT5_MODEL],
      selects: saveTrail(),
      prompts: ['', '{}'],
      onConfigChanged: () => {
        changed += 1;
      },
    });
    await flush();

    expect(changed).toBe(1);
  });

  // --- a failed/missing refresh is reported honestly, exactly once ----------

  const honestFailureCases: Array<{
    name: string;
    options: StubOptions;
    title?: string;
    reason: string;
  }> = [
    {
      name: 'reports a failed live refresh request honestly with ONE toast (config saved, reload to apply)',
      options: {
        onConfigChanged: () => ({
          ok: false,
          reason: 'profile refresh failed',
        }),
      },
      title: 'Config saved — live refresh failed',
      reason: 'profile refresh failed',
    },
    {
      name: 'warns to reload when no live refresh seam is available',
      options: { onConfigChanged: null },
      reason: 'no live refresh request path is wired',
    },
  ];

  for (const { name, options, title, reason } of honestFailureCases) {
    test(name, async () => {
      const stub = await run(SWITCH, {
        ...options,
        selects: ['cheap', 'apply', 'global'],
        confirms: [true],
      });
      await flush();

      // The switch itself persisted...
      expect(readUserConfig().preset).toBe('cheap');
      // ...but the live refresh failure is surfaced exactly once, with the
      // reason and the reload fallback, never as success.
      expect(stub.toasts).toHaveLength(1);
      expect(lastToast(stub)?.variant).toBe('warning');
      if (title) expect(lastToast(stub)?.title).toBe(title);
      expect(lastMessage(stub)).toContain(reason);
      expect(lastMessage(stub)).toContain('Reload OpenCode');
    });
  }

  test('production coordinator failure yields one honest warning, no success claim', async () => {
    // Production wiring: the manager context calls the real coordinator,
    // which talks to the (real) sidebar listener registered for this dir.
    const unregister = registerConfigChangeListener(env.projectDir, () => ({
      ok: false,
      reason: 'sidebar re-read failed',
    }));
    try {
      const stub = await run(SWITCH, {
        selects: ['cheap', 'apply', 'global'],
        confirms: [true],
        onConfigChanged: () =>
          notifyConfigChanged(env.projectDir, 'preset-manager'),
      });
      await flush();

      expect(readUserConfig().preset).toBe('cheap');
      expect(stub.toasts).toHaveLength(1);
      expect(lastToast(stub)?.variant).toBe('warning');
      expect(lastMessage(stub)).toContain('sidebar re-read failed');
      expect(lastMessage(stub)).toContain('Reload OpenCode');
      expect(lastMessage(stub)).not.toContain('Live refresh requested');
    } finally {
      unregister();
    }
  });

  test('a failed switch never notifies the live refresh seam', async () => {
    env.writeProjectConfig({ preset: 'locked-by-project' });
    let changed = 0;
    const stub = await run(
      {
        preset: 'old',
        presets: {
          cheap: GPT5_MINI_OVERRIDE,
          'locked-by-project': SONNET_OVERRIDE,
        },
      },
      {
        selects: ['cheap', 'apply', 'global'],
        confirms: [true],
        onConfigChanged: () => {
          changed += 1;
        },
      },
    );
    await flush();

    expect(changed).toBe(0);
    expect(readUserConfig().preset).toBe('old');
    expect(
      stub.toasts.some((toast) => toast.title === 'Preset not applied'),
    ).toBe(true);
  });
});

describe('preset manager working-copy fixes', () => {
  test('editing a marketplace-bearing preset and saving keeps marketplace byte-identical', async () => {
    const marketplace = { agents: ['owner/a', 'owner/b'] };
    const stub = await run(
      {
        presets: {
          mp: {
            orchestrator: { model: 'openai/gpt-5-mini' },
            marketplace,
          },
        },
      },
      {
        models: [GPT5_MODEL],
        selects: [
          'mp',
          'edit',
          'orchestrator',
          'openai/gpt-5',
          '__omo_save__',
          undefined,
        ],
        prompts: ['', '{}'],
      },
    );

    const saved = presets(readUserConfig()).mp as Record<string, unknown>;
    expect(saved.agents).toEqual({
      orchestrator: { model: 'openai/gpt-5' },
    });
    expect(JSON.stringify(saved.marketplace)).toBe(JSON.stringify(marketplace));
    expect(lastToast(stub)?.title).toBe('Preset saved');
    expectToast(stub, 'success', '"mp"', 'Live refresh requested');
  });

  test('a config change on disk while the editor is open surfaces a conflict instead of clobbering', async () => {
    env.writeUserConfig({
      presets: { p: { orchestrator: { model: 'openai/gpt-5-mini' } } },
    });
    const stub = makeStub({
      models: [GPT5_MODEL],
      selects: [
        'p',
        'edit',
        'orchestrator',
        'openai/gpt-5',
        '__omo_save__',
        undefined,
      ],
      prompts: ['', '{}'],
    });
    // Rewrite the preset behind the editor's back just before it saves:
    // the 5th select is the Level-2 dialog returning the Save action.
    const dialog = stub.ctx.ui?.dialog;
    const originalSelect = dialog?.select;
    if (!dialog || !originalSelect) throw new Error('dialog stub missing');
    let selectCalls = 0;
    dialog.select = async <Value>(
      input: V2PresetSelectInput<Value>,
    ): Promise<Value | undefined> => {
      selectCalls += 1;
      if (selectCalls === 5) {
        const current = JSON.parse(
          fs.readFileSync(env.userConfigPath, 'utf-8'),
        ) as { presets: { p: { orchestrator: Record<string, unknown> } } };
        current.presets.p.orchestrator = {
          model: 'anthropic/claude-sonnet-4-5',
          temperature: 0.9,
        };
        fs.writeFileSync(env.userConfigPath, JSON.stringify(current, null, 2));
      }
      return originalSelect(input);
    };
    await openPresetManagerV2(stub.ctx, env.projectDir);

    // The save reports the conflict and the newer on-disk content is kept,
    // not the editor's stale working copy.
    expect(lastToast(stub)?.title).toBe('Save failed');
    expectToast(stub, 'warning', '"p"');
    expect(presets(readUserConfig()).p).toEqual({
      orchestrator: { model: 'anthropic/claude-sonnet-4-5', temperature: 0.9 },
    });
  });

  test('a second Save from the same editor does not conflict with its own first write', async () => {
    const stub = await run(
      {
        presets: { p: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      },
      {
        models: [GPT5_MODEL, SONNET_MODEL],
        selects: [
          'p',
          'edit',
          'orchestrator',
          'openai/gpt-5',
          '__omo_save__',
          'orchestrator',
          'anthropic/claude-sonnet-4-5',
          '__omo_save__',
          undefined,
        ],
        prompts: ['0.5', '{}', '0.5', '{}'],
      },
    );

    // Both plain Saves succeed — the second must not conflict with the
    // editor's own first write (mutable baseline refreshed after Save).
    expect(stub.toasts.some((t) => t.title === 'Save failed')).toBe(false);
    expect(stub.toasts.filter((t) => t.title === 'Preset saved')).toHaveLength(
      2,
    );
    expectToast(stub, 'success', '"p"', 'Live refresh requested');
    expect(stub.reloadCalls()).toBe(2);
    // The committed result merges both edits: the temperature from the
    // first Save is preserved while the model reflects the second Save.
    expect(presets(readUserConfig()).p).toEqual({
      orchestrator: { model: 'anthropic/claude-sonnet-4-5', temperature: 0.5 },
    });
  });
});
