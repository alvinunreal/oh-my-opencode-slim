export function getEnv(name: string): string | undefined {
  const bunValue = (globalThis as { Bun?: { env?: Record<string, string> } })
    .Bun?.env?.[name];
  if (typeof bunValue === 'string' && bunValue.length > 0) return bunValue;

  const processValue = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.[name];
  return typeof processValue === 'string' && processValue.length > 0
    ? processValue
    : undefined;
}
