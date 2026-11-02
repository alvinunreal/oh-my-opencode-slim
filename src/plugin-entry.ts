export const INSTALLER_MANAGED_PLUGIN_OPTION =
  '__ohMyOpencodeSlimManagedByInstaller';

export type PluginEntry =
  | string
  | [string, Record<string, unknown>, ...unknown[]];

export function getPlugins(config: {
  plugin?: unknown;
  plugins?: unknown;
}): unknown[] {
  return [
    ...(Array.isArray(config.plugin) ? config.plugin : []),
    ...(Array.isArray(config.plugins) ? config.plugins : []),
  ];
}

export function getPluginSpec(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  const spec = Array.isArray(entry)
    ? entry[0]
    : entry && typeof entry === 'object'
      ? (entry as { package?: unknown }).package
      : undefined;
  return typeof spec === 'string' ? spec : undefined;
}
