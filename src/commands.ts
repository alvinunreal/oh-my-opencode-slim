import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Copies plugin command markdown files into the project's `.opencode/commands/`
 * directory so OpenCode discovers them natively (TUI autocomplete, etc.).
 *
 * Existing user files with the same name are NOT overwritten — user overrides
 * take precedence. Files are only written when missing or when the plugin
 * version has changed (detected by a marker comment in the copied file).
 */
export function installCommandFiles(commandsDir: string, projectDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(commandsDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return;
  }

  if (entries.length === 0) return;

  const targetDir = resolve(projectDir, ".opencode", "commands");

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = resolve(commandsDir, entry);
    const dest = resolve(targetDir, entry);

    try {
      if (existsSync(dest)) {
        // Check if the existing file is plugin-managed (has our marker).
        // If the user replaced it with their own version (no marker), skip.
        const existing = readFileSync(dest, "utf-8");
        if (!existing.includes("# managed-by: opencode-discipline")) {
          continue;
        }
      }

      const content = readFileSync(src, "utf-8");
      writeFileSync(dest, addMarker(content), "utf-8");
    } catch {
      // Best-effort — don't break plugin init if we can't write
    }
  }
}

function addMarker(content: string): string {
  // Insert marker as a YAML comment inside the frontmatter
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const lineBreak = content.includes("\r\n") ? "\r\n" : "\n";
    return content.replace(
      /^---\r?\n/,
      `---${lineBreak}# managed-by: opencode-discipline${lineBreak}`
    );
  }
  return `<!-- managed-by: opencode-discipline -->\n${content}`;
}
