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

export type MatchComparatorName =
  | 'exact'
  | 'trim-end'
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
  canonicalized?: boolean;
};

export type PatchHostFlavor = 'v1' | 'v2';

export type MatchHit = {
  start: number;
  del: number;
  add: string[];
};

export type SeekHit = {
  index: number;
  exact: boolean;
};

export type ResolvedChunk = {
  hit: MatchHit;
  canonical_old_lines: string[];
  canonical_new_lines: string[];
  canonical_change_context?: string;
  resolved_is_end_of_file: boolean;
  rewritten: boolean;
  // Half-open [canonical_start, canonical_end) range of the source lines
  // covered by the canonical representation. Used to keep serialized chunks
  // non-overlapping when rescue extends a chunk over shared context lines.
  canonical_start: number;
  canonical_end: number;
};

export type RescueResult =
  | { kind: 'miss' }
  | { kind: 'ambiguous'; phase: 'prefix_suffix' | 'lcs' }
  | { kind: 'match'; hit: MatchHit };

export type LineComparator = (a: string, b: string) => boolean;
