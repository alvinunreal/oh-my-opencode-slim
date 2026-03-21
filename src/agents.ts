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
 * Reads all agent `.md` files from the given directory, parses their YAML
 * frontmatter and markdown body, and returns a map of agent name to config.
 *
 * The returned config objects have the same shape as `AgentConfig` in the
 * OpenCode SDK — frontmatter keys map directly to config fields, and the
 * markdown body becomes the `prompt` field.
 */
export function loadAgentConfigs(agentsDir: string): Record<string, Record<string, unknown>> {
  let entries: string[];
  try {
    entries = readdirSync(agentsDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return {};
  }

  const configs: Record<string, Record<string, unknown>> = {};

  for (const entry of entries) {
    try {
      const content = readFileSync(resolve(agentsDir, entry), "utf-8");
      const { data, body } = parseFrontmatter(content);
      configs[basename(entry, ".md")] = { ...data, prompt: body };
    } catch {
      // Skip unreadable files
    }
  }

  return configs;
}
