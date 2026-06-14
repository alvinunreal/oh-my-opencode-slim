import { afterEach, describe, expect, test } from 'bun:test';
import { shouldInstallCompanion } from './install';
import type { InstallConfig } from './types';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

function baseConfig(): InstallConfig {
  return {
    hasTmux: false,
    installCustomSkills: false,
    reset: false,
    backgroundSubagents: 'no',
    companion: 'ask',
  };
}

describe('shouldInstallCompanion', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: ORIGINAL_STDIN_IS_TTY,
    });
  });

  test('dry-run defaults to install on niri', async () => {
    process.env.NIRI_SOCKET = '/run/user/1000/niri.sock';
    const config = { ...baseConfig(), dryRun: true };

    await expect(shouldInstallCompanion(config)).resolves.toBe(true);
    expect(config.companion).toBe('yes');
  });

  test('explicit companion yes still enables companion on niri', async () => {
    process.env.XDG_CURRENT_DESKTOP = 'niri';
    const config = { ...baseConfig(), companion: 'yes' as const };

    await expect(shouldInstallCompanion(config)).resolves.toBe(true);
  });

  test('dry-run still defaults to install outside niri', async () => {
    delete process.env.NIRI_SOCKET;
    delete process.env.XDG_CURRENT_DESKTOP;
    delete process.env.DESKTOP_SESSION;
    const config = { ...baseConfig(), dryRun: true };

    await expect(shouldInstallCompanion(config)).resolves.toBe(true);
    expect(config.companion).toBe('yes');
  });
});
