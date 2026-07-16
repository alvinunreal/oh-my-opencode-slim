type EventInput = {
  event: {
    type: string;
    properties?: { info?: { id?: string }; sessionID?: string };
  };
};

/**
 * Invalidate task continuations before multiplexer event handling and disposal
 * cleanup.
 */
export async function handleTaskSessionEvent(
  input: EventInput,
  invalidateTaskSessions: (input: EventInput) => Promise<void>,
  handleMultiplexerEvent: () => Promise<void>,
  cleanupInstance: () => Promise<void>,
): Promise<void> {
  await invalidateTaskSessions(input);
  await handleMultiplexerEvent();

  if (input.event.type === 'server.instance.disposed') {
    await cleanupInstance();
  }
}
