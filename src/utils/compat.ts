import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile as fsWriteFile } from 'node:fs/promises';

export const isBun = typeof globalThis.Bun !== 'undefined';

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

/**
 * Cross-runtime spawn that works in both Bun and Node.js.
 * API mimics Bun.spawn but uses node:child_process internally.
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
  const proc = nodeSpawn(cmd, args, {
    stdio: [
      options?.stdin ?? 'ignore',
      options?.stdout ?? 'pipe',
      options?.stderr ?? 'pipe',
    ],
    cwd: options?.cwd,
    env: options?.env as NodeJS.ProcessEnv,
  });

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
 */
export async function crossWrite(
  path: string,
  data: ArrayBuffer | Buffer | string,
): Promise<void> {
  await fsWriteFile(path, Buffer.from(data as ArrayBuffer));
}
