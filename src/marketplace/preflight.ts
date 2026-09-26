import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';
import type { RuntimeConfig } from '../config/runtime';
import type { MarketplacePackageManifest } from './schemas';
import { parseSkillFrontmatterName } from './skill-frontmatter';

const BUILTIN_MCPS = ['context7', 'gh_grep'] as const;
const PositiveTimeoutSchema = z.number().int().positive();
const StringMapSchema = z.record(z.string(), z.string());
const OAuthSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  redirectUri: z.string().optional(),
});
const OpenCodeMcpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    command: z.array(z.string()),
    environment: StringMapSchema.optional(),
    enabled: z.boolean().optional(),
    timeout: PositiveTimeoutSchema.optional(),
  }),
  z.object({
    type: z.literal('remote'),
    url: z.string(),
    enabled: z.boolean().optional(),
    headers: StringMapSchema.optional(),
    oauth: z.union([OAuthSchema, z.literal(false)]).optional(),
    timeout: PositiveTimeoutSchema.optional(),
  }),
]);
const V2TimeoutSchema = z.object({
  startup: PositiveTimeoutSchema.optional(),
  request: PositiveTimeoutSchema.optional(),
});
const V2McpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    command: z.array(z.string()),
    environment: StringMapSchema.optional(),
    disabled: z.boolean().optional(),
    timeout: V2TimeoutSchema.optional(),
  }),
  z.object({
    type: z.literal('remote'),
    url: z.string(),
    headers: StringMapSchema.optional(),
    oauth: z.union([OAuthSchema, z.literal(false)]).optional(),
    disabled: z.boolean().optional(),
    timeout: V2TimeoutSchema.optional(),
  }),
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const left = asObject(result[key]);
    const right = asObject(value);
    result[key] = left && right ? mergeObjects(left, right) : value;
  }
  return result;
}

function readConfig(path: string): Record<string, unknown> | undefined {
  try {
    const errors: Parameters<typeof parseJsonc>[1] = [];
    const value = parseJsonc(readFileSync(path, 'utf8'), errors, {
      allowTrailingComma: true,
    });
    return errors.length === 0 ? asObject(value) : undefined;
  } catch {
    return undefined;
  }
}

function home(): string {
  return process.env.OPENCODE_TEST_HOME?.trim() || homedir();
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

function configDirectories(project?: string): string[] {
  const directories = [join(configHome(), 'opencode')];
  const opencodeHome = join(home(), '.opencode');
  try {
    if (statSync(opencodeHome).isDirectory()) directories.push(opencodeHome);
  } catch {}
  const configured = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configured) directories.push(configured);
  if (project && process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== 'true') {
    const chain: string[] = [];
    let current = resolve(project);
    let boundary: string | undefined;
    for (let path = current; ; path = dirname(path)) {
      try {
        lstatSync(join(path, '.git'));
        boundary = path;
        break;
      } catch {}
      if (dirname(path) === path) break;
    }
    while (true) {
      const candidate = join(current, '.opencode');
      try {
        if (statSync(candidate).isDirectory()) chain.unshift(candidate);
      } catch {}
      if (current === boundary || dirname(current) === current) break;
      current = dirname(current);
    }
    directories.push(...chain);
  }
  return [...new Set(directories)];
}

function configFiles(project?: string): string[] {
  const userConfig = join(configHome(), 'opencode');
  const files = [
    join(userConfig, 'config.json'),
    join(userConfig, 'opencode.json'),
    join(userConfig, 'opencode.jsonc'),
  ];
  const explicit = process.env.OPENCODE_CONFIG?.trim();
  if (explicit) files.push(explicit);

  if (project && process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== 'true') {
    const chain: string[] = [];
    let current = resolve(project);
    let boundary: string | undefined;
    for (let path = current; ; path = dirname(path)) {
      try {
        lstatSync(join(path, '.git'));
        boundary = path;
        break;
      } catch {}
      if (dirname(path) === path) break;
    }
    while (true) {
      chain.unshift(current);
      if (current === boundary || dirname(current) === current) break;
      current = dirname(current);
    }
    for (const directory of chain) {
      files.push(
        join(directory, 'opencode.json'),
        join(directory, 'opencode.jsonc'),
      );
    }
  }

  for (const directory of configDirectories(project)) {
    if (
      directory.endsWith('.opencode') ||
      directory === process.env.OPENCODE_CONFIG_DIR?.trim()
    ) {
      files.push(
        join(directory, 'opencode.json'),
        join(directory, 'opencode.jsonc'),
      );
    }
  }
  return files;
}

export function loadMergedOpenCodeConfig(
  projectDirectory?: string,
): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  for (const file of configFiles(projectDirectory)) {
    const parsed = readConfig(file);
    if (parsed) merged = mergeObjects(merged, parsed);
  }
  const content = process.env.OPENCODE_CONFIG_CONTENT?.trim();
  if (content) {
    const errors: Parameters<typeof parseJsonc>[1] = [];
    const parsed = asObject(
      parseJsonc(content, errors, { allowTrailingComma: true }),
    );
    if (parsed && errors.length === 0) merged = mergeObjects(merged, parsed);
  }
  return merged;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === '' ||
    (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      path !== '..' &&
      !isAbsolute(path))
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkSkillTree(
  root: string,
  names: Set<string>,
  includeHidden = false,
): void {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return;
  }
  const visited = new Set<string>();
  const walk = (current: string): void => {
    let real: string;
    try {
      real = realpathSync(current);
      if (!inside(realRoot, real) || visited.has(real)) return;
      visited.add(real);
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const item = join(current, entry.name);
        let isDirectoryEntry: boolean;
        let isFile: boolean;
        try {
          const stat = entry.isSymbolicLink() ? statSync(item) : entry;
          isDirectoryEntry = stat.isDirectory();
          isFile = stat.isFile();
          if (entry.isSymbolicLink() && !inside(realRoot, realpathSync(item)))
            continue;
        } catch {
          continue;
        }
        if (isDirectoryEntry) walk(item);
        else if (isFile && entry.name === 'SKILL.md') {
          try {
            const name = parseSkillFrontmatterName(readFileSync(item, 'utf8'));
            if (name) names.add(name);
          } catch {}
        }
      }
    } catch {}
  };
  walk(root);
}

