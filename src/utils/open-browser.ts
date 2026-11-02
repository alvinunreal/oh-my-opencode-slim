import { spawn } from 'node:child_process';

import { log } from './logger';

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/** True under tests and CI, where opening a browser is never wanted. */
export function isAutomatedRuntime(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === 'test' ||
    isTruthyEnvFlag(env.CI) ||
    isTruthyEnvFlag(env.BUN_TEST) ||
    isTruthyEnvFlag(env.VITEST) ||
    env.JEST_WORKER_ID !== undefined
  );
}

/**
 * Open a URL in the default browser.
 * Supports macOS, Linux, and Windows. Failures are logged but not thrown.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux and other Unix-like systems
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      log('[browser] failed to open browser:', { error: error.message, url });
    });
    child.unref();
  } catch (error) {
    log('[browser] failed to spawn browser opener:', {
      error: error instanceof Error ? error.message : String(error),
      url,
    });
  }
}
