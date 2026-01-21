import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PluginConfigSchema, type PluginConfig } from "./schema";

function getUserConfigDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function loadConfigFromPath(configPath: string): PluginConfig | null {
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const rawConfig = JSON.parse(content);
      const result = PluginConfigSchema.safeParse(rawConfig);
      
      if (!result.success) {
        return null;
      }
      
      return result.data;
    }
  } catch {
    // Silently ignore config loading errors
  }
  return null;
}

function deepMerge<T extends Record<string, unknown>>(base?: T, override?: T): T | undefined {
  if (!base) return override;
  if (!override) return base;
  
  const result = { ...base } as T;
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];
    
    if (
      typeof baseVal === "object" && baseVal !== null &&
      typeof overrideVal === "object" && overrideVal !== null &&
      !Array.isArray(baseVal) && !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      ) as T[keyof T];
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

export function loadPluginConfig(directory: string): PluginConfig {
  const userConfigPath = path.join(
    getUserConfigDir(),
    "opencode",
    "oh-my-opencode-slim.json"
  );
  
  const projectConfigPath = path.join(directory, ".opencode", "oh-my-opencode-slim.json");

  let config: PluginConfig = loadConfigFromPath(userConfigPath) ?? {};
  
  const projectConfig = loadConfigFromPath(projectConfigPath);
  if (projectConfig) {
    config = {
      ...config,
      ...projectConfig,
      agents: deepMerge(config.agents, projectConfig.agents),
      tmux: deepMerge(config.tmux, projectConfig.tmux),
      disabled_agents: [
        ...new Set([
          ...(config.disabled_agents ?? []),
          ...(projectConfig.disabled_agents ?? []),
        ]),
      ],
    };
  }

  return config;
}
