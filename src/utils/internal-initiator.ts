export const SLIM_INTERNAL_INITIATOR_MARKER =
  '<!-- SLIM_INTERNAL_INITIATOR -->';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createInternalAgentTextPart(text: string): {
  type: 'text';
  text: string;
} {
  return {
    type: 'text',
    text: `${text}\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
  };
}

export function hasInternalInitiatorMarker(part: unknown): boolean {
  if (!isRecord(part) || part.type !== 'text') {
    return false;
  }

  if (typeof part.text !== 'string') {
    return false;
  }

  return part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER);
}
