/**
 * Shared multiplexer infrastructure
 *
 * Functions used across tmux, zellij, and herdr backend adapters.
 * Extracted to eliminate copy-paste duplication and prevent drift.
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { crossSpawn } from '../utils/compat';
import { log } from '../utils/logger';

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalize Windows backslashes to / so sh -lc (MSYS2/Git Bash) doesn't treat them as escape chars. */
export function normalizePathForShell(directory: string): string {
  return process.platform === 'win32'
    ? directory.replace(/\\/g, '/')
    : directory;
}

export function buildOpencodeAttachCommand(
  sessionId: string,
  serverUrl: string,
  directory: string,
  executable = 'opencode',
): string {
  const attachDir = normalizePathForShell(directory);
  return [
    executable === 'opencode' ? executable : quoteShellArg(executable),
    'attach',
    quoteShellArg(serverUrl),
    '--session',
    quoteShellArg(sessionId),
    '--dir',
    quoteShellArg(attachDir),
  ].join(' ');
}

/**
 * Resolve the absolute path to the running OpenCode binary so child shells
 * (e.g. a kitty-launched window) don't need `opencode` on their PATH. Falls
 * back to the bare `opencode` name when no absolute path can be determined.
 */
export function resolveOpencodeExecutable(): string {
  return resolveHostOpencodeBinary() ?? 'opencode';
}

/**
 * Build the `[shell, ...shellArgs, command]` array for launching a command in
 * the user's interactive shell. OpenCode respects the user's shell when running
 * commands; multiplexer panes must do the same, otherwise a hardcoded `sh -c`
 * breaks under non-POSIX shells (fish, nu, powershell, ...) or misses login
 * startup files (where `opencode` may be on PATH).
 *
 * Mirrors OpenCode's own `Shell.args()` resolution:
 * - nu / fish: `<shell> -c <command>` (no login mode)
 * - zsh: login mode; zsh sources ~/.zshenv automatically, then we source
 *   .zshrc before running the command
 * - bash: login mode, sources bashrc, then runs command
 * - cmd: `cmd /c <command>`
 * - powershell: `pwsh -NoProfile -Command <command>`
 * - default (sh/dash/elvish/xonsh/...): `<shell> -c <command>`
 *
 * Note: the working directory is supplied by the launcher (e.g. kitty's
 * `--cwd`), not by a `cd` inside the shell command.
 */
export function buildShellLaunchArgs(command: string): string[] {
  const shell = process.env.SHELL || '/bin/sh';
  const name = (shell.split(/[/\\]/).at(-1) ?? 'sh').replace(
    /\.(exe|EXE)$/,
    '',
  );

  if (name === 'nu' || name === 'fish') {
    return [shell, '-c', command];
  }
  if (name === 'zsh') {
    // zsh sources ~/.zshenv unconditionally at startup (every session, login or
    // not), so we must not source it again here. Only source .zshrc (login
    // mode already implies this, but doing it explicitly keeps PATH/aliases
    // consistent for the launched command).
    return [
      shell,
      '-l',
      '-c',
      `[[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1\n${command}`,
    ];
  }
  if (name === 'bash') {
    return [
      shell,
      '-l',
      '-c',
      `shopt -s expand_aliases\n[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true\n${command}`,
    ];
  }
  if (name === 'cmd') {
    return [shell, '/c', command];
  }
  if (name === 'pwsh' || name === 'powershell') {
    return [shell, '-NoProfile', '-Command', command];
  }
  return [shell, '-c', command];
}

export function resolveHostOpencodeBinary(
  options: {
    override?: string;
    envOverride?: string;
    execPath?: string;
    argv0?: string;
    pathExists?: (path: string) => boolean;
  } = {},
): string | null {
  const pathExists = options.pathExists ?? existsSync;
  for (const candidate of [
    options.override,
    options.envOverride ?? process.env.OPENCODE_BIN,
    options.execPath ?? process.execPath,
    options.argv0 ?? process.argv[0],
  ]) {
    if (
      candidate &&
      isAbsolute(candidate) &&
      /^opencode(?:\.exe)?$/i.test(basename(candidate)) &&
      pathExists(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

export async function findBinary(
  binaryName: string,
  options: { verify?: boolean } = {},
): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  const logPrefix = `[${binaryName}]`;

  try {
    const proc = crossSpawn([cmd, binaryName], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log(`${logPrefix} findBinary: '${cmd} ${binaryName}' failed`, {
        exitCode,
      });
      return null;
    }

    const stdout = await proc.stdout();
    const path = stdout.trim().split('\n')[0];
    if (!path) {
      log(`${logPrefix} findBinary: no path in output`);
      return null;
    }

    log(`${logPrefix} findBinary: found`, { path });

    // Verify the binary works if requested
    if (options.verify) {
      try {
        const verifyProc = crossSpawn([path, '-V'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const verifyExitCode = await verifyProc.exited;
        if (verifyExitCode !== 0) {
          log(`${logPrefix} findBinary: verification failed for ${path}`);
          return null;
        }
        const verifyStdout = await verifyProc.stdout();
        log(`${logPrefix} findBinary: verified`, {
          version: verifyStdout.trim(),
        });
      } catch (verifyErr) {
        log(`${logPrefix} findBinary: verification exception`, {
          error: String(verifyErr),
        });
        return null;
      }
    }

    return path;
  } catch (err) {
    log(`${logPrefix} findBinary: exception`, { error: String(err) });
    return null;
  }
}

const GRACEFUL_SHUTDOWN_DELAY_MS = 250;

export interface GracefulClosePaneOptions {
  /** Backend-specific Ctrl+C command args (binary prepended by caller). */
  ctrlC: string[];
  /** Backend-specific close/kill command args (binary prepended by caller). */
  close: string[];
  /** Accept exit code 1 as success (zellij/herdr treat "already closed" as 1). */
  acceptExitCode1?: boolean;
  /** Return true for empty/unknown paneId instead of false (zellij/herdr behavior). */
  emptyPaneReturnsTrue?: boolean;
  /** Env to pass to the kitten/kitty invocations (e.g. KITTY_LISTEN_ON). */
  env?: Record<string, string | undefined>;
}

export async function gracefulClosePane(
  binary: string | null,
  paneId: string,
  options: GracefulClosePaneOptions,
): Promise<boolean> {
  if (!binary) return false;

  const isEmpty = !paneId || paneId === 'unknown';
  if (isEmpty) return options.emptyPaneReturnsTrue ?? false;

  try {
    const ctrlCProc = crossSpawn([binary, ...options.ctrlC], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: options.env,
    });
    await ctrlCProc.exited;

    await new Promise((r) => setTimeout(r, GRACEFUL_SHUTDOWN_DELAY_MS));

    const proc = crossSpawn([binary, ...options.close], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: options.env,
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) return true;
    if (options.acceptExitCode1 && exitCode === 1) return true;
    return false;
  } catch {
    return false;
  }
}
