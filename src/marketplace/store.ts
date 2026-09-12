import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gt } from 'semver';
import {
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
} from './canonical';

export { digestMarketplaceBundle } from './canonical';

import { validateMarketplaceCompatibility } from './compatibility';
import {
  MarketplaceConflictError,
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
  MarketplaceValidationError,
} from './errors';
import {
  acquireMarketplaceLease,
  type MarketplaceLease,
  type MarketplaceLockOptions,
  syncDirectory,
  withMarketplaceLease,
  writeAtomic,
} from './lease';
import { getMarketplacePaths, type MarketplacePaths } from './paths';
import {
  MARKETPLACE_DIGEST_DOMAIN,
  MARKETPLACE_DIGEST_DOMAIN_V3,
  MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
  type MarketplaceLockEntry,
  type MarketplaceLockfile,
  MarketplaceLockfileSchema,
  type MarketplacePackageBundle,
  MarketplacePackageBundleSchema,
  type MarketplacePackageManifest,
  type MarketplaceSource,
  MarketplaceSourceSchema,
} from './schemas';

export type { MarketplaceLease, MarketplaceLockOptions };

export interface MarketplaceStoreOptions {
  rootDir?: string;
  pluginVersion?: string;
  lock?: Partial<MarketplaceLockOptions>;
}

export interface StoredMarketplacePackage {
  manifest: MarketplacePackageManifest;
  source: MarketplaceSource;
  digest: string;
  path: string;
}

export interface MarketplaceVerification {
  id: string;
  version?: string;
  valid: boolean;
  expectedDigest?: string;
  actualDigest?: string;
  message: string;
}

export interface MarketplaceStoreInspection {
  packages: StoredMarketplacePackage[];
  verifications: MarketplaceVerification[];
  lockfileError?: string;
  operationalError?: string;
}

/** Digest input is UTF-8 bytes of canonical stable JSON for `{ manifest }`. */
export const canonicalMarketplaceBundleBytes = canonicalizeMarketplaceValue;

function parseBundle(value: unknown): MarketplacePackageBundle {
  const result = MarketplacePackageBundleSchema.safeParse(value);
  if (!result.success) {
    throw new MarketplaceValidationError(result.error.message);
  }
  return result.data;
}

function packageVersionPath(
  paths: MarketplacePaths,
  id: string,
  version: string,
): string {
  const [namespace, name] = id.split('/');
  return path.join(paths.packagesDir, namespace, name, version);
}

