import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPresetCommand,
  createPresetDefaultCommand,
  createPresetStatusCommand,
  PRESET_COMMAND_DESCRIPTION,
  PRESET_COMMAND_NAME,
  presetApplyFeedback,
  presetDefaultFeedback,
  presetListFeedback,
  presetStatusFeedback,
} from './preset-command';
import type { SessionPresetState } from './session-presets';

let tempDir: string;
let previousConfigDir: string | undefined;
let previousXdgConfigHome: string | undefined;
let previousPresetEnv: string | undefined;

function userConfigPath(): string {
  return path.join(
    tempDir,
    'xdg-config',
    'opencode',
    'oh-my-opencode-slim.json',
  );
}

function writeUserConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(userConfigPath(), JSON.stringify(config));
}

function readUserConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(userConfigPath(), 'utf-8')) as Record<
    string,
    unknown
  >;
}

function boundState(sessionID: string, presetName: string): SessionPresetState {
  return {
    sessionID,
    status: 'bound',
    presetName,
    affects: 'future-children-only',
  };
}

function unboundState(sessionID: string): SessionPresetState {
  return {
    sessionID,
    status: 'unbound',
    presetName: null,
    affects: 'future-children-only',
  };
}

const readBound = (presetName: string) => (_sessionID: string) =>
  Promise.resolve(boundState('ses', presetName));

/** Records the calls and confirms the binding unless `respond` overrides it. */
function recorder(
  respond?: (
    sessionID: string,
    presetName: string,
  ) => Promise<SessionPresetState>,
) {
  const calls: Array<{ sessionID: string; presetName: string }> = [];
  return {
    calls,
    applyToSession: async (sessionID: string, presetName: string) => {
      calls.push({ sessionID, presetName });
      return respond
        ? respond(sessionID, presetName)
        : boundState(sessionID, presetName);
    },
  };
}

beforeEach(() => {
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  previousPresetEnv = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-preset-command-'));
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  fs.mkdirSync(path.dirname(userConfigPath()), { recursive: true });
  writeUserConfig({});
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  if (previousPresetEnv === undefined)
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  else process.env.OH_MY_OPENCODE_SLIM_PRESET = previousPresetEnv;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('presetListFeedback', () => {
  test('lists visible presets with the session team and the global default', async () => {
    writeUserConfig({
      preset: 'fast',
      presets: {
        fast: { fixer: { model: 'test/fast' } },
        broken: { extends: 'missing-parent' },
      },
    });
    const project = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.opencode', 'oh-my-opencode-slim.json'),
      JSON.stringify({ presets: { deep: { fixer: { model: 'test/deep' } } } }),
    );

    const message = await presetListFeedback({
      directory: project,
      sessionID: 'ses_caller',
      readSessionPreset: readBound('deep'),
      applyToSession: async () => boundState('ses_caller', 'deep'),
    });

    expect(message).toContain('Available presets: deep, fast.');
    expect(message).toContain('Saved session preset: deep.');
    expect(message).toContain('Global default: fast.');
    expect(message).toContain('/preset-status');
    expect(message).toContain('/preset-default <name>');
  });

  test('an unbound session says so instead of implying a team', async () => {
    writeUserConfig({
      preset: 'fast',
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });

    const message = await presetListFeedback({
      directory: tempDir,
      sessionID: 'ses_caller',
      readSessionPreset: async (sessionID) => unboundState(sessionID),
      applyToSession: async () => boundState('ses_caller', 'fast'),
    });

    expect(message).toContain('Session team: not bound yet.');
    expect(message).toContain('Global default: fast.');
  });

  test('an unreadable binding reports unknown instead of silently guessing', async () => {
    writeUserConfig({
      preset: 'fast',
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });

    const message = await presetListFeedback({
      directory: tempDir,
      sessionID: 'ses_caller',
      readSessionPreset: async () => {
        throw new Error('storage unavailable');
      },
      applyToSession: async () => boundState('ses_caller', 'fast'),
    });

    expect(message).not.toContain('Session team');
    expect(message).toContain(
      'Session status: unknown — Error: storage unavailable',
    );
    expect(message).toContain('Global default: fast.');
  });

  test('no presets configured points at the config file', async () => {
    expect(
      await presetListFeedback({
        directory: tempDir,
        sessionID: 'ses_caller',
        readSessionPreset: async (sessionID) => unboundState(sessionID),
        applyToSession: async () => boundState('ses_caller', 'fast'),
      }),
    ).toContain(
      'No presets configured. Define presets in oh-my-opencode-slim.jsonc.',
    );
  });
});

describe('presetApplyFeedback', () => {
  test('binds the invoking session instead of writing the default', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });
    const { calls, applyToSession } = recorder();

    const message = await presetApplyFeedback({
      directory: tempDir,
      presetName: 'fast',
      sessionID: 'ses_caller',
      applyToSession,
    });

    expect(calls).toEqual([{ sessionID: 'ses_caller', presetName: 'fast' }]);
    expect(message).toBe('Applied preset "fast" to this session\'s team.');
    expect(readUserConfig().preset).toBeUndefined();
  });

  test('an unknown name reports the valid options and binds nothing', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });
    const { calls, applyToSession } = recorder();

    const message = await presetApplyFeedback({
      directory: tempDir,
      presetName: 'missing',
      sessionID: 'ses_caller',
      applyToSession,
    });

    expect(message).toContain('Preset "missing" not found.');
    expect(message).toContain('Available presets: fast');
    expect(calls).toEqual([]);
  });

  test('a refused binding surfaces the server reason', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });
    const { applyToSession } = recorder(async () => {
      throw new Error('Cannot apply to an unbound child');
    });

    const message = await presetApplyFeedback({
      directory: tempDir,
      presetName: 'fast',
      sessionID: 'ses_child',
      applyToSession,
    });

    expect(message).toBe(
      'Preset "fast" was not applied: Cannot apply to an unbound child',
    );
  });

  test('an unconfirmed binding is reported instead of a success', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });
    const { applyToSession } = recorder(async (sessionID) =>
      unboundState(sessionID),
    );

    const message = await presetApplyFeedback({
      directory: tempDir,
      presetName: 'fast',
      sessionID: 'ses_caller',
      applyToSession,
    });

    expect(message).toContain('did not confirm the session binding');
  });
});

