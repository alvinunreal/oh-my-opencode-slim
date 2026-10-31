/**
 * Packaged dist import-closure verification (build-contract, scripts-only).
 *
 * Every relative import — static `import ... from './x'`, `export ... from`,
 * side-effect imports, and dynamic `await import('./x')` — emitted into a
 * `dist/**.js` bundle must resolve to another file inside the packaged `dist/`
 * tree that npm actually ships. With `--splitting`, dist/server/index.js,
 * dist/tui2.js, dist/tui.js and dist/cli/index.js reference hashed chunks
 * under `dist/chunks/`, `dist/server/chunks/`, and `dist/cli/chunks/`, and
 * those chunks import each other across directory levels (`../`). A chunk
 * that is built but not packaged (or a target that escapes `dist/`) breaks
 * the installed package at runtime, so this fails the release check.
 *
 * Bare specifiers (`zod`, `@opencode-ai/plugin`, `node:fs`, ...) are
 * externals or builtins and are ignored.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIST_PREFIX = 'dist/';

/** Import kinds reported by Bun.Transpiler.scan(). */
type ScannedImport = {
  kind: string;
  path: string;
};

/**
 * Verify the import closure of every packaged `dist/**.js` file.
 *
 * @param repoRoot absolute repository root (the files are read from disk)
 * @param packagedFiles npm pack file list (POSIX paths relative to repoRoot)
 * @throws Error with the actionable `importer -> missing target` chain
 */
export function verifyPackagedImportClosure(
  repoRoot: string,
  packagedFiles: Set<string>,
): void {
  const distJsFiles = [...packagedFiles]
    .filter((file) => file.startsWith(DIST_PREFIX) && file.endsWith('.js'))
    .sort();

  const transpiler = new Bun.Transpiler({ loader: 'js' });

  for (const file of distJsFiles) {
    const absolutePath = path.join(repoRoot, file);
    let source: string;
    try {
      source = readFileSync(absolutePath, 'utf8');
    } catch {
      throw new Error(
        `Packaged import closure cannot read ${file}: it is listed by npm pack but missing on disk under ${repoRoot}`,
      );
    }

    const imports = transpiler.scan(source).imports as ScannedImport[];
    for (const { kind, path: specifier } of imports) {
      if (!specifier.startsWith('.')) continue; // external / builtin

      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );

      if (!target.startsWith(DIST_PREFIX)) {
        throw new Error(
          `Packaged import closure escapes dist/: ${file} ${describeKind(
            kind,
          )} ${JSON.stringify(specifier)} resolves to ${JSON.stringify(
            target,
          )}, which is outside the packaged dist/ directory`,
        );
      }

      if (!packagedFiles.has(target)) {
        throw new Error(
          `Packaged import closure is broken: ${file} ${describeKind(
            kind,
          )} ${JSON.stringify(specifier)} resolves to ${target}, which is not included in the npm tarball (package.json "files")`,
        );
      }
    }
  }
}

function describeKind(kind: string): string {
  return kind === 'dynamic-import' ? 'dynamically imports' : 'imports';
}