function packageIdPath(paths: MarketplacePaths, id: string): string {
  const [namespace, name] = id.split('/');
  return path.join(paths.packagesDir, namespace, name);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

export function acquireMarketplaceLeaseForPaths(
  paths: MarketplacePaths,
  options: Partial<MarketplaceLockOptions> = {},
): MarketplaceLease {
  return acquireMarketplaceLease(paths, options);
}

function packageEntry(
  bundle: MarketplacePackageBundle,
  source: MarketplaceSource,
  digest: string,
): MarketplaceLockEntry {
  if (bundle.manifest.schemaVersion === 3) {
    return {
      manifestSchemaVersion: 3,
      manifestVersion: bundle.manifest.version,
      source,
      digest: {
        algorithm: 'sha256',
        domain: MARKETPLACE_DIGEST_DOMAIN_V3,
        value: digest,
      },
    };
  }
  return {
    manifestSchemaVersion: 2,
    manifestVersion: bundle.manifest.version,
    source,
    digest: {
      algorithm: 'sha256',
      domain: MARKETPLACE_DIGEST_DOMAIN,
      value: digest,
    },
  };
}

export class MarketplaceStore {
  readonly paths: MarketplacePaths;
  private readonly compatibility: MarketplaceStoreOptions;
  private readonly lockOptions: Partial<MarketplaceLockOptions>;

  constructor(options: MarketplaceStoreOptions = {}) {
    this.paths = getMarketplacePaths(options.rootDir);
    this.compatibility = options;
    this.lockOptions = options.lock ?? {};
  }

  /** Return a consistent lockfile snapshot. */
  getLockfile(): MarketplaceLockfile {
    return withMarketplaceLease(
      this.paths,
      () => this.readLockfile(),
      this.lockOptions,
    );
  }

  install(
    input: MarketplacePackageBundle,
    source: MarketplaceSource = { kind: 'in-memory', label: 'programmatic' },
  ): StoredMarketplacePackage {
    return this.mutatePackage(input, source, 'install');
  }

  update(
    input: MarketplacePackageBundle,
    source: MarketplaceSource = { kind: 'in-memory', label: 'programmatic' },
  ): StoredMarketplacePackage {
    return this.mutatePackage(input, source, 'update');
  }

  list(): StoredMarketplacePackage[] {
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        return Object.keys(lockfile.packages)
          .sort()
          .map((id) => this.loadLockedPackage(lockfile, id));
      },
      this.lockOptions,
    );
  }

  show(id: string): StoredMarketplacePackage {
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        return this.loadLockedPackage(lockfile, id);
      },
      this.lockOptions,
    );
  }

  /**
   * Reconcile once, snapshot the lockfile once, then integrity-load only
   * the selected package IDs. Other installed packages are not parsed.
   */
  loadSelected(ids: readonly string[]): {
    packages: Map<string, StoredMarketplacePackage>;
    errors: Map<string, Error>;
  } {
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        const packages = new Map<string, StoredMarketplacePackage>();
        const errors = new Map<string, Error>();
        const unique = [...new Set(ids)].sort();
        for (const id of unique) {
          try {
            packages.set(id, this.loadLockedPackage(lockfile, id));
          } catch (error) {
            errors.set(
              id,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
        return { packages, errors };
      },
      this.lockOptions,
    );
  }

  verify(id: string): MarketplaceVerification {
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        return this.verifyLocked(lockfile, id);
      },
      this.lockOptions,
    );
  }

  verifyAll(): MarketplaceVerification[] {
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        return Object.keys(lockfile.packages)
          .sort()
          .map((id) => this.verifyLocked(lockfile, id));
      },
      this.lockOptions,
    );
  }

  /**
   * Reconcile, read the lockfile, and load/verify every package under one
   * lease. Corrupt packages are reported instead of failing the snapshot.
   */
  inspectAll(): MarketplaceStoreInspection {
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        try {
          const lockfile = this.readLockfile();
          this.reconcileLockedState(lockfile, lease);
          const packages: StoredMarketplacePackage[] = [];
          const verifications: MarketplaceVerification[] = [];
          for (const id of Object.keys(lockfile.packages).sort()) {
            const entry = lockfile.packages[id];
            try {
              const stored = this.loadLockedPackage(lockfile, id);
              packages.push(stored);
              verifications.push({
                id,
                version: stored.manifest.version,
                valid: true,
                expectedDigest: entry?.digest.value,
                actualDigest: stored.digest,
                message: `${id}@${stored.manifest.version} verified`,
              });
            } catch (error) {
              if (error instanceof MarketplaceIntegrityError) {
                verifications.push({
                  id,
                  version: entry?.manifestVersion,
                  valid: false,
                  expectedDigest: entry?.digest.value,
                  message: error.message,
                });
                continue;
              }
              return {
                packages: [],
                verifications: [],
                operationalError:
                  error instanceof Error ? error.message : String(error),
              };
            }
          }
          return { packages, verifications };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (error instanceof MarketplaceLockfileError) {
            return { packages: [], verifications: [], lockfileError: message };
          }
          return {
            packages: [],
            verifications: [],
            operationalError: message,
          };
        }
      },
      this.lockOptions,
    );
  }

  remove(id: string, precondition?: () => void): void {
    withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        precondition?.();
        this.loadLockedPackage(lockfile, id);
        const packagePath = packageIdPath(this.paths, id);
        const [namespace, name] = id.split('/');
        const quarantinePath = path.join(
          this.paths.stagingDir,
          'removed',
          namespace,
          name,
        );
        lease.commit(() => {
          fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
          fs.renameSync(packagePath, quarantinePath);
          delete lockfile.packages[id];
          try {
            this.writeLockfileUnlocked(lockfile);
          } catch (error) {
            fs.renameSync(quarantinePath, packagePath);
            throw error;
          }
          try {
            fs.rmSync(quarantinePath, { recursive: true, force: true });
          } catch {
            // The committed lockfile makes the quarantine an orphan. The next
            // operation reconciles it without exposing transient package state.
          }
        });
      },
      this.lockOptions,
    );
  }

  private mutatePackage(
    input: MarketplacePackageBundle,
    source: MarketplaceSource,
    mode: 'install' | 'update',
  ): StoredMarketplacePackage {
    const bundle = parseBundle(input);
    validateMarketplaceCompatibility(bundle.manifest, this.compatibility);
    const sourceResult = MarketplaceSourceSchema.safeParse(source);
    if (!sourceResult.success) {
      throw new MarketplaceValidationError(sourceResult.error.message);
    }
    const normalizedSource = sourceResult.data;
    const digest = digestMarketplaceBundle(bundle);
    return withMarketplaceLease(
      this.paths,
      (lease) => {
        const lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
        const current = lockfile.packages[bundle.manifest.id];
        if (current) {
          const existing = this.loadLockedPackage(lockfile, bundle.manifest.id);
          if (
            mode === 'install' &&
            current.manifestVersion !== bundle.manifest.version
          ) {
            throw new MarketplaceConflictError(
              `${bundle.manifest.id} is installed at ${current.manifestVersion}; use update for an explicit version change`,
            );
          }
          if (
            mode === 'update' &&
            !gt(bundle.manifest.version, current.manifestVersion)
          ) {
            throw new MarketplaceConflictError(
              `${bundle.manifest.id}@${bundle.manifest.version} is not strictly newer than the installed ${current.manifestVersion}`,
            );
          }
          if (
            current.manifestVersion === bundle.manifest.version &&
            existing.digest !== digest
          ) {
            throw new MarketplaceConflictError(
              `${bundle.manifest.id}@${bundle.manifest.version} is already locked with a different digest`,
            );
          }
          if (existing.digest === digest) {
            if (mode === 'update') {
              throw new MarketplaceConflictError(
                `${bundle.manifest.id}@${bundle.manifest.version} is already selected; updates require a new exact version`,
              );
            }
            return existing;
          }
        }

        if (mode === 'update' && !current) {
          throw new MarketplaceConflictError(
            `${bundle.manifest.id} is not installed; updates require an existing package`,
          );
        }

        const versionPath = packageVersionPath(
          this.paths,
          bundle.manifest.id,
          bundle.manifest.version,
        );
        try {
          return lease.commit(() => {
            this.publishBundle(versionPath, bundle, digest);
            lockfile.packages[bundle.manifest.id] = packageEntry(
              bundle,
              normalizedSource,
              digest,
            );
            this.writeLockfileUnlocked(lockfile);
            return this.toStored(versionPath, bundle, normalizedSource, digest);
          });
        } catch (error) {
          try {
            lease.commit(() => {
              fs.rmSync(versionPath, { recursive: true, force: true });
            });
          } catch {
            // A fenced owner leaves the unique version directory for reconciliation.
          }
          throw error;
        }
      },
      this.lockOptions,
    );
  }

  private readLockfile(): MarketplaceLockfile {
    if (!fs.existsSync(this.paths.lockfilePath)) {
      return {
        schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
        packages: {},
      };
    }
    let parsed: unknown;
    try {
      parsed = readJson(this.paths.lockfilePath);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new MarketplaceLockfileError(
          `Marketplace lockfile is invalid: ${error.message}`,
        );
      }
      throw error;
    }
    const result = MarketplaceLockfileSchema.safeParse(parsed);
    if (!result.success) {
      throw new MarketplaceLockfileError(
        `Marketplace lockfile is invalid: ${result.error.message}`,
      );
    }
    return result.data;
  }

  private verifyLocked(
    lockfile: MarketplaceLockfile,
    id: string,
  ): MarketplaceVerification {
    const entry = lockfile.packages[id];
    if (!entry) return { id, valid: false, message: `${id} is not installed` };
    try {
      const stored = this.loadLockedPackage(lockfile, id);
      return {
        id,
        version: stored.manifest.version,
        valid: true,
        expectedDigest: entry.digest.value,
        actualDigest: stored.digest,
        message: `${id}@${stored.manifest.version} verified`,
      };
    } catch (error) {
      return {
        id,
        version: entry.manifestVersion,
        valid: false,
        expectedDigest: entry.digest.value,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Remove abandoned temporary data and unreferenced immutable versions. */
  private reconcileLockedState(
    lockfile: MarketplaceLockfile,
    lease: MarketplaceLease,
  ): void {
    lease.commit(() => this.reconcileLockedStateUnlocked(lockfile));
  }

  private reconcileLockedStateUnlocked(lockfile: MarketplaceLockfile): void {
    const removedRoot = path.join(this.paths.stagingDir, 'removed');
    if (fs.existsSync(removedRoot)) {
      for (const namespace of fs.readdirSync(removedRoot, {
        withFileTypes: true,
      })) {
        if (!namespace.isDirectory()) continue;
        for (const name of fs.readdirSync(
          path.join(removedRoot, namespace.name),
          {
            withFileTypes: true,
          },
        )) {
          if (!name.isDirectory()) continue;
          const id = `${namespace.name}/${name.name}`;
          const quarantinePath = path.join(
            removedRoot,
            namespace.name,
            name.name,
          );
          const packagePath = packageIdPath(this.paths, id);
          if (lockfile.packages[id] && !fs.existsSync(packagePath)) {
            fs.mkdirSync(path.dirname(packagePath), { recursive: true });
            fs.renameSync(quarantinePath, packagePath);
          } else {
            fs.rmSync(quarantinePath, { recursive: true, force: true });
          }
        }
      }
    }
    if (fs.existsSync(this.paths.stagingDir)) {
      for (const entry of fs.readdirSync(this.paths.stagingDir)) {
        fs.rmSync(path.join(this.paths.stagingDir, entry), {
          recursive: true,
          force: true,
        });
      }
    }
    if (!fs.existsSync(this.paths.packagesDir)) return;
    for (const namespace of fs.readdirSync(this.paths.packagesDir, {
      withFileTypes: true,
    })) {
      if (!namespace.isDirectory()) continue;
      const namespacePath = path.join(this.paths.packagesDir, namespace.name);
      for (const name of fs.readdirSync(namespacePath, {
        withFileTypes: true,
      })) {
        if (!name.isDirectory()) continue;
        const id = `${namespace.name}/${name.name}`;
        const packagePath = path.join(namespacePath, name.name);
        const selected = lockfile.packages[id]?.manifestVersion;
        for (const version of fs.readdirSync(packagePath, {
          withFileTypes: true,
        })) {
          if (!version.isDirectory() || version.name === selected) continue;
          fs.rmSync(path.join(packagePath, version.name), {
            recursive: true,
            force: true,
          });
        }
      }
    }
  }

  /** Every package read goes through this locked identity/integrity path. */
  private loadLockedPackage(
    lockfile: MarketplaceLockfile,
    id: string,
  ): StoredMarketplacePackage {
    const entry = lockfile.packages[id];
    if (!entry) throw new MarketplaceIntegrityError(`${id} is not installed`);
    const versionPath = packageVersionPath(
      this.paths,
      id,
      entry.manifestVersion,
    );
    const packageFile = path.join(versionPath, 'package.json');
    const digestFile = path.join(versionPath, 'sha256');
    try {
      const bundle = parseBundle(readJson(packageFile));
      const digest = digestMarketplaceBundle(bundle);
      const sidecar = fs.readFileSync(digestFile, 'utf8').trim();
      if (
        bundle.manifest.id !== id ||
        bundle.manifest.version !== entry.manifestVersion ||
        bundle.manifest.schemaVersion !== entry.manifestSchemaVersion ||
        sidecar !== digest ||
        entry.digest.algorithm !== 'sha256' ||
        entry.digest.domain !==
          (bundle.manifest.schemaVersion === 3
            ? MARKETPLACE_DIGEST_DOMAIN_V3
            : MARKETPLACE_DIGEST_DOMAIN) ||
        entry.digest.value !== digest
      ) {
        throw new MarketplaceIntegrityError(
          `Integrity or identity mismatch for ${id}@${entry.manifestVersion}`,
        );
      }
      return this.toStored(versionPath, bundle, entry.source, digest);
    } catch (error) {
      if (error instanceof MarketplaceIntegrityError) throw error;
      if (
        error instanceof MarketplaceValidationError ||
        error instanceof SyntaxError
      ) {
        throw new MarketplaceIntegrityError(
          `Cannot load ${id}@${entry.manifestVersion}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  private publishBundle(
    versionPath: string,
    bundle: MarketplacePackageBundle,
    digest: string,
  ): void {
    if (fs.existsSync(versionPath)) {
      throw new MarketplaceConflictError(
        `${bundle.manifest.id}@${bundle.manifest.version} already exists in the immutable store`,
      );
    }
    const temporaryPath = path.join(
      this.paths.stagingDir,
      `package-${process.pid}-${randomUUID()}`,
    );
    try {
      fs.mkdirSync(temporaryPath, { recursive: true });
      writeAtomic(
        path.join(temporaryPath, 'package.json'),
        `${canonicalizeMarketplaceValue(bundle)}\n`,
      );
      writeAtomic(path.join(temporaryPath, 'sha256'), `${digest}\n`);
      fs.mkdirSync(path.dirname(versionPath), { recursive: true });
      fs.renameSync(temporaryPath, versionPath);
      syncDirectory(path.dirname(versionPath));
    } finally {
      try {
        if (fs.existsSync(temporaryPath)) {
          fs.rmSync(temporaryPath, { recursive: true, force: true });
        }
      } catch {
        // A staged directory is never part of the active package set.
      }
    }
  }

  private writeLockfileUnlocked(lockfile: MarketplaceLockfile): void {
    const normalized: MarketplaceLockfile = {
      schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
      packages: Object.fromEntries(
        Object.entries(lockfile.packages).sort(([a], [b]) =>
          compareMarketplaceCodeUnits(a, b),
        ),
      ),
    };
    writeAtomic(
      this.paths.lockfilePath,
      `${canonicalizeMarketplaceValue(normalized)}\n`,
    );
  }

  private toStored(
    packagePath: string,
    bundle: MarketplacePackageBundle,
    source: MarketplaceSource,
    digest: string,
  ): StoredMarketplacePackage {
    return {
      manifest: bundle.manifest,
      source,
      digest,
      path: packagePath,
    };
  }
}
