import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import baseTui from '../tui';
import { recordTuiAgentActivity, recordTuiSessionParent } from '../tui-state';
import tui2Plugin, {
  applyPresetByName,
  buildPresetOptions,
  runPresetFlow,
  type V2TuiPluginContext,
} from './tui';

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
    process.env = originalEnv;
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('buildPresetOptions', () => {
    test('maps config presets to dialog options with agent summaries', () => {
      const options = buildPresetOptions(makeConfig());

      expect(options).toHaveLength(2);
      expect(options[0]).toMatchObject({
        title: 'balanced',
        value: 'balanced',
      });
      expect(options[0]?.description).toContain(
        'orchestrator → model: anthropic/claude-sonnet-4-5',
      );
      expect(options[1]).toMatchObject({ title: 'cheap', value: 'cheap' });
      expect(options[1]?.description).toContain(
        'orchestrator → model: openai/gpt-5-mini → temp: 0.4',
      );
    });

    test('shows effective resolved summaries for inheritance-only child presets', () => {
      const config = {
        presets: {
          base: {
            orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
          },
          child: {
            extends: 'base',
            agents: {},
          },
        },
      } as unknown as PluginConfig;

      const options = buildPresetOptions(config);

      const childOption = options.find((o) => o.value === 'child');
      expect(childOption).toBeDefined();
      expect(childOption?.description).toContain(
        'orchestrator → model: anthropic/claude-sonnet-4-5',
      );
    });

    test('shows effective resolved summaries combining base and child overrides', () => {
      const config = {
        presets: {
          base: {
            orchestrator: { model: 'anthropic/claude-sonnet-4-5' },
            oracle: { model: 'openai/gpt-5-mini' },
          },
          child: {
            extends: 'base',
            agents: {
              orchestrator: { model: 'openai/o3' },
            },
          },
        },
      } as unknown as PluginConfig;

      const options = buildPresetOptions(config);

      const childOption = options.find((o) => o.value === 'child');
      expect(childOption).toBeDefined();
      expect(childOption?.description).toContain(
        'orchestrator → model: openai/o3',
      );
      expect(childOption?.description).toContain(
        'oracle → model: openai/gpt-5-mini',
      );
    });

    test('shows summaries for presets with only non-model fields', () => {
      const config = {
        presets: {
          skillsOnly: {
            orchestrator: {
              inheritModelFrom: 'oracle',
              skills: ['test-skill'],
            },
          },
        },
      } as unknown as PluginConfig;

      const options = buildPresetOptions(config);

      expect(options).toHaveLength(1);
      expect(options[0]?.value).toBe('skillsOnly');
      expect(options[0]?.description).toContain('inherit: oracle');
      expect(options[0]?.description).toContain('skills: test-skill');
    });

    test('returns an empty list when no presets are configured', () => {
      expect(buildPresetOptions({} as PluginConfig)).toEqual([]);
    });
  });

  describe('applyPresetByName', () => {
    test('persists the preset name and returns a success message', () => {
      writeUserConfig({
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });

      const result = applyPresetByName(projectDir, makeConfig(), 'cheap');

      expect(result.ok).toBe(true);
      expect(result.presetName).toBe('cheap');
      expect(result.message).toContain('Saved preset "cheap"');
      expect(readUserConfig().preset).toBe('cheap');
    });

    test('reports unknown presets without touching the config file', () => {
      writeUserConfig({ preset: 'balanced' });

      const result = applyPresetByName(projectDir, makeConfig(), 'nope');

      expect(result.ok).toBe(false);
      expect(result.message).toContain('not found');
      expect(result.message).toContain('balanced');
      expect(readUserConfig()).toEqual({ preset: 'balanced' });
    });

    test('fails cleanly when project config explicitly sets a different preset', () => {
      const projectConfigDir = path.join(projectDir, '.opencode');
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc'),
        JSON.stringify({ preset: 'project-preset' }),
      );

      writeUserConfig({
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          'project-preset': { orchestrator: { model: 'openai/gpt-5' } },
        },
      });

      const result = applyPresetByName(projectDir, makeConfig(), 'balanced');

      expect(result.ok).toBe(false);
      expect(result.message).toContain(
        'project config (.opencode) explicitly sets preset "project-preset"',
      );
      expect(readUserConfig().preset).toBeUndefined();
    });
  });

  describe('runPresetFlow', () => {
    interface PresetStubCtx {
      ctx: {
        location: { directory: string };
        ui: {
          dialog: {
            select: (args: unknown) => Promise<string | undefined>;
          };
          toast?: { show: (toast: { message: string }) => void };
        };
      };
      toasts: string[];
      selectArgs: () => unknown;
    }

    function makeStubCtx(
      selection: string | undefined,
      withToast = true,
    ): PresetStubCtx {
      const toasts: string[] = [];
      let capturedSelectArgs: unknown;
      const ctx = {
        location: { directory: projectDir },
        ui: {
          dialog: {
            select: async (args: unknown) => {
              capturedSelectArgs = args;
              return selection;
            },
          },
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
      return { ctx, toasts, selectArgs: () => capturedSelectArgs };
    }

    test('selects, applies, and toasts the switch result', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });
      const stub = makeStubCtx('cheap');

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('Saved preset "cheap"');
      expect(readUserConfig().preset).toBe('cheap');
      const args = stub.selectArgs() as {
        title?: string;
        current?: string;
        options?: Array<{ value: string }>;
      };
      expect(args.title).toBe('Select preset');
      expect(args.current).toBe('balanced');
      expect(args.options?.map((option) => option.value)).toEqual([
        'balanced',
        'cheap',
      ]);
    });

    test('applies a named preset directly without opening the dialog', async () => {
      writeUserConfig({
        preset: 'balanced',
        presets: {
          balanced: { orchestrator: { model: 'anthropic/claude-sonnet-4-5' } },
          cheap: { orchestrator: { model: 'openai/gpt-5-mini' } },
        },
      });
      const stub = makeStubCtx('cheap');

      await runPresetFlow(stub.ctx, 'cheap');

      expect(stub.selectArgs()).toBeUndefined();
      expect(stub.toasts[0]).toContain('Saved preset "cheap"');
      expect(readUserConfig().preset).toBe('cheap');
    });

    test('cancels silently when the dialog is dismissed', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx(undefined);

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toEqual([]);
      expect(readUserConfig().preset).toBeUndefined();
    });

    test('toasts a hint when no presets are configured', async () => {
      // An explicit (preset-less) user config stops the search before the
      // machine's real default config dir.
      writeUserConfig({});
      const stub = makeStubCtx('cheap');

      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain('No presets configured');
      expect(stub.selectArgs()).toBeUndefined();
    });

    test('applies a named preset without a toast surface', async () => {
      writeUserConfig({
        presets: { cheap: { orchestrator: { model: 'openai/gpt-5-mini' } } },
      });
      const stub = makeStubCtx('cheap', false);

      await runPresetFlow(stub.ctx, 'cheap');

      expect(readUserConfig().preset).toBe('cheap');
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

      const stub = makeStubCtx('cheap');
      await runPresetFlow(stub.ctx);

      expect(stub.toasts).toHaveLength(1);
      expect(stub.toasts[0]).toContain(
        'project config (.opencode) explicitly sets preset "locked-by-project"',
      );
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
          text: { default: '#f0f0f0', subdued: '#8a8a8a' },
          background: { default: '#101010' },
          border: { default: '#3a3a3a' },
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
      const cleanup = (await tui2Plugin.setup(
        stub.ctx as unknown as V2TuiPluginContext,
      )) as (() => void) | undefined;

      stub.renderAppSlot();
      await stub.layers[0]?.commands[0]?.run('cheap');

      expect(readUserConfig().preset).toBe('cheap');
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
  });
});
