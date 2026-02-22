import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  ensureConfigDir,
  getConfigDir,
  getExistingConfigPath,
  getLiteConfig,
} from './paths';
import { generateLiteConfig } from './providers';
import type {
  ConfigMergeResult,
  DetectedConfig,
  InstallConfig,
  OpenCodeConfig,
} from './types';

const PACKAGE_NAME = 'oh-my-opencode-slim';

/**
 * Strip JSON comments (single-line // and multi-line) and trailing commas for JSONC support.
 */
export function stripJsonComments(json: string): string {
  const commentPattern = /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g;
  const trailingCommaPattern = /\\"|"(?:\\"|[^"])*"|(,)(\s*[}\]])/g;

  return json
    .replace(commentPattern, (match, commentGroup) =>
      commentGroup ? '' : match,
    )
    .replace(trailingCommaPattern, (match, comma, closing) =>
      comma ? closing : match,
    );
}

export function parseConfigFile(path: string): {
  config: OpenCodeConfig | null;
  error?: string;
} {
  try {
    if (!existsSync(path)) return { config: null };
    const stat = statSync(path);
    if (stat.size === 0) return { config: null };
    const content = readFileSync(path, 'utf-8');
    if (content.trim().length === 0) return { config: null };
    return { config: JSON.parse(stripJsonComments(content)) as OpenCodeConfig };
  } catch (err) {
    return { config: null, error: String(err) };
  }
}

export function parseConfig(path: string): {
  config: OpenCodeConfig | null;
  error?: string;
} {
  const result = parseConfigFile(path);
  if (result.config || result.error) return result;

  if (path.endsWith('.json')) {
    const jsoncPath = path.replace(/\.json$/, '.jsonc');
    return parseConfigFile(jsoncPath);
  }
  return { config: null };
}

/**
 * Write config to file atomically.
 */
export function writeConfig(configPath: string, config: OpenCodeConfig): void {
  if (configPath.endsWith('.jsonc')) {
    console.warn(
      '[config-manager] Writing to .jsonc file - comments will not be preserved',
    );
  }

  const tmpPath = `${configPath}.tmp`;
  const bakPath = `${configPath}.bak`;
  const content = `${JSON.stringify(config, null, 2)}\n`;

  // Backup existing config if it exists
  if (existsSync(configPath)) {
    copyFileSync(configPath, bakPath);
  }

  // Atomic write pattern: write to tmp, then rename
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, configPath);
}

export async function addPluginToOpenCodeConfig(): Promise<ConfigMergeResult> {
  try {
    ensureConfigDir();
  } catch (err) {
    return {
      success: false,
      configPath: getConfigDir(),
      error: `Failed to create config directory: ${err}`,
    };
  }

  const configPath = getExistingConfigPath();

  try {
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};
    const plugins = config.plugin ?? [];

    // Remove existing oh-my-opencode-slim entries
    const filteredPlugins = plugins.filter(
      (p) => p !== PACKAGE_NAME && !p.startsWith(`${PACKAGE_NAME}@`),
    );

    // Add fresh entry
    filteredPlugins.push(PACKAGE_NAME);
    config.plugin = filteredPlugins;

    writeConfig(configPath, config);
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to update opencode config: ${err}`,
    };
  }
}

// Removed: addAuthPlugins - no longer needed with cliproxy
// Removed: addProviderConfig - default opencode now has kimi provider config

export function writeLiteConfig(
  installConfig: InstallConfig,
): ConfigMergeResult {
  const configPath = getLiteConfig();

  try {
    ensureConfigDir();
    const config = generateLiteConfig(installConfig);

    // Atomic write for lite config too
    const tmpPath = `${configPath}.tmp`;
    const bakPath = `${configPath}.bak`;
    const content = `${JSON.stringify(config, null, 2)}\n`;

    // Backup existing config if it exists
    if (existsSync(configPath)) {
      copyFileSync(configPath, bakPath);
    }

    writeFileSync(tmpPath, content);
    renameSync(tmpPath, configPath);

    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to write lite config: ${err}`,
    };
  }
}

export function disableDefaultAgents(): ConfigMergeResult {
  const configPath = getExistingConfigPath();

  try {
    ensureConfigDir();
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};

    const agent = (config.agent ?? {}) as Record<string, unknown>;
    agent.explore = { disable: true };
    agent.general = { disable: true };
    config.agent = agent;

    writeConfig(configPath, config);
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to disable default agents: ${err}`,
    };
  }
}

export function canModifyOpenCodeConfig(): boolean {
  try {
    const configPath = getExistingConfigPath();
    if (!existsSync(configPath)) return true; // Will be created
    const stat = statSync(configPath);
    // Check if writable - simple check for now
    return !!(stat.mode & 0o200);
  } catch {
    return false;
  }
}

export function addAntigravityPlugin(): ConfigMergeResult {
  const configPath = getExistingConfigPath();
  try {
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};
    const plugins = config.plugin ?? [];

    const pluginName = 'opencode-antigravity-auth@latest';
    if (!plugins.includes(pluginName)) {
      plugins.push(pluginName);
    }
    config.plugin = plugins;

    writeConfig(configPath, config);
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to add antigravity plugin: ${err}`,
    };
  }
}

