export const DEDUP_WINDOW_MS = 5_000;

export function asHttpStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 100 && value <= 599 ? value : undefined;
  }
  if (typeof value === 'string' && /^\d{3}$/.test(value)) {
    const parsed = Number(value);
    return parsed >= 100 && parsed <= 599 ? parsed : undefined;
  }
  return undefined;
}
