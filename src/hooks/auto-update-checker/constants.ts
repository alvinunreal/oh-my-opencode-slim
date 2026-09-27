import * as os from 'node:os';
import * as path from 'node:path';
import { getOpenCodeConfigPaths } from '../../cli/config-manager';

export { INSTALLER_MANAGED_PLUGIN_OPTION } from '../../plugin-entry';

export const PACKAGE_NAME = 'oh-my-opencode-slim';
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
export const NPM_PACKAGE_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
export const NPM_FETCH_TIMEOUT = 5000;

/**
 * Resolves OpenCode's plugin cache root. OpenCode uses `XDG_CACHE_HOME` when
 * set, otherwise `~/.cache`, followed by `opencode` on every platform.
 * Keep this in sync with `getOpenCodePluginCacheDir()` in
 * `src/cli/config-io.ts`.
 */
function getCacheDir(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'opencode');
}

/** The directory used by OpenCode to cache node_modules for plugins. */
export const CACHE_DIR = getCacheDir();

/** Path to this plugin's package.json within the OpenCode cache. */
export const INSTALLED_PACKAGE_JSON = path.join(
  CACHE_DIR,
  'node_modules',
  PACKAGE_NAME,
  'package.json',
);

const configPaths = getOpenCodeConfigPaths();

/** Primary OpenCode configuration file path (standard JSON). */
export const USER_OPENCODE_CONFIG = configPaths[0];

/** Alternative OpenCode configuration file path (JSON with Comments). */
export const USER_OPENCODE_CONFIG_JSONC = configPaths[1];