export function addGoogleProvider(): ConfigMergeResult {
  const configPath = getExistingConfigPath();
  try {
    const { config: parsedConfig, error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    const config = parsedConfig ?? {};
    const providers = (config.provider ?? {}) as Record<string, unknown>;

    providers.google = {
      models: {
        'antigravity-gemini-3.1-pro': {
          name: 'Gemini 3.1 Pro (Antigravity)',
          limit: { context: 1048576, output: 65535 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          variants: {
            low: { thinkingLevel: 'low' },
            high: { thinkingLevel: 'high' },
          },
        },
        'antigravity-gemini-3-flash': {
          name: 'Gemini 3 Flash (Antigravity)',
          limit: { context: 1048576, output: 65536 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          variants: {
            minimal: { thinkingLevel: 'minimal' },
            low: { thinkingLevel: 'low' },
            medium: { thinkingLevel: 'medium' },
            high: { thinkingLevel: 'high' },
          },
        },
        'antigravity-claude-sonnet-4-5': {
          name: 'Claude Sonnet 4.5 (Antigravity)',
          limit: { context: 200000, output: 64000 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
        'antigravity-claude-sonnet-4-5-thinking': {
          name: 'Claude Sonnet 4.5 Thinking (Antigravity)',
          limit: { context: 200000, output: 64000 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          variants: {
            low: { thinkingConfig: { thinkingBudget: 8192 } },
            max: { thinkingConfig: { thinkingBudget: 32768 } },
          },
        },
        'antigravity-claude-opus-4-5-thinking': {
          name: 'Claude Opus 4.5 Thinking (Antigravity)',
          limit: { context: 200000, output: 64000 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          variants: {
            low: { thinkingConfig: { thinkingBudget: 8192 } },
            max: { thinkingConfig: { thinkingBudget: 32768 } },
          },
        },
        'gemini-2.5-flash': {
          name: 'Gemini 2.5 Flash (Gemini CLI)',
          limit: { context: 1048576, output: 65536 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
        'gemini-2.5-pro': {
          name: 'Gemini 2.5 Pro (Gemini CLI)',
          limit: { context: 1048576, output: 65536 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
        'gemini-3-flash-preview': {
          name: 'Gemini 3 Flash Preview (Gemini CLI)',
          limit: { context: 1048576, output: 65536 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
        'gemini-3.1-pro-preview': {
          name: 'Gemini 3.1 Pro Preview (Gemini CLI)',
          limit: { context: 1048576, output: 65535 },
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        },
      },
    };
    config.provider = providers;

    writeConfig(configPath, config);
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to add google provider: ${err}`,
    };
  }
}

export function addChutesProvider(): ConfigMergeResult {
  const configPath = getExistingConfigPath();
  try {
    // Chutes now follows the OpenCode auth flow (same as other providers).
    // Keep this step as a no-op success for backward-compatible install output.
    const { error } = parseConfig(configPath);
    if (error) {
      return {
        success: false,
        configPath,
        error: `Failed to parse config: ${error}`,
      };
    }
    return { success: true, configPath };
  } catch (err) {
    return {
      success: false,
      configPath,
      error: `Failed to validate chutes provider config: ${err}`,
    };
  }
}

export function detectAntigravityConfig(): boolean {
  const { config } = parseConfig(getExistingConfigPath());
  if (!config) return false;

  const providers = config.provider as Record<string, unknown> | undefined;
  if (providers?.google) return true;

  const plugins = config.plugin ?? [];
  return plugins.some((p) => p.startsWith('opencode-antigravity-auth'));
}

export function detectCurrentConfig(): DetectedConfig {
  const result: DetectedConfig = {
    isInstalled: false,
    hasKimi: false,
    hasOpenAI: false,
    hasAnthropic: false,
    hasCopilot: false,
    hasZaiPlan: false,
    hasAntigravity: false,
    hasChutes: false,
    hasOpencodeZen: false,
    hasTmux: false,
  };

  const { config } = parseConfig(getExistingConfigPath());
  if (!config) return result;

  const plugins = config.plugin ?? [];
  result.isInstalled = plugins.some((p) => p.startsWith(PACKAGE_NAME));
  result.hasAntigravity = plugins.some((p) =>
    p.startsWith('opencode-antigravity-auth'),
  );

  // Check for providers
  const providers = config.provider as Record<string, unknown> | undefined;
  result.hasKimi = !!providers?.kimi;
  result.hasAnthropic = !!providers?.anthropic;
  result.hasCopilot = !!providers?.['github-copilot'];
  result.hasZaiPlan = !!providers?.['zai-coding-plan'];
  result.hasChutes = !!providers?.chutes;
  if (providers?.google) result.hasAntigravity = true;

  // Try to detect from lite config
  const { config: liteConfig } = parseConfig(getLiteConfig());
  if (liteConfig && typeof liteConfig === 'object') {
    const configObj = liteConfig as Record<string, unknown>;
    const presetName = configObj.preset as string;
    const presets = configObj.presets as Record<string, unknown>;
    const agents = presets?.[presetName] as
      | Record<string, { model?: string }>
      | undefined;

    if (agents) {
      const models = Object.values(agents)
        .map((a) => a?.model)
        .filter(Boolean);
      result.hasOpenAI = models.some((m) => m?.startsWith('openai/'));
      result.hasAnthropic = models.some((m) => m?.startsWith('anthropic/'));
      result.hasCopilot = models.some((m) => m?.startsWith('github-copilot/'));
      result.hasZaiPlan = models.some((m) => m?.startsWith('zai-coding-plan/'));
      result.hasOpencodeZen = models.some((m) => m?.startsWith('opencode/'));
      if (models.some((m) => m?.startsWith('google/'))) {
        result.hasAntigravity = true;
      }
      if (models.some((m) => m?.startsWith('chutes/'))) {
        result.hasChutes = true;
      }
    }

    if (configObj.tmux && typeof configObj.tmux === 'object') {
      const tmuxConfig = configObj.tmux as { enabled?: boolean };
      result.hasTmux = tmuxConfig.enabled === true;
    }
  }

  return result;
}
