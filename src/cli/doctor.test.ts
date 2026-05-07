import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  doctor,
  formatJsonDoctorResult,
  parseDoctorArgs,
  runDoctorCheck,
} from './doctor';

describe('parseDoctorArgs', () => {
  test('no args returns empty', () => {
    const result = parseDoctorArgs([]);
    expect(result).toEqual({});
  });

  test('--json sets json flag', () => {
    const result = parseDoctorArgs(['--json']);
    expect(result.json).toBe(true);
  });

  test('--help sets help flag', () => {
    const result = parseDoctorArgs(['--help']);
    expect(result).toEqual({ help: true });
  });

  test('unknown option returns error', () => {
    const result = parseDoctorArgs(['--project']);
    expect(result.error).toBe('Unknown doctor option: --project');
  });

  test('multiple unknown options keeps first error', () => {
    const result = parseDoctorArgs(['--bad1', '--json', '--bad2']);
    expect(result).toEqual({
      json: true,
      error: 'Unknown doctor option: --bad1',
    });
  });

  test('positional arg returns error', () => {
    const result = parseDoctorArgs(['/my/project']);
    expect(result.error).toBe('Unknown doctor option: /my/project');
  });
});

describe('runDoctorCheck', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: typeof process.env;

  function setupTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    return dir;
  }

  beforeEach(() => {
    tempDir = setupTempDir();
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('no config files returns ok', () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.configs).toHaveLength(2);
    expect(result.configs[0].scope).toBe('user');
    expect(result.configs[0].exists).toBe(false);
    expect(result.configs[1].scope).toBe('project');
    expect(result.configs[1].exists).toBe(false);
    expect(result.presetCheck).toBeUndefined();
  });

  test('valid project config returns ok', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.jsonc'),
      `{
        // JSONC comments are supported.
        "agents": {
          "oracle": { "model": "test/model" },
        },
      }`,
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.configs[1].ok).toBe(true);
    expect(result.configs[1].path).toContain('.jsonc');
  });

  test('invalid JSON returns not ok with invalid-json error', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      '{ invalid json }',
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(false);
    expect(result.configs[1].ok).toBe(false);
    expect(result.configs[1].error?.kind).toBe('invalid-json');
    expect(result.presetCheck).toBeUndefined();
  });

  test('config deleted after discovery returns read error with path', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    const configPath = path.join(configDir, 'oh-my-opencode-slim.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{}');

    const statSpy = spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    try {
      const result = runDoctorCheck(projectDir);

      expect(result.ok).toBe(false);
      expect(result.configs[1].path).toBe(configPath);
      expect(result.configs[1].exists).toBe(false);
      expect(result.configs[1].ok).toBe(false);
      expect(result.configs[1].error?.kind).toBe('read-error');
      expect(result.configs[1].error?.message).toBe(
        'File was not found while reading',
      );
    } finally {
      statSpy.mockRestore();
    }
  });

  test('invalid schema returns not ok with schema issues', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    // temperature must be 0-2
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { temperature: 99 } } }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(false);
    expect(result.configs[1].ok).toBe(false);
    expect(result.configs[1].error?.kind).toBe('invalid-schema');
    expect(result.configs[1].error?.issues).toBeDefined();
    expect(result.configs[1].error?.issues[0].path).toContain('temperature');
  });

  test('multiple schema errors includes relevant paths', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { temperature: 99 } },
        multiplexer: { type: 'unknown' },
      }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(false);
    expect(result.configs[1].error?.kind).toBe('invalid-schema');
    const issuePaths = result.configs[1].error?.issues?.map((i) =>
      i.path.join('.'),
    );
    expect(issuePaths).toContain('agents.oracle.temperature');
    expect(issuePaths).toContain('multiplexer.type');
  });

  test('empty config file returns invalid-json error', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'oh-my-opencode-slim.json'), '');

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(false);
    expect(result.configs[1].error?.kind).toBe('invalid-json');
    expect(result.configs[1].error?.message).toContain('Empty file');
  });

  test('invalid user config skips preset check', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      '{ invalid }',
    );

    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'mypreset',
        presets: { mypreset: { oracle: { model: 'test/model' } } },
      }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(false);
    expect(result.configs[0].ok).toBe(false);
    expect(result.presetCheck).toBeUndefined();
  });

  test('preset check passes with valid preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'mypreset',
        presets: { mypreset: { oracle: { model: 'test/model' } } },
      }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.presetCheck).toEqual({ preset: 'mypreset', ok: true });
  });

  test('preset check fails for missing preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'nonexistent',
        presets: { other: {} },
      }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(false);
    expect(result.presetCheck?.ok).toBe(false);
    expect(result.presetCheck?.error?.kind).toBe('missing-preset');
  });

  test('env preset overrides config preset', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'config-preset',
        presets: {
          'config-preset': { oracle: { model: 'config/model' } },
          'env-preset': { oracle: { model: 'env/model' } },
        },
      }),
    );

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env-preset';

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.presetCheck?.preset).toBe('env-preset');
    expect(result.presetCheck?.ok).toBe(true);
  });

  test('project config overrides user config with merge', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        agents: { oracle: { temperature: 0.5 } },
        presets: {
          'test-preset': {
            oracle: { model: 'user/model' },
            explorer: { model: 'user/explorer' },
          },
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'test-preset',
        agents: { oracle: { model: 'project/model' } },
      }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.presetCheck?.preset).toBe('test-preset');
    expect(result.presetCheck?.ok).toBe(true);
    expect(result.configs[0].config?.agents?.oracle?.temperature).toBe(0.5);
    expect(result.configs[1].config?.agents?.oracle?.model).toBe(
      'project/model',
    );
  });

  test('json formatter omits parsed config payload', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'secret/model' } } }),
    );

    const result = runDoctorCheck(projectDir);
    const parsed = JSON.parse(formatJsonDoctorResult(result));

    expect(result.configs[1].config?.agents?.oracle?.model).toBe(
      'secret/model',
    );
    expect(parsed.configs[1].config).toBeUndefined();
  });

  test('project preset overrides user preset', () => {
    const userOpencodeDir = path.join(tempDir, 'user-config', 'opencode');
    fs.mkdirSync(userOpencodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(userOpencodeDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'user-preset',
        presets: {
          'user-preset': { oracle: { model: 'user/model' } },
          'project-preset': { oracle: { model: 'project/model' } },
        },
      }),
    );

    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({
        preset: 'project-preset',
      }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.presetCheck?.preset).toBe('project-preset');
    expect(result.presetCheck?.ok).toBe(true);
  });

  test('.jsonc preferred over .json', () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });

    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { model: 'json-model' } } }),
    );
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.jsonc'),
      JSON.stringify({ agents: { oracle: { model: 'jsonc-model' } } }),
    );

    const result = runDoctorCheck(projectDir);

    expect(result.ok).toBe(true);
    expect(result.configs[1].path).toContain('.jsonc');
  });
});

