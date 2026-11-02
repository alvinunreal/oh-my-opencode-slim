import { afterEach, describe, expect, test } from 'bun:test';
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
import { MarketplaceService } from './service';
import { readDesiredMarketplacePackageIds } from './status';
import { MarketplaceStore } from './store';

const PACKAGE_A = 'community/docs-researcher';
const PACKAGE_B = 'community/other';

const activeFixtures: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  while (activeFixtures.length > 0) {
    const fixture = activeFixtures.pop();
    fixture?.cleanup();
  }
});

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

  let cleaned = false;
  const handle = {
    root,
    project,
    userConfig,
    projectConfig,
    store,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousPreset === undefined)
        delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
      else process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPreset;
      rmSync(root, { recursive: true, force: true });
    },
  };
  activeFixtures.push(handle);
  return handle;
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
  test('refuses project activation when the host disables project config', () => {
    const fixture = setup();
    const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    try {
      const config = JSON.stringify({ preset: 'work', presets: { work: {} } });
      writeFileSync(fixture.userConfig, config);
      writeFileSync(fixture.projectConfig, config);
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      const service = new MarketplaceService({
        rootDir: join(fixture.root, 'store'),
        projectDir: fixture.project,
        pluginVersion: '3.2.0',
      });
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';

      expect(() => service.enable(PACKAGE_A)).toThrow(
        'OPENCODE_DISABLE_PROJECT_CONFIG',
      );
      expect(() => service.disable(PACKAGE_A)).toThrow(
        'OPENCODE_DISABLE_PROJECT_CONFIG',
      );
      expect(readFileSync(fixture.projectConfig, 'utf8')).toBe(config);
      service.enable(PACKAGE_A, 'user');
      expect(readFileSync(fixture.userConfig, 'utf8')).toContain(PACKAGE_A);
    } finally {
      if (previous === undefined)
        delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
      else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous;
      fixture.cleanup();
    }
  });

  test('masks ancestor activation locally without editing the ancestor', () => {
    const fixture = setup();
    try {
      const shared = JSON.stringify({
        preset: 'work',
        presets: {
          work: { marketplace: { agents: [PACKAGE_A] } },
        },
      });
      writeFileSync(fixture.projectConfig, shared);
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      const nested = join(fixture.project, '.slim', 'worktrees', 'feature');
      mkdirSync(nested, { recursive: true });

      disableMarketplacePackage(nested, PACKAGE_A);

      expect(readFileSync(fixture.projectConfig, 'utf8')).toBe(shared);
      expect(readDesiredMarketplacePackageIds(nested)).not.toContain(PACKAGE_A);
      expect(readDesiredMarketplacePackageIds(fixture.project)).toContain(
        PACKAGE_A,
      );
      expect(
        existsSync(join(nested, '.opencode', 'oh-my-opencode-slim.jsonc')),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

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

          enableMarketplaceAgent(
            fixture.project,
            PACKAGE_A,
            fixture.store,
            layer,
          );
          disableMarketplacePackage(fixture.project, PACKAGE_A, layer);

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

  test('ignores schema-invalid user config when activating a valid project preset', () => {
    const fixture = setup();
    try {
      const invalidUser = JSON.stringify({
        presets: {
          work: { marketplace: { agents: ['not a valid package ID'] } },
        },
      });
      writeFileSync(fixture.userConfig, invalidUser);
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({ preset: 'work', presets: { work: {} } }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      expect(readFileSync(fixture.userConfig, 'utf8')).toBe(invalidUser);
      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_add: [PACKAGE_A] });
      expect(
        resolvePresetDefinition(
          'work',
          JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets,
        ).marketplace?.agents,
      ).toEqual([PACKAGE_A]);
    } finally {
      fixture.cleanup();
    }
  });

  test('ignores malformed user JSONC consistently during project activation', () => {
    const fixture = setup();
    const jsoncPath = fixture.userConfig.replace(/\.json$/, '.jsonc');
    const invalidUser = '{ /* malformed user config */ presets: { work: }';
    try {
      writeFileSync(jsoncPath, invalidUser);
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({ preset: 'work', presets: { work: {} } }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      expect(readFileSync(jsoncPath, 'utf8')).toBe(invalidUser);
      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toEqual({ agents_add: [PACKAGE_A] });
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
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store, 'user');

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

  test('project scope masks shared user activation without changing another project', () => {
    const fixture = setup();
    const otherProject = join(fixture.root, 'other-project');
    const projectJsonc = fixture.projectConfig.replace(/\.json$/, '.jsonc');
    try {
      const sharedConfig = JSON.stringify({
        preset: 'work',
        presets: { work: { marketplace: { agents: [PACKAGE_A] } } },
      });
      writeFileSync(fixture.userConfig, sharedConfig);
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));
      mkdirSync(otherProject, { recursive: true });

      disableMarketplacePackage(fixture.project, PACKAGE_A);

      expect(existsSync(projectJsonc)).toBe(true);
      expect(existsSync(fixture.projectConfig)).toBe(false);
      expect(readFileSync(fixture.userConfig, 'utf8')).toBe(sharedConfig);
      const projectPresets = parse(readFileSync(projectJsonc, 'utf8')).presets;
      expect(projectPresets.work.marketplace).toEqual({
        agents_remove: [PACKAGE_A],
      });
      expect(
        resolvePresetDefinition(
          'work',
          mergePresetMaps(
            parse(readFileSync(fixture.userConfig, 'utf8')).presets,
            projectPresets,
          ) ?? {},
        ).marketplace?.agents,
      ).toEqual([]);
      expect(
        resolvePresetDefinition(
          'work',
          parse(readFileSync(fixture.userConfig, 'utf8')).presets,
        ).marketplace?.agents,
      ).toEqual([PACKAGE_A]);
      expect(readDesiredMarketplacePackageIds(otherProject)).toEqual([
        PACKAGE_A,
      ]);

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      expect(
        parse(readFileSync(projectJsonc, 'utf8')).presets.work.marketplace,
      ).toEqual({ agents_remove: [] });
      expect(readFileSync(fixture.userConfig, 'utf8')).toBe(sharedConfig);
      expect(
        resolvePresetDefinition(
          'work',
          mergePresetMaps(
            parse(readFileSync(fixture.userConfig, 'utf8')).presets,
            parse(readFileSync(projectJsonc, 'utf8')).presets,
          ) ?? {},
        ).marketplace?.agents,
      ).toEqual([PACKAGE_A]);
      expect(readDesiredMarketplacePackageIds(otherProject)).toEqual([
        PACKAGE_A,
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('explicit user scope changes only the user config', () => {
    const fixture = setup();
    try {
      const sharedConfig = JSON.stringify({
        preset: 'user-work',
        presets: {
          'user-work': { marketplace: { agents: [PACKAGE_A] } },
        },
      });
      writeFileSync(fixture.userConfig, sharedConfig);
      const projectConfig = JSON.stringify({
        preset: 'project-work',
        presets: { 'project-work': {} },
      });
      writeFileSync(fixture.projectConfig, projectConfig);

      disableMarketplacePackage(fixture.project, PACKAGE_A, 'user');

      expect(readFileSync(fixture.userConfig, 'utf8')).not.toBe(sharedConfig);
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets[
          'user-work'
        ].marketplace,
      ).toEqual({ agents: [] });
      expect(readFileSync(fixture.projectConfig, 'utf8')).toBe(projectConfig);
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

      disableMarketplacePackage(fixture.project, PACKAGE_A, 'user');
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store, 'user');
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

  test('evaluates local replacement and addition placeholders but keeps untouched text', () => {
    const fixture = setup();
    const previousPackage = process.env.MARKETPLACE_LOCAL_PACKAGE;
    const previousOther = process.env.MARKETPLACE_LOCAL_OTHER;
    try {
      process.env.MARKETPLACE_LOCAL_PACKAGE = PACKAGE_A;
      process.env.MARKETPLACE_LOCAL_OTHER = PACKAGE_B;
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              marketplace: {
                agents: ['{env:MARKETPLACE_LOCAL_PACKAGE}', PACKAGE_B],
              },
            },
          },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      disableMarketplacePackage(fixture.project, PACKAGE_A, 'user');
      let saved = JSON.parse(readFileSync(fixture.userConfig, 'utf8'));
      expect(saved.presets.work.marketplace.agents).toEqual([PACKAGE_B]);

      // An addition directive uses the same effective ID comparison while
      // preserving the untouched placeholder verbatim.
      saved.presets.work.marketplace = {
        agents_add: [
          '{env:MARKETPLACE_LOCAL_PACKAGE}',
          '{env:MARKETPLACE_LOCAL_OTHER}',
        ],
      };
      writeFileSync(fixture.userConfig, JSON.stringify(saved));
      disableMarketplacePackage(fixture.project, PACKAGE_A, 'user');
      saved = JSON.parse(readFileSync(fixture.userConfig, 'utf8'));
      expect(saved.presets.work.marketplace.agents_add).toEqual([
        '{env:MARKETPLACE_LOCAL_OTHER}',
      ]);
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store, 'user');
      saved = JSON.parse(readFileSync(fixture.userConfig, 'utf8'));
      expect(saved.presets.work.marketplace.agents_add).toEqual([
        '{env:MARKETPLACE_LOCAL_OTHER}',
        PACKAGE_A,
      ]);
    } finally {
      if (previousPackage === undefined)
        delete process.env.MARKETPLACE_LOCAL_PACKAGE;
      else process.env.MARKETPLACE_LOCAL_PACKAGE = previousPackage;
      if (previousOther === undefined)
        delete process.env.MARKETPLACE_LOCAL_OTHER;
      else process.env.MARKETPLACE_LOCAL_OTHER = previousOther;
      fixture.cleanup();
    }
  });

  test('cancels an interpolated local removal without rewriting other entries', () => {
    const fixture = setup();
    const previousPackage = process.env.MARKETPLACE_REMOVE_PACKAGE;
    const previousOther = process.env.MARKETPLACE_REMOVE_OTHER;
    try {
      process.env.MARKETPLACE_REMOVE_PACKAGE = PACKAGE_A;
      process.env.MARKETPLACE_REMOVE_OTHER = PACKAGE_B;
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            base: { marketplace: { agents: [PACKAGE_A] } },
            work: {
              extends: 'base',
              marketplace: {
                agents_remove: [
                  '{env:MARKETPLACE_REMOVE_PACKAGE}',
                  '{env:MARKETPLACE_REMOVE_OTHER}',
                ],
              },
            },
          },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store, 'user');

      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace.agents_remove,
      ).toEqual(['{env:MARKETPLACE_REMOVE_OTHER}']);
      disableMarketplacePackage(fixture.project, PACKAGE_A, 'user');
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace.agents_remove,
      ).toEqual(['{env:MARKETPLACE_REMOVE_OTHER}', PACKAGE_A]);
    } finally {
      if (previousPackage === undefined)
        delete process.env.MARKETPLACE_REMOVE_PACKAGE;
      else process.env.MARKETPLACE_REMOVE_PACKAGE = previousPackage;
      if (previousOther === undefined)
        delete process.env.MARKETPLACE_REMOVE_OTHER;
      else process.env.MARKETPLACE_REMOVE_OTHER = previousOther;
      fixture.cleanup();
    }
  });

  test('fails without changing config for missing or invalid local placeholders', () => {
    const fixture = setup();
    const previous = process.env.MARKETPLACE_INVALID_PACKAGE;
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          preset: 'work',
          presets: {
            work: {
              marketplace: {
                agents_add: ['{env:MARKETPLACE_MISSING_PACKAGE}', PACKAGE_B],
              },
            },
          },
        }),
      );
      const original = readFileSync(fixture.userConfig, 'utf8');
      expect(() =>
        disableMarketplacePackage(fixture.project, PACKAGE_A, 'user'),
      ).toThrow(
        "environment variable 'MARKETPLACE_MISSING_PACKAGE' is not set",
      );
      expect(readFileSync(fixture.userConfig, 'utf8')).toBe(original);

      process.env.MARKETPLACE_INVALID_PACKAGE = 'not-a-package-id';
      const invalid = JSON.parse(original);
      invalid.presets.work.marketplace.agents_add = [
        '{env:MARKETPLACE_INVALID_PACKAGE}',
        PACKAGE_B,
      ];
      writeFileSync(fixture.userConfig, JSON.stringify(invalid));
      const invalidOriginal = readFileSync(fixture.userConfig, 'utf8');
      expect(() =>
        disableMarketplacePackage(fixture.project, PACKAGE_A, 'user'),
      ).toThrow('invalid marketplace.agents_add package ID');
      expect(readFileSync(fixture.userConfig, 'utf8')).toBe(invalidOriginal);
    } finally {
      if (previous === undefined)
        delete process.env.MARKETPLACE_INVALID_PACKAGE;
      else process.env.MARKETPLACE_INVALID_PACKAGE = previous;
      fixture.cleanup();
    }
  });

  test('unmasks an inherited package when the project preset has empty additions', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: { work: { marketplace: { agents_add: [PACKAGE_A] } } },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: { marketplace: { agents_add: [] } } },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);

      let saved = JSON.parse(readFileSync(fixture.projectConfig, 'utf8'));
      expect(saved.presets.work.marketplace).toBeUndefined();
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A]);

      const afterEnable = readFileSync(fixture.projectConfig, 'utf8');
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      expect(readFileSync(fixture.projectConfig, 'utf8')).toBe(afterEnable);

      disableMarketplacePackage(fixture.project, PACKAGE_A);
      saved = JSON.parse(readFileSync(fixture.projectConfig, 'utf8'));
      expect(saved.presets.work.marketplace).toEqual({
        agents_remove: [PACKAGE_A],
      });
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([]);

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A]);
    } finally {
      fixture.cleanup();
    }
  });

  test('unmasks a lower-layer removal when project preset has empty removals', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({
          presets: {
            work: {
              marketplace: {
                agents: [PACKAGE_A],
                agents_remove: [PACKAGE_A],
              },
            },
          },
        }),
      );
      writeFileSync(
        fixture.projectConfig,
        JSON.stringify({
          preset: 'work',
          presets: { work: { marketplace: { agents_remove: [] } } },
        }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      // The empty project list masks the user's removal, so the package is
      // already active and enabling it again must be an idempotent no-op.
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      const afterEnable = readFileSync(fixture.projectConfig, 'utf8');
      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      expect(readFileSync(fixture.projectConfig, 'utf8')).toBe(afterEnable);
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A]);

      disableMarketplacePackage(fixture.project, PACKAGE_A);
      expect(
        JSON.parse(readFileSync(fixture.projectConfig, 'utf8')).presets.work
          .marketplace,
      ).toBeUndefined();
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([]);

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store);
      expect(
        resolveStoredPreset(fixture.userConfig, fixture.projectConfig, 'work')
          .marketplace?.agents,
      ).toEqual([PACKAGE_A]);
    } finally {
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

  test.each(['project', 'user'] as const)(
    'falls back to the persisted preset when the environment preset is empty in %s scope',
    (scope) => {
      const fixture = setup();
      try {
        process.env.OH_MY_OPENCODE_SLIM_PRESET = '';
        writeFileSync(
          fixture.userConfig,
          JSON.stringify({ preset: 'work', presets: { work: {} } }),
        );
        fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

        enableMarketplaceAgent(
          fixture.project,
          PACKAGE_A,
          fixture.store,
          scope,
        );

        const targetPath =
          scope === 'project'
            ? fixture.projectConfig.replace(/\.json$/, '.jsonc')
            : fixture.userConfig;
        expect(
          JSON.parse(readFileSync(targetPath, 'utf8')).presets.work.marketplace
            .agents_add,
        ).toEqual([PACKAGE_A]);
      } finally {
        fixture.cleanup();
      }
    },
  );

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
   enableMarketplaceAgent(directory, packageId, new MarketplaceStore({ rootDir: root, pluginVersion: '3.2.0' }), 'user');
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
      // EXCEPTION (ts-no-test-timers): bounded negative window — a
      // cross-process worker effect has no event to await; the sleep IS
      // the assertion's "long enough for it to have happened" bound.
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

  test('checks package existence under the config lease before adding a reference', async () => {
    const fixture = setup();
    const configLockRoot = join(
      fixture.root,
      'config',
      'opencode',
      '.oh-my-opencode-slim.json.write-lock',
    );
    const configLease = acquireMarketplaceLease(
      getMarketplacePaths(configLockRoot),
    );
    let leaseReleased = false;
    let worker: ReturnType<typeof Bun.spawn> | undefined;
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({ preset: 'work', presets: { work: {} } }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      const readyPath = join(fixture.root, 'enable.ready');
      const showPath = join(fixture.root, 'store.show');
      const resultPath = join(fixture.root, 'enable.result');
      worker = Bun.spawn(
        [
          'bun',
          '-e',
          `import { writeFileSync } from 'node:fs';
import { enableMarketplaceAgent } from './src/marketplace/activation-config.ts';
import { MarketplaceStore } from './src/marketplace/store.ts';
const { directory, packageId, root, readyPath, showPath, resultPath } = JSON.parse(process.argv[1]);
const store = new MarketplaceStore({ rootDir: root, pluginVersion: '3.2.0' });
const reader = { show(id) { writeFileSync(showPath, 'checked'); return store.show(id); } };
writeFileSync(readyPath, 'ready');
try {
  enableMarketplaceAgent(directory, packageId, reader, 'user');
  writeFileSync(resultPath, 'enabled');
} catch (error) {
  writeFileSync(resultPath, String(error));
}`,
          JSON.stringify({
            directory: fixture.project,
            packageId: PACKAGE_A,
            root: join(fixture.root, 'store'),
            readyPath,
            showPath,
            resultPath,
          }),
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
      );

      const deadline = Date.now() + 10_000;
      while (!existsSync(readyPath)) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for activation worker to start');
        }
        await Bun.sleep(10);
      }
      // EXCEPTION (ts-no-test-timers): bounded negative window for a
      // cross-process worker effect (see the earlier note).
      await Bun.sleep(100);
      expect(existsSync(showPath)).toBe(false);

      // The held config lease represents a removal that has acquired the
      // config lock before the store lock. Once the package is gone, activation
      // must observe that fact before it publishes the config reference.
      fixture.store.remove(PACKAGE_A);
      configLease.release();
      leaseReleased = true;

      expect(await worker.exited).toBe(0);
      expect(readFileSync(resultPath, 'utf8')).toContain('Error');
      expect(existsSync(showPath)).toBe(true);
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace,
      ).toBeUndefined();
    } finally {
      if (!leaseReleased) configLease.release();
      if (worker) await worker.exited;
      fixture.cleanup();
    }
  });

  test('a removal after activation commit disables its config reference', () => {
    const fixture = setup();
    try {
      writeFileSync(
        fixture.userConfig,
        JSON.stringify({ preset: 'work', presets: { work: {} } }),
      );
      fixture.store.install(bundle(PACKAGE_A, 'docsresearcher'));

      enableMarketplaceAgent(fixture.project, PACKAGE_A, fixture.store, 'user');
      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace.agents_add,
      ).toEqual([PACKAGE_A]);

      disableMarketplacePackage(fixture.project, PACKAGE_A, 'user');
      fixture.store.remove(PACKAGE_A);

      expect(
        JSON.parse(readFileSync(fixture.userConfig, 'utf8')).presets.work
          .marketplace.agents_add,
      ).toEqual([]);
      expect(() => fixture.store.show(PACKAGE_A)).toThrow();
    } finally {
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
        enableMarketplaceAgent(
          fixture.project,
          PACKAGE_A,
          fixture.store,
          'user',
        ),
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
