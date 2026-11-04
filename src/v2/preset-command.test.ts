import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPresetCommand,
  PRESET_COMMAND_DESCRIPTION,
  PRESET_COMMAND_NAME,
  presetApplyFeedback,
  presetListFeedback,
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
      presets: { fast: { fixer: { model: 'test/fast' } } },
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

    expect(message).toBe(
      'Available presets: deep, fast. Session team: deep. Global default: fast. Run /preset <name> to apply one to this session.',
    );
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

  test('an unreadable binding reports the default only', async () => {
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
    ).toBe(
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
    ).rejects.toThrow(
      'Available presets: fast. Session team: not bound yet. Run /preset <name> to apply one to this session.',
    );
  });

  test('rejects with the feedback instead of starting a turn, binding the invoking session', async () => {
    writeUserConfig({
      presets: { fast: { fixer: { model: 'test/fast' } } },
    });
    const { calls, applyToSession } = recorder();

    await expect(
      createPresetCommand({ ...options(), applyToSession }).execute({
        sessionID: 'ses_preset',
        prompt: { text: 'fast' },
      }),
    ).rejects.toThrow('Applied preset "fast" to this session\'s team.');
    expect(calls).toEqual([{ sessionID: 'ses_preset', presetName: 'fast' }]);
    expect(readUserConfig().preset).toBeUndefined();
  });
});
