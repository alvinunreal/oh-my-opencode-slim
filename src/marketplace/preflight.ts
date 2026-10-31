import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

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
