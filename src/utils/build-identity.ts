import { getBuildInfo } from '../generated/build-info';

/**
 * Runtime build identity for diagnostics logs: the build-time constants
 * plus the resolved module entry URL.
 *
 * The entry answers "which copy of the plugin actually loaded" — hosts
 * resolve a bare plugin name through their own package cache, so several
 * copies of the plugin can coexist on disk (host npm cache, packages
 * installs) and only the loaded entry proves which one is running.
 * Incident 2026-09-27: a stale pre-fix 2.2.19 from the host's npm cache
 * ran while a fixed build sat installed elsewhere, and the plugin log
 * could not reveal the mismatch — the entry had to be recovered from the
 * host's own log after the fact.
 */
export function pluginBuildIdentity(): {
  version: string;
  buildTime: string;
  entry: string[];
} {
  // Path segments, not the raw URL: the logger's redaction choke point
  // masks opaque runs of 32+ characters, which collapses a full file URL
  // into something like "file:///home…js" and hides exactly the
  // cache-vs-install distinction this field exists to expose. Segments
  // stay under the masking threshold individually and remain readable.
  return { ...getBuildInfo(), entry: import.meta.url.split('/') };
}
