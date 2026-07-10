import * as fs from 'node:fs';
import { z } from 'zod';
import { findPluginConfigPaths, mergePluginConfigs } from '../config/loader';
import { type PluginConfig, PluginConfigSchema } from '../config/schema';
import { stripJsonComments } from './config-io';

export type DoctorArgs = {
  json?: boolean;
  error?: string;
  help?: boolean;
};

export function parseDoctorArgs(args: string[]): DoctorArgs {
  const result: DoctorArgs = {};

  for (const arg of args) {
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      result.error ??= `Unknown doctor option: ${arg}`;
    }
  }

  return result;
}

export type ConfigCheckResult = {
  scope: 'user' | 'project';
  path: string | null;
  exists: boolean;
  ok: boolean;
  config?: PluginConfig;
  error?: {
    kind: 'invalid-json' | 'invalid-schema' | 'read-error';
    message: string;
    issues?: z.ZodIssue[];
  };
};

export type PresetCheckResult = {
  preset: string;
  ok: boolean;
  error?: { kind: 'missing-preset'; message: string };
};

export type DoctorResult = {
  ok: boolean;
  project: string;
  configs: ConfigCheckResult[];
  presetCheck?: PresetCheckResult;
};

function checkConfigFile(
  scope: 'user' | 'project',
  configPath: string | null,
): ConfigCheckResult {
  if (configPath === null) {
    return { scope, path: null, exists: false, ok: true };
  }

  try {
    const stat = fs.statSync(configPath);

    if (stat.size === 0) {
      return {
        scope,
        path: configPath,
        exists: true,
        ok: false,
        error: {
          kind: 'invalid-json',
          message: 'Empty file is not valid JSON',
        },
      };
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(stripJsonComments(content));
    const parseResult = PluginConfigSchema.safeParse(rawConfig);

    if (!parseResult.success) {
      return {
        scope,
        path: configPath,
        exists: true,
        ok: false,
        error: {
          kind: 'invalid-schema',
          message: z.prettifyError(parseResult.error),
          issues: parseResult.error.issues,
        },
      };
    }

    return {
      scope,
      path: configPath,
      exists: true,
      ok: true,
      config: parseResult.data,
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        scope,
        path: configPath,
        exists: true,
        ok: false,
        error: {
          kind: 'invalid-json',
          message: err.message,
        },
      };
    } else if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return {
        scope,
        path: configPath,
        exists: false,
        ok: false,
        error: {
          kind: 'read-error',
          message: 'File was not found while reading',
        },
      };
    }

    return {
      scope,
      path: configPath,
      exists: true,
      ok: false,
      error: {
        kind: 'read-error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function checkPreset(
  mergedConfig: PluginConfig,
): PresetCheckResult | undefined {
  const envPreset = process.env.OH_MY_OPENCODE_SLIM_PRESET;
  const presetName = envPreset || mergedConfig.preset;

  if (presetName === undefined) {
    return undefined;
  }

  if (!mergedConfig.presets?.[presetName]) {
    return {
      preset: presetName,
      ok: false,
      error: {
        kind: 'missing-preset',
        message: `Preset "${presetName}" not found in config`,
      },
    };
  }

  return { preset: presetName, ok: true };
}

function getMergedConfig(
  userConfig?: PluginConfig,
  projectConfig?: PluginConfig,
): PluginConfig {
  return projectConfig
    ? mergePluginConfigs(userConfig ?? {}, projectConfig)
    : (userConfig ?? {});
}

export function runDoctorCheck(cwd: string): DoctorResult {
  const { userConfigPath, projectConfigPath } = findPluginConfigPaths(cwd);

  const userCheck = checkConfigFile('user', userConfigPath);
  const projectCheck = checkConfigFile('project', projectConfigPath);

  const configs = [userCheck, projectCheck];

  const hasInvalidConfig = configs.some((c) => !c.ok);

  let presetCheckResult: DoctorResult['presetCheck'] | undefined;
  if (!hasInvalidConfig) {
    const mergedConfig = getMergedConfig(userCheck.config, projectCheck.config);
    presetCheckResult = checkPreset(mergedConfig);
  }

  return {
    ok:
      configs.every((c) => c.ok) &&
      (!presetCheckResult || presetCheckResult.ok),
    project: cwd,
    configs,
    presetCheck: presetCheckResult,
  };
}

export function formatHumanDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];

  lines.push(`Project: ${result.project}`);
  lines.push('');

  for (const config of result.configs) {
    if (config.path === null) {
      lines.push(`[${config.scope}] No config file found`);
    } else {
      const status = config.ok ? '✓' : '✗';
      lines.push(`[${config.scope}] ${config.path} ${status}`);

      if (!config.ok && config.error) {
        if (config.error.kind === 'invalid-json') {
          lines.push(`  Invalid JSON: ${config.error.message}`);
        } else if (config.error.kind === 'invalid-schema') {
          lines.push('  Schema error:');
          for (const line of config.error.message.split('\n')) {
            lines.push(`  ${line}`);
          }
        } else if (config.error.kind === 'read-error') {
          lines.push(`  Read error: ${config.error.message}`);
        }
      }
    }
  }

  if (result.presetCheck) {
    lines.push('');
    const status = result.presetCheck.ok ? '✓' : '✗';
    lines.push(`[preset] ${result.presetCheck.preset} ${status}`);

    if (result.presetCheck.error) {
      lines.push(`  ${result.presetCheck.error.message}`);
    }
  }

  return lines.join('\n');
}

export function formatJsonDoctorResult(result: DoctorResult): string {
  return JSON.stringify(
    {
      ...result,
      configs: result.configs.map(({ config: _config, ...config }) => config),
    },
    null,
    2,
  );
}

export async function doctor(args: DoctorArgs): Promise<number> {
  if (args.help) {
    console.log(`Usage: oh-my-opencode-ultraslim doctor [OPTIONS]

Options:
  --json              Print diagnostics as JSON
  -h, --help          Show this help message`);
    return 0;
  }

  if (args.error) {
    console.error(args.error);
    return 1;
  }

  const result = runDoctorCheck(process.cwd());

  if (args.json) {
    console.log(formatJsonDoctorResult(result));
  } else {
    console.log(formatHumanDoctorResult(result));
  }

  return result.ok ? 0 : 1;
}
