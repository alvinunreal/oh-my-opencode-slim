import { tool } from '@opencode-ai/plugin';
import {
  DEFAULT_GREP_CONTEXT,
  DEFAULT_GREP_LIMIT,
  DEFAULT_GREP_TIMEOUT_MS,
  MAX_GREP_CONTEXT,
  MAX_GREP_LIMIT,
  MAX_GREP_TIMEOUT_MS,
} from './constants';

const z = tool.schema;

export const grepArgsSchema: Record<string, unknown> = {
  pattern: z
    .string()
    .min(1)
    .describe('Regex pattern to search for in file contents.'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in. Defaults to the current project directory.',
    ),
  include: z
    .string()
    .optional()
    .describe("Optional glob to include, e.g. '*.ts' or '*.{ts,tsx}'."),
  globs: z
    .array(z.string())
    .optional()
    .describe(
      'Additional ripgrep globs. Supports include patterns and negated patterns like !dist/**.',
    ),
  exclude_globs: z
    .array(z.string())
    .optional()
    .describe(
      'Extra glob exclusions, automatically passed as negated rg globs.',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .default('content')
    .describe(
      'Output mode: content shows matching lines, files_with_matches shows only matching file paths, count shows per-file match counts.',
    ),
  case_sensitive: z
    .boolean()
    .default(true)
    .describe('Use case-sensitive matching (default: true).'),
  smart_case: z
    .boolean()
    .default(false)
    .describe(
      'Enable smart-case matching: lowercase patterns become case-insensitive, uppercase stays case-sensitive.',
    ),
  word_regexp: z.boolean().default(false).describe('Match whole words only.'),
  context: z
    .number()
    .int()
    .min(0)
    .max(MAX_GREP_CONTEXT)
    .default(DEFAULT_GREP_CONTEXT)
    .describe(
      'Symmetric context lines around each match. Used as the fallback for before_context/after_context when those are omitted.',
    ),
  before_context: z
    .number()
    .int()
    .min(0)
    .max(MAX_GREP_CONTEXT)
    .optional()
    .describe(
      'Optional context lines before each match. When provided, it overrides the before side of context.',
    ),
  after_context: z
    .number()
    .int()
    .min(0)
    .max(MAX_GREP_CONTEXT)
    .optional()
    .describe(
      'Optional context lines after each match. When provided, it overrides the after side of context.',
    ),
  max_results: z
    .number()
    .int()
    .positive()
    .max(MAX_GREP_LIMIT)
    .default(DEFAULT_GREP_LIMIT)
    .describe(
      'Maximum entries to return globally. In content mode this counts match entries; in files_with_matches/count it counts files.',
    ),
  max_count_per_file: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional ripgrep per-file match cap. Uses rg max-count when supported by the selected output mode.',
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_GREP_TIMEOUT_MS)
    .default(DEFAULT_GREP_TIMEOUT_MS)
    .describe('Timeout in milliseconds for the rg process.'),
  hidden: z
    .boolean()
    .default(true)
    .describe(
      'Include hidden files and directories while still respecting rg ignore rules.',
    ),
  follow_symlinks: z
    .boolean()
    .default(false)
    .describe('Follow symbolic links.'),
  fixed_strings: z
    .boolean()
    .default(false)
    .describe('Treat the pattern as a literal string instead of a regex.'),
  invert_match: z
    .boolean()
    .default(false)
    .describe('Invert the search so ripgrep returns non-matching lines.'),
  multiline: z
    .boolean()
    .default(false)
    .describe('Enable multiline regex mode so matches can span line breaks.'),
  multiline_dotall: z
    .boolean()
    .default(false)
    .describe(
      'When multiline is enabled, also let . match newlines (ripgrep multiline-dotall).',
    ),
  pcre2: z
    .boolean()
    .default(false)
    .describe(
      'Use the PCRE2 regex engine for advanced regex features when needed.',
    ),
  file_type: z
    .string()
    .optional()
    .describe(
      'Optional single ripgrep file type filter, e.g. ts, js, py, md. Works alongside file_types.',
    ),
  file_types: z
    .array(z.string())
    .optional()
    .describe(
      'Optional ripgrep file type filters to include. Applied in addition to file_type.',
    ),
  exclude_file_types: z
    .array(z.string())
    .optional()
    .describe('Optional ripgrep file type filters to exclude using type-not.'),
  max_filesize: z
    .string()
    .optional()
    .describe('Optional ripgrep max-filesize value such as 1M, 500K, or 2G.'),
  sort_by: z
    .enum(['none', 'path', 'mtime'])
    .default('none')
    .describe(
      'Optional result ordering. Path ordering uses ripgrep sort mode; mtime orders by file modification time.',
    ),
  sort_order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Ordering direction when sort_by is enabled.'),
};
