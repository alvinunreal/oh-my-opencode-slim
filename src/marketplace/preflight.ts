import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { parseJsonConfigFile, parseJsoncText } from '../config/jsonc';
import { deepMerge } from '../config/loader';
import type { RuntimeConfig } from '../config/runtime';
import { parseSkillFrontmatterName } from './skill-frontmatter';

const BUILTIN_MCPS = ['context7', 'gh_grep'] as const;
const CLAUDE_EXTERNAL_DIR = '.claude';
const AGENTS_EXTERNAL_DIR = '.agents';

function truthyEnv(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === 'true' || value === '1';
}

function opencodeHome(): string {
  const override = process.env.OPENCODE_TEST_HOME?.trim();
  return override && override.length > 0 ? override : homedir();
}

function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkUp(start: string, stop?: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (stop && current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function gitWorktree(directory: string): string | undefined {
  for (const current of walkUp(directory)) {
    try {
      statSync(join(current, '.git'));
      return current;
    } catch {
      // Continue walking toward the filesystem root.
    }
  }
  return undefined;
}

function existingNamedDirectories(
  start: string,
  name: string,
  stop?: string,
): string[] {
  const found: string[] = [];
  for (const current of walkUp(start, stop)) {
    const candidate = join(current, name);
    if (isDirectory(candidate)) found.push(candidate);
  }
  return found;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function opencodeConfigDirectories(projectDirectory?: string): string[] {
  const directories = [join(xdgConfigHome(), 'opencode')];
  if (projectDirectory && !truthyEnv('OPENCODE_DISABLE_PROJECT_CONFIG')) {
    directories.push(
      ...existingNamedDirectories(
        projectDirectory,
        '.opencode',
        gitWorktree(projectDirectory),
      ),
    );
  }
  const homeOpencode = join(opencodeHome(), '.opencode');
  if (isDirectory(homeOpencode)) directories.push(homeOpencode);
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configDir) directories.push(configDir);
  return unique(directories);
}

function projectConfigFiles(projectDirectory?: string): string[] {
  if (!projectDirectory || truthyEnv('OPENCODE_DISABLE_PROJECT_CONFIG')) {
    return [];
  }
  const files: string[] = [];
  for (const current of walkUp(
    projectDirectory,
    gitWorktree(projectDirectory),
  ).reverse()) {
    files.push(join(current, 'opencode.json'), join(current, 'opencode.jsonc'));
  }
  return files;
}

function directoryConfigFiles(projectDirectory?: string): string[] {
  const files: string[] = [];
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  for (const directory of opencodeConfigDirectories(projectDirectory)) {
    if (directory.endsWith('.opencode') || directory === configDir) {
      files.push(
        join(directory, 'opencode.json'),
        join(directory, 'opencode.jsonc'),
      );
    }
  }
  return files;
}

function parseConfigObject(filePath: string): Record<string, unknown> | null {
  const parsed = parseJsonConfigFile(filePath).config;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function mergeConfigLayer(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const mcp = source.mcp;
  if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
    target.mcp = deepMerge(
      (target.mcp as Record<string, unknown> | undefined) ?? {},
      mcp as Record<string, unknown>,
    );
  }
  const skills = source.skills;
  if (skills && typeof skills === 'object' && !Array.isArray(skills)) {
    const current =
      (target.skills as Record<string, unknown> | undefined) ?? {};
    const next = skills as { paths?: unknown; urls?: unknown };
    target.skills = {
      ...current,
      ...(Array.isArray(next.paths) ? { paths: next.paths } : {}),
      ...(Array.isArray(next.urls) ? { urls: next.urls } : {}),
    };
  }
}

export function loadMergedOpenCodeConfig(
  projectDirectory?: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const globalDir = join(xdgConfigHome(), 'opencode');
  for (const filePath of [
    join(globalDir, 'config.json'),
    join(globalDir, 'opencode.json'),
    join(globalDir, 'opencode.jsonc'),
  ]) {
    const parsed = parseConfigObject(filePath);
    if (parsed) mergeConfigLayer(merged, parsed);
  }
  const customFile = process.env.OPENCODE_CONFIG?.trim();
  if (customFile) {
    const parsed = parseConfigObject(customFile);
    if (parsed) mergeConfigLayer(merged, parsed);
  }
  for (const filePath of projectConfigFiles(projectDirectory)) {
    const parsed = parseConfigObject(filePath);
    if (parsed) mergeConfigLayer(merged, parsed);
  }
  for (const filePath of directoryConfigFiles(projectDirectory)) {
    const parsed = parseConfigObject(filePath);
    if (parsed) mergeConfigLayer(merged, parsed);
  }
  const content = process.env.OPENCODE_CONFIG_CONTENT?.trim();
  if (content) {
    try {
      const parsed = parseJsoncText(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mergeConfigLayer(merged, parsed as Record<string, unknown>);
      }
    } catch {
      // Invalid OPENCODE_CONFIG_CONTENT is ignored for preflight.
    }
  }
  return merged;
}

function entryKind(
  fullPath: string,
  isSymbolicLink: boolean,
  isDirectoryEntry: boolean,
  isFile: boolean,
): 'dir' | 'file' | 'other' {
  if (isSymbolicLink) {
    try {
      const target = statSync(fullPath);
      if (target.isDirectory()) return 'dir';
      if (target.isFile()) return 'file';
    } catch {
      return 'other';
    }
    return 'other';
  }
  if (isDirectoryEntry) return 'dir';
  if (isFile) return 'file';
  return 'other';
}

function addSkillName(skillFile: string, names: Set<string>): void {
  try {
    const name = parseSkillFrontmatterName(readFileSync(skillFile, 'utf8'));
    if (name) names.add(name);
  } catch {
    // Unreadable or invalid SKILL.md files are not available skills.
  }
}

function walkSkillTree(
  directory: string,
  names: Set<string>,
  includeHidden = false,
): void {
  const visited = new Set<string>();
  const walk = (current: string): void => {
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const fullPath = join(current, entry.name);
        const kind = entryKind(
          fullPath,
          entry.isSymbolicLink(),
          entry.isDirectory(),
          entry.isFile(),
        );
        if (kind === 'dir') {
          walk(fullPath);
          continue;
        }
        if (kind === 'file' && entry.name === 'SKILL.md') {
          addSkillName(fullPath, names);
        }
      }
    } catch {
      return;
    }
  };
  if (isDirectory(directory)) walk(directory);
}