describe('doctor CLI wrapper', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: typeof process.env;

  async function runDoctorCliFrom(
    projectDir: string,
    args: Parameters<typeof doctor>[0] = {},
  ): Promise<number> {
    process.chdir(projectDir);
    try {
      return await doctor(args);
    } finally {
      process.chdir(originalCwd);
    }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cli-test-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  test('help exits 0', async () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const exitCode = await runDoctorCliFrom(projectDir, { help: true });
    expect(exitCode).toBe(0);
  });

  test('unknown arg exits 1', async () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const exitCode = await runDoctorCliFrom(projectDir, {
      error: 'Unknown doctor option: --bad',
    });
    expect(exitCode).toBe(1);
  });

  test('no config exits 0', async () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const exitCode = await runDoctorCliFrom(projectDir);
    expect(exitCode).toBe(0);
  });

  test('invalid config exits 1', async () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      '{ invalid }',
    );

    const exitCode = await runDoctorCliFrom(projectDir);
    expect(exitCode).toBe(1);
  });

  test('--json mode outputs valid JSON', async () => {
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    const consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const exitCode = await runDoctorCliFrom(projectDir, { json: true });
      const output = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(true);
      expect(fs.realpathSync(parsed.project)).toBe(fs.realpathSync(projectDir));
      expect(parsed.configs).toHaveLength(2);
      expect(parsed.configs[0].scope).toBe('user');
      expect(parsed.configs[1].scope).toBe('project');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  test('JSON output has correct shape with schema error', async () => {
    const projectDir = path.join(tempDir, 'project');
    const configDir = path.join(projectDir, '.opencode');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'oh-my-opencode-slim.json'),
      JSON.stringify({ agents: { oracle: { temperature: 5 } } }),
    );

    const consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const exitCode = await runDoctorCliFrom(projectDir, { json: true });
      const output = consoleLogSpy.mock.calls
        .map((c) => c.join(' '))
        .join('\n');
      const parsed = JSON.parse(output);

      expect(exitCode).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.configs[1].error.kind).toBe('invalid-schema');
      expect(Array.isArray(parsed.configs[1].error.issues)).toBe(true);
      expect(parsed.configs[1].error.issues[0].path).toContain('temperature');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});
