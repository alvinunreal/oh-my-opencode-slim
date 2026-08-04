import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginConfig } from './loader';
import { PluginConfigSchema } from './schema';

describe('preset inheritance', () => {
  let tempDir: string;
  let originalEnv: typeof process.env;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-inheritance-'));
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function writeProjectConfig(config: unknown): string {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify(config),
    );
    return projectDir;
  }

  function writeUserConfig(config: unknown): void {
    const configDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify(config),
    );
  }

  test('accepts trimmed names and null while rejecting empty parent names', () => {
    const valid = PluginConfigSchema.safeParse({
      presets: {
        child: { $extends: '  base  ', oracle: { model: 'child/model' } },
        detached: { $extends: null },
      },
    });

    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.presets?.child?.$extends).toBe('base');
      expect(valid.data.presets?.detached?.$extends).toBeNull();
    }

    expect(
      PluginConfigSchema.safeParse({
        presets: { child: { $extends: '   ' } },
      }).success,
    ).toBe(false);
  });

  test('resolves a chain oldest-first, including parent-only presets and root precedence', () => {
    const projectDir = writeProjectConfig({
      preset: 'child',
      agents: {
        oracle: {
          options: { rootOnly: true, shared: 'root' },
          temperature: 0.9,
        },
      },
      presets: {
        base: {
          oracle: {
            model: 'base/model',
            options: { baseOnly: true, shared: 'base' },
          },
        },
        middle: {
          $extends: 'base',
          oracle: {
            options: { middleOnly: true, shared: 'middle' },
          },
        },
        child: {
          $extends: 'middle',
          oracle: {
            model: 'child/model',
            options: { childOnly: true, shared: 'child' },
          },
          explorer: { model: 'child/explorer' },
        },
      },
    });

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.agents?.oracle).toEqual({
      model: 'child/model',
      options: {
        baseOnly: true,
        middleOnly: true,
        childOnly: true,
        rootOnly: true,
        shared: 'root',
      },
      temperature: 0.9,
    });
    expect(config.agents?.explorer?.model).toBe('child/explorer');
    expect(config.agents?.$extends).toBeUndefined();
    expect(config.resolvedPresets?.base?.oracle?.model).toBe('base/model');
    expect(config.resolvedPresets?.middle?.oracle?.options).toEqual({
      baseOnly: true,
      middleOnly: true,
      shared: 'middle',
    });
    expect(config.resolvedPresets?.child?.oracle?.options).toEqual({
      baseOnly: true,
      middleOnly: true,
      childOnly: true,
      shared: 'child',
    });
    expect(config.resolvedPresets?.child?.$extends).toBeUndefined();
  });

  test('replaces and detaches a lower-layer parent after structural merge', () => {
    writeUserConfig({
      preset: 'child',
      presets: {
        base: { oracle: { model: 'base/model' } },
        alternate: { oracle: { model: 'alternate/model' } },
        child: { $extends: 'base', oracle: { temperature: 0.5 } },
      },
    });
    const replacementProjectDir = writeProjectConfig({
      presets: { child: { $extends: 'alternate' } },
    });

    const replaced = loadPluginConfig(replacementProjectDir, { silent: true });
    expect(replaced.agents?.oracle).toEqual({
      model: 'alternate/model',
      temperature: 0.5,
    });

    fs.writeFileSync(
      path.join(replacementProjectDir, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ presets: { child: { $extends: null } } }),
    );

    const detached = loadPluginConfig(replacementProjectDir, { silent: true });
    expect(detached.agents?.oracle).toEqual({ temperature: 0.5 });
    expect(detached.resolvedPresets?.child?.$extends).toBeUndefined();
  });

  test('eagerly rejects an inactive missing parent with a semantic error', () => {
    const projectDir = writeProjectConfig({
      presets: {
        active: { oracle: { model: 'active/model' } },
        inactive: { $extends: 'missing' },
      },
    });

    let error: unknown;
    try {
      loadPluginConfig(projectDir, { silent: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 'PRESET_INHERITANCE_MISSING_PARENT',
    });
    expect((error as Error).message).toContain('inactive');
    expect((error as Error).message).toContain('missing');
  });

  test('rejects missing parents named after inherited object properties', () => {
    const projectDir = writeProjectConfig({
      presets: {
        child: { $extends: 'toString' },
      },
    });

    let error: unknown;
    try {
      loadPluginConfig(projectDir, { silent: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 'PRESET_INHERITANCE_MISSING_PARENT',
    });
    expect((error as Error).message).toContain('toString');
  });

  test('retains and resolves an authored __proto__ parent from JSON config', () => {
    writeUserConfig({
      presets: { base: { oracle: { model: 'base/model' } } },
    });
    const projectDir = writeProjectConfig(
      JSON.parse(
        '{"preset":"child","presets":{"__proto__":{"oracle":{"model":"proto/model"}},"child":{"$extends":"__proto__"}}}',
      ),
    );

    const config = loadPluginConfig(projectDir, { silent: true });

    expect(config.agents?.oracle).toEqual({ model: 'proto/model' });
    expect(
      Object.getOwnPropertyDescriptor(config.presets ?? {}, '__proto__')?.value,
    ).toEqual({
      oracle: { model: 'proto/model' },
    });
    expect(
      Object.getOwnPropertyDescriptor(config.resolvedPresets ?? {}, '__proto__')
        ?.value,
    ).toEqual({ oracle: { model: 'proto/model' } });
  });

  test('eagerly rejects an inactive cycle and reports its path', () => {
    const projectDir = writeProjectConfig({
      presets: {
        active: { oracle: { model: 'active/model' } },
        first: { $extends: 'second' },
        second: { $extends: 'third' },
        third: { $extends: 'first' },
      },
    });

    let error: unknown;
    try {
      loadPluginConfig(projectDir, { silent: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: 'PRESET_INHERITANCE_CYCLE',
    });
    expect((error as Error).message).toContain(
      'first -> second -> third -> first',
    );
  });

  test('generated schema rejects whitespace-only $extends values', () => {
    const schemaPath = path.resolve(
      import.meta.dirname,
      '../../oh-my-opencode-slim.schema.json',
    );
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const extendsSchema =
      schema.properties.presets.additionalProperties.properties.$extends;
    const stringBranch = extendsSchema.anyOf.find(
      (b: { type: string }) => b.type === 'string',
    );

    // spec.md:113-115 — generated schema must reject empty and whitespace-only $extends names
    expect(stringBranch).toBeDefined();
    expect(stringBranch.pattern).toBeDefined();

    const re = new RegExp(stringBranch.pattern);
    expect(re.test('')).toBe(false);
    expect(re.test('   ')).toBe(false);
    expect(re.test('base')).toBe(true);
    expect(re.test('my-preset_42')).toBe(true);

    const nullBranch = extendsSchema.anyOf.find(
      (b: { type: string }) => b.type === 'null',
    );
    expect(nullBranch).toBeDefined();
  });

  test('keeps schema and malformed JSON failures on the warning fallback path', () => {
    const warnings: Array<{ kind: string; message: string }> = [];
    const projectDir = writeProjectConfig({
      presets: { invalid: { $extends: '' } },
    });

    expect(
      loadPluginConfig(projectDir, {
        silent: true,
        onWarning: (warning) => warnings.push(warning),
      }),
    ).toEqual({});
    expect(warnings[0]?.kind).toBe('invalid-schema');

    fs.writeFileSync(
      path.join(projectDir, '.opencode', 'oh-my-opencode-slim.json'),
      '{ invalid json }',
    );
    warnings.length = 0;

    expect(
      loadPluginConfig(projectDir, {
        silent: true,
        onWarning: (warning) => warnings.push(warning),
      }),
    ).toEqual({});
    expect(warnings[0]?.kind).toBe('invalid-json');
  });
});