describe('createPresetCommand', () => {
  const options = () => ({
    directory: tempDir,
    applyToSession: async (sessionID: string, presetName: string) =>
      boundState(sessionID, presetName),
    readSessionPreset: async (sessionID: string) => unboundState(sessionID),
  });

  test('exposes the server command identity', () => {
    const command = createPresetCommand(options());
    expect(command.name).toBe(PRESET_COMMAND_NAME);
    expect(command.description).toBe(PRESET_COMMAND_DESCRIPTION);
  });

  test('no argument rejects with the preset list', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });

    await expect(
      createPresetCommand(options()).execute({
        sessionID: 'ses_preset',
        prompt: { text: '  ' },
      }),
    ).rejects.toThrow('Available presets: fast.');
  });

  test('binds the invoking session without a turn/default write, trimming and reapplying the whole name', async () => {
    writeUserConfig({
      presets: { 'fast team': { fixer: { model: 'test/fast' } } },
    });
    const { calls, applyToSession } = recorder();
    const command = createPresetCommand({ ...options(), applyToSession });
    for (let i = 0; i < 2; i++) {
      await expect(
        command.execute({
          sessionID: 'ses',
          prompt: { text: '  fast team  ' },
        }),
      ).rejects.toThrow('Applied preset "fast team"');
    }
    expect(calls).toEqual([
      { sessionID: 'ses', presetName: 'fast team' },
      { sessionID: 'ses', presetName: 'fast team' },
    ]);
    expect(readUserConfig().preset).toBeUndefined();
  });
});

