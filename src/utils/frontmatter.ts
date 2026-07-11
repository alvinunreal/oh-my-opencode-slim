/**
 * Parse `---` delimited frontmatter from a string.
 * Handles both `\n` and `\r\n` line endings.
 * Returns null if no frontmatter is found.
 */
export function parseFrontmatter(
  content: string,
): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (!kv) continue;
    result[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}
