export type ApplyPatchRuntimeOptions = {
  prefixSuffix: boolean;
  lcsRescue: boolean;
};

export type ApplyPatchErrorKind =
  | 'blocked'
  | 'validation'
  | 'verification'
  | 'internal';

export type ApplyPatchErrorCode =
  | 'malformed_patch'
  | 'outside_workspace'
  | 'verification_failed'
  | 'internal_unexpected';

export type ApplyPatchRescueStrategy = 'prefix/suffix' | 'lcs' | 'anchor';

export type MatchComparatorName =
  | 'exact'
  | 'unicode'
  | 'trim-end'
  | 'unicode-trim-end'
  | 'trim'
  | 'unicode-trim';

export type PatchChunk = {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
};

export type AddPatchHunk = {
  type: 'add';
  path: string;
  contents: string;
};

export type DeletePatchHunk = {
  type: 'delete';
  path: string;
};

export type UpdatePatchHunk = {
  type: 'update';
  path: string;
  move_path?: string;
  chunks: PatchChunk[];
};

export type PatchHunk = AddPatchHunk | DeletePatchHunk | UpdatePatchHunk;

export type ParsedPatch = {
  hunks: PatchHunk[];
};

export type AddPreparedChange = {
  type: 'add';
  file: string;
  text: string;
};

export type DeletePreparedChange = {
  type: 'delete';
  file: string;
};

export type UpdatePreparedChange = {
  type: 'update';
  file: string;
  move?: string;
  text: string;
};

export type PreparedChange =
  | AddPreparedChange
  | DeletePreparedChange
  | UpdatePreparedChange;

export type MatchHit = {
  start: number;
  del: number;
  add: string[];
};

export type SeekHit = {
  index: number;
  comparator: MatchComparatorName;
  exact: boolean;
};

export type ResolvedChunk = {
  hit: MatchHit;
  old_lines: string[];
  canonical_old_lines: string[];
  canonical_new_lines: string[];
  canonical_change_context?: string;
  resolved_is_end_of_file: boolean;
  rewritten: boolean;
  strategy?: ApplyPatchRescueStrategy;
  matchComparator?: MatchComparatorName;
};

export type RescueResult =
  | { kind: 'miss' }
  | { kind: 'ambiguous'; phase: 'prefix_suffix' | 'lcs' }
  | { kind: 'match'; hit: MatchHit };

export type LineComparator = (a: string, b: string) => boolean;
