export const GREP_TOOL_ID = 'grep';
export const RG_BINARY = 'rg';
export const GREP_BINARY = 'grep';

export const GREP_DESCRIPTION = `A powerful local search tool built on ripgrep.

Usage:
- Compatible base args: pattern, path?, include?
- Output modes: content, files_with_matches, count
- Supports regex and fixed-string search, smart-case, PCRE2, invert_match, multiline, and multiline_dotall
- Supports context, file type and glob filters, hidden files, symlink following, per-file max counts, max_filesize, and path or mtime sorting
- For mtime sorting, the tool uses a hybrid strategy and may fall back to direct search with a warning when safe mtime ordering is not possible
- Use this tool instead of shelling out to rg for code/content search in the workspace`;

export const DEFAULT_GREP_TIMEOUT_MS = 80_000;
export const MAX_GREP_TIMEOUT_MS = 140_000;

export const DEFAULT_GREP_LIMIT = 500;
export const MAX_GREP_LIMIT = 5_000;
export const MAX_MTIME_DISCOVERY_FILES = 5_000;

export const DEFAULT_GREP_CONTEXT = 0;
export const MAX_GREP_CONTEXT = 20;

export const DEFAULT_GREP_MAX_CONCURRENCY = 2;
export const DEFAULT_GREP_RETRY_COUNT = 1;
export const DEFAULT_GREP_RETRY_DELAY_MS = 150;

export const CONTEXT_BUFFER_MULTIPLIER = 2;
export const MAX_LINE_LENGTH = 2_000;
export const MAX_STDERR_CHARS = 20_000_000;