describe('read-only preset status and defaults', () => {
  test('reports saved bindings even with an empty catalog, including unnamed bound sessions', async () => {
    const before = fs.readFileSync(userConfigPath(), 'utf-8');
    for (const [presetName, selection, label] of [
      [null, 'default', 'default-derived (root sessions refresh'],
      ['deleted', 'explicit', 'explicit (fixed'],
      ['legacy', undefined, 'legacy explicit (fixed'],
    ] as const) {
      const read = mock(async () => ({
        ...boundState('ses', presetName ?? ''),
        presetName,
        selection,
      }));
      const message = await presetStatusFeedback({
        directory: tempDir,
        sessionID: 'ses',
        readSessionPreset: read,
      });
      expect(message).toContain('Session status: bound.');
      expect(message).toContain(`Selection: ${label}`);
      expect(message).toContain(
        `Saved session preset: ${presetName ?? '(no named preset)'}.`,
      );
      expect(message).toContain('No presets configured.');
      expect(message).not.toContain('not bound');
      expect(read).toHaveBeenCalledTimes(1);
    }
    const read = mock(async () => unboundState('ses'));
    const command = createPresetStatusCommand({
      directory: tempDir,
      readSessionPreset: read,
    });
    await expect(
      command.execute({ sessionID: 'ses', prompt: { text: 'oops' } }),
    ).rejects.toThrow('Usage: /preset-status');
    expect(read).not.toHaveBeenCalled();
    await expect(command.execute({ sessionID: 'ses' })).rejects.toThrow(
      'Session status: unbound.',
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(userConfigPath(), 'utf-8')).toBe(before);
  });

  test('distinguishes default sources and reports configuration errors without hiding saved bindings', async () => {
    writeUserConfig({
      preset: 'user',
      presets: { user: { fixer: { model: 'test/user' } } },
    });
    const project = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
    const file = path.join(project, '.opencode', 'oh-my-opencode-slim.json');
    fs.writeFileSync(file, JSON.stringify({ preset: 'project' }));
    const options = {
      directory: project,
      sessionID: 'ses',
      readSessionPreset: async () => unboundState('ses'),
    };
    const projectMessage = await presetStatusFeedback(options);
    expect(projectMessage).toContain('Global default: user.');
    expect(projectMessage).toContain(
      'Effective project default: project (source: project config (.opencode)).',
    );
    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'env';
    const envMessage = await presetStatusFeedback(options);
    expect(envMessage).toContain('Global default: user.');
    expect(envMessage).toContain(
      'Effective project default: env (source: environment: OH_MY_OPENCODE_SLIM_PRESET).',
    );
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).preset).toBe('project');
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    fs.writeFileSync(file, JSON.stringify({ preset: '' }));
    expect(await presetStatusFeedback(options)).toContain(
      'Effective project default: (none) (source: project config (.opencode)).',
    );
    for (const corrupt of [
      () => fs.writeFileSync(userConfigPath(), '{ broken'),
      () => {
        fs.rmSync(userConfigPath());
        fs.mkdirSync(userConfigPath());
      },
    ]) {
      corrupt();
      const message = await presetStatusFeedback({
        directory: tempDir,
        sessionID: 'ses',
        readSessionPreset: readBound('saved'),
      });
      expect(message).toContain('Saved session preset: saved.');
      expect(message).toContain('Preset defaults/catalog: unknown');
      expect(message).not.toContain('Global default: (none)');
    }
  });
});

