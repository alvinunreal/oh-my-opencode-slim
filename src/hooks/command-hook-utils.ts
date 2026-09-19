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

/**
 * Canonical delivery handoff contract shared by the `/deepwork` and `/loop`
 * user-entry adapters. The parent/orchestrator owns protocol coordination;
 * slash commands only hand off user context and point at the protocol.
 */
export const DELIVERY_HANDOFF_CONTRACT = [
  'Delivery unit packet (factual, for the parent):',
  '- delivery unit ID and plan version;',
  '- scope, exclusions, and dependencies;',
  '- proof commands and prerequisites;',
  '- Tier-2 authority, if applicable;',
  '- attempt count and any prior failure;',
  '- factual context: local evidence, external sources (URL + ref +',
  '  retrieval time), and stated uncertainty.',
  '',
  'Delivery order:',
  'Fixer delivery -> planned proof -> one implementation Reviewer',
  'review -> at most two repairs with affected proof ->',
  'parent acceptance.',
  '',
  'Slash commands are user-entry adapters. They do not',
  'programmatically dispatch tasks or receive typed return objects.',
  'The parent/orchestrator coordinates the protocol.',
].join('\n');
