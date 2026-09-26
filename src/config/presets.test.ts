import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from './loader';
import {
  mergeAgentOverrides,
  mergePresetMaps,
  PresetResolutionError,
  resolvePreset,
  resolvePresetDefinition,
  resolvePresets,
} from './presets';
import { PluginConfigSchema } from './schema';

function parsePresets(input: unknown) {
  const presets = PluginConfigSchema.parse(input).presets;
  if (!presets) throw new Error('Expected presets in test config');
  return presets;
}

describe('preset inheritance', () => {
  test('marketplace directives resolve against the latest parent', () => {
    const presets = parsePresets({
      presets: {
        base: { marketplace: { agents: ['owner/a', 'owner/b', 'owner/c'] } },
        child: {
          extends: 'base',
          marketplace: { agents_remove: ['owner/a'] },
        },
        added: {
          extends: 'child',
          marketplace: { agents_add: ['owner/d'] },
        },
        restored: {
          extends: 'child',
          marketplace: { agents_add: ['owner/a'], agents_remove: [] },
        },
      },
    });

    expect(resolvePresetDefinition('child', presets).marketplace).toEqual({
      agents: ['owner/b', 'owner/c'],
    });
    expect(resolvePresetDefinition('added', presets).marketplace).toEqual({
      agents: ['owner/b', 'owner/c', 'owner/d'],
    });
    expect(resolvePresetDefinition('restored', presets).marketplace).toEqual({
      agents: ['owner/b', 'owner/c', 'owner/a'],
    });
    expect(resolvePreset('added', presets)).toEqual({});
  });

  test('marketplace replacement and explicit empty list clear inherited agents', () => {
    const presets = parsePresets({
      presets: {
        base: { marketplace: { agents: ['owner/a', 'owner/b'] } },
        replaced: {
          extends: 'base',
          marketplace: { agents: ['owner/d'], agents_add: ['owner/e'] },
        },
        cleared: { extends: 'base', marketplace: { agents: [] } },
      },
    });
    expect(resolvePresetDefinition('replaced', presets).marketplace).toEqual({
      agents: ['owner/d', 'owner/e'],
    });
    expect(resolvePresetDefinition('cleared', presets).marketplace).toEqual({
      agents: [],
    });
  });

  test('normalizes marketplace activation from structured preset definitions', () => {
    const presets = parsePresets({
      presets: {
        base: {
          agents: { oracle: { model: 'provider/base' } },
          marketplace: { agents: ['owner/a'] },
        },
        child: {
          extends: 'base',
          agents: { oracle: { temperature: 0.5 } },
          marketplace: { agents_add: ['owner/b'] },
        },
      },
    });

    expect(resolvePresetDefinition('child', presets)).toEqual({
      extends: 'base',
      agents: {
        oracle: { model: 'provider/base', temperature: 0.5 },
      },
      marketplace: { agents: ['owner/a', 'owner/b'] },
    });
  });

  test('composes marketplace directives across config layers', () => {
    const base = parsePresets({
      presets: {
        root: { marketplace: { agents: ['owner/a', 'owner/b'] } },
        child: {
          extends: 'root',
          marketplace: { agents_add: ['owner/c'], agents_remove: ['owner/a'] },
        },
      },
    });
    const project = parsePresets({
      presets: {
        child: {
          marketplace: { agents_add: ['owner/d'], agents_remove: ['owner/c'] },
        },
      },
    });

    const merged = mergePresetMaps(base, project);
    expect(resolvePresetDefinition('child', merged ?? {}).marketplace).toEqual({
      agents: ['owner/b', 'owner/d'],
    });
    expect(merged?.child).toMatchObject({
      marketplace: {
        agents_add: ['owner/d'],
        agents_remove: ['owner/a', 'owner/c'],
      },
    });
  });

  test('project additions and removals cancel matching lower-layer directives', () => {
    const user = parsePresets({
      presets: {
        base: { marketplace: { agents: ['owner/a', 'owner/b', 'owner/c'] } },
        child: {
          extends: 'base',
          marketplace: { agents_remove: ['owner/a', 'owner/b'] },
        },
        added: { marketplace: { agents_add: ['owner/a', 'owner/b'] } },
      },
    });
    const project = parsePresets({
      presets: {
        base: { marketplace: { agents_add: ['owner/d'] } },
        child: { marketplace: { agents_add: ['owner/a'] } },
        added: { marketplace: { agents_remove: ['owner/a'] } },
      },
    });

    const merged = mergePresetMaps(user, project) ?? {};
    expect(merged.child).toMatchObject({
      marketplace: { agents_add: ['owner/a'], agents_remove: ['owner/b'] },
    });
    expect(resolvePresetDefinition('child', merged).marketplace).toEqual({
      agents: ['owner/a', 'owner/c', 'owner/d'],
    });
    expect(resolvePresetDefinition('added', merged).marketplace).toEqual({
      agents: ['owner/b'],
    });
  });

  test('project replacement discards inherited directives but keeps local directives', () => {
    const user = parsePresets({
      presets: {
        base: { marketplace: { agents: ['owner/a'] } },
        child: {
          extends: 'base',
          marketplace: {
            agents_add: ['owner/c'],
            agents_remove: ['owner/b'],
          },
        },
      },
    });
    const project = parsePresets({
      presets: {
        base: { marketplace: { agents_add: ['owner/d'] } },
        child: {
          marketplace: {
            agents: [],
            agents_add: ['owner/b', 'owner/e'],
            agents_remove: ['owner/e'],
          },
        },
      },
    });

    const merged = mergePresetMaps(user, project) ?? {};
    expect(resolvePresetDefinition('base', merged).marketplace).toEqual({
      agents: ['owner/a', 'owner/d'],
    });
    expect(resolvePresetDefinition('child', merged).marketplace).toEqual({
      agents: ['owner/b'],
    });
  });

  test('same-layer removal wins over addition and an empty directive clears lower state', () => {
    const user = parsePresets({
      presets: {
        child: {
          marketplace: {
            agents: ['owner/a'],
            agents_add: ['owner/b'],
            agents_remove: ['owner/a'],
          },
        },
      },
    });
    const project = parsePresets({
      presets: {
        child: {
          marketplace: {
            agents_add: ['owner/a'],
            agents_remove: ['owner/a'],
          },
        },
      },
    });
    const merged = mergePresetMaps(user, project) ?? {};
    expect(resolvePresetDefinition('child', merged).marketplace).toEqual({
      agents: ['owner/b'],
    });

    const cleared = mergePresetMaps(
      merged,
      parsePresets({
        presets: { child: { marketplace: { agents_remove: [] } } },
      }),
    );
    expect(resolvePresetDefinition('child', cleared ?? {}).marketplace).toEqual(
      {
        agents: ['owner/a', 'owner/b'],
      },
    );
  });

  test('validates unique non-empty marketplace package IDs', () => {
    expect(() =>
      parsePresets({
        presets: {
          invalid: { marketplace: { agents_add: ['owner/a', 'owner/a'] } },
        },
      }),
    ).toThrow();
    expect(() =>
      parsePresets({
        presets: {
          invalid: { marketplace: { agents_remove: [' ', 'owner/a'] } },
        },
      }),
    ).toThrow();
  });

  test('canonical agent aliases win field-by-field over legacy aliases', () => {
    expect(
      mergeAgentOverrides(
        {},
        {
          explore: {
            model: 'legacy/model',
            temperature: 0.2,
            options: { legacy: true },
          },
          explorer: {
            model: 'canonical/model',
            options: { canonical: true },
          },
        },
      ),
    ).toEqual({
      explorer: {
        model: 'canonical/model',
        temperature: 0.2,
        options: { legacy: true, canonical: true },
      },
    });
  });

  test('canonical inheritance clears a same-layer aliased model', () => {
    expect(
      mergeAgentOverrides(
        { explorer: { model: 'base/model' } },
        {
          explore: { model: 'legacy/model' },
          explorer: { inheritModelFrom: 'session' },
        },
      ),
    ).toEqual({ explorer: { inheritModelFrom: 'session' } });
  });

  test('resolves legacy flat presets unchanged', () => {
    const presets = parsePresets({
      presets: { fast: { explorer: { model: 'provider/fast' } } },
    });

    expect(resolvePreset('fast', presets)).toEqual({
      explorer: { model: 'provider/fast' },
    });
  });

  test('preserves legacy custom names that resemble preset metadata', () => {
    const presets = parsePresets({
      presets: {
        custom: {
          extends: { model: 'extends/model' },
          agents: { model: 'agents/model' },
          model: { model: 'model/model' },
        },
      },
    });

    expect(resolvePreset('custom', presets)).toEqual({
      extends: { model: 'extends/model' },
      agents: { model: 'agents/model' },
      model: { model: 'model/model' },
    });
  });

  test('does not confuse a model-like custom agent with the agents wrapper', () => {
    const presets = parsePresets({
      presets: {
        custom: { agents: { model: { model: 'model/model' } } },
      },
    });

    expect(resolvePreset('custom', presets)).toEqual({
      model: { model: 'model/model' },
    });
  });

  test('retains a legacy options-named custom agent', () => {
    const presets = parsePresets({
      presets: {
        custom: { options: { model: 'options/model' } },
      },
    });

    expect(resolvePreset('custom', presets)).toEqual({
      options: { model: 'options/model' },
    });
  });

  test('resolves multiple inheritance levels with child precedence', () => {
    const presets = parsePresets({
      presets: {
        base: {
          agents: {
            oracle: { model: 'provider/base', temperature: 0.2 },
          },
        },
        middle: {
          extends: 'base',
          agents: { oracle: { temperature: 0.5 } },
        },
        child: {
          extends: 'middle',
          agents: { oracle: { model: 'provider/child' } },
        },
      },
    });

    expect(resolvePreset('child', presets)).toEqual({
      oracle: { model: 'provider/child', temperature: 0.5 },
    });
  });

  test('deep-merges nested objects and replaces arrays', () => {
    const presets = parsePresets({
      presets: {
        base: {
          oracle: {
            options: { reasoning: { effort: 'low' }, verbosity: 'low' },
            skills: ['base'],
          },
        },
        child: {
          extends: 'base',
          agents: {
            oracle: {
              options: { reasoning: { budget: 1000 } },
              skills: ['child'],
            },
          },
        },
      },
    });

    expect(resolvePreset('child', presets)).toEqual({
      oracle: {
        options: {
          reasoning: { effort: 'low', budget: 1000 },
          verbosity: 'low',
        },
        skills: ['child'],
      },
    });
  });

  test('inheritModelFrom clears an inherited model', () => {
    const presets = parsePresets({
      presets: {
        base: { oracle: { model: 'provider/base', variant: 'fast' } },
        child: {
          extends: 'base',
          agents: { oracle: { inheritModelFrom: 'session' } },
        },
      },
    });

    expect(resolvePreset('child', presets)).toEqual({
      oracle: { inheritModelFrom: 'session', variant: 'fast' },
    });
  });

  test('missing parents and cycles fail without partial results', () => {
    expect(() =>
      resolvePreset('child', {
        child: { extends: 'missing', agents: { oracle: { model: 'partial' } } },
      }),
    ).toThrow('Preset "child" extends missing preset "missing"');

    expect(() =>
      resolvePresets({
        a: { extends: 'b', agents: { oracle: { model: 'a' } } },
        b: { extends: 'a', agents: { oracle: { model: 'b' } } },
      }),
    ).toThrow(new PresetResolutionError('cycle', ['a', 'b', 'a']).message);
  });

  test('resolves a project preset extending a user preset', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-layers-'));
    const userDir = path.join(tempDir, 'user', 'opencode');
    const projectDir = path.join(tempDir, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousCustom = process.env.OPENCODE_CONFIG_DIR;

    try {
      fs.mkdirSync(userDir, { recursive: true });
      fs.mkdirSync(projectConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(userDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          presets: {
            shared: {
              oracle: {
                model: 'provider/shared',
                options: { fromUser: true },
              },
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(projectConfigDir, 'oh-my-opencode-slim.json'),
        JSON.stringify({
          preset: 'project',
          presets: {
            project: {
              extends: 'shared',
              agents: { oracle: { temperature: 0.7 } },
            },
          },
          agents: { oracle: { options: { fromProject: true } } },
        }),
      );
      process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user');
      delete process.env.OPENCODE_CONFIG_DIR;

      const config = loadPluginConfig(projectDir, { silent: true });
      expect(config.agents?.oracle).toEqual({
        model: 'provider/shared',
        temperature: 0.7,
        options: { fromUser: true, fromProject: true },
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousCustom === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousCustom;
    }
  });
});
