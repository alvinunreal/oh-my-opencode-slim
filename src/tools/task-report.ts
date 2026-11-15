import { randomUUID } from 'node:crypto';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { isRecord } from '../utils/guards';
import {
  INTERNAL_INITIATOR_METADATA_KEY,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../utils/internal-initiator';
import type { ExperimentalV2 } from '../v2/client-shim';
import {
  createInternalSyntheticMessageID,
  recordInternalAdmission,
} from '../v2/internal-admissions';

const z = tool.schema;
const MAX_REPORT_LENGTH = 2000;

/** exact2.3 may return a stale same-id record; confirm the payload is ours. */
function assertNativeSyntheticAdmitted(
  result: unknown,
  id: string,
  sessionID: string,
  text: string,
  description: string,
): void {
  const payload = isRecord(result) ? result.payload : undefined;
  if (
    !isRecord(result) ||
    result.id !== id ||
    result.sessionID !== sessionID ||
    result.type !== 'synthetic' ||
    result.delivery !== 'queue' ||
    !isRecord(payload) ||
    payload.text !== text ||
    payload.description !== description ||
    !isRecord(payload.metadata) ||
    payload.metadata[INTERNAL_INITIATOR_METADATA_KEY] !== true
  ) {
    throw new Error('The parent session did not accept the report');
  }
}

export function createTaskReportTool(options: {
  input: PluginInput;
  isDisposed?: () => boolean;
}): Record<'task_report', ToolDefinition> {
  const task_report = tool({
    description:
      'Queue a bounded progress update or blocker for the calling child’s verified parent. The host does not wake the parent; processing is not confirmed.',
    args: {
      kind: z
        .enum(['progress', 'escalation'])
        .describe(
          'Use progress for a material update; escalation for a blocker or decision.',
        ),
      message: z
        .string()
        .trim()
        .min(1)
        .max(MAX_REPORT_LENGTH)
        .describe(
          `Update for the parent (max ${MAX_REPORT_LENGTH} characters)`,
        ),
    },
    async execute(args, toolContext) {
      if (options.isDisposed?.()) throw new Error('Plugin is disposing');
      const childSessionID = toolContext?.sessionID;
      if (!childSessionID) {
        throw new Error('task_report requires a subagent session');
      }

      const session = (
        options.input as PluginInput & { experimental_v2?: ExperimentalV2 }
      ).experimental_v2?.session;
      if (
        !session ||
        typeof session.get !== 'function' ||
        typeof session.synthetic !== 'function'
      ) {
        throw new Error(
          'task_report requires the native v2 session.get and session.synthetic capabilities',
        );
      }

      const child = await session.get({ sessionID: childSessionID });
      if (options.isDisposed?.()) throw new Error('Plugin is disposing');

      if (
        !isRecord(child) ||
        child.id !== childSessionID ||
        typeof child.agent !== 'string'
      ) {
        throw new Error('Could not verify the calling subagent session');
      }
      const agent = child.agent;
      const parentID = child.parentID;
      if (typeof parentID !== 'string' || !parentID) {
        throw new Error('task_report is only available in a child session');
      }

      const updateID = randomUUID();
      const message = [
        `<subagent-update id="${updateID}" kind="${args.kind}">`,
        `From @${agent} (session ${childSessionID}):`,
        args.message.trim(),
        '</subagent-update>',
      ].join('\n');
      const text = `${message}\n${SLIM_INTERNAL_INITIATOR_MARKER}`;
      const description = 'oh-my-opencode-slim internal initiator';

      if (options.isDisposed?.()) throw new Error('Plugin is disposing');

      // exact2.3: record before admission, host validates the parent.
      const id = createInternalSyntheticMessageID();
      recordInternalAdmission(parentID, id);
      const admitted = await session.synthetic({
        sessionID: parentID,
        id,
        text,
        description,
        metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
        delivery: 'queue',
        resume: false,
      });
      assertNativeSyntheticAdmitted(admitted, id, parentID, text, description);

      return `Update ${updateID} queued for the parent without waking it. The host accepted the update; processing is not confirmed.`;
    },
  });

  return { task_report };
}
