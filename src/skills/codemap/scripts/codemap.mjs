#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.1';
export const STATE_DIR = '.slim';
export const STATE_FILE = 'codemap.json';
export const LEGACY_STATE_FILE = 'cartography.json';
export const CODEMAP_FILE = 'codemap.md';

export class PatternMatcher {
  regex;

  constructor(patterns) {
    if (!patterns.length) {
      this.regex = null;
      return;
    }

    const regexParts = patterns.map((pattern) => {
      let reg = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      reg = reg.replace(/\\\*\\\*\//g, '(?:.*/)?');
      reg = reg.replace(/\\\*\\\*/g, '.*');
      reg = reg.replace(/\\\*/g, '[^/]*');
      reg = reg.replace(/\\\?/g, '.');

      if (pattern.endsWith('/')) {
        reg += '.*';
      }

      if (pattern.startsWith('/')) {
        reg = `^${reg.slice(1)}`;
      } else {
        reg = `(?:^|.*/)${reg}`;
      }

      return `(?:${reg}$)`;
    });

    this.regex = new RegExp(regexParts.join('|'));
  }

  matches(filePath) {
    if (!this.regex) return false;
    return this.regex.test(filePath);
  }
}

export function loadGitignore(root) {
  const gitignorePath = path.join(root, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  return readFileSync(gitignorePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function walkFiles(root) {
  const files = [];

  function visit(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          visit(fullPath);
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  visit(root);
  return files.sort();
}

export function selectFiles(
  root,
  includePatterns,
  excludePatterns,
  exceptions,
  gitignorePatterns,
) {
  const includeMatcher = new PatternMatcher(includePatterns);
  const excludeMatcher = new PatternMatcher(excludePatterns);
  const gitignoreMatcher = new PatternMatcher(gitignorePatterns);
  const exceptionSet = new Set(exceptions);

  return walkFiles(root).filter((fullPath) => {
    let relPath = path.relative(root, fullPath).replaceAll(path.sep, '/');
    if (relPath.startsWith('./')) {
      relPath = relPath.slice(2);
    }

    if (gitignoreMatcher.matches(relPath)) return false;
    if (excludeMatcher.matches(relPath) && !exceptionSet.has(relPath)) {
      return false;
    }

    return includeMatcher.matches(relPath) || exceptionSet.has(relPath);
  });
}

export function computeFileHash(filePath) {
  try {
    const buffer = readFileSync(filePath);
    return createHash('md5').update(buffer).digest('hex');
  } catch {
    return '';
  }
}

export function computeFolderHash(folder, fileHashes) {
  const folderFiles = Object.entries(fileHashes)
    .filter(
      ([filePath]) =>
        filePath.startsWith(`${folder}/`) ||
        (folder === '.' && !filePath.includes('/')),
    )
    .sort(([a], [b]) => a.localeCompare(b));

  if (!folderFiles.length) return '';

  const hasher = createHash('md5');
  for (const [filePath, hash] of folderFiles) {
    hasher.update(`${filePath}:${hash}\n`);
  }
  return hasher.digest('hex');
}

export function getFoldersWithFiles(files, root) {
  const folders = new Set(['.']);

  for (const filePath of files) {
    const relPath = path.relative(root, filePath).replaceAll(path.sep, '/');
    const parts = relPath.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      folders.add(parts.slice(0, i + 1).join('/'));
    }
  }

  return folders;
}

export function migrateLegacyState(root) {
  const stateDir = path.join(root, STATE_DIR);
  const legacyPath = path.join(stateDir, LEGACY_STATE_FILE);
  const statePath = path.join(stateDir, STATE_FILE);

  if (existsSync(statePath) || !existsSync(legacyPath)) {
    return false;
  }

  mkdirSync(stateDir, { recursive: true });
  renameSync(legacyPath, statePath);
  console.log(
    `Migrated ${STATE_DIR}/${LEGACY_STATE_FILE} -> ${STATE_DIR}/${STATE_FILE}`,
  );
  return true;
}

export function loadState(root) {
  migrateLegacyState(root);
  const statePath = path.join(root, STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(root, state) {
  const stateDir = path.join(root, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export function createEmptyCodemap(folderPath, folderName) {
  const codemapPath = path.join(folderPath, CODEMAP_FILE);
  if (existsSync(codemapPath)) return;

  const content = `# ${folderName}/

<!-- Fixer: Fill in this section with architectural understanding -->

## Responsibility

<!-- What is this folder's job in the system? -->

## Design

<!-- Key patterns, abstractions, architectural decisions -->

## Flow

<!-- How does data/control flow through this module? -->

## Integration

<!-- How does it connect to other parts of the system? -->
`;

  writeFileSync(codemapPath, content);
}

function buildState(
  root,
  includePatterns,
  excludePatterns,
  exceptions,
  selectedFiles,
) {
  const fileHashes = {};
  for (const filePath of selectedFiles) {
    const relPath = path.relative(root, filePath).replaceAll(path.sep, '/');
    fileHashes[relPath] = computeFileHash(filePath);
  }

  const folders = getFoldersWithFiles(selectedFiles, root);
  const folderHashes = {};
  for (const folder of folders) {
    folderHashes[folder] = computeFolderHash(folder, fileHashes);
  }

  const state = {
    metadata: {
      version: VERSION,
      last_run: new Date().toISOString(),
      root,
      include_patterns: includePatterns,
      exclude_patterns: excludePatterns,
      exceptions,
    },
    file_hashes: fileHashes,
    folder_hashes: folderHashes,
  };

  return { state, folders };
}

export function cmdInit({ root, include = [], exclude = [], exception = [] }) {
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    console.error(`Error: ${resolvedRoot} is not a directory`);
    return 1;
  }

  const includePatterns = include.length ? include : ['**/*'];
  const excludePatterns = exclude;
  const exceptions = exception;
  const gitignore = loadGitignore(resolvedRoot);

  console.log(`Scanning ${resolvedRoot}...`);
  console.log(`Include patterns: ${JSON.stringify(includePatterns)}`);
  console.log(`Exclude patterns: ${JSON.stringify(excludePatterns)}`);
  console.log(`Exceptions: ${JSON.stringify(exceptions)}`);

  const selectedFiles = selectFiles(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    gitignore,
  );

  console.log(`Selected ${selectedFiles.length} files`);

  const { state, folders } = buildState(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    selectedFiles,
  );

  saveState(resolvedRoot, state);
  console.log(`Created ${STATE_DIR}/${STATE_FILE}`);

  for (const folder of folders) {
    const folderPath =
      folder === '.' ? resolvedRoot : path.join(resolvedRoot, folder);
    const folderName = folder === '.' ? path.basename(resolvedRoot) : folder;
    createEmptyCodemap(folderPath, folderName);
  }

  console.log(`Created ${folders.size} empty codemap.md files`);
  return 0;
}

export function cmdChanges({ root }) {
  const resolvedRoot = path.resolve(root);
  const state = loadState(resolvedRoot);
  if (!state) {
    console.error("No codemap state found. Run 'init' first.");
    return 1;
  }

  const metadata = state.metadata ?? {};
  const includePatterns = metadata.include_patterns ?? ['**/*'];
  const excludePatterns = metadata.exclude_patterns ?? [];
  const exceptions = metadata.exceptions ?? [];
  const gitignore = loadGitignore(resolvedRoot);

  const currentFiles = selectFiles(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    gitignore,
  );

  const currentHashes = Object.fromEntries(
    currentFiles.map((filePath) => [
      path.relative(resolvedRoot, filePath).replaceAll(path.sep, '/'),
      computeFileHash(filePath),
    ]),
  );

  const savedHashes = state.file_hashes ?? {};
  const currentPaths = new Set(Object.keys(currentHashes));
  const savedPaths = new Set(Object.keys(savedHashes));

  const added = [...currentPaths]
    .filter((filePath) => !savedPaths.has(filePath))
    .sort();
  const removed = [...savedPaths]
    .filter((filePath) => !currentPaths.has(filePath))
    .sort();
  const modified = [...currentPaths]
    .filter((filePath) => savedPaths.has(filePath))
    .filter((filePath) => currentHashes[filePath] !== savedHashes[filePath])
    .sort();

  if (!added.length && !removed.length && !modified.length) {
    console.log('No changes detected.');
    return 0;
  }

  if (added.length) {
    console.log(`\n${added.length} added:`);
    for (const filePath of added) console.log(`  + ${filePath}`);
  }

  if (removed.length) {
    console.log(`\n${removed.length} removed:`);
    for (const filePath of removed) console.log(`  - ${filePath}`);
  }

  if (modified.length) {
    console.log(`\n${modified.length} modified:`);
    for (const filePath of modified) console.log(`  ~ ${filePath}`);
  }

  const affectedFolders = new Set(['.']);
  for (const filePath of [...added, ...removed, ...modified]) {
    const parts = filePath.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      affectedFolders.add(parts.slice(0, i + 1).join('/'));
    }
  }

  const sortedFolders = [...affectedFolders].sort();
  console.log(`\n${sortedFolders.length} folders affected:`);
  for (const folder of sortedFolders) {
    console.log(`  ${folder}/`);
  }

  return 0;
}

export function cmdUpdate({ root }) {
  const resolvedRoot = path.resolve(root);
  const state = loadState(resolvedRoot);
  if (!state) {
    console.error("No codemap state found. Run 'init' first.");
    return 1;
  }

  const metadata = state.metadata ?? {};
  const includePatterns = metadata.include_patterns ?? ['**/*'];
  const excludePatterns = metadata.exclude_patterns ?? [];
  const exceptions = metadata.exceptions ?? [];
  const gitignore = loadGitignore(resolvedRoot);

  const selectedFiles = selectFiles(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    gitignore,
  );

  const { state: nextState } = buildState(
    resolvedRoot,
    includePatterns,
    excludePatterns,
    exceptions,
    selectedFiles,
  );

  saveState(resolvedRoot, nextState);
  console.log(
    `Updated ${STATE_DIR}/${STATE_FILE} with ${selectedFiles.length} files`,
  );
  return 0;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { include: [], exclude: [], exception: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];

    if (!arg?.startsWith('--')) continue;
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    const key = arg.slice(2);
    if (key === 'include' || key === 'exclude' || key === 'exception') {
      options[key].push(value);
    } else if (key === 'root') {
      options.root = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    i++;
  }

  return { command, options };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);

    if (!command || !options.root) {
      console.error(
        'Usage: codemap.mjs <init|changes|update> --root /path [--include glob] [--exclude glob] [--exception path]',
      );
      return 1;
    }

    if (command === 'init') return cmdInit(options);
    if (command === 'changes') return cmdChanges(options);
    if (command === 'update') return cmdUpdate(options);

    console.error(`Unknown command: ${command}`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  process.exit(main());
}
