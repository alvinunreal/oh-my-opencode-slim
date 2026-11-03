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

// shortcut: v2 exposes only error text here, use structured errors if the host adds them.
export function isNoRouteFailureMessage(message: string): boolean {
  return /^(?:Model unavailable: |Variant unavailable for |Unsupported package for |Cannot initialize |No model is available for session )/.test(
    message,
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
