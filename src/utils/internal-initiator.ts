import { isRecord } from './guards';
import { parseTaskStatusOutput } from './task';

export const SLIM_INTERNAL_INITIATOR_MARKER =
  '<!-- SLIM_INTERNAL_INITIATOR -->';

export const INTERNAL_INITIATOR_METADATA_KEY =
  'oh-my-opencode-slim.internalInitiator';

/**
 * OpenCode v1's native background-task notifier submits an untagged
 * synthetic user message when a child finishes. It is still an internal
 * lifecycle continuation, and treating it as external would overwrite the
 * parent's live fallback model with the agent's configured primary.
 */
export function isNativeBackgroundTaskNotification(part: unknown): boolean {
  if (
    !isRecord(part) ||
    part.type !== 'text' ||
    part.synthetic !== true ||
    typeof part.text !== 'string'
  ) {
    return false;
  }

  const status = parseTaskStatusOutput(part.text);
  if (status?.state === 'completed') {
    return (
      part.text.includes('<summary>Background task completed: ') &&
      part.text.includes('<task_result>') &&
      part.text.includes('</task_result>')
    );
  }
  if (status?.state === 'error') {
    return (
      part.text.includes('<summary>Background task failed: ') &&
      part.text.includes('<task_error>') &&
      part.text.includes('</task_error>')
    );
  }
  return false;
}

export function createInternalAgentTextPart(
  text: string,
  extraMetadata?: Record<string, unknown>,
): {
  type: 'text';
  text: string;
  synthetic: true;
  metadata: Record<string, unknown>;
} {
  return {
    type: 'text',
    synthetic: true,
    text: `${text}\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
    metadata: {
      [INTERNAL_INITIATOR_METADATA_KEY]: true,
      ...extraMetadata,
    },
  };
}

export function isInternalInitiatorPart(part: unknown): boolean {
  if (!isRecord(part) || part.type !== 'text') {
    return false;
  }

  if (part.synthetic !== true || !isRecord(part.metadata)) {
    return false;
  }

  return (
    part.metadata[INTERNAL_INITIATOR_METADATA_KEY] === true ||
    // OpenCode's compaction continuation emits compaction_continue: true
    // instead of our internal initiator key; treat it as internal to
    // prevent board injection on the continuation turn (#922).
    // Upstream key is not a stable plugin contract — graceful degradation
    // if renamed: injection resumes, loop returns, no crash.
    part.metadata.compaction_continue === true
  );
}
