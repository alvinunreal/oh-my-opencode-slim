import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';
import type { V2Context, V2SessionPresetRpcHandlers } from './types';

const state = z.object({
  sessionID: z.string(),
  status: z.enum(['bound', 'unbound']),
  presetName: z.string().nullable(),
  selection: z.enum(['explicit', 'default']).optional(),
  affects: z.literal('future-children-only'),
  team: z
    .object({
      agentModels: z.record(z.string(), z.string()),
      agentVariants: z.record(z.string(), z.string()),
      inheritance: z.record(z.string(), z.enum(['session', 'orchestrator'])),
    })
    .optional(),
});

/** Shared server/TUI contract. Call context.client.rpc(sessionPresetRpc).
 * No method writes config or changes the session's native model. */
export const sessionPresetRpc = Rpc.define({
  id: 'oh-my-opencode-slim.session-preset.v1',
  methods: {
    read: {
      input: z.object({ sessionID: z.string().min(1) }).strict(),
      output: state,
      errors: { session_location_mismatch: z.null() },
    },
    apply: {
      input: z
        .object({ sessionID: z.string().min(1), presetName: z.string().min(1) })
        .strict(),
      output: state,
    },
  },
  events: {},
});

export class SessionPresetLocationMismatch extends Error {}

export function registerSessionPresetRpc(
  rpc: NonNullable<V2Context['rpc']>,
  handlers: {
    read: (
      input: z.output<typeof sessionPresetRpc.methods.read.input>,
    ) => Promise<z.input<typeof state>>;
    apply: V2SessionPresetRpcHandlers['apply'];
  },
): ReturnType<NonNullable<V2Context['rpc']>['register']> {
  return rpc.register(sessionPresetRpc, {
    apply: handlers.apply,
    read: async (input, context) => {
      try {
        return await handlers.read(input);
      } catch (error) {
        if (!(error instanceof SessionPresetLocationMismatch)) throw error;
        return context.error('session_location_mismatch', error.message, null);
      }
    },
  });
}

export type { SessionPresetState } from './session-presets';
