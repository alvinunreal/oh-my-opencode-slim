import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { InterviewAssistantState } from '../interview/types';

const z = tool.schema;

export interface InterviewSubmitStateResult {
  ok: boolean;
  /** Short acknowledgement, or `⎔ Interview state rejected: <reason>`. */
  message: string;
}

/** Minimal service surface the tool needs. Kept structural so both the v1
 * interview manager service and the v2 bridge service satisfy it. */
export interface InterviewSubmitStateService {
  getActiveInterviewId: (sessionID: string) => string | null;
  submitState: (
    sessionID: string,
    state: InterviewAssistantState,
    messageID?: string,
  ) => Promise<InterviewSubmitStateResult>;
}

interface InterviewSubmitStateToolOptions {
  /** Resolved lazily so the v2 bridge can swap in its own service. */
  service: () => InterviewSubmitStateService;
  /** Configured `interview.maxQuestions`; caps the questions arg. */
  maxQuestions?: number;
}

const MIN_QUESTIONS = 1;
const DEFAULT_MAX_QUESTIONS = 2;

/**
 * Persist interview state through a plugin tool call instead of visible
 * assistant text. The single object arg keeps the generic TUI tool row free
 * of the spec/patch payload: object args are omitted by the TUI.
 */
export function createInterviewSubmitStateTool(
  options: InterviewSubmitStateToolOptions,
): Record<'interview_submit_state', ToolDefinition> {
  const maxQuestions = Math.max(
    MIN_QUESTIONS,
    options.maxQuestions ?? DEFAULT_MAX_QUESTIONS,
  );

  const interview_submit_state = tool({
    description: `Submit the current interview state. Call this exactly once per interview turn with the full specification (kickoff) or a one-line status plus unified diff (later turns), and up to ${maxQuestions} questions. Do not print an <interview_state> block or any other prose.`,
    args: {
      state: z.object({
        title: z
          .string()
          .optional()
          .describe('Concise kebab-case title for the filename (kickoff only)'),
        summary: z
          .string()
          .describe(
            'Full specification on the kickoff turn; a one-line status afterwards',
          ),
        patch: z
          .string()
          .optional()
          .describe('Unified diff against the current spec body only'),
        questions: z
          .array(
            z.object({
              id: z.string(),
              question: z.string(),
              options: z.array(z.string()).optional(),
              suggested: z.string().optional(),
            }),
          )
          .max(maxQuestions),
      }),
    },
    async execute(args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) {
        return '⎔ Interview state rejected: missing session';
      }
      const service = options.service();
      if (!service.getActiveInterviewId(sessionID)) {
        return '⎔ Interview state rejected: no active interview';
      }
      const state = args.state as InterviewAssistantState;
      const result = await service.submitState(
        sessionID,
        state,
        toolContext?.messageID,
      );
      return result.message;
    },
  });

  return { interview_submit_state };
}
