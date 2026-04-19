import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { GREP_DESCRIPTION, GREP_TOOL_ID } from './constants';
import { formatGrepResult } from './format';
import { normalizeGrepInput } from './normalize';
import { sanitizeTitle } from './path-utils';
import { runRipgrep } from './runner';
import { grepArgsSchema } from './schema';
import type {
  GrepRunner,
  GrepSearchResult,
  GrepToolInput,
  NormalizedGrepInput,
} from './types';

interface CreateGrepToolOptions {
  run?: GrepRunner;
}

function getRawPattern(args: GrepToolInput): string {
  return typeof args.pattern === 'string' && args.pattern.length > 0
    ? args.pattern
    : 'grep';
}

function getTitle(
  args: GrepToolInput,
  normalized?: NormalizedGrepInput,
): string {
  return sanitizeTitle(normalized?.pattern ?? getRawPattern(args));
}

function buildBaseMetadata(
  args: GrepToolInput,
  normalized?: NormalizedGrepInput,
): Record<string, unknown> {
  return {
    backend: 'rg',
    pattern: normalized?.pattern ?? getRawPattern(args),
    path: normalized?.requestedPath ?? args.path,
    resolved_path: normalized?.resolvedPath,
    real_path: normalized?.searchPath,
    include: normalized?.include ?? args.include,
    globs: normalized?.globs ?? args.globs ?? [],
    exclude_globs: normalized?.excludeGlobs ?? args.exclude_globs ?? [],
    output_mode: normalized?.outputMode ?? args.output_mode ?? 'content',
    case_sensitive: normalized?.caseSensitive ?? args.case_sensitive !== false,
    smart_case: normalized?.smartCase ?? args.smart_case === true,
    word_regexp: normalized?.wordRegexp ?? args.word_regexp === true,
    context: normalized?.context ?? args.context,
    context_requested: normalized?.context ?? args.context,
    context_effective:
      normalized && normalized.beforeContext === normalized.afterContext
        ? normalized.beforeContext
        : undefined,
    before_context: normalized?.beforeContext ?? args.before_context,
    after_context: normalized?.afterContext ?? args.after_context,
    max_results: normalized?.maxResults ?? args.max_results,
    max_count_per_file: normalized?.maxCountPerFile ?? args.max_count_per_file,
    timeout_ms: normalized?.timeoutMs ?? args.timeout_ms,
    hidden: normalized?.hidden ?? args.hidden !== false,
    follow_symlinks:
      normalized?.followSymlinks ?? args.follow_symlinks === true,
    real_path_exhaustive: normalized
      ? !normalized.followSymlinks
      : args.follow_symlinks !== true,
    fixed_strings: normalized?.fixedStrings ?? args.fixed_strings === true,
    invert_match: normalized?.invertMatch ?? args.invert_match === true,
    multiline: normalized?.multiline ?? args.multiline === true,
    multiline_dotall:
      normalized?.multilineDotall ?? args.multiline_dotall === true,
    pcre2: normalized?.pcre2 ?? args.pcre2 === true,
    file_type: normalized?.fileType ?? args.file_type,
    file_types: normalized?.fileTypes ?? args.file_types ?? [],
    exclude_file_types:
      normalized?.excludeFileTypes ?? args.exclude_file_types ?? [],
    max_filesize: normalized?.maxFilesize ?? args.max_filesize,
    sort_by: normalized?.sortBy ?? args.sort_by ?? 'none',
    sort_order: normalized?.sortOrder ?? args.sort_order,
  };
}

function buildResultMetadata(
  args: GrepToolInput,
  normalized: NormalizedGrepInput,
  result: GrepSearchResult,
): Record<string, unknown> {
  const strategy =
    result.strategy ??
    (normalized.sortBy === 'mtime' ? 'mtime-hybrid' : 'direct');

  return {
    ...buildBaseMetadata(args, normalized),
    backend: result.backend ?? 'rg',
    matches: result.totalMatches,
    match_kind: result.matchKind,
    files: result.totalFiles,
    truncated: result.truncated,
    limit_reached: result.limitReached,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    retry_count: result.retryCount,
    exit_code: result.exitCode,
    error: result.error,
    cwd: result.cwd,
    command: result.command,
    strategy,
    discovery_command: result.discoveryCommand,
    replay_batch_count: result.replayBatchCount,
    replay_target_count: result.replayTargetCount,
    discovered_files: result.discoveredFiles,
    sorted_files: result.sortedFiles,
    replayed_files: result.replayedFiles,
    partial_phase: result.partialPhase,
    mtime_discovery_capped: result.mtimeDiscoveryCapped,
  };
}

function buildFailureMetadata(
  args: GrepToolInput,
  stage: 'normalize' | 'permission' | 'execution',
  error: unknown,
  normalized?: NormalizedGrepInput,
): Record<string, unknown> {
  return {
    ...buildBaseMetadata(args, normalized),
    truncated: false,
    limit_reached: false,
    timed_out: false,
    cancelled: false,
    retry_count: 0,
    exit_code: undefined,
    error: error instanceof Error ? error.message : String(error),
    error_stage: stage,
  };
}

async function emitMetadataSafely(
  ctx: {
    metadata: (payload: {
      title: string;
      metadata: Record<string, unknown>;
    }) => Promise<unknown> | unknown;
  },
  title: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  try {
    await ctx.metadata({ title, metadata });
    return true;
  } catch {
    return false;
  }
}

export function createGrepTool(
  pluginCtx: PluginInput,
  options: CreateGrepToolOptions = {},
): ToolDefinition {
  const run = options.run ?? runRipgrep;
  const argsSchema = grepArgsSchema as Parameters<typeof tool>[0]['args'];

  return tool({
    description: GREP_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const rawArgs = args as unknown as GrepToolInput;
      let normalized: NormalizedGrepInput | undefined;
      let stage: 'normalize' | 'permission' | 'execution' = 'normalize';

      try {
        normalized = normalizeGrepInput(rawArgs, ctx, pluginCtx);
        stage = 'permission';

        await ctx.ask({
          permission: GREP_TOOL_ID,
          patterns: normalized.permissionPatterns,
          always: normalized.permissionPatterns,
          metadata: buildBaseMetadata(rawArgs, normalized),
        });

        stage = 'execution';
        const result = await run(normalized, ctx.abort);
        const output = formatGrepResult(normalized, result);

        await emitMetadataSafely(
          ctx,
          getTitle(rawArgs, normalized),
          buildResultMetadata(rawArgs, normalized, result),
        );

        return output;
      } catch (error) {
        await emitMetadataSafely(
          ctx,
          getTitle(rawArgs, normalized),
          buildFailureMetadata(rawArgs, stage, error, normalized),
        );
        throw error;
      }
    },
  });
}
