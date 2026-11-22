import { Rpc } from '@opencode/plugin/rpc';
import { z } from 'zod';

const state = z.object({
  sessionID: z.string(),
  status: z.enum(['bound', 'unbound']),
  presetName: z.string().nullable(),
  selection: z.enum(['explicit', 'default']).optional(),
  affects: z.literal('future-children-only'),
  root: z
    .object({
      model: z.string(),
      variant: z.string().optional(),
      forced: z.boolean(),
    })
    .optional(),
  rootForce: z
    .union([
      z.object({ outcome: z.literal('switched'), model: z.string() }),
      z.object({ outcome: z.literal('no-orchestrator-model') }),
    ])
    .optional(),
  team: z
    .object({
      agentModels: z.record(z.string(), z.string()),
      agentVariants: z.record(z.string(), z.string()),
      inheritance: z.record(z.string(), z.enum(['session', 'orchestrator'])),
    })
    .optional(),
});

/** Shared server/TUI contract. Call context.client.rpc(sessionPresetRpc).
 * No method writes config or changes the session's native model — except
 * `apply` with `forceOrchestrator`, which switches the invoking root
 * session's model per ADR-005. */
export const sessionPresetRpc = Rpc.define({
  id: 'oh-my-opencode-slim.session-preset.v1',
  methods: {
    read: {
      input: z.object({ sessionID: z.string().min(1) }).strict(),
      output: state,
    },
    apply: {
      input: z
        .object({
          sessionID: z.string().min(1),
          presetName: z.string().min(1),
          forceOrchestrator: z.boolean().optional(),
        })
        .strict(),
      output: state,
    },
  },
  events: {},
});

export type { SessionPresetState } from './session-presets';
