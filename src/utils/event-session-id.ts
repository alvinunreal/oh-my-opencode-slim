/** Mapped message events carry a message ID as well as the session ID. */
export function resolveEventSessionID(event: {
  type: string;
  properties?: {
    info?: { id?: string; sessionID?: string };
    sessionID?: string;
  };
}): string | undefined {
  const info = event.properties?.info;
  if (
    event.type === 'message.updated' ||
    event.type === 'step-finish' ||
    event.type === 'message.part.updated'
  ) {
    return info?.sessionID ?? event.properties?.sessionID;
  }
  return info?.id ?? event.properties?.sessionID;
}
