import matter from 'gray-matter';

/**
 * Quote malformed plain YAML values containing colons by converting them to
 * block scalars, matching OpenCode's tolerance for Claude-style descriptions.
 */
function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;

  const lines = match[1].split(/\r?\n/);
  const sanitized: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '' || /^\s/.test(line)) {
      sanitized.push(line);
      continue;
    }

    const keyValue = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!keyValue) {
      sanitized.push(line);
      continue;
    }

    const [, key, rawValue] = keyValue;
    const value = rawValue.trim();
    if (
      value === '' ||
      value === '>' ||
      value === '|' ||
      value.startsWith('"') ||
      value.startsWith("'") ||
      !value.includes(':')
    ) {
      sanitized.push(line);
      continue;
    }

    sanitized.push(`${key}: |-`, `  ${value}`);
  }

  return content.replace(match[1], sanitized.join('\n'));
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

/** Parse skill frontmatter and return its string name when valid. */
export function parseSkillFrontmatterName(content: string): string | undefined {
  try {
    const parsed = matter(content);
    if (isSkillFrontmatter(parsed.data)) return parsed.data.name;
  } catch {
    try {
      const parsed = matter(fallbackSanitization(content));
      if (isSkillFrontmatter(parsed.data)) return parsed.data.name;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
