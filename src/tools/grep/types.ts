export interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
  globs?: string[];
  exclude_globs?: string[];
  output_mode?: GrepOutputMode;
  case_sensitive?: boolean;
  smart_case?: boolean;
  word_regexp?: boolean;
  context?: number;
  before_context?: number;
  after_context?: number;
  max_results?: number;
  max_count_per_file?: number;
  timeout_ms?: number;
  hidden?: boolean;
  follow_symlinks?: boolean;
  fixed_strings?: boolean;
  invert_match?: boolean;
  multiline?: boolean;
  multiline_dotall?: boolean;
  pcre2?: boolean;
  file_type?: string;
  file_types?: string[];
  exclude_file_types?: string[];
  max_filesize?: string;
  sort_by?: GrepSortMode;
  sort_order?: GrepSortOrder;
}

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';
export type GrepSortMode = 'none' | 'path' | 'mtime';
export type GrepSortOrder = 'asc' | 'desc';
export type GrepMatchKind = 'match' | 'file' | 'occurrence';
export type GrepBackend = 'rg' | 'grep';

export interface NormalizedGrepInput {
  pattern: string;
  requestedPath: string;
  resolvedPath: string;
  searchPath: string;
  include?: string;
  globs: string[];
  excludeGlobs: string[];
  outputMode: GrepOutputMode;
  caseSensitive: boolean;
  smartCase: boolean;
  wordRegexp: boolean;
  context: number;
  beforeContext: number;
  afterContext: number;
  maxResults: number;
  maxCountPerFile?: number;
  timeoutMs: number;
  hidden: boolean;
  followSymlinks: boolean;
  fixedStrings: boolean;
  invertMatch: boolean;
  multiline: boolean;
  multilineDotall: boolean;
  pcre2: boolean;
  fileType?: string;
  fileTypes: string[];
  excludeFileTypes: string[];
  maxFilesize?: string;
  sortBy: GrepSortMode;
  sortOrder: GrepSortOrder;
  searchTargets?: string[];
  cwd: string;
  worktree: string;
  permissionPatterns: string[];
}

export interface GrepContextLine {
  lineNumber: number;
  text: string;
}

export interface GrepMatch {
  lineNumber: number;
  lineText: string;
  submatches: string[];
  before: GrepContextLine[];
  after: GrepContextLine[];
}

export interface GrepFileMatch {
  file: string;
  absolutePath: string;
  replayPath?: string;
  nonUtf8Path?: boolean;
  pathKey?: string;
  matchCount: number;
  matches: GrepMatch[];
}

export interface GrepSummaryData {
  elapsedTotalMs?: number;
  elapsedTotalHuman?: string;
  stats?: Record<string, unknown>;
}

export interface GrepSearchResult {
  files: GrepFileMatch[];
  totalMatches: number;
  totalFiles: number;
  backend?: GrepBackend;
  outputMode: GrepOutputMode;
  matchKind: GrepMatchKind;
  truncated: boolean;
  limitReached: boolean;
  timedOut: boolean;
  cancelled: boolean;
  exitCode: number;
  retryCount: number;
  command?: string[];
  cwd: string;
  stderr: string;
  warnings: string[];
  error?: string;
  summary?: GrepSummaryData;
  strategy?: 'direct' | 'mtime-hybrid' | 'mtime-fallback';
  discoveryCommand?: string[];
  replayBatchCount?: number;
  replayTargetCount?: number;
  discoveredFiles?: number;
  sortedFiles?: number;
  replayedFiles?: number;
  partialPhase?: 'discovery' | 'mtime-sort' | 'replay';
  mtimeDiscoveryCapped?: boolean;
}

export type GrepRunner = (
  input: NormalizedGrepInput,
  signal: AbortSignal,
) => Promise<GrepSearchResult>;

export interface RgTextPayload {
  text: string;
  bytes?: string;
}

export interface RgPathPayload {
  text?: string;
  bytes?: string;
}

export interface RgSubmatch {
  match: RgTextPayload;
  start: number;
  end: number;
}

interface RgLineData {
  path?: RgPathPayload;
  lines?: RgTextPayload;
  line_number?: number;
}

export interface RgMatchEvent {
  type: 'match';
  data: RgLineData & {
    path: RgPathPayload;
    lines: RgTextPayload;
    line_number: number;
    submatches: RgSubmatch[];
  };
}

export interface RgContextEvent {
  type: 'context';
  data: RgLineData;
}

export interface RgBeginEvent {
  type: 'begin';
  data: {
    path?: RgPathPayload;
  };
}

export interface RgEndEvent {
  type: 'end';
  data: {
    path?: RgPathPayload;
  };
}

export interface RgSummaryEvent {
  type: 'summary';
  data: {
    elapsed_total?: {
      human?: string;
      secs: number;
      nanos: number;
    };
    stats?: Record<string, unknown>;
  };
}

export type RgJsonEvent =
  | RgMatchEvent
  | RgContextEvent
  | RgBeginEvent
  | RgEndEvent
  | RgSummaryEvent;
