export const INSTALLER_MANAGED_PLUGIN_OPTION =
  '__ohMyOpencodeSlimManagedByInstaller';

export type PluginEntry =
  | string
  | [string, Record<string, unknown>, ...unknown[]];
