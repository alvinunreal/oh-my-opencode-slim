import { isRecord } from './guards';

export const SLIM_INTERNAL_INITIATOR_MARKER =
  '<!-- SLIM_INTERNAL_INITIATOR -->';

export const INTERNAL_INITIATOR_METADATA_KEY =
  'oh-my-opencode-slim.internalInitiator';

export function createInternalAgentTextPart(text: string): {
  type: 'text';
  text: string;
  synthetic: true;
  metadata: { 'oh-my-opencode-slim.internalInitiator': true };
} {
  return {
    type: 'text',
    synthetic: true,
    text: `${text}\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
    metadata: { [INTERNAL_INITIATOR_METADATA_KEY]: true },
  } as const;
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
