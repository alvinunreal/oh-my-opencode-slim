/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of `bun run build`); do not edit by hand.
 *
 * This committed copy is the offline placeholder: the version mirrors
 * package.json so tests pass without a build, and the epoch build time
 * marks it as never-really-built. A real build overwrites both values.
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '2.2.21';
export const BUILD_TIME = '1970-01-01T00:00:00.000Z';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; buildTime: string } {
  return { version: BUILD_VERSION, buildTime: BUILD_TIME };
}
