/**
 * Absolute-path rescue (#1143).
 *
 * Agents occasionally guess an absolute path with dropped directory
 * segments (e.g. `/home/u/Work/Project` when the workspace is
 * `/home/u/Work/Parent/Child/Project`). The host then fails the tool
 * call with `NotFound: FileSystem.access (<path>)` before the tool even
 * runs, wasting a turn.
 *
 * Rescue contract (deliberately narrow):
 * - Only absolute path arguments (`filePath`/`path`) of read/list/
 *   glob/grep whose absence is a plain ENOENT (permission/I/O errors
 *   pass through untouched).
 * - Only guesses that are NOT already anchored under the workspace: a
 *   missing path inside the workspace is a legitimate absence and must
 *   surface, never be silently redirected.
 * - The rewrite identifies an anchor — a contiguous suffix of the
 *   workspace path appearing inside the guess (longest first) — and
 *   re-anchors the FULL relative tail that follows it. The tail is
 *   never trimmed: if it does not exist, there is no rescue.
 * - Candidates must exist per a successful stat (any stat error —
 *   ENOTDIR, EACCES, EIO — rejects the candidate) and `..` segments
 *   anywhere in the guess disable the rescue entirely.
 *
 * The hook never blocks and never invents paths: without a matching,
 * existing, confined candidate the call proceeds exactly as written.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import { log } from '../../utils/logger';

interface ToolExecuteBeforeInput {
  tool: string;
}

interface ToolExecuteBeforeOutput {
  args?: {
    filePath?: unknown;
    [key: string]: unknown;
  };
}

type PathOperations = Pick<typeof path, 'isAbsolute' | 'join' | 'resolve' | 'sep'>;

interface RescueOptions {
  pathOperations?: PathOperations;
  exists?: (p: string) => boolean;
}

/** Argument keys carrying a file path, per host tool schema. */
const PATH_ARG_KEYS = ['filePath', 'path'] as const;

/** Tools whose path argument denotes a file/directory target. */
const RESCUED_TOOLS = new Set(['read', 'list', 'glob', 'grep']);

/** True when the path is missing (ENOENT only — other stat errors are
 * environment problems, not absent paths, and must not trigger a
 * rewrite). */
function isMissing(p: string): boolean {
  try {
    statSync(p);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function defaultExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-anchor a guessed absolute path onto the workspace.
 *
 * Selection is unambiguous by construction: the anchor is the LONGEST
 * contiguous suffix of the workspace path that appears in the guess.
 * That anchor must appear exactly once in the guess (several
 * occurrences make the interpretation ambiguous → null), and only its
 * FULL relative tail is ever considered — a missing tail is a
 * legitimate absence → null. There is no fallback to a shorter anchor
 * or another occurrence once the longest anchor has been selected.
 * An empty tail (the guess ends at the anchor) rescues to the
 * workspace root — the canonical dropped-parents case.
 */
export function findRescuedSuffix(
  raw: string,
  workspace: string,
  pathOperations: PathOperations = path,
  exists: (p: string) => boolean = defaultExists,
): string | null {
  // Segment with the injected flavor's separator throughout: on win32
  // the workspace resolves to backslashes while a guess may arrive with
  // forward slashes (C:/Users/…), which Windows treats as absolute —
  // normalize so both sides segment identically (#1186 review).
  const sep = pathOperations.sep;
  const root = pathOperations.resolve(workspace);
  const resolvedRaw = pathOperations.resolve(raw);
  if (resolvedRaw === root || resolvedRaw.startsWith(`${root}${sep}`)) {
    return null;
  }

  const normalized = sep === '/' ? raw : raw.replaceAll('/', sep);
  const guessSegments = normalized.split(sep).filter((s) => s.length > 0);
  if (guessSegments.some((s) => s === '..' || s === '.')) return null;
  const rootSegments = root.split(sep).filter((s) => s.length > 0);

  // Select the longest workspace suffix appearing in the guess.
  for (let anchorLen = rootSegments.length; anchorLen >= 1; anchorLen -= 1) {
    const anchor = rootSegments.slice(rootSegments.length - anchorLen);
    const occurrences: number[] = [];
    for (let i = 0; i + anchorLen <= guessSegments.length; i += 1) {
      if (anchor.every((seg, j) => guessSegments[i + j] === seg)) {
        occurrences.push(i);
      }
    }
    if (occurrences.length === 0) continue; // shorter anchor may match
    if (occurrences.length > 1) return null; // ambiguous — no rescue
    // Exactly one occurrence of the longest matching anchor: its FULL
    // tail decides, with no reinterpretation.
    const tail = guessSegments.slice(occurrences[0] + anchorLen);
    const candidate = [root, ...tail].join(sep);
    return exists(candidate) ? candidate : null;
  }
  return null;
}

export function createAbsolutePathRescueHook(
  ctx: PluginInput,
  options: RescueOptions = {},
) {
  const pathOperations = options.pathOperations ?? path;
  const exists = options.exists ?? defaultExists;
  const workspace = ctx.directory;

  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (!RESCUED_TOOLS.has(input.tool)) return;

      const args = output.args;
      if (!args || typeof args !== 'object') return;

      for (const key of PATH_ARG_KEYS) {
        const raw = args[key];
        if (typeof raw !== 'string' || raw === '') continue;
        if (!pathOperations.isAbsolute(raw)) continue;
        if (!isMissing(raw)) continue;

        const rescued = findRescuedSuffix(
          raw,
          workspace,
          pathOperations,
          exists,
        );
        if (rescued === null) continue;

        (args as Record<string, unknown>)[key] = rescued;
        log('absolute-path-rescue rewrote tool path', {
          tool: input.tool,
          from: raw,
          to: rescued,
        });
        return;
      }
    },
  };
}
