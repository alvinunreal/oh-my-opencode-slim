import { readFileSync } from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

/** Read the installed plugin version from the package shipped with this code. */
export function readPluginPackageVersion(): string | undefined {
  for (const packageUrl of [
    new URL('../../package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
  ]) {
    try {
      const metadata = JSON.parse(
        readFileSync(packageUrl, 'utf8'),
      ) as PackageMetadata;
      if (typeof metadata.version === 'string') return metadata.version;
    } catch {
      // Try the next package location for source and bundled execution.
    }
  }
  return undefined;
}
