import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { getConfigDir } from '../config/paths';
import { CUSTOM_SKILLS, type CustomSkill } from './custom-skills-registry';

export { CUSTOM_SKILLS, type CustomSkill };

export interface BundledSkillInfo {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
}

/** Parse the `---` frontmatter block of a SKILL.md into flat string values. */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.+)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '');
    // Folded/block scalars (`>-`, `|`, `&`) carry no inline value — ignore
    // them so the registry fallback applies.
    if (value && !/^[>|&]/.test(value)) out[kv[1].toLowerCase()] = value;
  }
  return out;
}

/** Strip the frontmatter block so `content` is prompt body only. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * Bundled skills registered in-process via the host's `ctx.skill` channel —
 * never copied to the OpenCode skills directory. `path` points at the
 * SKILL.md inside the installed package, so the host resolves relative
 * resources against the live package version and plugin updates apply on
 * the next restart with zero disk state.
 */
export function buildBundledSkillInfos(
  packageRoot: string,
  disabled: readonly string[],
): BundledSkillInfo[] {
  const skip = new Set(disabled);
  const infos: BundledSkillInfo[] = [];
  for (const skill of CUSTOM_SKILLS) {
    if (skip.has(skill.name)) continue;
    try {
      const mdPath = join(packageRoot, skill.sourcePath, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      const raw = readFileSync(mdPath, 'utf-8').replace(/^\uFEFF/, '');
      const fm = parseFrontmatter(raw);
      infos.push({
        id: skill.name,
        name: skill.name,
        description: fm.description ?? skill.description,
        path: mdPath,
        content: stripFrontmatter(raw).trim(),
      });
    } catch {
      // Unreadable skill source: skip rather than break registration.
    }
  }
  return infos;
}

export interface LegacySkillCleanupResult {
  /** Customized/conflict copies kept — they shadow the in-process registration. */
  kept: string[];
  /** Disabled customized/conflict copies moved outside the host skill scan. */
  backedUp: string[];
  /** Legacy state dir existed but the manifest was unreadable. */
  manifestUnreadable: boolean;
}

function legacySkillHash(dir: string): string {
  const entries: {
    path: string;
    relativePath: string;
    kind: string;
    mode: number;
  }[] = [];
  function visit(current: string): void {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new Error('Cannot safely hash a symlink');
      if (!stat.isDirectory() && !stat.isFile())
        throw new Error('Unsupported skill entry');
      entries.push({
        path,
        relativePath: relative(dir, path),
        kind: stat.isDirectory() ? 'directory' : 'file',
        mode: stat.mode,
      });
      if (stat.isDirectory()) visit(path);
    }
  }
  visit(dir);
  const hash = createHash('sha256');
  entries.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  for (const entry of entries) {
    hash.update(
      `${entry.kind}\0${entry.relativePath}\0${entry.mode & 0o7777}\0`,
    );
    if (entry.kind === 'file') hash.update(readFileSync(entry.path));
  }
  return hash.digest('hex');
}

/**
 * One-time removal of the retired disk-copy sync state (skills-manifest.json,
 * its staging dirs, and the managed skill copies it tracked). The host loads
 * skills straight from the skills directory, so stale managed copies would
 * keep loading and shadow the in-process registrations. User-authored skills
 * are not tracked in the manifest and are never touched. Customized copies of
 * ENABLED skills are kept (user edits win); customized copies of DISABLED
 * skills are renamed aside so they stop shadowing while the data survives.
 */
export function removeLegacySkillSyncState(
  configDir = getConfigDir(),
  disabled: readonly string[] = [],
): LegacySkillCleanupResult {
  const result: LegacySkillCleanupResult = {
    kept: [],
    backedUp: [],
    manifestUnreadable: false,
  };
  const legacyDir = join(configDir, '.oh-my-opencode-slim');
  if (!existsSync(legacyDir)) return result;
  const manifestPath = join(legacyDir, 'skills-manifest.json');
  let entries: Record<string, { status?: string; lastManagedHash?: string }> =
    {};
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      skills?: Record<string, { status?: string; lastManagedHash?: string }>;
    };
    entries = manifest.skills ?? {};
  } catch {
    result.manifestUnreadable = true;
    return result;
  }
  const skillsDir = join(configDir, 'skills');
  const disabledSet = new Set(disabled);
  for (const [name, entry] of Object.entries(entries)) {
    // Reject directory aliases as well as path traversal from JSON names.
    if (!name || name === '.' || name === '..' || basename(name) !== name) {
      continue;
    }
    const dir = join(skillsDir, name);
    if (!existsSync(dir)) continue;
    let customized = true;
    try {
      customized =
        entry?.status !== 'managed' ||
        !entry.lastManagedHash ||
        !lstatSync(dir).isDirectory() ||
        legacySkillHash(dir) !== entry.lastManagedHash;
    } catch {
      // Never remove a skill whose contents cannot be verified.
    }
    if (customized && disabledSet.has(name)) {
      try {
        const backupDir = join(configDir, '.oh-my-opencode-slim-skill-backups');
        const backup = join(backupDir, name);
        mkdirSync(backupDir, { recursive: true });
        if (existsSync(backup)) throw new Error('Skill backup already exists');
        renameSync(dir, backup);
        result.backedUp.push(name);
      } catch {
        result.kept.push(name);
      }
      continue;
    }
    if (customized) {
      result.kept.push(name);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort — the host simply keeps loading whatever survived.
    }
  }
  rmSync(legacyDir, { recursive: true, force: true });
  return result;
}
