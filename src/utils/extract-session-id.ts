export function extractSessionId(
  info: { id?: string } | undefined | null,
  sessionID: string | undefined | null,
): string | undefined {
  // ponytail: ?? undefined converts null to undefined for TS strict mode
  return info?.id ?? sessionID ?? undefined;
}
