/**
 * Register a command hook in the OpenCode config if it doesn't already exist.
 * Returns true if the command was registered, false if it already existed.
 */
export function registerCommandHook(
  opencodeConfig: Record<string, unknown>,
  commandName: string,
  template: string,
  description: string,
): boolean {
  const cmdConfig = (opencodeConfig as { command?: Record<string, unknown> })
    .command;
  if (cmdConfig?.[commandName]) return false;
  if (!opencodeConfig.command)
    (opencodeConfig as Record<string, unknown>).command = {};
  (
    (opencodeConfig as Record<string, unknown>).command as Record<
      string,
      unknown
    >
  )[commandName] = { template, description };
  return true;
}