function configuredSkillPaths(project: string | undefined): string[] {
  const skills = asObject(loadMergedOpenCodeConfig(project).skills);
  if (!Array.isArray(skills?.paths)) return [];
  return skills.paths.flatMap((path) => {
    if (typeof path !== 'string' || path.trim() === '') return [];
    const expanded = path.startsWith('~/') ? join(home(), path.slice(2)) : path;
    const resolved = isAbsolute(expanded)
      ? expanded
      : join(project ?? process.cwd(), expanded);
    return isDirectory(resolved) ? [resolved] : [];
  });
}

function externalSkillRoots(project?: string): string[] {
  if (process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS === 'true') return [];
  const names = ['.agents'];
  if (
    process.env.OPENCODE_DISABLE_CLAUDE_CODE !== 'true' &&
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS !== 'true'
  )
    names.unshift('.claude');
  const roots = names.map((name) => join(home(), name));
  if (project) {
    let current = resolve(project);
    for (;;) {
      for (const name of names) roots.push(join(current, name));
      if (dirname(current) === current) break;
      current = dirname(current);
    }
  }
  return roots.filter(isDirectory);
}

export function discoverOnDiskSkillNames(
  projectDirectory?: string,
  extraDirectories: readonly string[] = [],
): string[] {
  const names = new Set<string>();
  for (const root of externalSkillRoots(projectDirectory)) {
    walkSkillTree(join(root, 'skills'), names, true);
  }
  for (const directory of configDirectories(projectDirectory)) {
    walkSkillTree(join(directory, 'skill'), names);
    walkSkillTree(join(directory, 'skills'), names);
  }
  for (const directory of configuredSkillPaths(projectDirectory)) {
    walkSkillTree(directory, names);
  }
  for (const directory of extraDirectories) walkSkillTree(directory, names);
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

export function discoverOnDiskOpenCodeMcps(
  projectDirectory?: string,
  hostFlavor?: string,
): Record<string, unknown> {
  const config = loadMergedOpenCodeConfig(projectDirectory);
  const mcp = asObject(config.mcp);
  if (!mcp) return {};
  if (hostFlavor !== 'v2') return mcp;
  const servers = asObject(mcp.servers);
  if (!servers) return {};
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([name, value]) =>
        V2McpSchema.safeParse(value).success &&
        (value as { disabled?: boolean }).disabled !== true &&
        name.length > 0,
    ),
  );
}

export function discoverPreflightMcps(
  runtime: RuntimeConfig,
  projectDirectory?: string,
  hostFlavor?: string,
): string[] {
  const disabled = new Set(runtime.disabledMcps);
  const names = new Set<string>(
    BUILTIN_MCPS.filter((name) => !disabled.has(name)),
  );
  for (const [name, definition] of Object.entries(
    discoverOnDiskOpenCodeMcps(projectDirectory, hostFlavor),
  )) {
    if (disabled.has(name)) continue;
    if (
      hostFlavor === 'v2'
        ? V2McpSchema.safeParse(definition).success
        : OpenCodeMcpSchema.safeParse(definition).success
    ) {
      if (
        (definition as { enabled?: boolean }).enabled !== false &&
        (definition as { disabled?: boolean }).disabled !== true
      )
        names.add(name);
    }
  }
  return [...names];
}

export function discoverDesiredV2Mcps(
  runtime: RuntimeConfig,
  projectDirectory: string,
  liveAvailableMcpNames: readonly string[],
): string[] {
  const live = new Set(liveAvailableMcpNames);
  const disabled = new Set(runtime.disabledMcps);
  const names = new Set<string>(
    BUILTIN_MCPS.filter((name) => live.has(name) && !disabled.has(name)),
  );
  for (const name of Object.keys(
    discoverOnDiskOpenCodeMcps(projectDirectory, 'v2'),
  )) {
    if (!disabled.has(name)) names.add(name);
  }
  return [...names];
}

export interface MarketplaceRequirementReport {
  skills: { required: string[]; available: string[]; missing: string[] };
  mcps: { required: string[]; available: string[]; missing: string[] };
}

export function evaluateMarketplaceRequirements(
  manifest: Pick<MarketplacePackageManifest, 'skills' | 'mcps'>,
  availableSkills: readonly string[],
  availableMcps: readonly string[],
): MarketplaceRequirementReport {
  const classify = (
    required: readonly string[],
    available: readonly string[],
  ) => {
    const availableSet = new Set(available);
    return {
      required: [...required],
      available: required.filter((name) => availableSet.has(name)),
      missing: required.filter((name) => !availableSet.has(name)),
    };
  };
  return {
    skills: classify(manifest.skills, availableSkills),
    mcps: classify(manifest.mcps, availableMcps),
  };
}
