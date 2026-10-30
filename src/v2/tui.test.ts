import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RGBA } from '@opentui/core';
import { testRender } from '@opentui/solid';
import { createSignal } from 'solid-js';
import type { PluginConfig } from '../config';
import { TmuxMultiplexer } from '../multiplexer/tmux';
import baseTui, { readTuiGates } from '../tui';
import {
  recordTuiAgentActivity,
  recordTuiAgentModels,
  recordTuiSessionParent,
} from '../tui-state';
import {
  notifyConfigChanged,
  registerConfigChangeListener,
} from './config-change-coordinator';
import tui2Plugin, { runPresetFlow, type V2TuiPluginContext } from './tui';

function makeConfig(): PluginConfig {
  return {
    preset: 'balanced',
    presets: {
      balanced: {
        orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
        explorer: { model: 'openai/gpt-5-mini' },
      },
      cheap: {
        orchestrator: { model: 'openai/gpt-5-mini', temperature: 0.4 },
      },
    },
  } as PluginConfig;
}

function userConfigPath(): string {
  return path.join(
    process.env.OPENCODE_CONFIG_DIR ?? '',
    'oh-my-opencode-slim.json',
  );
}

function writeUserConfig(content: Record<string, unknown>): void {
  fs.writeFileSync(userConfigPath(), JSON.stringify(content, null, 2));
}

function readUserConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(userConfigPath(), 'utf-8')) as Record<
    string,
    unknown
  >;
}

