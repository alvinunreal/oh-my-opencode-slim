import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

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
    },
    apply: {
      input: z
        .object({ sessionID: z.string().min(1), presetName: z.string().min(1) })
        .strict(),
      output: state,
    },
    unbind: {
      input: z.object({ sessionID: z.string().min(1) }).strict(),
      output: state,
    },
    createBound: {
      input: z.object({ presetName: z.string().min(1) }).strict(),
      output: state,
      errors: { create_failed: z.null() },
    },
  },
  events: {},
});

export type { SessionPresetState } from './session-presets';
