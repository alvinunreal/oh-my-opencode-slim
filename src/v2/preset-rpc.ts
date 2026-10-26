import { z } from 'zod';

const state = z.object({
  sessionID: z.string(),
  status: z.enum(['bound', 'unbound', 'initializing', 'transitioning']),
  presetName: z.string().nullable(),
  affects: z.literal('future-delegations'),
  team: z
    .object({
      agentModels: z.record(z.string(), z.string()),
      agentVariants: z.record(z.string(), z.string()),
      inheritance: z.record(z.string(), z.enum(['session', 'orchestrator'])),
    })
    .optional(),
  executionPresetName: z.string().nullable().optional(),
  pending: z
    .object({
      kind: z.enum(['createBound', 'transition']),
      operationID: z.string(),
      presetName: z.string().nullable(),
    })
    .optional(),
});

/** Shared portable server/TUI contract. No method writes configuration files
 * or sends a prompt; retry completes only the frozen pending operation. */
export const sessionPresetRpc = {
  id: 'oh-my-opencode-slim.session-preset.v2',
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
    createBound: {
      input: z
        .object({
          sessionID: z.string().min(1),
          operationID: z.string().min(1),
          presetName: z.string().min(1),
          agent: z.string().min(1),
          model: z
            .object({
              providerID: z.string().min(1),
              id: z.string().min(1),
              variant: z.string().optional(),
            })
            .strict(),
        })
        .strict(),
      output: state,
    },
    retry: {
      input: z
        .object({
          sessionID: z.string().min(1),
          operationID: z.string().min(1),
        })
        .strict(),
      output: state,
    },
  },
  events: {},
} as const;

export type { SessionPresetState } from './session-presets';
