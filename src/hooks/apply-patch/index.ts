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
      | 'skipped'
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

      const args = output.args;
      if (!args || typeof args.patchText !== 'string') {
        return;
      }
      const patchText = args.patchText;

      const root = input.directory || ctx.directory || process.cwd();
      const worktree = ctx.worktree || root;
      try {
        const result = await rewritePatch(
          root,
          patchText,
          APPLY_PATCH_RESCUE_OPTIONS,
          worktree,
        );

        if (result.changed) {
          args.patchText = result.patchText;
          logHookStatus('rewrite');
          return;
        }

        logHookStatus('unchanged');
        return;
      } catch (error) {
        const normalizedError = isApplyPatchError(error)
          ? error
          : createApplyPatchInternalError(
              `Unexpected hook failure before native apply: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
        const details = getApplyPatchErrorDetails(normalizedError);

        if (
          normalizedError.kind === 'blocked' &&
          // Only the plugin-side outside-workspace preflight should fail open.
          // Keep the code check explicit so any future blocked error remains
          // fail-closed by default.
          details?.code === 'outside_workspace'
        ) {
          logHookStatus('skipped', {
            kind: details.kind,
            code: details.code,
            reason: normalizedError.message,
            failOpen: true,
            rescueOptions: APPLY_PATCH_RESCUE_OPTIONS,
            rewriteStage: 'before-native',
          });
          return;
        }

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