/** Polls a predicate until it holds; fails loudly on timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

describe('v2 tui preset plugin', () => {
  let configHome: string;
  let projectDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui2-cfg-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui2-proj-'));
    process.env.OPENCODE_CONFIG_DIR = configHome;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('runPresetFlow', () => {
    interface ScriptedCtx {
      ctx: {
        location: { directory: string };
        agent?: { reload: () => Promise<void> };
        ui: {
          dialog?: {
            select: (args: unknown) => Promise<string | undefined>;
            prompt: (args: unknown) => Promise<string | undefined>;
            confirm: (args: unknown) => Promise<boolean | undefined>;
          };
          toast?: { show: (toast: { message: string }) => void };
        };
      };
      toasts: string[];
      selectCalls: unknown[];
      promptCalls: unknown[];
      selectTitles: () => string[];
      reloadCalls: () => number;
    }

    function makeStubCtx(
      script: {
        selects?: Array<string | undefined>;
        prompts?: Array<string | undefined>;
        confirms?: Array<boolean | undefined>;
      } = {},
      options: {
        withToast?: boolean;
        withDialogs?: boolean;
        withReload?: boolean;
      } = {},
    ): ScriptedCtx {
      const {
        withToast = true,
        withDialogs = true,
        withReload = true,
      } = options;
      const selects = [...(script.selects ?? [])];
      const prompts = [...(script.prompts ?? [])];
      const confirms = [...(script.confirms ?? [])];
      const toasts: string[] = [];
      const selectCalls: unknown[] = [];
      const promptCalls: unknown[] = [];
      let reloadCalls = 0;
      const ctx = {
        location: { directory: projectDir },
        ...(withReload
          ? {
              agent: {
                reload: async () => {
                  reloadCalls += 1;
                },
              },
            }
          : {}),
        ui: {
          ...(withDialogs
            ? {
                dialog: {
                  select: async (args: unknown) => {
                    selectCalls.push(args);
                    return selects.shift();
                  },
                  prompt: async (args: unknown) => {
                    promptCalls.push(args);
                    return prompts.shift();
                  },
                  confirm: async (args: unknown) => {
                    void args;
                    return confirms.shift();
                  },
                },
              }
            : {}),
          ...(withToast
            ? {
                toast: {
                  show: (toast: { message: string }) => {
                    toasts.push(toast.message);
                  },
                },
              }
            : {}),
        },
      };
      return {
        ctx,
        toasts,
        selectCalls,
        promptCalls,
        selectTitles: () =>
          selectCalls.map((call) => (call as { title?: string }).title ?? ''),
        reloadCalls: () => reloadCalls,
      };
    }

    /** Route the stub to a session and answer the session-preset RPC. */
    function attachSessionRpc(
      stub: ScriptedCtx,
      options: { sessionID?: string } = {},
    ) {
      const sessionID = options.sessionID ?? 'visible-root';
      const applies: unknown[] = [];
      Object.assign(stub.ctx.ui, {
        router: { current: () => ({ type: 'session', sessionID }) },
      });
      Object.assign(stub.ctx, {
        client: {
          rpc: () => ({
            read: async () => ({
              sessionID,
              status: 'unbound',
              presetName: null,
              affects: 'future-children-only',
            }),
            apply: async (input: unknown, applyOptions: unknown) => {
              applies.push({ input, options: applyOptions });
              return {
                sessionID,
                status: 'bound',
                presetName: (input as { presetName: string }).presetName,
                affects: 'future-children-only',
              };
            },
          }),
        },
      });
      return { applies };
    }

    test('opens the manager and applies the selected preset', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });
      const stub = makeStubCtx({
        selects: ['cheap', 'apply', 'global'],
        confirms: [true],
      });
      const unregister = registerConfigChangeListener(projectDir, () => ({
        ok: true,
      }));

      try {
        await runPresetFlow(stub.ctx);

        expect(stub.toasts).toHaveLength(1);
        expect(stub.toasts[0]).toContain('Saved preset "cheap"');
        expect(readUserConfig().preset).toBe('cheap');
      } finally {
        unregister();
      }
      expect(stub.selectTitles()[0]).toBe('Presets');
      const listArgs = stub.selectCalls[0] as {
        current?: string;
        options?: Array<{ title: string; value: string }>;
      };
      expect(listArgs.current).toBe('balanced');
      expect(listArgs.options?.map((option) => option.value)).toEqual([
        'balanced',
        'cheap',
        '__omo_new_preset__',
      ]);
      expect(listArgs.options?.[0]?.title).toContain('(default)');
      expect(stub.selectTitles()[1]).toBe('Preset: cheap');
    });

    test('applies a named preset to the visible session and leaves the default alone', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });
      const stub = makeStubCtx();
      const { applies } = attachSessionRpc(stub);

      await runPresetFlow(stub.ctx, 'cheap');

      expect(stub.selectCalls).toHaveLength(0);
      expect(applies).toEqual([
        {
          input: { sessionID: 'visible-root', presetName: 'cheap' },
          options: { location: { directory: projectDir } },
        },
      ]);
      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain(
        'Applied preset "cheap" to this session\'s team.',
      );
      expect(stub.toasts[0]).toContain('global default stay unchanged');
      expect(readUserConfig().preset).toBe('balanced');
    });

    test('an unknown named preset binds nothing and lists the options', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx();
      const { applies } = attachSessionRpc(stub);

      await runPresetFlow(stub.ctx, 'nope');

      expect(applies).toEqual([]);
      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('Preset "nope" not found.');
      expect(stub.toasts[0]).toContain('Available presets: cheap');
    });

    test('a refused session binding surfaces the server reason and writes nothing', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx();
      Object.assign(stub.ctx.ui, {
        router: { current: () => ({ type: 'session', sessionID: 'child-1' }) },
      });
      Object.assign(stub.ctx, {
        client: {
          rpc: () => ({
            read: async () => ({
              sessionID: 'child-1',
              status: 'unbound',
              presetName: null,
              affects: 'future-children-only',
            }),
            apply: async () => {
              throw new Error('Cannot apply to an unbound child');
            },
          }),
        },
      });

      await runPresetFlow(stub.ctx, 'cheap');

      expect(stub.toasts).toEqual([
        'Preset "cheap" was not applied: Cannot apply to an unbound child',
      ]);
      expect(readUserConfig().preset).toBe('balanced');
    });

    test('a named preset on the home screen applies nothing', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx();
      Object.assign(stub.ctx.ui, {
        router: { current: () => ({ type: 'home' }) },
      });

      await runPresetFlow(stub.ctx, 'cheap');

      expect(stub.toasts).toEqual([
        'No session is displayed. Open a conversation first. Nothing was applied.',
      ]);
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('a host without session-preset RPC reports it instead of writing a default', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx();
      Object.assign(stub.ctx.ui, {
        router: { current: () => ({ type: 'session', sessionID: 'root' }) },
      });

      await runPresetFlow(stub.ctx, 'cheap');

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain(
        'Session presets are unavailable on this server',
      );
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('a named preset never writes config, so no config listener fires', async () => {
      writeUserConfig({
        preset: 'old',
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      let notifications = 0;
      const unregister = registerConfigChangeListener(projectDir, () => {
        notifications += 1;
        return { ok: true };
      });
      const stub = makeStubCtx();
      attachSessionRpc(stub);

      try {
        await runPresetFlow(stub.ctx, 'cheap');
      } finally {
        unregister();
      }

      expect(notifications).toBe(0);
      expect(readUserConfig().preset).toBe('old');
    });

    test('cancels silently when the manager is dismissed', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({ selects: [undefined] });

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toEqual([]);
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('bare /preset reads the current route and applies only its session through RPC', async () => {
      writeUserConfig(makeConfig() as unknown as Record<string, unknown>);
      const before = fs.readFileSync(userConfigPath(), 'utf-8');
      const stub = makeStubCtx({
        selects: ['cheap', 'apply', 'session'],
        confirms: [true],
      });
      const reads: unknown[] = [];
      const applies: unknown[] = [];
      Object.assign(stub.ctx.ui, {
        router: {
          current: () => ({ type: 'session', sessionID: 'visible-root' }),
        },
      });
      Object.assign(stub.ctx, {
        client: {
          rpc: (contract: { id: string }) => {
            expect(contract.id).toBe('oh-my-opencode-slim.session-preset.v1');
            return {
              read: async (input: unknown, options: unknown) => {
                reads.push({ input, options });
                return {
                  sessionID: 'visible-root',
                  status: 'unbound',
                  presetName: null,
                  affects: 'future-children-only',
                };
              },
              apply: async (input: unknown, options: unknown) => {
                applies.push({ input, options });
                return {
                  sessionID: 'visible-root',
                  status: 'bound',
                  presetName: 'cheap',
                  affects: 'future-children-only',
                };
              },
            };
          },
        },
      });
      await runPresetFlow(stub.ctx);
      expect(reads).toEqual([
        {
          input: { sessionID: 'visible-root' },
          options: {
            location: { directory: projectDir },
            signal: expect.any(AbortSignal),
          },
        },
      ]);
      expect(applies).toEqual([
        {
          input: { sessionID: 'visible-root', presetName: 'cheap' },
          options: { location: { directory: projectDir } },
        },
      ]);
      expect(stub.toasts[0]).toContain('"cheap" applied.');
      expect(fs.readFileSync(userConfigPath(), 'utf-8')).toBe(before);
      expect(stub.reloadCalls()).toBe(0);
    });

    test('bare /preset on home rejects Current session without RPC or a global write', async () => {
      writeUserConfig(makeConfig() as unknown as Record<string, unknown>);
      const before = readUserConfig();
      const stub = makeStubCtx({ selects: ['cheap', 'apply', 'session'] });
      Object.assign(stub.ctx.ui, {
        router: { current: () => ({ type: 'home' }) },
      });
      await runPresetFlow(stub.ctx);
      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('No session is displayed');
      expect(readUserConfig()).toEqual(before);
    });

    test('opens the create prompt when no presets are configured', async () => {
      // An explicit (preset-less) user config stops the search before the
      // machine's real default config dir.
      writeUserConfig({});
      const stub = makeStubCtx({ prompts: [undefined] });

      await runPresetFlow(stub.ctx);

      expect(stub.selectCalls).toHaveLength(0);
      expect(
        (stub.promptCalls[0] as { title?: string } | undefined)?.title,
      ).toBe('Create new preset');
      // Cancelled create leaves the config untouched and closes the manager.
      expect(readUserConfig()).toEqual({});
    });

    test('applies a named preset without a toast surface', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({}, { withToast: false });
      const { applies } = attachSessionRpc(stub);

      await runPresetFlow(stub.ctx, 'cheap');

      expect(applies).toHaveLength(1);
    });

    test('guides when the host exposes no dialogs', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx({}, { withDialogs: false });

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('dialog API');
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('toasts warning and does not persist when project config preset conflicts', async () => {
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: 'locked-by-project' }),
      );

      writeUserConfig({
        preset: 'old',
        presets: {
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
          'locked-by-project': {
            orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
          },
        },
      });

      const stub = makeStubCtx({
        selects: ['cheap', 'apply', 'global'],
        confirms: [true],
      });
      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('project config (.opencode)');
      expect(stub.toasts[0]).toContain('"locked-by-project"');
      expect(readUserConfig().preset).toBe('old');
    });
  });

  describe('plugin module', () => {
    interface KeymapCommandStub {
      id?: string;
      title?: string;
      group?: string;
      palette?: boolean;
      slash?: { name: string; aliases?: string[]; arguments?: boolean };
      run: (input?: string) => void | Promise<void>;
    }

    interface SetupStub {
      ctx: Record<string, unknown>;
      slotClaims: Array<{ append?: string; render?: () => unknown }>;
      layers: Array<{ mode?: string; commands: KeymapCommandStub[] }>;
      renderAppSlot: () => void;
      keymapDisposed: () => boolean;
      slotDisposeCalls: () => number;
    }

    function makeSetupCtx(options: { keymap?: boolean } = {}): SetupStub {
      const { keymap = true } = options;
      const slotClaims: Array<{ append?: string; render?: () => unknown }> = [];
      const layers: SetupStub['layers'] = [];
      let slotDisposeCalls = 0;
      let keymapDisposed = false;
      const ctx: Record<string, unknown> = {
        location: { directory: projectDir },
        renderer: { requestRender: () => {} },
        theme: {
          categorical: [
            {
              100: '#001100',
              200: '#002200',
              300: '#003300',
              400: '#004400',
              500: RGBA.fromInts(210, 80, 90),
              600: '#006600',
              700: '#007700',
              800: '#008800',
              900: '#009900',
            },
            {
              100: '#110000',
              200: '#220000',
              300: '#330000',
              400: '#440000',
              500: RGBA.fromInts(80, 170, 100),
              600: '#660000',
              700: '#770000',
              800: '#880000',
              900: '#990000',
            },
          ],
          hue: {
            interactive: {
              100: '#111111',
              200: RGBA.fromInts(70, 90, 210),
              300: '#333333',
              400: '#444444',
              500: '#555555',
              600: '#666666',
              700: '#777777',
              800: '#888888',
              900: '#999999',
            },
          },
          text: {
            base: '#f0f0f0',
            muted: '#8a8a8a',
            feedback: {
              success: { base: '#12ab34' },
              warning: { base: '#de9b21' },
            },
          },
          background: { base: '#101010', raised: { base: '#202020' } },
          border: { base: '#3a3a3a' },
        },
        ui: {
          slot: (claim: { append?: string; render?: () => unknown }) => {
            slotClaims.push(claim);
            return () => {
              slotDisposeCalls += 1;
            };
          },
          router: {
            current: () => ({ type: 'home' }),
          },
        },
      };
      if (keymap) {
        ctx.keymap = {
          layer: (thunk: () => SetupStub['layers'][number]) => {
            layers.push(thunk());
            return {
              dispose: () => {
                keymapDisposed = true;
              },
            };
          },
        };
      }
      return {
        ctx,
        slotClaims,
        layers,
        renderAppSlot: () => {
          const claim = slotClaims.find((slot) => slot.append === 'app');
          claim?.render?.();
        },
        keymapDisposed: () => keymapDisposed,
        slotDisposeCalls: () => slotDisposeCalls,
      };
    }

    test('keeps the v1 dual contract and extends the v2 setup', () => {
      expect(tui2Plugin.id).toBe(baseTui.id);
      expect(tui2Plugin.tui).toBe(baseTui.tui);
      expect(typeof tui2Plugin.setup).toBe('function');
    });

    test('sidebar separates default from session snapshot and rejects stale route/workspace responses', async () => {
      writeUserConfig(makeConfig() as unknown as Record<string, unknown>);
      process.env.XDG_DATA_HOME = path.join(configHome, 'sidebar-data');
      process.env.OPENCODE_LOG_DIR = path.join(configHome, 'logs');
      process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS = '60000';
      recordTuiAgentModels(
        { agentModels: { oracle: 'global/team-b' } },
        projectDir,
      );
      const [route, setRoute] = createSignal({
        type: 'session',
        sessionID: 'root-a',
      });
      const [directory, setDirectory] = createSignal(projectDir);
      const stub = makeSetupCtx();
      const ui = stub.ctx.ui as { router: { current: () => unknown } };
      ui.router.current = route;
      Object.defineProperty(stub.ctx, 'location', {
        get: () => ({ directory: directory() }),
      });
      let notifyRendered = () => {};
      const rendered = new Promise<void>((resolve) => {
        notifyRendered = resolve;
      });
      stub.ctx.renderer = { requestRender: () => notifyRendered() };
      let notifySecondRead = () => {};
      const secondRead = new Promise<void>((resolve) => {
        notifySecondRead = resolve;
      });
      let finishSecondRead: (value: unknown) => void = () => {};
      const pending = new Promise((resolve) => {
        finishSecondRead = resolve;
      });
      const requests: unknown[] = [];
      stub.ctx.client = {
        rpc: () => ({
          read: async (input: { sessionID: string }, options: unknown) => {
            requests.push({ input, options });
            if (input.sessionID === 'root-b') {
              notifySecondRead();
              return pending;
            }
            return {
              sessionID: input.sessionID,
              status: 'bound',
              presetName: 'server-alpha',
              affects: 'future-children-only',
              team: {
                agentModels: { oracle: 'saved/team-a' },
                agentVariants: {},
                inheritance: {},
              },
            };
          },
        }),
      };
      let cleanup: (() => void) | undefined;
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      try {
        cleanup = await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        );
        await rendered;
        const sidebar = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );
        if (!sidebar?.render) throw new Error('Sidebar slot missing');
        screen = await testRender(() => sidebar.render?.() as never, {
          width: 80,
          height: 32,
        });
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain('Default');
        expect(screen.captureCharFrame()).toContain('balanced');
        expect(screen.captureCharFrame()).toContain(
          'Session team snapshot: server-alpha',
        );
        expect(screen.captureCharFrame()).toContain('team-a');
        expect(screen.captureCharFrame()).not.toContain('team-b');

        setRoute({ type: 'session', sessionID: 'root-b' });
        await screen.renderOnce();
        expect(screen.captureCharFrame()).not.toContain('server-alpha');
        expect(screen.captureCharFrame()).not.toContain('team-a');
        expect(screen.captureCharFrame()).toContain(
          'Session team snapshot: Loading',
        );
        writeUserConfig({
          ...makeConfig(),
          preset: 'cheap',
        } as unknown as Record<string, unknown>);
        await notifyConfigChanged(projectDir, 'test-route-refresh');
        await secondRead;
        setRoute({ type: 'session', sessionID: 'root-c' });
        setDirectory(configHome);
        finishSecondRead({
          sessionID: 'root-b',
          status: 'bound',
          presetName: 'late-beta',
          affects: 'future-children-only',
          team: {
            agentModels: { oracle: 'saved/late-team' },
            agentVariants: {},
            inheritance: {},
          },
        });
        await screen.renderOnce();
        expect(screen.captureCharFrame()).not.toContain('late-beta');
        expect(screen.captureCharFrame()).not.toContain('late-team');
        expect(screen.captureCharFrame()).not.toContain('server-alpha');
        expect(requests[1]).toEqual({
          input: { sessionID: 'root-b' },
          options: {
            location: { directory: projectDir },
            signal: expect.any(AbortSignal),
          },
        });
        setRoute({ type: 'home', sessionID: '' });
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain(
          'Session team snapshot: No session displayed',
        );
      } finally {
        finishSecondRead({
          sessionID: 'root-b',
          status: 'unbound',
          presetName: null,
          affects: 'future-children-only',
        });
        cleanup?.();
        screen?.renderer.destroy();
      }
    });

    test('sidebar overlays the picker selection only on a root orchestrator session', async () => {
      writeUserConfig({ ...makeConfig(), compactSidebar: false });
      process.env.XDG_DATA_HOME = path.join(configHome, 'overlay-data');
      process.env.OPENCODE_LOG_DIR = path.join(configHome, 'logs');
      process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS = '60000';
      // Static on-disk projection: what the sidebar shows WITHOUT the overlay.
      recordTuiAgentModels(
        {
          agentModels: { orchestrator: 'zai-coding-plan/glm-5.3' },
          agentVariants: { orchestrator: 'medium' },
        },
        projectDir,
      );
      const [route, setRoute] = createSignal({
        type: 'session',
        sessionID: 'root-a',
      });
      const stub = makeSetupCtx();
      const ui = stub.ctx.ui as {
        router: { current: () => unknown };
        model?: unknown;
      };
      ui.router.current = route;
      ui.model = {
        current: () => ({
          providerID: 'opencode-go',
          modelID: 'gemini-x',
          variant: 'high',
        }),
      };
      stub.ctx.data = {
        session: {
          get: (sessionID: string) =>
            sessionID === 'root-a'
              ? { agent: 'orchestrator' }
              : sessionID === 'child-1'
                ? { parentID: 'root-a', agent: 'explorer' }
                : { agent: 'general' },
        },
      };
      let notifyRendered = () => {};
      const rendered = new Promise<void>((resolve) => {
        notifyRendered = resolve;
      });
      stub.ctx.renderer = { requestRender: () => notifyRendered() };
      stub.ctx.client = {
        rpc: () => ({
          read: async (input: { sessionID: string }) => ({
            sessionID: input.sessionID,
            status: 'bound',
            presetName: 'balanced',
            affects: 'future-children-only',
            team: {
              agentModels: { orchestrator: 'saved/preset-root-model' },
              agentVariants: { orchestrator: 'low' },
              inheritance: {},
            },
          }),
        }),
      };
      let cleanup: (() => void) | undefined;
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      /**
       * Flip the preset row (a real config-state change) to re-drive
       * refreshSidebar, then poll the rendered frame until it shows the
       * expected model. The refresh itself is event-driven; waitFor only
       * bridges the renderOnce/frame microtask gap.
       */
      const assertRouteShows = async (
        preset: string,
        nextRoute: unknown,
        expectedModel: string,
        notExpectedModel: string,
        expectedVariant: string,
      ) => {
        writeUserConfig({
          ...makeConfig(),
          compactSidebar: false,
          preset,
        } as unknown as Record<string, unknown>);
        setRoute(nextRoute as { type: string; sessionID?: string });
        await notifyConfigChanged(projectDir, 'overlay-refresh');
        await waitFor(() => {
          void screen?.renderOnce();
          return screen?.captureCharFrame().includes(expectedModel) === true;
        });
        const frame = screen?.captureCharFrame() ?? '';
        expect(frame).not.toContain(notExpectedModel);
        expect(frame).not.toContain('preset-root-model');
        expect(frame).toMatch(new RegExp(`variant\\s+${expectedVariant}`));
      };
      try {
        cleanup = await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        );
        await rendered;
        const sidebar = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );
        if (!sidebar?.render) throw new Error('Sidebar slot missing');
        screen = await testRender(() => sidebar.render?.() as never, {
          width: 80,
          height: 32,
        });
        await screen.renderOnce();
        // Root orchestrator session: the picker selection replaces the
        // static row immediately, before any prompt commits the switch.
        expect(screen.captureCharFrame()).toContain('gemini-x');
        expect(screen.captureCharFrame()).not.toContain('glm-5.3');
        expect(screen.captureCharFrame()).toMatch(/variant\s+high/);

        // Every leg starts from a root-a frame showing gemini-x, so each
        // route change below has an observable transition (no vacuous
        // passes) — child sessions, other root agents, and the home screen
        // all lift the overlay back to the static on-disk model.
        await assertRouteShows(
          'cheap',
          { type: 'session', sessionID: 'child-1' },
          'glm-5.3',
          'gemini-x',
          'medium',
        );
        await assertRouteShows(
          'balanced',
          { type: 'session', sessionID: 'root-a' },
          'gemini-x',
          'glm-5.3',
          'high',
        );
        await assertRouteShows(
          'cheap',
          { type: 'session', sessionID: 'root-b' },
          'glm-5.3',
          'gemini-x',
          'medium',
        );
        await assertRouteShows(
          'balanced',
          { type: 'home', sessionID: '' },
          'glm-5.3',
          'gemini-x',
          'medium',
        );
      } finally {
        cleanup?.();
        screen?.renderer.destroy();
      }
    });

    test('setup registers the sidebar slot and the /preset layer in the app slot render', async () => {
      const stub = makeSetupCtx();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        expect(stub.slotClaims.map((slot) => slot.append)).toEqual([
          'sidebar.content',
          'app',
        ]);
        expect(stub.layers).toHaveLength(0);

        stub.renderAppSlot();

        expect(stub.layers).toHaveLength(1);
        const layer = stub.layers[0];
        expect(layer?.mode).toBe('global');
        const command = layer?.commands[0];
        expect(command?.id).toBe('omo.preset');
        expect(command?.title).toBe('OMO: switch preset');
        expect(command?.group).toBe('System');
        expect(command?.palette).toBe(true);
        expect(command?.slash).toEqual({ name: 'preset', arguments: true });
        expect(stub.keymapDisposed()).toBe(false);

        cleanup?.();
        cleanup = undefined;
        expect(stub.keymapDisposed()).toBe(false);
        expect(stub.slotDisposeCalls()).toBe(2);
      } finally {
        cleanup?.();
      }
    });

    test('disabled_commands preset removes the TUI /preset command', async () => {
      writeUserConfig({ disabled_commands: ['preset'] });
      const stub = makeSetupCtx();
      const cleanup = (await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      )) as (() => void) | undefined;

      stub.renderAppSlot();

      expect(stub.layers[0]?.commands.map((command) => command.id)).toEqual([
        'omo.kill_all',
        'omo.open_subagent',
      ]);
      cleanup?.();
    });

    test('disabled_commands killall/subagent remove their keymap commands', async () => {
      writeUserConfig({ disabled_commands: ['killall', 'subagent'] });
      const stub = makeSetupCtx();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        stub.renderAppSlot();

        expect(stub.layers[0]?.commands.map((command) => command.id)).toEqual([
          'omo.preset',
        ]);
      } finally {
        cleanup?.();
      }
    });

    test('default enabled commands stay registered (preset, killall, subagent)', async () => {
      // An explicit empty user config stops the search before the machine's
      // real default config dir, so the defaults here are deterministic.
      writeUserConfig({});
      const stub = makeSetupCtx();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        stub.renderAppSlot();

        expect(stub.layers[0]?.commands.map((command) => command.id)).toEqual([
          'omo.preset',
          'omo.kill_all',
          'omo.open_subagent',
        ]);
      } finally {
        cleanup?.();
      }
    });

    test('setup registers nothing when the tui master switch is false', async () => {
      writeUserConfig({ tui: false });
      const stub = makeSetupCtx();

      const cleanup = await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      );

      // No sidebar slot, no app/preset slot, no keymap layer, no disposer:
      // the TUI entry registers nothing at all.
      expect(stub.slotClaims).toHaveLength(0);
      expect(stub.layers).toHaveLength(0);
      expect(cleanup).toBeUndefined();
    });

    test('renders agent labels and models in categorical colors and the brand in the interactive hue', async () => {
      const stub = makeSetupCtx();
      writeUserConfig(makeConfig() as unknown as Record<string, unknown>);
      recordTuiSessionParent('oracle-live', 'root', projectDir);
      recordTuiAgentActivity(
        {
          sessionID: 'oracle-live',
          agentName: 'oracle',
          active: true,
          details: { status: 'busy' },
        },
        projectDir,
      );
      recordTuiAgentModels(
        {
          agentModels: {
            oracle: 'openai/gpt-5-mini',
            explorer: 'anthropic/claude-haiku',
          },
          agentDisplayNames: { oracle: 'Oracle' },
        },
        projectDir,
      );
      let cleanup: (() => void) | undefined;
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        (stub.ctx.ui as { router: { current: () => unknown } }).router.current =
          () => ({ type: 'session', sessionID: 'root' });
        const sidebarSlot = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );

        expect(sidebarSlot).toBeDefined();
        screen = await testRender(() => sidebarSlot?.render?.() as never, {
          width: 160,
          height: 24,
        });
        await screen.renderOnce();

        const spans = screen.captureSpans().lines.flatMap((line) => line.spans);
        const namedAgent = spans.find((span) => span.text.includes('Oracle'));
        const secondAgent = spans.find((span) =>
          span.text.includes('explorer'),
        );
        const model = spans.find((span) => span.text.includes('gpt-5-mini'));
        const secondModel = spans.find((span) =>
          span.text.includes('claude-haiku'),
        );
        const brand = spans.find((span) => span.text.includes('OMO-Slim'));
        const activeIndicator = spans.find(
          (span) =>
            Math.abs(span.fg.g - 171 / 255) < 0.01 &&
            Math.abs(span.fg.b - 52 / 255) < 0.01,
        );
        const mutedText = spans.find(
          (span) =>
            span.text.startsWith('v') && Math.abs(span.fg.r - 138 / 255) < 0.01,
        );
        expect(namedAgent).toBeDefined();
        expect(secondAgent).toBeDefined();
        expect(model).toBeDefined();
        expect(secondModel).toBeDefined();
        expect(brand).toBeDefined();
        expect(activeIndicator).toBeDefined();
        expect(mutedText).toBeDefined();
        expect(namedAgent?.fg.r).toBeCloseTo(210 / 255);
        expect(secondAgent?.fg.r).toBeCloseTo(80 / 255);
        expect(model?.fg).toEqual(namedAgent?.fg);
        expect(secondModel?.fg).toEqual(secondAgent?.fg);
        expect(brand?.bg.b).toBeCloseTo(210 / 255);
        expect(brand?.fg.r).toBeCloseTo(240 / 255);
        expect(activeIndicator?.fg.g).toBeCloseTo(171 / 255);
      } finally {
        cleanup?.();
        screen?.renderer.destroy();
      }
    });

    test('agent hover contrasts with the raised sidebar surface and restores on exit', async () => {
      const stub = makeSetupCtx();
      writeUserConfig(makeConfig() as unknown as Record<string, unknown>);
      recordTuiAgentModels(
        { agentModels: { oracle: 'openai/gpt-5-mini' } },
        projectDir,
      );
      let cleanup: (() => void) | undefined;
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        (stub.ctx.ui as { router: { current: () => unknown } }).router.current =
          () => ({ type: 'session', sessionID: 'root' });
        const sidebarSlot = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );
        screen = await testRender(() => sidebarSlot?.render?.() as never, {
          width: 80,
          height: 16,
        });
        await screen.renderOnce();

        const row = screen
          .captureCharFrame()
          .split('\n')
          .findIndex((line) => line.includes('oracle'));
        expect(row).toBeGreaterThanOrEqual(0);
        const backgrounds = () =>
          screen
            ?.captureSpans()
            .lines[row]?.spans.map((span) => span.bg.toInts());
        const before = backgrounds();
        expect(before?.length).toBeGreaterThan(0);
        // Unpainted rows inherit the fixture's raised (#202020) sidebar
        // surface. Hover must be an opaque contrast color, not that surface.
        expect(before?.every((color) => color[3] === 0)).toBe(true);
        await screen.mockMouse.moveTo(5, row);
        await screen.renderOnce();
        const hovered = backgrounds();
        expect(hovered).not.toEqual(before);
        const painted = hovered?.filter((color) => color[3] > 0) ?? [];
        expect(
          painted.length > 0 &&
            painted.every(
              (color) => color[0] !== 32 || color[1] !== 32 || color[2] !== 32,
            ),
        ).toBe(true);
        await screen.mockMouse.moveTo(0, 15);
        await screen.renderOnce();
        expect(backgrounds()).toEqual(before);
      } finally {
        cleanup?.();
        screen?.renderer.destroy();
      }
    });

    test('renders retry indicators with the v2 warning token', async () => {
      const stub = makeSetupCtx();
      for (const sessionID of ['retrying', 'retrying2']) {
        recordTuiSessionParent(sessionID, 'root', projectDir);
        recordTuiAgentActivity(
          {
            sessionID,
            agentName: 'oracle',
            active: true,
            details: { status: 'retry' },
          },
          projectDir,
        );
      }
      recordTuiAgentModels(
        { agentModels: { oracle: 'openai/gpt-5-mini' } },
        projectDir,
      );
      (
        stub.ctx.ui as {
          router: { current: () => unknown; navigate?: unknown };
        }
      ).router.current = () => ({ type: 'session', sessionID: 'root' });
      (stub.ctx.ui as { router: { navigate?: unknown } }).router.navigate =
        () => {};
      let cleanup: (() => void) | undefined;
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        const sidebarSlot = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );
        expect(sidebarSlot).toBeDefined();
        screen = await testRender(() => sidebarSlot?.render?.() as never, {
          width: 100,
          height: 20,
        });
        await screen.renderOnce();
        const initial = screen.captureSpans();
        const agentLine = initial.lines.findIndex((line) =>
          line.spans.some((span) => span.text.includes('oracle')),
        );
        expect(agentLine).toBeGreaterThanOrEqual(0);
        await screen.mockMouse.click(10, agentLine);
        await screen.flush();
        const spans = screen.captureSpans().lines.flatMap((line) => line.spans);
        const retryIndicator = spans.find(
          (span) =>
            Math.abs(span.fg.r - 222 / 255) < 0.01 &&
            Math.abs(span.fg.g - 155 / 255) < 0.01 &&
            Math.abs(span.fg.b - 33 / 255) < 0.01,
        );
        expect(retryIndicator).toBeDefined();
        expect(retryIndicator?.fg.r).toBeCloseTo(222 / 255);
        expect(retryIndicator?.fg.g).toBeCloseTo(155 / 255);
        expect(retryIndicator?.fg.b).toBeCloseTo(33 / 255);
      } finally {
        cleanup?.();
        screen?.renderer.destroy();
      }
    });

    test('re-invokes layer on every app slot render', async () => {
      const stub = makeSetupCtx();
      const cleanup = (await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      )) as (() => void) | undefined;

      stub.renderAppSlot();
      stub.renderAppSlot();

      expect(stub.layers).toHaveLength(2);
      cleanup?.();
    });

    test('runs the preset flow when the registered command is invoked', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeSetupCtx();
      const applies: unknown[] = [];
      (stub.ctx.ui as { router: { current: () => unknown } }).router.current =
        () => ({ type: 'session', sessionID: 'root-a' });
      stub.ctx.client = {
        rpc: () => ({
          read: async () => ({
            sessionID: 'root-a',
            status: 'unbound',
            presetName: null,
            affects: 'future-children-only',
          }),
          apply: async (input: unknown) => {
            applies.push(input);
            return {
              sessionID: 'root-a',
              status: 'bound',
              presetName: (input as { presetName: string }).presetName,
              affects: 'future-children-only',
            };
          },
        }),
      };
      const cleanup = (await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      )) as (() => void) | undefined;

      stub.renderAppSlot();
      await stub.layers[0]?.commands[0]?.run('cheap');

      expect(applies).toEqual([{ sessionID: 'root-a', presetName: 'cheap' }]);
      expect(readUserConfig().preset).toBeUndefined();
      cleanup?.();
    });

    test('setup keeps the sidebar when keymap.layer is unavailable', async () => {
      const stub = makeSetupCtx({ keymap: false });
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        expect(stub.slotClaims.map((slot) => slot.append)).toEqual([
          'sidebar.content',
          'app',
        ]);
        stub.renderAppSlot();
        expect(stub.layers).toHaveLength(0);
      } finally {
        cleanup?.();
      }
    });

    test('setup registers nothing when disabled by env', async () => {
      process.env.OH_MY_OPENCODE_SLIM_DISABLE = '1';
      const stub = makeSetupCtx();

      const cleanup = await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      );

      expect(stub.slotClaims).toHaveLength(0);
      expect(stub.layers).toHaveLength(0);
      expect(cleanup).toBeUndefined();
    });

    test('layer includes omo.kill_all with alt+w bind', async () => {
      const stub = makeSetupCtx();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.kill_all',
        );
        expect(command?.title).toBe('OMO: kill all running subagents');
        expect(command?.group).toBe('System');
        expect(command?.palette).toBe(true);
        expect(command?.slash).toEqual({ name: 'killall' });
        expect((command as { bind?: string } | undefined)?.bind).toBe('alt+w');
      } finally {
        cleanup?.();
      }
    });

    test('omo.kill_all run aborts visible-conversation running subagents and toasts', async () => {
      const originalDataHome = process.env.XDG_DATA_HOME;
      const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-kill2-'));
      const aborts: string[] = [];
      const toasts: string[] = [];
      let cleanup: (() => void) | undefined;
      try {
        process.env.XDG_DATA_HOME = dataHome;
        recordTuiSessionParent('ora-live', 'conv-1', projectDir);
        recordTuiAgentActivity(
          {
            sessionID: 'ora-live',
            agentName: 'oracle',
            active: true,
            details: { status: 'busy' },
          },
          projectDir,
        );

        const stub = makeSetupCtx();
        (stub.ctx as { client?: unknown }).client = {
          v2: {},
          session: {
            abort: async (args: { sessionID: string }) => {
              aborts.push(args.sessionID);
            },
          },
        };
        (stub.ctx.ui as { router?: unknown }).router = {
          current: () => ({ type: 'session', sessionID: 'conv-1' }),
        };
        (stub.ctx.ui as { toast?: unknown }).toast = {
          show: (toast: { message: string }) => {
            toasts.push(toast.message);
          },
        };

        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.kill_all',
        );
        await command?.run();
        // run() is fire-and-forget (void runKillAllFlow): the abort call
        // starts synchronously, the toast lands a microtask later.
        await Bun.sleep(50);

        expect(aborts).toEqual(['ora-live']);
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toContain('Kill-all sent to 1 running subagent');
      } finally {
        cleanup?.();
        fs.rmSync(dataHome, { recursive: true, force: true });
        if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalDataHome;
      }
    });

    test('fallback command opens the latest subagent tab manually', async () => {
      const stub = makeSetupCtx();
      const opened: string[] = [];
      const toasts: string[] = [];
      stub.ctx.data = {
        session: {
          list: () => [
            { id: 'ora-old', parentID: 'conv-1', time: { created: 1 } },
            { id: 'ora-new', parentID: 'conv-1', time: { created: 2 } },
            { id: 'other', parentID: 'conv-2', time: { created: 3 } },
          ],
        },
      };
      (stub.ctx.ui as { router?: unknown }).router = {
        current: () => ({ type: 'session', sessionID: 'conv-1' }),
      };
      (stub.ctx.ui as { tabs?: unknown }).tabs = {
        enabled: () => true,
        open: (sessionID: string) => {
          opened.push(sessionID);
          return true;
        },
      };
      (stub.ctx.ui as { toast?: unknown }).toast = {
        show: (toast: { message: string }) => {
          toasts.push(toast.message);
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.open_subagent',
        );
        expect(command).toBeDefined();
        // Registration alone must never open anything (manual fallback).
        expect(opened).toEqual([]);

        await command?.run();
        await Bun.sleep(10);
        expect(opened).toEqual(['ora-new']);
        expect(toasts[0]).toContain('ora-new');
      } finally {
        cleanup?.();
      }
    });

    test('fallback command toasts when session tabs are disabled', async () => {
      const stub = makeSetupCtx();
      const opened: string[] = [];
      const toasts: string[] = [];
      stub.ctx.data = {
        session: {
          list: () => [
            { id: 'ora-new', parentID: 'conv-1', time: { created: 2 } },
          ],
        },
      };
      (stub.ctx.ui as { router?: unknown }).router = {
        current: () => ({ type: 'session', sessionID: 'conv-1' }),
      };
      (stub.ctx.ui as { tabs?: unknown }).tabs = {
        enabled: () => false,
        open: (sessionID: string) => {
          opened.push(sessionID);
          return false;
        },
      };
      (stub.ctx.ui as { toast?: unknown }).toast = {
        show: (toast: { message: string }) => {
          toasts.push(toast.message);
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        stub.renderAppSlot();

        const command = stub.layers[0]?.commands.find(
          (c) => c.id === 'omo.open_subagent',
        );
        await command?.run();
        await Bun.sleep(10);
        expect(opened).toEqual([]);
        expect(toasts[0]).toContain('tabs are disabled');
      } finally {
        cleanup?.();
      }
    });

    test('a standalone host never wires panes even with a multiplexer configured', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';
      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--standalone'];

      const subscriptions: string[] = [];
      stub.ctx.data = {
        on: (type: string) => {
          subscriptions.push(type);
          return () => {};
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => ({ urls: ['http://127.0.0.1:9999'] }),
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        // Standalone: no wiring, no subscriptions (diagnostic path instead).
        expect(subscriptions).toEqual([]);
      } finally {
        cleanup?.();
        process.argv = originalArgv;
      }
    });

    test('wires the v2 pane lifecycle in shared mode and disposes it on cleanup', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      // First call resolves the shared-service base URL; every later call is
      // the liveness probe, which fails here so the wiring never reaches the
      // real adapter factory (no tmux commands run during the test).
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;

        // The wiring subscribes through the host `data.on` feed, proving the
        // lifecycle was established for this v2 process.
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }

      // Disposal must release every host subscription (fire-and-forget in the
      // setup cleanup; the unsubscribe loop runs synchronously).
      expect([...unsubscribed].sort()).toEqual(expectedEvents);
    });

    async function assertProjectPaneAdmission(sidebar: boolean) {
      writeUserConfig({
        sidebar,
        disabled_hooks: ['auto-update-checker'],
      });
      const projectB = path.join(projectDir, 'project-b');
      for (const [directory, type] of [
        [projectDir, 'tmux'],
        [projectB, 'none'],
      ]) {
        const configDir = path.join(directory, '.opencode');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, 'oh-my-opencode-slim.json'),
          JSON.stringify({ multiplexer: { type } }),
        );
      }
      process.env.TMUX_PANE = '%test';
      const originalArgv = process.argv;
      process.argv = ['opencode'];
      const spawn = jest
        .spyOn(TmuxMultiplexer.prototype, 'spawnPane')
        .mockResolvedValue({ success: true, paneId: '%test-child' });
      const close = jest
        .spyOn(TmuxMultiplexer.prototype, 'closePane')
        .mockResolvedValue(true);
      const layout = jest
        .spyOn(TmuxMultiplexer.prototype, 'applyLayout')
        .mockResolvedValue();
      const sweep = jest
        .spyOn(TmuxMultiplexer.prototype, 'listPanesWithTitles')
        .mockResolvedValue([]);
      const stub = makeSetupCtx();
      let directory = projectDir;
      let parent = 'parent-a';
      Object.defineProperty(stub.ctx, 'location', {
        get: () => ({ directory }),
      });
      (stub.ctx.ui as { router: { current: () => unknown } }).router.current =
        () => ({ type: 'session', sessionID: parent });
      const handlers = new Map<string, (event: unknown) => void>();
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
      };
      stub.ctx.client = {
        server: { info: async () => ({ urls: ['http://127.0.0.1:1'] }) },
        session: {
          list: async () => [],
          active: async () => ({ 'child-a': {}, 'child-b': {} }),
        },
      };
      jest.useFakeTimers();
      let cleanup: (() => Promise<void>) | undefined;
      try {
        expect(readTuiGates(projectB, 'v2').gates.multiplexerType).toBe('none');
        cleanup = await baseTui.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        );
        handlers.get('session.created')?.({
          data: {
            sessionID: 'child-a',
            parentID: parent,
            location: { directory },
          },
        });
        for (let i = 0; i < 40; i += 1) await Promise.resolve();
        expect(spawn).toHaveBeenCalledTimes(1);
        directory = projectB;
        parent = 'parent-b';
        handlers.get('session.created')?.({
          data: {
            sessionID: 'child-b',
            parentID: parent,
            location: { directory },
          },
        });
        for (let i = 0; i < 40; i += 1) await Promise.resolve();
        expect(spawn).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(5_000);
        for (let i = 0; i < 40; i += 1) await Promise.resolve();
        handlers.get('session.created')?.({
          data: {
            sessionID: 'child-b',
            parentID: parent,
            location: { directory },
          },
        });
        for (let i = 0; i < 40; i += 1) await Promise.resolve();
        expect(spawn).toHaveBeenCalledTimes(1);
      } finally {
        await cleanup?.();
        jest.useRealTimers();
        process.argv = originalArgv;
        spawn.mockRestore();
        close.mockRestore();
        layout.mockRestore();
        sweep.mockRestore();
      }
    }

    test('sidebar-off project changes apply the new pane admission', () =>
      assertProjectPaneAdmission(false));

    test('sidebar-on project changes apply the new pane admission', () =>
      assertProjectPaneAdmission(true));

    test('sidebar refresh renders project config already synced by pane wiring', async () => {
      writeUserConfig({
        ...makeConfig(),
        sidebar: true,
        disabled_hooks: ['auto-update-checker'],
      });
      process.env.XDG_DATA_HOME = path.join(configHome, 'sidebar-project-data');
      process.env.TMUX_PANE = '%test';
      delete process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS;
      delete process.env.OH_MY_OPENCODE_SLIM_PANE_VIEWER;
      const originalArgv = process.argv;
      process.argv = ['opencode'];
      const projectB = path.join(projectDir, 'project-b');
      for (const [directory, type, preset] of [
        [projectDir, 'tmux', 'balanced'],
        [projectB, 'none', 'cheap'],
      ]) {
        const configDir = path.join(directory, '.opencode');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(
          path.join(configDir, 'oh-my-opencode-slim.json'),
          JSON.stringify({
            multiplexer: { type },
            preset,
            compactSidebar: type !== 'none',
          }),
        );
      }
      const sweep = jest
        .spyOn(TmuxMultiplexer.prototype, 'listPanesWithTitles')
        .mockResolvedValue([]);
      const spawn = jest
        .spyOn(TmuxMultiplexer.prototype, 'spawnPane')
        .mockResolvedValue({ success: true, paneId: '%test-child' });
      const close = jest
        .spyOn(TmuxMultiplexer.prototype, 'closePane')
        .mockResolvedValue(true);
      const layout = jest
        .spyOn(TmuxMultiplexer.prototype, 'applyLayout')
        .mockResolvedValue();
      const stub = makeSetupCtx();
      let directory = projectDir;
      (stub.ctx.ui as { router: { current: () => unknown } }).router.current =
        () => ({
          type: 'session',
          sessionID: directory === projectDir ? 'parent-a' : 'parent-b',
        });
      Object.defineProperty(stub.ctx, 'location', {
        get: () => ({ directory }),
      });
      const handlers = new Map<string, (event: unknown) => void>();
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
      };
      stub.ctx.client = {
        server: { info: async () => ({ urls: ['http://127.0.0.1:1'] }) },
        session: { list: async () => [], active: async () => ({}) },
        rpc: () => ({
          read: async (input: { sessionID: string }) => ({
            sessionID: input.sessionID,
            status: 'unbound',
            presetName: null,
            affects: 'future-children-only',
          }),
        }),
      };
      let notifyRender = () => {};
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      stub.ctx.renderer = {
        requestRender: () => {
          notifyRender();
          screen?.renderer.requestRender();
        },
      };
      jest.useFakeTimers();
      let cleanup: (() => Promise<void>) | undefined;
      try {
        let rendered = new Promise<void>((resolve) => {
          notifyRender = resolve;
        });
        cleanup = await baseTui.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        );
        await rendered;
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        const sidebar = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );
        if (!sidebar?.render) throw new Error('Sidebar slot missing');
        screen = await testRender(() => sidebar.render?.() as never, {
          width: 80,
          height: 24,
        });
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain('Default balanced');
        directory = projectB;
        handlers.get('session.created')?.({
          data: {
            sessionID: 'child-b',
            parentID: 'parent-b',
            location: { directory },
          },
        });
        rendered = new Promise<void>((resolve) => {
          notifyRender = resolve;
        });
        jest.advanceTimersByTime(1_000);
        await rendered;
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain('Default cheap');
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        rendered = new Promise<void>((resolve) => {
          notifyRender = resolve;
        });
        recordTuiAgentModels(
          { agentModels: { oracle: 'r2-provider/r2-model' } },
          projectB,
        );
        jest.advanceTimersByTime(1_000);
        await rendered;
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain('r2-model');
        expect(screen.captureCharFrame()).toContain('r2-provider');
      } finally {
        await cleanup?.();
        jest.useRealTimers();
        process.argv = originalArgv;
        sweep.mockRestore();
        spawn.mockRestore();
        close.mockRestore();
        layout.mockRestore();
        screen?.renderer.destroy();
      }
    });

    test('sidebar updates the default preset changed in the preset manager', async () => {
      writeUserConfig({
        ...makeConfig(),
        disabled_hooks: ['auto-update-checker'],
        multiplexer: { type: 'none' },
      });
      process.env.XDG_DATA_HOME = path.join(configHome, 'preset-sidebar-data');
      delete process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS;
      delete process.env.OH_MY_OPENCODE_SLIM_PANE_VIEWER;
      const stub = makeSetupCtx();
      const ui = stub.ctx.ui as {
        router: { current: () => unknown };
        dialog?: unknown;
      };
      ui.router.current = () => ({ type: 'session', sessionID: 'root' });
      const selections = ['cheap', 'apply', 'global'];
      ui.dialog = {
        select: async () => selections.shift(),
        prompt: async () => undefined,
        confirm: async () => true,
      };
      let notifyRead = () => {};
      stub.ctx.client = {
        rpc: () => ({
          read: async () => {
            notifyRead();
            return {
              sessionID: 'root',
              status: 'bound',
              presetName: 'session-team',
              affects: 'future-children-only',
              team: {
                agentModels: { oracle: 'provider/model' },
                agentVariants: {},
                inheritance: {},
              },
            };
          },
        }),
      };
      let notifyRender = () => {};
      let screen: Awaited<ReturnType<typeof testRender>> | undefined;
      stub.ctx.renderer = {
        requestRender: () => {
          notifyRender();
          screen?.renderer.requestRender();
        },
      };
      jest.useFakeTimers();
      let cleanup: (() => Promise<void>) | undefined;
      try {
        let rendered = new Promise<void>((resolve) => {
          notifyRender = resolve;
        });
        cleanup = await baseTui.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        );
        await rendered;
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        rendered = new Promise<void>((resolve) => {
          notifyRender = resolve;
        });
        recordTuiAgentModels(
          { agentModels: { oracle: 'provider/model' } },
          projectDir,
        );
        jest.advanceTimersByTime(1_000);
        await rendered;
        const sidebar = stub.slotClaims.find(
          (slot) => slot.append === 'sidebar.content',
        );
        if (!sidebar?.render) throw new Error('Sidebar slot missing');
        screen = await testRender(() => sidebar.render?.() as never, {
          width: 80,
          height: 24,
        });
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain('Default balanced');
        expect(screen.captureCharFrame()).toContain(
          'Session team snapshot: session-team',
        );

        await runPresetFlow(stub.ctx as unknown as V2TuiPluginContext);
        expect(readUserConfig().preset).toBe('cheap');
        const refreshed = new Promise<void>((resolve) => {
          notifyRead = resolve;
        });
        jest.advanceTimersByTime(1_000);
        await refreshed;
        await screen.renderOnce();
        expect(screen.captureCharFrame()).toContain('Default cheap');
        expect(screen.captureCharFrame()).toContain(
          'Session team snapshot: session-team',
        );
      } finally {
        await cleanup?.();
        jest.useRealTimers();
        screen?.renderer.destroy();
      }
    });

    test('pane wiring follows the live v2 project location', async () => {
      writeUserConfig({ sidebar: false, multiplexer: { type: 'tmux' } });
      process.env.TMUX_PANE = '%1';
      delete process.env.TMUX;
      const originalArgv = process.argv;
      process.argv = ['opencode'];
      const stub = makeSetupCtx();
      let directory = projectDir;
      Object.defineProperty(stub.ctx, 'location', {
        get: () => ({ directory }),
      });
      const ui = stub.ctx.ui as { router: { current: () => unknown } };
      ui.router.current = () => ({ type: 'session', sessionID: 'parent' });
      const handlers = new Map<string, (event: unknown) => void>();
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
      };
      const reads: string[] = [];
      stub.ctx.client = {
        server: { info: async () => ({ urls: ['http://127.0.0.1:1'] }) },
        session: {
          list: async (input: { directory: string; parentID?: string }) => {
            if (!input.parentID) reads.push(input.directory);
            return [];
          },
          active: async () => [],
        },
      };
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        reads.length = 0;
        directory = `${projectDir}-new`;
        handlers.get('session.created')?.({
          data: {
            sessionID: 'child',
            parentID: 'parent',
            location: { directory },
          },
        });
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        expect(reads).toContain(directory);
      } finally {
        cleanup?.();
        process.argv = originalArgv;
      }
    });

    test('pane wiring retries a transient initial shared server failure', async () => {
      writeUserConfig({
        sidebar: false,
        disabled_hooks: ['auto-update-checker'],
        multiplexer: { type: 'tmux' },
      });
      process.env.TMUX_PANE = '%1';
      delete process.env.TMUX;
      const originalArgv = process.argv;
      process.argv = ['opencode'];
      const stub = makeSetupCtx();
      const subscriptions: string[] = [];
      stub.ctx.data = {
        on: (type: string) => {
          subscriptions.push(type);
          return () => {};
        },
      };
      let available = false;
      let calls = 0;
      stub.ctx.client = {
        server: {
          info: async () => {
            calls += 1;
            if (!available) throw new Error('temporary');
            return { urls: ['http://127.0.0.1:1'] };
          },
        },
      };
      jest.useFakeTimers();
      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect(calls).toBe(1);
        expect(subscriptions).toEqual([]);
        available = true;
        jest.advanceTimersByTime(5_000);
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
        expect(calls).toBeGreaterThan(1);
        expect(subscriptions).toContain('session.created');
      } finally {
        cleanup?.();
        jest.useRealTimers();
        process.argv = originalArgv;
      }
    });

    test('does not wire panes when the v2 server URL cannot be resolved', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions: string[] = [];
      stub.ctx.data = {
        on: (type: string) => {
          subscriptions.push(type);
          return () => {};
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            throw new Error('service down');
          },
        },
      };

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect(subscriptions).toEqual([]);
      } finally {
        cleanup?.();
      }
    });

    test('rebuilds the pane wiring when multiplexer.type is enabled (hot reload)', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ multiplexer: { type: 'none' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        // Disabled at startup: no wiring and no host subscriptions.
        expect(subscriptions.size).toBe(0);

        // v2 hot-reloads config; enabling panes must rebuild the wiring on the
        // next sidebar poll instead of staying unavailable until restart.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ multiplexer: { type: 'tmux' } }),
        );
        // Drive the real config notification instead of waiting on a guessed
        // poll interval (the sidebar-off interval is intentionally 5s).
        const notified = await notifyConfigChanged(
          projectDir,
          'pane-enable-test',
        );
        expect(notified.ok).toBe(true);
        const input = readTuiGates(projectDir, 'v2');
        expect(input.gates.multiplexerType).toBe('tmux');
        expect(input.paneConfig?.invalid).toBe(false);
        await waitFor(() => subscriptions.size > 0);
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }
      expect([...unsubscribed].sort()).toEqual(expectedEvents);
    });

    test('disposes the pane wiring when multiplexer.type is disabled (hot reload)', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);

        // Disabling panes must dispose the live wiring instead of leaving it
        // creating panes for the rest of the process lifetime.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ multiplexer: { type: 'none' } }),
        );
        const notified = await notifyConfigChanged(
          projectDir,
          'pane-disable-test',
        );
        expect(notified.ok).toBe(true);
        await waitFor(() => unsubscribed.length >= expectedEvents.length);
        expect([...unsubscribed].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }
    });

    test('disposes the pane wiring on hot reload with the sidebar disabled', async () => {
      // Keep this poll-driven config reload fast without depending on the
      // production 5s sidebar-off interval.
      process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS = '25';
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ sidebar: false, multiplexer: { type: 'tmux' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) return { urls: ['http://127.0.0.1:1'] };
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect([...subscriptions.keys()].sort()).toEqual(expectedEvents);

        // The sidebar switch must not take the pane config listener with it.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ sidebar: false, multiplexer: { type: 'none' } }),
        );
        const notified = await notifyConfigChanged(
          projectDir,
          'pane-disable-test',
        );
        expect(notified.ok).toBe(true);
        await waitFor(() => unsubscribed.length >= expectedEvents.length);
        expect([...unsubscribed].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
        cleanup = undefined;
      }
    });

    test('does not leave live pane wiring behind when teardown races a rebuild', async () => {
      const stub = makeSetupCtx();
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      const configPath = path.join(
        projectConfigDir,
        'oh-my-opencode-slim.json',
      );
      fs.writeFileSync(
        configPath,
        JSON.stringify({ multiplexer: { type: 'none' } }),
      );
      process.env.TMUX_PANE = '%1';

      const subscriptions = new Map<string, unknown>();
      const unsubscribed: string[] = [];
      let releaseResolve: ((value: { urls: string[] }) => void) | undefined;
      let infoCalls = 0;
      stub.ctx.data = {
        on: (type: string, handler: (event: unknown) => void) => {
          subscriptions.set(type, handler);
          return () => {
            unsubscribed.push(type);
          };
        },
      };
      stub.ctx.client = {
        server: {
          info: async () => {
            infoCalls += 1;
            if (infoCalls === 1) {
              return await new Promise<{ urls: string[] }>((resolve) => {
                releaseResolve = resolve;
              });
            }
            throw new Error('probe down');
          },
        },
      };

      const expectedEvents = [
        'session.created',
        'session.deleted',
        'session.execution.failed',
        'session.execution.interrupted',
        'session.execution.started',
        'session.execution.succeeded',
        'session.idle',
      ];

      let cleanup: (() => void) | undefined;
      try {
        cleanup = (await tui2Plugin.setup(
          stub.ctx as unknown as V2TuiPluginContext,
        )) as (() => void) | undefined;
        expect(subscriptions.size).toBe(0);

        // Start a rebuild, let it park on the host probe, then tear down
        // while it is still waiting.
        fs.writeFileSync(
          configPath,
          JSON.stringify({ multiplexer: { type: 'tmux' } }),
        );
        const notified = await notifyConfigChanged(
          projectDir,
          'pane-rebuild-test',
        );
        expect(notified.ok).toBe(true);
        await waitFor(() => infoCalls >= 1);
        cleanup();
        cleanup = undefined;
        releaseResolve?.({ urls: ['http://127.0.0.1:1'] });

        // The late wiring must dispose itself instead of staying subscribed
        // (and creating panes) for a closed TUI.
        await waitFor(() => unsubscribed.length >= expectedEvents.length);
        expect([...unsubscribed].sort()).toEqual(expectedEvents);
      } finally {
        cleanup?.();
      }
    });
  });
});
