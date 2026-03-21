import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, body: content.trim() };
  }

  return {
    data: (parseYaml(match[1]) ?? {}) as Record<string, unknown>,
    body: match[2].trim()
  };
}

/**
 * Reads all command `.md` files from the given directory and converts them
 * into OpenCode `config.command` entries.
 */
export function loadCommandConfigs(commandsDir: string): Record<string, Record<string, unknown>> {
  let entries: string[];
  try {
    entries = readdirSync(commandsDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return {};
  }

  const configs: Record<string, Record<string, unknown>> = {};

  for (const entry of entries) {
    try {
      const content = readFileSync(resolve(commandsDir, entry), "utf-8");
      const { data, body } = parseFrontmatter(content);
      configs[basename(entry, ".md")] = { ...data, template: body };
    } catch {
      // Skip unreadable files
    }
  }

  return configs;
}
