/**
 * Shared type guard: checks if a value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
