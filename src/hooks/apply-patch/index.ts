import type { PluginInput } from '@opencode-ai/plugin';

import { log } from '../../utils/logger';
import { ensureApplyPatchError } from './errors';
import { rewritePatch } from './rewrite';

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
  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      // v1 hosts name the native patch tool `apply_patch`; v2 names it
      // `patch` (same `{ patchText }` input shape).
      if (input.tool !== 'apply_patch' && input.tool !== 'patch') {
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
          worktree,
          input.tool === 'patch' ? 'v2' : 'v1',
        );

        if (result.changed) {
          args.patchText = result.patchText;
          log('apply-patch hook rewrite');
          return;
        }

        log('apply-patch hook unchanged');
        return;
      } catch (error) {
        const normalizedError = ensureApplyPatchError(
          error,
          'Unexpected hook failure before native apply',
        );

        // Code derives from kind. A new blocked reason needs its own code to
        // remain fail-closed rather than inheriting this outside-workspace gate.
        if (normalizedError.code === 'outside_workspace') {
          log('apply-patch hook skipped', {
            kind: normalizedError.kind,
            code: normalizedError.code,
            reason: normalizedError.message,
            failOpen: true,
            rewriteStage: 'before-native',
          });
          return;
        }

        log(`apply-patch hook ${normalizedError.kind}`, {
          kind: normalizedError.kind,
          code: normalizedError.code,
          reason: normalizedError.message,
          failOpen: false,
          rewriteStage: 'before-native',
        });
        throw normalizedError;
      }
    },
  };
}
