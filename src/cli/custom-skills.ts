import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getConfigDir } from '../config/paths';
import { CUSTOM_SKILLS } from './custom-skills-registry';

export { CUSTOM_SKILLS };

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
  /** Disabled customized/conflict copies renamed aside as <name>.omos-backup. */
  backedUp: string[];
  /** Legacy state dir existed but the manifest was unreadable. */
  manifestUnreadable: boolean;
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
  let entries: Record<string, { status?: string }> = {};
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      skills?: Record<string, { status?: string }>;
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
    const customized =
      entry?.status === 'customized' || entry?.status === 'conflict';
    if (customized && disabledSet.has(name)) {
      // Disabled + user-edited: preserve the data, stop the shadow.
      try {
        renameSync(dir, `${dir}.omos-backup`);
        result.backedUp.push(name);
      } catch {
        // Best effort.
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
