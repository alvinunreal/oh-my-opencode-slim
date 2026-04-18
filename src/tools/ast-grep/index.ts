import type { ToolDefinition } from '@opencode-ai/plugin';
import { ast_grep_replace, ast_grep_search } from './tools';

export const builtinTools: Record<string, ToolDefinition> = {
  ast_grep_search,
  ast_grep_replace,
};

export {
  ensureCliAvailable,
  getAstGrepPath,
  isCliAvailable,
  startBackgroundInit,
} from './cli';
export type { EnvironmentCheckResult } from './constants';
export { checkEnvironment, formatEnvironmentCheck } from './constants';
export {
  ensureAstGrepBinary,
  getCacheDir,
  getCachedBinaryPath,
} from './downloader';
export type { CliLanguage, CliMatch, SgResult } from './types';
export { CLI_LANGUAGES } from './types';
export { ast_grep_replace, ast_grep_search };
