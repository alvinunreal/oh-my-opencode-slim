/** Correlate a no-route failure with the input that started its turn. */
export function noRouteOutcomeID(inputID: string, message: string): string {
  return `no-route:${JSON.stringify([inputID, message])}`;
}

export function isNoRouteAnchor(type: unknown, status: unknown): boolean {
  return (
    type === 'user' ||
    type === 'synthetic' ||
    (type === 'compaction' && status === 'completed')
  );
}

export function noRouteModel(message: string): string | undefined {
  return (
    /^Model unavailable: (.+?)(?:\. This provider has been deprecated;.*)?$/.exec(
      message,
    )?.[1] ??
    /^(?:Variant unavailable for |Unsupported package for |Cannot initialize )(.+?): /.exec(
      message,
    )?.[1]
  );
}
