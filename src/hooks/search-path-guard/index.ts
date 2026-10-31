import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import { log } from '../../utils/logger';

interface ToolExecuteBeforeInput {
  tool: string;
}

interface ToolExecuteBeforeOutput {
  args?: {
    path?: unknown;
    [key: string]: unknown;
  };
}

type PathOperations = Pick<typeof path, 'isAbsolute' | 'join' | 'resolve'>;

/**
 * Resolve a search path the same way as the corresponding host tool.
 *
 * v1's grep uses path.join while v1's glob uses path.resolve. The v2 tool
 * adapter uses path.resolve for both tools. `pathOperations` is injectable so
 * path flavor behavior can be tested deterministically without a Windows CI
 * runner; production uses Node's native path flavor, as does the host.
 */
export function resolveSearchPath(
  tool: string,
  hostFlavor: string | undefined,
  directory: string | undefined,
  raw: string,
  pathOperations: PathOperations = path,
): string | null {
  if (!directory) return null;
  if (
    hostFlavor === 'v2' &&
    (raw === '~' ||
      raw.startsWith('~/') ||
      (process.platform === 'win32' && raw.startsWith('~\\')))
  ) {
    return pathOperations.resolve(
      directory,
      pathOperations.join(homedir(), raw.slice(2)),
    );
  }
  if (pathOperations.isAbsolute(raw)) return raw;
  if (hostFlavor === 'v2' || tool === 'glob') {
    return pathOperations.resolve(directory, raw);
  }
  return pathOperations.join(directory, raw);
}

export function createSearchPathGuardHook(ctx: PluginInput) {
  const hostFlavor = (ctx as PluginInput & { hostFlavor?: string }).hostFlavor;

  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (input.tool !== 'grep' && input.tool !== 'glob') {
        return;
      }

      const args = output.args;
      if (!args || typeof args !== 'object') {
        return;
      }

      // Only v2 glob treats the literal placeholders as an absent path.
      const raw = args.path;
      if (
        typeof raw !== 'string' ||
        raw === '' ||
        (hostFlavor === 'v2' &&
          input.tool === 'glob' &&
          (raw === 'undefined' || raw === 'null'))
      ) {
        return;
      }

      // Mirror each host tool's resolution rule exactly. grep uses join while
      // glob uses resolve; that distinction matters for relative paths on
      // Windows, including drive-relative paths such as `C:src`.
      // Without a resolution base, never block (conservative fallback).
      const resolved = resolveSearchPath(
        input.tool,
        hostFlavor,
        ctx.directory,
        raw,
      );
      if (resolved === null) {
        return;
      }

      let missing = false;
      try {
        statSync(resolved);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // Genuine missing path (broken symlinks included, matching the
          // pending upstream fix). Report it as such.
          missing = true;
        } else if (code === 'ENOTDIR') {
          log('search-path-guard blocked invalid path', {
            tool: input.tool,
            path: raw,
            resolved,
            code,
          });
          throw new Error(
            `Search path is invalid: ${resolved} (from "${raw}"). ` +
              `A path component is not a directory (ENOTDIR), so the ${input.tool} ` +
              'search was blocked before ripgrep ran. Verify the target path ' +
              'and that every parent component is a directory.',
          );
        } else {
          // Any other stat failure (permissions or I/O) keeps its original
          // meaning: pass through and never misdiagnose.
          log('search-path-guard passed on stat error', {
            tool: input.tool,
            path: raw,
            resolved,
            code,
          });
        }
      }

      if (missing) {
        log('search-path-guard blocked', {
          tool: input.tool,
          path: raw,
          resolved,
        });
        throw new Error(
          `Search path does not exist: ${resolved} (from "${raw}"). ` +
            `The ${input.tool} search was blocked before ripgrep ran. ` +
            'Verify the target path, or list its parent directory to find ' +
            'the correct location.',
        );
      }
    },
  };
}
