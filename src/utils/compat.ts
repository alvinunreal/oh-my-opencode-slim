import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface CrossSpawnResult {
  proc: ChildProcess;
  /** Collects all stdout into a string */
  stdout: () => Promise<string>;
  /** Collects all stderr into a string */
  stderr: () => Promise<string>;
  /** Resolves when process exits with exit code */
  exited: Promise<number>;
  /** Kill the process */
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Current exit code or null if running */
  get exitCode(): number | null;
}

function collectStream(
  stream: NodeJS.ReadableStream | null,
): () => Promise<string> {
  if (!stream) return () => Promise.resolve('');
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return () =>
    new Promise<string>((resolve, reject) => {
      if (!stream.readable) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
        return;
      }
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
}

const WINDOWS_PATH_EXT_DEFAULT = '.COM;.EXE;.BAT;.CMD';
const DIRECT_EXECUTION_EXTENSIONS = new Set(['.exe', '.com']);

export interface ResolvedWindowsCommand {
  /** Absolute path of the executable (or shim) that was found. */
  file: string;
  /**
   * True when `file` is a `.cmd`/`.bat` shim that only cmd.exe can
   * interpret; the caller must spawn it through cmd.exe with a quoted
   * command line instead of passing it to spawn() directly.
   */
  viaCmdShell: boolean;
}

function isRegularFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function splitList(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Splits a Windows PATH the way cmd.exe reads it: a `;` inside a quoted
 * component does not separate entries, the surrounding quotes are
 * stripped, and an empty component stands for the current directory.
 * Plain `String.split(';')` would shred quoted entries whose directory
 * names contain `;` and silently drop current-directory entries.
 */
function splitWindowsPath(pathEnv: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of pathEnv) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === path.delimiter && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => (part === '' ? '.' : part));
}

/**
 * Resolve a bare command name against PATH and PATHEXT the way cmd.exe
 * does, so spawn() can launch it on Windows.
 *
 * child_process.spawn only starts real executables; it cannot run the
 * extensionless sh and `.cmd` shims that npm-style installs leave on PATH
 * (for example `bun` installed via `npm install -g bun` exposes only
 * `bun.cmd` next to the real `bun.exe` buried in node_modules). A raw
 * spawn('bun') then fails with ENOENT even though bun runs fine in a
 * shell, which silently breaks bun-based flows such as the auto-updater.
 *
 * Walks PATH entries in order; within each entry, tries PATHEXT
 * extensions in declared order. PATH entries are split the way cmd.exe
 * reads them (quoted entries may contain `;`, empty entries mean the
 * current directory — see splitWindowsPath). The first directory
 * containing any match wins, and the matched extension decides whether
 * the file is directly spawnable (`.exe`/`.com`) or must run through
 * cmd.exe (`.cmd`/`.bat`).
 */
export function resolveWindowsCommand(
  command: string,
  pathEnv: string = process.env.PATH ?? '',
  pathExtEnv: string = process.env.PATHEXT ?? WINDOWS_PATH_EXT_DEFAULT,
): ResolvedWindowsCommand | undefined {
  const extensions = splitList(pathExtEnv, ';').map((ext) =>
    ext.startsWith('.') ? ext : `.${ext}`,
  );
  const extensionsLower = new Set(extensions.map((ext) => ext.toLowerCase()));
  const commandExt = path.extname(command);
  const candidates =
    commandExt && extensionsLower.has(commandExt.toLowerCase())
      ? [command]
      : extensions.map((ext) => `${command}${ext}`);
  const candidatesLower = candidates.map((candidate) =>
    candidate.toLowerCase(),
  );

  for (const dir of splitWindowsPath(pathEnv)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    // Directory listing gives us the on-disk casing, so matching stays
    // case-insensitive even on case-sensitive filesystems.
    const byLowerName = new Map(
      entries.map((entry) => [entry.toLowerCase(), entry]),
    );
    for (const candidateLower of candidatesLower) {
      const actualName = byLowerName.get(candidateLower);
      if (actualName === undefined) continue;
      const candidatePath = path.join(dir, actualName);
      if (!isRegularFile(candidatePath)) continue;
      const resolvedExt = path.extname(actualName).toLowerCase();
      return {
        file: candidatePath,
        viaCmdShell: !DIRECT_EXECUTION_EXTENSIONS.has(resolvedExt),
      };
    }
  }
  return undefined;
}

/**
 * cmd.exe metacharacters neutralised by double-quoting the argument.
 * Inside double quotes, `& | < > ( ) ^ !` are literal to cmd; unquoted
 * they split or chain commands (verified on Windows: passing `a&echo x`
 * as a bare token makes cmd execute the second command). `"` is not
 * listed — arguments containing it are rejected by
 * isCmdUnsafeArgument instead.
 */
const CMD_METACHARACTERS = /[\s&|<>()^!]/;

