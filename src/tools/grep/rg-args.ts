import { RG_BINARY } from './constants';
import type { NormalizedGrepInput } from './types';

export function appendContextArgs(
  args: string[],
  input: Pick<
    NormalizedGrepInput,
    'afterContext' | 'beforeContext' | 'outputMode'
  >,
): void {
  if (input.outputMode !== 'content') {
    return;
  }

  if (input.beforeContext <= 0 && input.afterContext <= 0) {
    return;
  }

  if (input.beforeContext === input.afterContext) {
    args.push('-C', String(input.beforeContext));
    return;
  }

  if (input.beforeContext > 0) {
    args.push('-B', String(input.beforeContext));
  }

  if (input.afterContext > 0) {
    args.push('-A', String(input.afterContext));
  }
}

function appendFileTypeArgs(
  args: string[],
  input: Pick<NormalizedGrepInput, 'excludeFileTypes' | 'fileTypes'>,
): void {
  for (const fileType of input.fileTypes) {
    args.push('--type', fileType);
  }

  for (const fileType of input.excludeFileTypes) {
    args.push('--type-not', fileType);
  }
}

export function buildRgArgs(input: NormalizedGrepInput): string[] {
  const args = ['--no-config', '--color', 'never'];

  if (input.outputMode === 'files_with_matches') {
    args.push('--null', '--files-with-matches', '--with-filename');
  }

  if (input.outputMode === 'content') {
    args.push('--json', '--with-filename', '--line-number', '--stats');
  }

  if (input.outputMode === 'count') {
    args.push('--null', '--count-matches', '--with-filename');
  }

  if (input.sortBy === 'path') {
    args.push(input.sortOrder === 'desc' ? '--sortr' : '--sort', 'path');
  }

  if (input.smartCase) {
    args.push('--smart-case');
  } else if (!input.caseSensitive) {
    args.push('-i');
  }

  if (input.wordRegexp) {
    args.push('-w');
  }

  appendContextArgs(args, input);

  if (input.maxCountPerFile) {
    args.push('--max-count', String(input.maxCountPerFile));
  }

  if (input.fixedStrings) {
    args.push('--fixed-strings');
  }

  if (input.invertMatch) {
    args.push('--invert-match');
  }

  if (input.multiline) {
    args.push('--multiline');
  }

  if (input.multilineDotall) {
    args.push('--multiline-dotall');
  }

  if (input.pcre2) {
    args.push('--pcre2');
  }

  appendFileTypeArgs(args, input);

  if (input.maxFilesize) {
    args.push('--max-filesize', input.maxFilesize);
  }

  if (input.include) {
    args.push('--glob', input.include);
  }

  for (const glob of input.globs) {
    args.push('--glob', glob);
  }

  for (const glob of input.excludeGlobs) {
    const normalizedGlob = glob.startsWith('!') ? glob : `!${glob}`;
    args.push('--glob', normalizedGlob);
  }

  if (input.hidden) {
    args.push('--hidden');
  }

  if (input.followSymlinks) {
    args.push('--follow');
  }

  args.push(
    '--regexp',
    input.pattern,
    ...(input.searchTargets ?? [input.searchPath]),
  );
  return args;
}

export function buildRgCommand(
  input: NormalizedGrepInput,
  binaryPath = RG_BINARY,
): string[] {
  return [binaryPath, ...buildRgArgs(input)];
}
