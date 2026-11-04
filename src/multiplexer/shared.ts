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
import type { PaneSpawnOptions } from './types';

export const PANE_VIEWER_ENV = 'OH_MY_OPENCODE_SLIM_PANE_VIEWER';

/** Mark a viewer in the shell that launches it. */
export function markViewerCommand(
  command: string,
  shell = process.env.SHELL || '/bin/sh',
): string {
  const name = shellName(shell);
  if (name === 'pwsh' || name === 'powershell')
    return `$env:${PANE_VIEWER_ENV}='1'; ${command}`;
  if (name === 'cmd') return `set "${PANE_VIEWER_ENV}=1" && ${command}`;
  return `env ${PANE_VIEWER_ENV}=1 ${command}`;
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quotes one argument for the shell that will interpret the command.
 * PowerShell escapes an embedded apostrophe by doubling it inside a
 * single-quoted string (`'O''Brien'`); the POSIX `'\''` form is not readable
 * to it.
 */
function quoteForShell(value: string, shell?: PaneShell): string {
  return shell === 'powershell'
    ? `'${value.replace(/'/g, "''")}'`
    : quoteShellArg(value);
}

/** Normalize Windows backslashes to / so sh -lc (MSYS2/Git Bash) doesn't treat them as escape chars. */
export function normalizePathForShell(directory: string): string {
  return process.platform === 'win32'
    ? directory.replace(/\\/g, '/')
    : directory;
}

export type PaneShell = 'posix' | 'powershell';

/** Quote an executable for the pane shell: bare fallback stays bare, Windows
 * backslashes become / for MSYS2/Git Bash; PowerShell needs the call operator. */
function formatExecutableForShell(
  executable: string,
  shell?: PaneShell,
): string {
  if (executable === 'opencode') return executable;
  const normalized = normalizePathForShell(executable);
  const quoted = quoteForShell(normalized, shell);
  return shell === 'powershell' ? `& ${quoted}` : quoted;
}

/** @public knip: test-only export via cache-busted dynamic import. */
export function buildOpencodeAttachCommand(
  sessionId: string,
  serverUrl: string,
  directory: string,
  // Resolved host binary (falls back to bare 'opencode'): pane shells
  // (zellij `sh -lc`, tmux server PATH) may not have `opencode` on PATH
  // (e.g. linuxbrew installs), #514.
  executable = resolveOpencodeExecutable(),
  shell?: PaneShell,
): string {
  const attachDir = normalizePathForShell(directory);
  return [
    formatExecutableForShell(executable, shell),
    'attach',
    quoteForShell(serverUrl, shell),
    '--session',
    quoteForShell(sessionId, shell),
    '--dir',
    quoteForShell(attachDir, shell),
  ].join(' ');
}

/**
 * Viewer command flavor, one per host deployment mode (FR-2 matrix):
 * `v1` attaches to a reflected server URL; `v2-shared` lets the viewer
 * rediscover the shared background service itself; `v2-remote` connects to
 * the same explicit `--server` the parent client uses.
 */
export type ViewerFlavor = 'v1' | 'v2-shared' | 'v2-remote';

export type ViewerCommandOptions = Pick<
  PaneSpawnOptions,
  'viewerFlavor' | 'viewerSurface'
> & {
  /** Absolute host binary; defaults to the resolved host binary (falls
   back to bare `opencode`). */
  executable?: string;
  shell?: PaneShell;
};

/**
 * Builds the pane viewer command for one host flavor (FR-2 command matrix).
 * Every adapter routes through here so the matrix lives in exactly one place.
 *
 * - `v1`: `<resolved-binary> attach <url> --session <id> --dir <dir>`
 *   (was bare `opencode`; now resolveOpencodeExecutable())
 * - `v2-shared`: `<resolved-binary> --session <id> <dir>` — the viewer
 *   discovers the same shared background service by itself; no URL is passed.
 * - `v2-remote`: `<resolved-binary> --server <url> --session <id> <dir>` — the
 *   `OPENCODE_PASSWORD` secret is never part of the command text; adapters
 *   inject it at pane creation through their native spawn-time environment
 *   mechanism, or through `withParentEnvPassword` where none exists.
 *
 * `mini` uses `attach ... --mini` on v1 (OpenCode >= 1.17.10). On v2 it
 * uses the `mini` subcommand, which rejects a positional directory; adapters
 * pin the pane cwd instead (herdr/kitty/wezterm natively, tmux `-c`,
 * Zellij `--cwd`, cmux-tui `cd`).
 */
export function buildViewCommand(
  sessionId: string,
  serverUrl: string,
  directory: string,
  options: ViewerCommandOptions = {},
): string {
  const flavor = options.viewerFlavor ?? 'v1';
  const executable = options.executable ?? resolveOpencodeExecutable();
  const mini = options.viewerSurface === 'mini';
  if (flavor === 'v1') {
    const attach = buildOpencodeAttachCommand(
      sessionId,
      serverUrl,
      directory,
      executable,
      options.shell,
    );
    return mini ? `${attach} --mini` : attach;
  }
  const viewDir = normalizePathForShell(directory);
  return [
    formatExecutableForShell(executable, options.shell),
    ...(mini ? ['mini'] : []),
    ...(flavor === 'v2-remote'
      ? ['--server', quoteForShell(serverUrl, options.shell)]
      : []),
    '--session',
    quoteForShell(sessionId, options.shell),
    ...(viewerNeedsPaneCwd(options)
      ? []
      : [quoteForShell(viewDir, options.shell)]),
  ].join(' ');
}

/** Only v2 mini omits the directory, so its adapter must pin the pane cwd. */
export function viewerNeedsPaneCwd(
  options: ViewerCommandOptions = {},
): boolean {
  return (
    options.viewerSurface === 'mini' && (options.viewerFlavor ?? 'v1') !== 'v1'
  );
}

/** Shells whose `-c` argument is a POSIX script. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Whether the resolved shell can run a POSIX script. Used to gate the
 * `/proc`-based viewer-secret bridge (cmux-tui, wezterm): unknown and Windows
 * shells count as non-POSIX, so the caller fails closed instead of feeding a
 * command-substitution script to a shell that cannot parse it.
 */
export function isPosixShell(shell: string): boolean {
  return POSIX_SHELLS.has(shellName(shell));
}

/**
 * Whether the shell supports the POSIX `cd '...' && ...` viewer wrapper,
 * not general `&&` support. POSIX shells and fish (since 3.0) are supported;
 * nu, cmd, and PowerShell wrappers are not handled.
 */
const AND_CHAIN_SHELLS = new Set([...POSIX_SHELLS, 'fish']);

export function shellSupportsAndChain(shell = process.env.SHELL): boolean {
  return AND_CHAIN_SHELLS.has(shellName(shell ?? '/bin/sh'));
}

/**
 * Wraps `command` in a POSIX script that recovers the viewer password from
 * this process's own `/proc/<pid>/environ` (readable by the owning user only)
 * and exports it (as `OPENCODE_PASSWORD` by default) before running the
 * command. Adapters whose CLI has no spawn-time env mechanism (zellij,
 * cmux-tui, wezterm) use this so
 * the secret never appears in command text or argv — it exists only in the
 * pane's environment at viewer start.
 *
 * Precedence matches the v2 host wiring: `OPENCODE_PASSWORD` first, then
 * `OPENCODE_SERVER_PASSWORD`. `/proc/<pid>/environ` is NUL-separated and is
 * split with `tr`, so the value is read line-wise: a password containing
 * newlines is recovered only up to its first line (documented limitation).
 *
 * `exportAs` names the variable the viewer reads: v2 viewers read
 * `OPENCODE_PASSWORD` (the default, with the precedence above), while a v1
 * `opencode attach` viewer reads only `OPENCODE_SERVER_PASSWORD`, so that is
 * the only variable consulted for it.
 */
export function withParentEnvPassword(
  command: string,
  exportAs:
    | 'OPENCODE_PASSWORD'
    | 'OPENCODE_SERVER_PASSWORD' = 'OPENCODE_PASSWORD',
): string {
  const environ = `/proc/${process.pid}/environ`;
  const read = (name: string): string =>
    `$(tr '\\0' '\\n' < ${environ} 2>/dev/null | sed -n 's/^${name}=//p' | head -n 1)`;
  // A v1 viewer authenticates with exactly what `opencode attach` reads, so
  // a stray v2 `OPENCODE_PASSWORD` must not take precedence there.
  const lookup =
    exportAs === 'OPENCODE_SERVER_PASSWORD'
      ? [`_omo_pw=${read('OPENCODE_SERVER_PASSWORD')}`]
      : [
          `_omo_pw=${read('OPENCODE_PASSWORD')}`,
          `[ -n "$_omo_pw" ] || _omo_pw=${read('OPENCODE_SERVER_PASSWORD')}`,
        ];
  return [
    ...lookup,
    `if [ -n "$_omo_pw" ]; then export ${exportAs}="$_omo_pw"; fi`,
    'unset _omo_pw',
    command,
  ].join('\n');
}

/**
 * Masks the viewer secret in spawn argv before it reaches a log payload.
 * The secret travels as a spawn-time environment entry (`-e` / `--env`), so
 * masking `OPENCODE_PASSWORD=…` / `OPENCODE_SERVER_PASSWORD=…` values keeps
 * every log line secret-free; viewer commands never contain it.
 */
export function redactViewerSecretArgs(args: readonly string[]): string[] {
  return args.map((arg) => {
    const separator = arg.indexOf('=');
    if (separator === -1) return arg;
    const name = arg.slice(0, separator);
    return name === 'OPENCODE_PASSWORD' ||
      name === 'OPENCODE_SERVER_PASSWORD' ||
      name === 'OPENCODE_SERVER_USERNAME'
      ? `${name}=<redacted>`
      : arg;
  });
}

/**
 * Resolve the absolute path to the running OpenCode binary so child shells
 * (e.g. a kitty-launched window) don't need `opencode` on their PATH. Falls
 * back to the bare `opencode` name when no absolute path can be determined.
 */
function resolveOpencodeExecutable(): string {
  return resolveHostOpencodeBinary() ?? 'opencode';
}

/**
 * Build the `[shell, ...shellArgs, command]` array for launching a command in
 * the user's interactive shell. OpenCode respects the user's shell when running
 * commands; multiplexer panes must do the same, otherwise a hardcoded `sh -c`
 * breaks under non-POSIX shells (fish, nu, powershell, ...).
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
  const name = shellName(shell);

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

/** Resolved basename of a shell path, without a `.exe` suffix. */
function shellName(shell: string): string {
  return (shell.split(/[/\\]/).at(-1) ?? 'sh').replace(/\.(exe|EXE)$/, '');
}

/**
 * Whether the resolved interactive shell treats `#` as a comment. Adapters
 * that prefix a POSIX comment data marker to a command must omit it when the
 * shell has no `#` comments (only `cmd` today). Reuses the same shell-name
 * resolution as `buildShellLaunchArgs` so the two can never disagree.
 */
export function shellSupportsHashComments(
  shell = process.env.SHELL || '/bin/sh',
): boolean {
  return shellName(shell) !== 'cmd';
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

/**
 * Log prefix of one `findBinary` probe: `[<binaryName>]` by default. Callers
 * that probe a differently named distribution binary (cmux probes `cmux` as a
 * legacy fallback while its logs are prefixed `[cmux-tui]`) pass `logPrefix`.
 *
 * @public knip: test-only export via cache-busted dynamic import.
 */
export function findBinaryLogPrefix(
  binaryName: string,
  logPrefix?: string,
): string {
  return `[${logPrefix ?? binaryName}]`;
}

export async function findBinary(
  binaryName: string,
  options: {
    verify?: boolean;
    logPrefix?: string;
    onVerified?: (version: string) => void;
  } = {},
): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  const logPrefix = findBinaryLogPrefix(binaryName, options.logPrefix);

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

    log(`${logPrefix} findBinary: found ${path}`);

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
        options.onVerified?.(verifyStdout.trim());
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
  /**
   * Treat a failed close as success only when its stderr proves the pane is
   * already gone. Stricter than `acceptExitCode1` for backends whose CLI also
   * exits 1 on transport/protocol errors while the pane still exists (a false
   * success would make the caller forget a live pane).
   */
  isAlreadyClosed?: (stderr: string) => boolean;
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

    const inspectStderr = options.isAlreadyClosed !== undefined;
    const proc = crossSpawn([binary, ...options.close], {
      stdout: 'ignore',
      stderr: inspectStderr ? 'pipe' : 'ignore',
      env: options.env,
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) return true;
    if (options.isAlreadyClosed) {
      return options.isAlreadyClosed(await proc.stderr());
    }
    if (options.acceptExitCode1 && exitCode === 1) return true;
    return false;
  } catch {
    return false;
  }
}