function configuredSkillPaths(
  projectDirectory: string | undefined,
  merged: Record<string, unknown>,
): string[] {
  const skills = merged.skills as { paths?: unknown } | undefined;
  if (!Array.isArray(skills?.paths)) return [];
  const home = opencodeHome();
  const paths: string[] = [];
  for (const item of skills.paths) {
    if (typeof item !== 'string' || item.trim().length === 0) continue;
    const expanded = item.startsWith('~/') ? join(home, item.slice(2)) : item;
    const resolved = isAbsolute(expanded)
      ? expanded
      : join(projectDirectory ?? process.cwd(), expanded);
    if (isDirectory(resolved)) paths.push(resolved);
  }
  return paths;
}

function externalSkillRoots(projectDirectory?: string): string[] {
  if (truthyEnv('OPENCODE_DISABLE_EXTERNAL_SKILLS')) return [];
  const roots: string[] = [];
  const names: string[] = [AGENTS_EXTERNAL_DIR];
  if (
    !truthyEnv('OPENCODE_DISABLE_CLAUDE_CODE') &&
    !truthyEnv('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS')
  ) {
    names.unshift(CLAUDE_EXTERNAL_DIR);
  }
  const home = opencodeHome();
  for (const name of names) {
    const globalRoot = join(home, name);
    if (isDirectory(globalRoot)) roots.push(globalRoot);
  }
  if (projectDirectory) {
    const stop = gitWorktree(projectDirectory);
    for (const name of names) {
      roots.push(...existingNamedDirectories(projectDirectory, name, stop));
    }
  }
  return unique(roots);
}

export function discoverOnDiskSkillNames(
  projectDirectory?: string,
  extraDirectories: readonly string[] = [],
): string[] {
  const names = new Set<string>();
  const merged = loadMergedOpenCodeConfig(projectDirectory);
  for (const root of externalSkillRoots(projectDirectory)) {
    walkSkillTree(join(root, 'skills'), names, true);
  }
  for (const directory of opencodeConfigDirectories(projectDirectory)) {
    walkSkillTree(join(directory, 'skill'), names);
    walkSkillTree(join(directory, 'skills'), names);
  }
  for (const directory of configuredSkillPaths(projectDirectory, merged)) {
    walkSkillTree(directory, names);
  }
  for (const directory of extraDirectories) {
    walkSkillTree(directory, names);
  }
  return [...names];
}

export function discoverPreflightSkills(
  runtime: RuntimeConfig,
  projectDirectory?: string,
  extraDirectories: readonly string[] = [],
): string[] {
  const disabled = new Set(runtime.disabledSkills);
  return discoverOnDiskSkillNames(projectDirectory, extraDirectories).filter(
    (name) => !disabled.has(name),
  );
}

const PositiveTimeoutSchema = z.number().int().positive();
const StringMapSchema = z.record(z.string(), z.string());
const McpOAuthSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  redirectUri: z.string().optional(),
});
const McpLocalSchema = z.object({
  type: z.literal('local'),
  command: z.array(z.string()),
  environment: StringMapSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: PositiveTimeoutSchema.optional(),
});
const McpRemoteSchema = z.object({
  type: z.literal('remote'),
  url: z.string(),
  enabled: z.boolean().optional(),
  headers: StringMapSchema.optional(),
  oauth: z.union([McpOAuthSchema, z.literal(false)]).optional(),
  timeout: PositiveTimeoutSchema.optional(),
});
const McpDefinitionSchema = z.discriminatedUnion('type', [
  McpLocalSchema,
  McpRemoteSchema,
]);

function isValidMcpDefinition(value: unknown): boolean {
  const parsed = McpDefinitionSchema.safeParse(value);
  return parsed.success && parsed.data.enabled !== false;
}

export function discoverOnDiskOpenCodeMcps(
  projectDirectory?: string,
): Record<string, unknown> {
  const mcp = loadMergedOpenCodeConfig(projectDirectory).mcp;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return {};
  return mcp as Record<string, unknown>;
}

export function discoverPreflightMcps(
  runtime: RuntimeConfig,
  projectDirectory?: string,
): string[] {
  const disabled = new Set(runtime.disabledMcps);
  const names = new Set<string>();
  for (const name of BUILTIN_MCPS) {
    if (!disabled.has(name)) names.add(name);
  }
  for (const [name, definition] of Object.entries(
    discoverOnDiskOpenCodeMcps(projectDirectory),
  )) {
    if (disabled.has(name) || !isValidMcpDefinition(definition)) continue;
    names.add(name);
  }
  return [...names];
}