describe('changing the user default without applying a session preset', () => {
  beforeEach(() =>
    writeUserConfig({
      preset: 'fast',
      presets: {
        fast: { fixer: { model: 'test/fast' } },
        'deep team': { fixer: { model: 'test/deep' } },
        marketBase: { marketplace: { agents: ['team/toolkit'] } },
        market: { extends: 'marketBase' },
        broken: { extends: 'missing-parent' },
      },
    }),
  );

  test('no argument only displays defaults/options; a whole trimmed name saves and awaits refresh exactly once', async () => {
    const previousMarketBase = process.env.OMO_TEST_MARKET_BASE;
    process.env.OMO_TEST_MARKET_BASE = 'marketBase';
    try {
      const config = readUserConfig();
      (config.presets as Record<string, unknown>).market = {
        extends: '{env:OMO_TEST_MARKET_BASE}',
      };
      writeUserConfig(config);
      const refreshDefault = mock(async () => ({ ok: true as const }));
      const command = createPresetDefaultCommand({
        directory: tempDir,
        refreshDefault,
      });
      expect(command.name).toBe('preset-default');
      const before = fs.readFileSync(userConfigPath(), 'utf-8');
      await expect(
        command.execute({ sessionID: 'ses', prompt: { text: '  ' } }),
      ).rejects.toThrow('Global default: fast.');
      expect(refreshDefault).not.toHaveBeenCalled();
      expect(fs.readFileSync(userConfigPath(), 'utf-8')).toBe(before);
      await expect(
        command.execute({ sessionID: 'ses', prompt: { text: '  market  ' } }),
      ).rejects.toThrow('Runtime profiles refreshed');
      expect(readUserConfig().preset).toBe('market');
      expect(readUserConfig()).toHaveProperty(
        'presets.market.extends',
        '{env:OMO_TEST_MARKET_BASE}',
      );
      expect(readUserConfig()).toHaveProperty(
        'presets.marketBase.marketplace.agents',
        ['team/toolkit'],
      );
      expect(refreshDefault).toHaveBeenCalledTimes(1);
    } finally {
      if (previousMarketBase === undefined)
        delete process.env.OMO_TEST_MARKET_BASE;
      else process.env.OMO_TEST_MARKET_BASE = previousMarketBase;
    }
  });

  test('refused or failed default changes preserve files and never refresh', async () => {
    const refreshDefault = mock(async () => ({ ok: true as const }));
    const before = fs.readFileSync(userConfigPath(), 'utf-8');
    const project = path.join(tempDir, 'project');
    fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
    const file = path.join(project, '.opencode', 'oh-my-opencode-slim.json');
    const content = JSON.stringify({ preset: 'fast' });
    fs.writeFileSync(file, content);
    expect(
      await presetDefaultFeedback({
        directory: project,
        presetName: 'deep team',
        refreshDefault,
      }),
    ).toContain('project config (.opencode) explicitly sets preset "fast"');
    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'fast';
    expect(
      await presetDefaultFeedback({
        directory: tempDir,
        presetName: 'deep team',
        refreshDefault,
      }),
    ).toContain('OH_MY_OPENCODE_SLIM_PRESET');
    expect(fs.readFileSync(userConfigPath(), 'utf-8')).toBe(before);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
    expect(refreshDefault).not.toHaveBeenCalled();
    delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
    const emptyOverride = JSON.stringify({ preset: '' });
    fs.writeFileSync(file, emptyOverride);
    expect(
      await presetDefaultFeedback({
        directory: project,
        presetName: 'deep team',
        refreshDefault,
      }),
    ).toContain('explicitly sets an empty preset');
    expect(fs.readFileSync(userConfigPath(), 'utf-8')).toBe(before);
    expect(fs.readFileSync(file, 'utf-8')).toBe(emptyOverride);
    expect(refreshDefault).not.toHaveBeenCalled();
    expect(
      await presetDefaultFeedback({
        directory: tempDir,
        presetName: 'missing',
        refreshDefault,
      }),
    ).toContain('not found');
    // Inject the existing persistence boundary: filesystem denial is not
    // portable when the suite runs as root.
    const write = spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      const message = await presetDefaultFeedback({
        directory: tempDir,
        presetName: 'deep team',
        refreshDefault,
      });
      expect(message).toContain('Could not save');
      expect(message).toContain('disk full');
    } finally {
      write.mockRestore();
    }
    expect(readUserConfig().preset).toBe('fast');
    expect(refreshDefault).not.toHaveBeenCalled();
    fs.writeFileSync(userConfigPath(), '{ bad');
    await expect(
      presetDefaultFeedback({
        directory: tempDir,
        presetName: 'deep team',
        refreshDefault,
      }),
    ).rejects.toThrow(userConfigPath());
    expect(fs.readFileSync(userConfigPath(), 'utf-8')).toBe('{ bad');
    expect(refreshDefault).not.toHaveBeenCalled();
  });

  test('a saved default remains saved when runtime refresh refuses or throws', async () => {
    for (const refreshDefault of [
      async () => ({ ok: false as const, reason: 'invalid runtime config' }),
      async () => {
        throw new Error('refresh unavailable');
      },
    ]) {
      const message = await presetDefaultFeedback({
        directory: tempDir,
        presetName: 'deep team',
        refreshDefault,
      });
      expect(message).toContain(
        'Saved global default "deep team". Session bindings unchanged.',
      );
      expect(message).toContain('Runtime refresh failed:');
      expect(message).not.toContain('Runtime profiles refreshed');
      expect(readUserConfig().preset).toBe('deep team');
    }
  });
});