/**
 * Detects characters that cannot be passed through `cmd.exe /c` at
 * all:
 *
 * - `%` expands environment variables even inside double quotes and
 *   has no escape on the cmd command line.
 * - `"` toggles cmd's quoted region no matter what precedes it —
 *   cmd.exe, unlike the MSVCRT argument parser, does not treat `\` as
 *   an escape. Emitting `\"` therefore closes the quoted region and
 *   exposes any following metacharacter as command syntax (verified:
 *   `a"&echo x` injected the second command). Doubling quotes instead
 *   (`a""&b`) stays safe at the cmd layer but is ambiguous to the
 *   child: node's argv parser reads `""` as a literal quote while
 *   bun's splits the argument in two (verified), so no single
 *   escaping works across targets.
 * - Control characters corrupt the command line.
 *
 * Node.js refuses to spawn `.cmd`/`.bat` files with any arguments at
 * all for the same class of reasons (EINVAL since CVE-2024-27980
 * hardening); we keep the provably-safe subset and throw otherwise.
 */
function isCmdUnsafeArgument(arg: string): boolean {
  if (arg.includes('%') || arg.includes('"')) return true;
  for (let i = 0; i < arg.length; i++) {
    if (arg.charCodeAt(i) <= 0x1f) return true;
  }
  return false;
}

/**
 * Quotes one argument for a `cmd.exe /c` command line. Arguments that
 * contain no metacharacters are passed through untouched — cmd's /s
 * stripping mangles gratuitously quoted tokens. Quoted arguments have
 * no `"` left to escape (those throw in isCmdUnsafeArgument); only a
 * trailing backslash run must be doubled so the closing quote is not
 * read as an escape by the child's argument parser.
 *
 * Throws on arguments that cmd.exe cannot represent faithfully (`%`,
 * `"`, control characters) so callers fail loudly instead of
 * executing an altered command line.
 */
function escapeWindowsArgument(arg: string): string {
  if (isCmdUnsafeArgument(arg)) {
    throw new Error(
      `cannot pass ${JSON.stringify(arg)} through a .cmd shim: cmd.exe reinterprets '%', '"', and control characters even inside quotes`,
    );
  }
  if (!CMD_METACHARACTERS.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Builds the full command line handed to `cmd.exe /d /s /c`. The whole
 * line is wrapped in one outer pair of quotes because cmd's /s
 * processing strips the first and the last quote of the /c payload:
 * without the outer pair, a spaced path like `"C:\Program
 * Files\...\bun.cmd"` loses its quotes and the spawn fails (verified on
 * Windows). Exported for unit tests only.
 */
export function buildWindowsCommandLine(file: string, args: string[]): string {
  return `"${[file, ...args].map(escapeWindowsArgument).join(' ')}"`;
}

/**
 * Cross-runtime spawn that works in both Bun and Node.js.
 * API mimics Bun.spawn but uses node:child_process internally.
 *
 * On Windows, bare command names are resolved against PATH/PATHEXT first
 * (see resolveWindowsCommand) so npm-installed CLIs that only expose
 * `.cmd` shims still run. Non-Windows platforms and explicit paths are
 * passed through unchanged.
 */
export function crossSpawn(
  command: string[],
  options?: {
    stdout?: 'pipe' | 'inherit' | 'ignore';
    stderr?: 'pipe' | 'inherit' | 'ignore';
    stdin?: 'pipe' | 'inherit' | 'ignore';
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): CrossSpawnResult {
  const [cmd, ...args] = command;
  let file = cmd;
  const fileArgs = args;
  let viaCmdShell = false;

  if (
    process.platform === 'win32' &&
    !cmd.includes('/') &&
    !cmd.includes('\\')
  ) {
    const resolved = resolveWindowsCommand(cmd);
    if (resolved) {
      file = resolved.file;
      viaCmdShell = resolved.viaCmdShell;
    }
  }

  const spawnOptions: SpawnOptions = {
    stdio: [
      options?.stdin ?? 'ignore',
      options?.stdout ?? 'pipe',
      options?.stderr ?? 'pipe',
    ],
    cwd: options?.cwd,
    env: options?.env as NodeJS.ProcessEnv,
  };

  const proc: ChildProcess = viaCmdShell
    ? nodeSpawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', buildWindowsCommandLine(file, fileArgs)],
        // The command line is pre-quoted by buildWindowsCommandLine, so
        // it must reach cmd.exe verbatim — without this flag Node/Bun
        // re-escape the quotes and cmd strips the backslashes.
        { ...spawnOptions, windowsVerbatimArguments: true },
      )
    : nodeSpawn(file, fileArgs, spawnOptions);

  const stdoutCollector = collectStream(proc.stdout);
  const stderrCollector = collectStream(proc.stderr);

  const exited = new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  });

  return {
    proc,
    stdout: stdoutCollector,
    stderr: stderrCollector,
    exited,
    kill: (signal) => proc.kill(signal as NodeJS.Signals),
    get exitCode() {
      return proc.exitCode;
    },
  };
}

/**
 * Cross-runtime file write that works in both Bun and Node.js.
 *
 * Order matters: Buffer is checked before treating the remainder as
 * ArrayBuffer so Buffer slices are written as-is (no parent-buffer copy).
 * Remaining union member is treated as ArrayBuffer without `instanceof`,
 * which fails for cross-realm ArrayBuffers.
 */
export async function crossWrite(
  path: string,
  data: ArrayBuffer | Buffer | string,
): Promise<void> {
  if (typeof data === 'string') {
    await fsWriteFile(path, Buffer.from(data));
    return;
  }
  if (Buffer.isBuffer(data)) {
    await fsWriteFile(path, data);
    return;
  }
  await fsWriteFile(path, Buffer.from(data));
}
