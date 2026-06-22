const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const PLUGIN_DISABLE_ENV = 'OH_MY_OPENCODE_SLIM_DISABLE';

export function isTruthyEnvValue(value: string | undefined): boolean {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? '');
}

export function isPluginDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTruthyEnvValue(env[PLUGIN_DISABLE_ENV]);
}
