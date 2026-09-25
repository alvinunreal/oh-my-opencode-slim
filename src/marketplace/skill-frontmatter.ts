import matter from 'gray-matter';

/**
 * OpenCode-compatible YAML frontmatter sanitization for skills whose YAML is
 * invalid because an unquoted value contains a colon (Claude-style).
 */
function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;

  const frontmatter = match[1];
  const lines = frontmatter.split(/\r?\n/);
  const result: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') {
      result.push(line);
      continue;
    }
    if (line.match(/^\s+/)) {
      result.push(line);
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      result.push(line);
      continue;
    }
    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    if (
      value === '' ||
      value === '>' ||
      value === '|' ||
      value.startsWith('"') ||
      value.startsWith("'")
    ) {
      result.push(line);
      continue;
    }
    if (value.includes(':')) {
      result.push(`${key}: |-`);
      result.push(`  ${value}`);
      continue;
    }
    result.push(line);
  }

  const processed = result.join('\n');
  return content.replace(frontmatter, () => processed);
}

function isSkillFrontmatter(
  data: unknown,
): data is { name: string; description?: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as { name?: unknown }).name === 'string' &&
    ((data as { description?: unknown }).description === undefined ||
      typeof (data as { description?: unknown }).description === 'string')
  );
}

/** Parse SKILL.md using OpenCode's gray-matter + frontmatter schema. */
export function parseSkillFrontmatterName(content: string): string | undefined {
  try {
    const parsed = matter(content);
    if (isSkillFrontmatter(parsed.data)) return parsed.data.name;
    return undefined;
  } catch {
    try {
      const parsed = matter(fallbackSanitization(content));
      if (isSkillFrontmatter(parsed.data)) return parsed.data.name;
      return undefined;
    } catch {
      return undefined;
    }
  }
}
