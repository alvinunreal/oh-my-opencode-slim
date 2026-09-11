import { existsSync, readFileSync, statSync } from 'node:fs';

export interface ParsedJsonConfig {
  config: unknown | null;
  error?: string;
}

/** Strip comments and trailing commas from the JSONC used by OpenCode. */
export function stripJsonComments(json: string): string {
  const commentPattern = /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g;
  const trailingCommaPattern = /\\"|"(?:\\"|[^"])*"|(,)(\s*[}\]])/g;

  return json
    .replace(commentPattern, (match, commentGroup) =>
      commentGroup ? '' : match,
    )
    .replace(trailingCommaPattern, (match, comma, closing) =>
      comma ? closing : match,
    );
}

/** Parse JSONC text the same way OpenCode config files are loaded. */
export function parseJsoncText(text: string): unknown {
  return JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ''))) as unknown;
}

export function parseJsonConfigFile(filePath: string): ParsedJsonConfig {
  try {
    if (!existsSync(filePath)) return { config: null };
    if (statSync(filePath).size === 0) return { config: null };
    const content = readFileSync(filePath, 'utf8');
    if (content.trim().length === 0) return { config: null };
    return { config: parseJsoncText(content) };
  } catch (error) {
    return { config: null, error: String(error) };
  }
}

export function parseJsonConfig(filePath: string): ParsedJsonConfig {
  const result = parseJsonConfigFile(filePath);
  if (result.config || result.error) return result;
  if (filePath.endsWith('.json')) {
    return parseJsonConfigFile(filePath.replace(/\.json$/, '.jsonc'));
  }
  return { config: null };
}
