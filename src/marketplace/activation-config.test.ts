import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { mergePresetMaps, resolvePresetDefinition } from '../config/presets';
import {
  disableMarketplacePackage,
  enableMarketplaceAgent,
} from './activation-config';
import { acquireMarketplaceLease } from './lease';
import { getMarketplacePaths } from './paths';
import { MarketplaceStore } from './store';

const PACKAGE_A = 'community/docs-researcher';
const PACKAGE_B = 'community/other';

function bundle(id: string, agentName: string) {
  return {
    manifest: {
      schemaVersion: 2 as const,
      id,
      version: '1.0.0',
      displayName: agentName,
      description: 'Test agent package',
      agentName,
      prompt: 'A test prompt.',
      skills: [],
      mcps: [],
      tools: [],
      author: { name: 'Test author' },
      tags: [],
      license: 'MIT',
      compatibility: { plugin: '*' },
      model: { source: 'session' as const },
      routing: {
        description: 'Test routing',
        when: 'When testing',
        keywords: [],
      },
    },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-activation-config-'));
  const configHome = join(root, 'config');
  const project = join(root, 'project');
  const configDir = join(configHome, 'opencode');
  const projectConfigDir = join(project, '.opencode');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectConfigDir, { recursive: true });
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  process.env.XDG_CONFIG_HOME = configHome;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  const userConfig = join(configDir, 'oh-my-opencode-slim.json');
  const projectConfig = join(projectConfigDir, 'oh-my-opencode-slim.json');
  const store = new MarketplaceStore({
    rootDir: join(root, 'store'),
    pluginVersion: '3.2.0',
  });

  return {
    root,
    project,
    userConfig,
    projectConfig,
    store,
    cleanup() {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousPreset === undefined)
        delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
      else process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPreset;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function resolveStoredPreset(
  userConfig: string,
  projectConfig: string,
  name: string,
) {
  const userPresets = JSON.parse(readFileSync(userConfig, 'utf8')).presets;
  const projectPresets = JSON.parse(
    readFileSync(projectConfig, 'utf8'),
  ).presets;
  return resolvePresetDefinition(
    name,
    mergePresetMaps(userPresets, projectPresets) ?? {},
  );
}

describe('marketplace activation persistence', () => {
  for (const layer of ['user', 'project'] as const) {
    for (const [overrideName, override] of [
      ['with model', { model: 'openai/gpt-5' }],
      ['empty override', {}],
    ] as const) {
      test(`preserves flat marketplace agent ${overrideName} in ${layer} config`, () => {
        const fixture = setup();
        try {
          const configPath =
            layer === 'user' ? fixture.userConfig : fixture.projectConfig;
          writeFileSync(
            configPath,
            JSON.stringify({
              preset: 'work',
              presets: { work: { marketplace: override } },
            }),
          );
          fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

          enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
          disableMarketplacePackage(fixture.project, PACKAGE_A);

          const saved = JSON.parse(readFileSync(configPath, 'utf8'));
          expect(saved.presets.work.agents.marketplace).toEqual(override);
          expect(saved.presets.work.marketplace).toEqual({ agents_add: [] });
          expect(
            resolvePresetDefinition('work', saved.presets).agents.marketplace,
          ).toEqual(override);
        } finally {
          fixture.cleanup();
        }
      });
    }
  }

  test('retains user-inherited agents when a project marketplace agent is wrapped', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: { base: { oracle: { model: 'openai/gpt-5' } } },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              extends: 'base',
              marketplace: { model: 'openai/gpt-4.1' },
            },
          },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      const saved = JSON.parse(readFileSync(fixture.projectConfig, 'utf8'));
      expect(saved.presets.work).toMatchObject({
        extends: 'base',
        agents: { marketplace: { model: 'openai/gpt-4.1' } },
        marketplace: { agents_add: [PACKAGE_A] },
      });
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .agents.oracle,
      ).toEqual({ model: 'openai/gpt-5' });
    } finally {
      fixture.cleanup();
    }
  });

  test('updates JSONC while preserving comments and unrelated config keys', () => {
    const fixture = setup();
    try {
      const source = `{
  // Keep this note.
  "preset": "work",
  "presets": { "work": { "oracle": { "model": "openai/gpt-5" } } },
  "disabled_agents": ["legacy-agent"],
}\n`;
      writeFileSync(fixture.userConfig.replace(/\.json$/, '.jsonc'), source);
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      const written = fixture.userConfig.replace(/\.json$/, '.jsonc');
      const contents = readFileSync(written, 'utf8');
      expect(contents).toContain('// Keep this note.');
      expect(parse(contents)).toMatchObject({
        preset: 'work',
        presets: {
          work: {
            oracle: { model: 'openai/gpt-5' },
            marketplace: { agents_add: [PACKAGE_A] },
          },
        },
        disabled_agents: ['legacy-agent'],
      });
      expect(existsSync(`${written}.bak`)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('disables an inherited package with a removal directive, not a snapshot', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: { base: { marketplace: { agents: [PACKAGE_A] } } },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: { extends: 'base', oracle: { model: 'openai/gpt-5' } },
          },
        }),
      );
      disableMarketplacePackage(fixture.project, PACKAGE_A);
      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_remove: [PACKAGE_A] });
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: {
            base: { marketplace: { agents: [PACKAGE_A, PACKAGE_B] } },
          },
        }),
      );
      const userPresets = JSON.parse(
        readFileSync(fixture.userConfig, 'utf8'),
      ).presets;
      const projectPresets = JSON.parse(
        readFileSync(fixture.projectConfig, 'utf8'),
      ).presets;
      const resolved = resolvePresetDefinition(
        'work',
        mergePresetMaps(userPresets, projectPresets) ?? {},
      );
      expect(resolved.marketplace?.agents).toEqual([PACKAGE_B]);
      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .oracle,
      ).toEqual({ model: 'openai/gpt-5' });
    } finally {
      fixture.cleanup();
    }
  });

  test('retains project parent declarations when the child masks an inherited package', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: {
            base: { marketplace: { agents: [PACKAGE_A] } },
          },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            base: { marketplace: { agents_add: [PACKAGE_B] } },
            work: { extends: 'base' },
          },
        }),
      );

      disableMarketplacePackage(fixture.project, PACKAGE_B);

      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_remove: [PACKAGE_B] });
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A]);
    } finally {
      fixture.cleanup();
    }
  });

  test('enables and disables a parent-inherited package without pinning it', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: { base: { marketplace: { agents: [PACKAGE_A] } } },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: { extends: 'base' } },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      disableMarketplacePackage(fixture.project, PACKAGE_A);
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_remove: [] });
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A]);
    } finally {
      fixture.cleanup();
    }
  });

  test('user-only re-enable does not pin an inherited package after its parent changes', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            base: { marketplace: { agents: [PACKAGE_A] } },
            work: { extends: 'base' },
          },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      disableMarketplacePackage(fixture.project, PACKAGE_A);
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_remove: [] });

      const userConfig = JSON.parse(readFileSync(fixture.userConfig, 'utf8'));
      userConfig.presets.base.marketplace.agents = [];
      writeFileSync(fixture.userConfig, JSON.stringify(userConfig));
      expect(
        resolvePresetDefinition('work', userConfig.presets).marketplace?.agents,
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps parent and lower-layer directives while cancelling only a matching removal', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: {
            base: { marketplace: { agents: [PACKAGE_A, PACKAGE_B] } },
            work: { marketplace: { agents_add: [PACKAGE_A] } },
          },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            base: { marketplace: { agents_add: ['community/third'] } },
            work: {
              extends: 'base',
              marketplace: {
                agents_add: ['community/fourth'],
                agents_remove: [PACKAGE_A, PACKAGE_B],
              },
            },
          },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({
        agents_add: ['community/fourth'],
        agents_remove: [PACKAGE_B],
      });
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A, 'community/third', 'community/fourth']);
    } finally {
      fixture.cleanup();
    }
  });

  test('resolves environment-interpolated parent names and package IDs', () => {
    const fixture = setup();
    const previousBase = process.env.MARKETPLACE_TEST_BASE;
    const previousPackage = process.env.MARKETPLACE_TEST_PACKAGE;
    try {
      process.env.MARKETPLACE_TEST_BASE = 'base';
      process.env.MARKETPLACE_TEST_PACKAGE = PACKAGE_A;
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: {
            base: {
              marketplace: { agents: ['{env:MARKETPLACE_TEST_PACKAGE}'] },
            },
          },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: { extends: '{env:MARKETPLACE_TEST_BASE}' } },
        }),
      );

      disableMarketplacePackage(fixture.project, PACKAGE_A);

      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_remove: [PACKAGE_A] });
    } finally {
      if (previousBase === undefined) delete process.env.MARKETPLACE_TEST_BASE;
      else process.env.MARKETPLACE_TEST_BASE = previousBase;
      if (previousPackage === undefined)
        delete process.env.MARKETPLACE_TEST_PACKAGE;
      else process.env.MARKETPLACE_TEST_PACKAGE = previousPackage;
      fixture.cleanup();
    }
  });

  test('uses environment-selected preset without persisting the selection', () => {
    const fixture = setup();
    try {
      process.env.OH_MY_OPENCODE_SLIM_PRESET = 'work';
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({ presets: { work: {} } }),
      );
      writeFileSync(fixture.projectConfig, JSON.stringify({ presets: {} }));
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      const saved = JSON.parse(readFileSync(fixture.projectConfig, 'utf8'));
      expect(saved).not.toHaveProperty('preset');
      expect(saved.presets.work.marketplace.agents_add).toEqual([PACKAGE_A]);
    } finally {
      fixture.cleanup();
    }
  });

  test('competing processes retain both package activations', async () => {
    const fixture = setup();
    const lockRoot = join(
      join(fixture.root, 'config', 'opencode'),
      '.oh-my-opencode-slim.json.write-lock',
    );
    const lock = acquireMarketplaceLease(getMarketplacePaths(lockRoot));
    let released = false;
    let workers: ReturnType<typeof Bun.spawn>[] = [];
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({ preset: 'work', presets: { work: {} } }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      fixture.store.install(bundle(PACKAGE_B, 'otheragent'));
      const worker = (id: string) =>
        Bun.spawn(
          [
            'bun',
            '-e',
            `import { enableMarketplaceAgent } from './src/marketplace/activation-config.ts';
import { MarketplaceStore } from './src/marketplace/store.ts';
import { writeFileSync } from 'node:fs';
const { directory, packageId, root, readyPath, donePath } = JSON.parse(process.argv[1]);
writeFileSync(readyPath, 'ready');
enableMarketplaceAgent(directory, packageId, new MarketplaceStore({ rootDir: root, pluginVersion: '3.2.0' }));
writeFileSync(donePath, 'done');`,
            JSON.stringify({
              directory: fixture.project,
              packageId: id,
              root: join(fixture.root, 'store'),
              readyPath: join(fixture.root, `${id.split('/')[1]}.ready`),
              donePath: join(fixture.root, `${id.split('/')[1]}.done`),
            }),
          ],
          { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
        );
      workers = [worker(PACKAGE_A), worker(PACKAGE_B)];
      const readyPaths = [
        join(fixture.root, 'docs-researcher.ready'),
        join(fixture.root, 'other.ready'),
      ];
      const deadline = Date.now() + 10_000;
      while (!readyPaths.every(existsSync)) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for activation writers to start');
        }
        await Bun.sleep(10);
      }
      await Bun.sleep(100);
      expect(existsSync(join(fixture.root, 'docs-researcher.done'))).toBe(
        false,
      );
      expect(existsSync(join(fixture.root, 'other.done'))).toBe(false);
      lock.release();
      released = true;
      const exits = await Promise.all(workers.map((process) => process.exited));
      const errors = await Promise.all(
        workers.map((process) => new Response(process.stderr).text()),
      );
      expect(exits).toEqual([0, 0]);
      expect(errors).toEqual(['', '']);
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace.agents_add,
      ).toEqual(expect.arrayContaining([PACKAGE_A, PACKAGE_B]));
    } finally {
      if (!released) lock.release();
      await Promise.allSettled(workers.map((process) => process.exited));
      fixture.cleanup();
    }
  });

  test('failed publication leaves the original config intact and backup recoverable', () => {
    const fixture = setup();
    try {
      const original = JSON.stringify({
        preset: 'work',
        presets: { work: {} },
      });
      writeFileSync(fixture.userConfig, original);
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      mkdirSync(`${fixture.userConfig}.bak`);

      expect(() =>
        enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store),
      ).toThrow();
      expect(readFileSync(fixture.userConfig, 'utf8')).toBe(original);
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work,
      ).toEqual({});
    } finally {
      fixture.cleanup();
    }
  });
});
