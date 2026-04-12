import type { PluginInput } from '@opencode-ai/plugin';

import { log } from '../../utils/logger';
import {
  createApplyPatchInternalError,
  getApplyPatchErrorDetails,
  isApplyPatchError,
  isApplyPatchVerificationError,
} from './errors';
import { rewritePatch } from './operations';
import type { ApplyPatchRuntimeOptions } from './types';

const APPLY_PATCH_RESCUE_OPTIONS: ApplyPatchRuntimeOptions = {
  prefixSuffix: true,
  lcsRescue: true,
};

interface ToolExecuteBeforeInput {
  tool: string;
  directory?: string;
}

interface ToolExecuteBeforeOutput {
  args?: {
    patchText?: unknown;
    [key: string]: unknown;
  };
}

export function createApplyPatchHook(ctx: PluginInput) {
  function logHookStatus(
    state:
      | 'rewrite'
      | 'unchanged'
      | 'blocked'
      | 'validation'
      | 'verification'
      | 'internal',
    data?: Record<string, unknown>,
  ) {
    log(`apply-patch hook ${state}`, data);
  }

  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (input.tool !== 'apply_patch') {
        return;
      }

      if (typeof output.args?.patchText !== 'string') {
        return;
      }

      const root = input.directory || ctx.directory || process.cwd();
      const worktree = ctx.worktree || root;

      try {
        const result = await rewritePatch(
          root,
          output.args.patchText,
          APPLY_PATCH_RESCUE_OPTIONS,
          worktree,
        );

        if (result.changed) {
          output.args.patchText = result.patchText;
          logHookStatus('rewrite', {
            rewrittenChunks: result.rewrittenChunks,
            totalChunks: result.totalChunks,
            strategies: result.rewriteModes,
          });
          return;
        }

        logHookStatus('unchanged', {
          rewrittenChunks: 0,
          totalChunks: result.totalChunks,
        });
        return;
      } catch (error) {
        const normalizedError = isApplyPatchError(error)
          ? error
          : createApplyPatchInternalError(
              `Unexpected hook failure before native apply: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
        const details = getApplyPatchErrorDetails(normalizedError);

        logHookStatus(
          isApplyPatchVerificationError(normalizedError)
            ? 'verification'
            : normalizedError.kind === 'validation'
              ? 'validation'
              : normalizedError.kind === 'internal'
                ? 'internal'
                : 'blocked',
          {
            kind: details?.kind ?? 'internal',
            code: details?.code ?? 'internal_unexpected',
            reason: normalizedError.message,
            failOpen: false,
            rescueOptions: APPLY_PATCH_RESCUE_OPTIONS,
            rewriteStage: 'before-native',
          },
        );
        throw normalizedError;
      }
    },
  };
}
