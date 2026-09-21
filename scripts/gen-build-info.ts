#!/usr/bin/env bun

/**
 * Generates src/generated/build-info.ts: the plugin version (from
 * package.json) and the build timestamp as two string constants, so
 * runtime logs can identify the exact build that produced them.
 *
 * Runs as the first step of `bun run build`. The committed stamp is
 * owned by `postversion`, which re-runs this script with `--force` and
 * amends the release commit. An ordinary (unforced) run keeps the
 * committed stamp whenever the on-disk file already carries the current
 * package version: it only writes when the file is absent, the version
 * changed, or the file no longer matches the generated template. This
 * keeps repeated dev builds from dirtying tracked source; the trade-off
 * is that BUILD_TIME identifies the release stamp, not each local build.
 *
 * ALL console output goes to STDERR. CI packs the artifact with
 * `npm pack --json --ignore-scripts`; the runner npm still executes the
 * `prepare` script (the build) there, and a `[gen-build-info] …` line on
 * STDOUT would shift the first `[` that
 * scripts/verify-release-artifact.ts `parsePackJson` slices from,
 * breaking its JSON parse with `Unexpected identifier "gen"`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Diagnostics sink; injectable so tests can assert the STDOUT contract. */
export type BuildInfoWriter = {
  error: (message: string) => void;
};

export const defaultBuildInfoWriter: BuildInfoWriter = {
  error: (message) => console.error(message),
};

export function renderBuildInfoSource(
  version: string,
  buildTime: string,
): string {
  return `/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of \`bun run build\`); do not edit by hand.
 *
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '${version}';
export const BUILD_TIME = '${buildTime}';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; buildTime: string } {
  return { version: BUILD_VERSION, buildTime: BUILD_TIME };
}
`;
}

/** Write the stamp iff needed. Unforced: the file is kept as-is when it
 * already matches the generated template for the current package version
 * (only its BUILD_TIME may differ), so dev builds never dirty tracked
 * source. `force` always restamps with a fresh BUILD_TIME (`postversion`
 * uses this for the release commit). Returns whether the file was
 * rewritten. */
export function generateBuildInfo(options: {
  rootDir: string;
  force?: boolean;
  now?: () => Date;
  writer?: BuildInfoWriter;
}): { wrote: boolean } {
  const writer = options.writer ?? defaultBuildInfoWriter;
  const pkg = JSON.parse(
    readFileSync(join(options.rootDir, 'package.json'), 'utf8'),
  ) as {
    version?: unknown;
  };

  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no usable "version" field');
  }

  if (/['\\]/.test(pkg.version)) {
    throw new Error('package.json "version" contains a quote or backslash');
  }

  const buildTime = (options.now ?? (() => new Date()))().toISOString();
  const contents = renderBuildInfoSource(pkg.version, buildTime);
  const outputPath = join(options.rootDir, 'src', 'generated', 'build-info.ts');

  let previous: string | undefined;
  try {
    previous = readFileSync(outputPath, 'utf8');
  } catch {
    previous = undefined; // Absent (fresh checkout / clean dist): write it.
  }

  if (!options.force && previous !== undefined) {
    const previousTime = previous.match(
      /^export const BUILD_TIME = '([^'\\]*)';$/m,
    )?.[1];
    if (
      previousTime !== undefined &&
      previous === renderBuildInfoSource(pkg.version, previousTime)
    ) {
      writer.error(
        `[gen-build-info] ${outputPath} already current (version ${pkg.version}, built ${previousTime}); not rewritten`,
      );
      return { wrote: false };
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
  writer.error(
    `[gen-build-info] wrote ${outputPath} (version ${pkg.version}, built ${buildTime})`,
  );
  return { wrote: true };
}

if (import.meta.main) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  generateBuildInfo({
    rootDir: join(__dirname, '..'),
    force: process.argv.includes('--force'),
  });
}
