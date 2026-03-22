import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, body: content.trim() };
  }

  return {
    data: (parseYaml(match[1]) ?? {}) as Record<string, unknown>,
    body: match[2].trim()
  };
}
