import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gt } from 'semver';
import {
  canonicalizeMarketplaceValue,
  compareMarketplaceCodeUnits,
  digestMarketplaceBundle,
} from './canonical.js';
import { satisfiesPluginCompatibility } from './compatibility.js';
import {
  MarketplaceCompatibilityError,
  MarketplaceConflictError,
  MarketplaceIntegrityError,
  MarketplaceLockfileError,
  MarketplaceLockOwnershipError,
  MarketplaceValidationError,
} from './errors.js';
import { normalizeMarketplacePackageId } from './ids.js';
import {
  acquireMarketplaceLease,
  type MarketplaceLease,
  type MarketplaceLockOptions,
  normalizeLockOptions,
  syncDirectory,
  writeAtomic,
} from './lease.js';
import { getMarketplacePaths, type MarketplacePaths } from './paths.js';
import {
  MARKETPLACE_DIGEST_DOMAIN,
  MARKETPLACE_DIGEST_DOMAIN_V3,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3,
  type MarketplacePackageBundle,
  MarketplacePackageBundleSchema,
  type MarketplacePackageManifest,
  MarketplaceVersionSchema,
} from './schemas.js';
import {
  MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
  type MarketplaceLockEntry,
  type MarketplaceLockfile,
  MarketplaceLockfileSchema,
  type MarketplaceSource,
  MarketplaceSourceSchema,
} from './store-schemas.js';

export type { MarketplaceLease, MarketplaceLockOptions } from './lease.js';

export interface MarketplaceStoreOptions {
  pluginVersion: string;
  rootDir?: string;
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

type MutationMode = 'install' | 'update';
const PACKAGE_READ_ERROR_CODES = new Set([
  'EACCES',
  'EBADF',
  'EBUSY',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPackageReadFailure(error: unknown): boolean {
  if (error instanceof MarketplaceIntegrityError) return true;
  const code = errnoCode(error);
  return code !== undefined && PACKAGE_READ_ERROR_CODES.has(code);
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function packageVersionPath(
  paths: MarketplacePaths,
  id: string,
  version: string,
): string {
  const [publisher, name] = id.split('/');
  return path.join(paths.packagesDir, publisher, name, version);
}

function packageIdPath(paths: MarketplacePaths, id: string): string {
  const [publisher, name] = id.split('/');
  return path.join(paths.packagesDir, publisher, name);
}

function sourceFrom(value: unknown): MarketplaceSource {
  const parsed = MarketplaceSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new MarketplaceValidationError(parsed.error.message);
  }
  return parsed.data;
}

function bundleFrom(value: unknown): MarketplacePackageBundle {
  const parsed = MarketplacePackageBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new MarketplaceValidationError(parsed.error.message);
  }
  return parsed.data;
}

function packageEntry(
  bundle: MarketplacePackageBundle,
  source: MarketplaceSource,
  digest: string,
): MarketplaceLockEntry {
  if (
    bundle.manifest.schemaVersion === MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3
  ) {
    return {
      manifestSchemaVersion: MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3,
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
    manifestSchemaVersion: MARKETPLACE_MANIFEST_SCHEMA_VERSION,
    manifestVersion: bundle.manifest.version,
    source,
    digest: {
      algorithm: 'sha256',
      domain: MARKETPLACE_DIGEST_DOMAIN,
      value: digest,
    },
  };
}

function lockEntryMatchesBundle(
  entry: MarketplaceLockEntry,
  bundle: MarketplacePackageBundle,
  digest: string,
): boolean {
  const schemaVersion = bundle.manifest.schemaVersion;
  return (
    entry.manifestSchemaVersion === schemaVersion &&
    entry.manifestVersion === bundle.manifest.version &&
    entry.digest.algorithm === 'sha256' &&
    entry.digest.domain ===
      (schemaVersion === MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3
        ? MARKETPLACE_DIGEST_DOMAIN_V3
        : MARKETPLACE_DIGEST_DOMAIN) &&
    entry.digest.value === digest
  );
}

function childDirectories(directory: string): string[] {
  if (!pathExists(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareMarketplaceCodeUnits);
}

function childEntries(directory: string): string[] {
  if (!pathExists(directory)) return [];
  return fs.readdirSync(directory).sort(compareMarketplaceCodeUnits);
}

function removeTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  syncDirectory(path.dirname(target));
}

export class MarketplaceStore {
  readonly paths: MarketplacePaths;
  private readonly pluginVersion: string;
  private readonly lockOptions: MarketplaceLockOptions;
  private pendingLeaseCleanup: MarketplaceLease | undefined;

  constructor(options: MarketplaceStoreOptions) {
    const pluginVersion = MarketplaceVersionSchema.safeParse(
      options.pluginVersion,
    );
    if (!pluginVersion.success) {
      throw new MarketplaceValidationError(
        `Invalid plugin version: ${pluginVersion.error.message}`,
      );
    }
    this.pluginVersion = pluginVersion.data;
    this.lockOptions = normalizeLockOptions(options.lock ?? {});
    this.paths = getMarketplacePaths(options.rootDir);
  }

  getLockfile(): MarketplaceLockfile {
    return this.withLease(() => this.readLockfile());
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
    return this.withLease((lease) => {
      const lockfile = this.readLockfile();
      this.reconcileLockedState(lockfile, lease);
      return Object.keys(lockfile.packages)
        .sort(compareMarketplaceCodeUnits)
        .map((id) => this.loadLockedPackage(lockfile, id));
    });
  }

  show(id: string): StoredMarketplacePackage {
    const normalizedId = this.normalizeId(id);
    return this.withLease((lease) => {
      const lockfile = this.readLockfile();
      this.reconcileLockedState(lockfile, lease);
      return this.loadLockedPackage(lockfile, normalizedId);
    });
  }

  loadSelected(ids: readonly string[]): {
    packages: Map<string, StoredMarketplacePackage>;
    errors: Map<string, Error>;
  } {
    return this.withLease((lease) => {
      const lockfile = this.readLockfile();
      this.reconcileLockedState(lockfile, lease);
      const packages = new Map<string, StoredMarketplacePackage>();
      const errors = new Map<string, Error>();
      const normalizedIds = new Set<string>();
      for (const id of ids) {
        try {
          normalizedIds.add(this.normalizeId(id));
        } catch (error) {
          errors.set(
            id,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      for (const id of [...normalizedIds].sort(compareMarketplaceCodeUnits)) {
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
    });
  }

  verify(id: string): MarketplaceVerification {
    const normalizedId = this.normalizeId(id);
    return this.withLease((lease) => {
      const lockfile = this.readLockfile();
      this.reconcileLockedState(lockfile, lease);
      return this.verifyLocked(lockfile, normalizedId);
    });
  }

  verifyAll(): MarketplaceVerification[] {
    return this.withLease((lease) => {
      const lockfile = this.readLockfile();
      this.reconcileLockedState(lockfile, lease);
      return Object.keys(lockfile.packages)
        .sort(compareMarketplaceCodeUnits)
        .map((id) => this.verifyLocked(lockfile, id));
    });
  }

  inspectAll(): MarketplaceStoreInspection {
    return this.withLease((lease) => {
      let lockfile: MarketplaceLockfile;
      try {
        lockfile = this.readLockfile();
        this.reconcileLockedState(lockfile, lease);
      } catch (error) {
        if (error instanceof MarketplaceLockfileError) {
          return {
            packages: [],
            verifications: [],
            lockfileError: error.message,
          };
        }
        return {
          packages: [],
          verifications: [],
          operationalError: errorText(error),
        };
      }

      const packages: StoredMarketplacePackage[] = [];
      const verifications: MarketplaceVerification[] = [];
      for (const id of Object.keys(lockfile.packages).sort(
        compareMarketplaceCodeUnits,
      )) {
        const entry = lockfile.packages[id];
        try {
          const stored = this.loadLockedPackage(lockfile, id);
          packages.push(stored);
          verifications.push({
            id,
            version: stored.manifest.version,
            valid: true,
            expectedDigest: entry.digest.value,
            actualDigest: stored.digest,
            message: `${id}@${stored.manifest.version} verified`,
          });
        } catch (error) {
          if (error instanceof MarketplaceIntegrityError) {
            verifications.push({
              id,
              version: entry.manifestVersion,
              valid: false,
              expectedDigest: entry.digest.value,
              message: error.message,
            });
            continue;
          }
          return {
            packages,
            verifications,
            operationalError: errorText(error),
          };
        }
      }
      return { packages, verifications };
    });
  }

  remove(id: string, options?: { onCommitted?: () => void }): void {
    const normalizedId = this.normalizeId(id);
    this.withLease((lease) => {
      const lockfile = this.readLockfile();
      if (!lockfile.packages[normalizedId]) {
        // Absence in the authoritative lockfile means removal is already
        // committed. Notify before reconciliation so cleanup failures cannot
        // make the caller roll back config references for a committed removal.
        options?.onCommitted?.();
        this.reconcileLockedState(lockfile, lease);
        return;
      }
      this.reconcileLockedState(lockfile, lease);

      const packagePath = packageIdPath(this.paths, normalizedId);
      const quarantinePath = this.removalQuarantinePath(normalizedId);
      let quarantined = false;

      lease.commit(() => {
        if (pathExists(packagePath)) {
          fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
          fs.renameSync(packagePath, quarantinePath);
          syncDirectory(path.dirname(packagePath));
          syncDirectory(path.dirname(quarantinePath));
          quarantined = true;
        }

        const packages = { ...lockfile.packages };
        delete packages[normalizedId];
        try {
          this.writeLockfile({
            schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
            packages,
          });
        } catch (error) {
          if (quarantined) {
            fs.mkdirSync(path.dirname(packagePath), { recursive: true });
            fs.renameSync(quarantinePath, packagePath);
            syncDirectory(path.dirname(packagePath));
          }
          throw error;
        }
      });

      // Notification is post-commit and outside the rollback boundary.
      options?.onCommitted?.();

      if (quarantined) {
        try {
          removeTree(quarantinePath);
        } catch {
          // Lockfile publication committed the removal; reconciliation reaps it.
        }
      }
    });
  }

  private mutatePackage(
    input: MarketplacePackageBundle,
    sourceInput: MarketplaceSource,
    mode: MutationMode,
  ): StoredMarketplacePackage {
    const bundle = bundleFrom(input);
    const source = sourceFrom(sourceInput);
    if (
      !satisfiesPluginCompatibility(
        this.pluginVersion,
        bundle.manifest.compatibility.plugin,
      )
    ) {
      throw new MarketplaceCompatibilityError(
        `${bundle.manifest.id}@${bundle.manifest.version} requires plugin ${bundle.manifest.compatibility.plugin}; current plugin is ${this.pluginVersion}`,
      );
    }

    const id = bundle.manifest.id;
    const version = bundle.manifest.version;
    const digest = digestMarketplaceBundle(bundle);

    return this.withLease((lease) => {
      const lockfile = this.readLockfile();
      this.reconcileLockedState(lockfile, lease);
      const current = lockfile.packages[id];
      let exactRepair = false;

      if (current) {
        if (mode === 'install' && current.manifestVersion !== version) {
          throw new MarketplaceConflictError(
            `${id} is installed at ${current.manifestVersion}; use update for an explicit version change`,
          );
        }
        if (mode === 'update' && !gt(version, current.manifestVersion)) {
          throw new MarketplaceConflictError(
            `${id}@${version} is not strictly newer than installed ${current.manifestVersion}`,
          );
        }
        if (mode === 'install') {
          if (!lockEntryMatchesBundle(current, bundle, digest)) {
            throw new MarketplaceConflictError(
              `${id}@${version} is already locked with a different identity or digest`,
            );
          }
          try {
            return this.loadLockedPackage(lockfile, id);
          } catch (error) {
            if (!isPackageReadFailure(error)) throw error;
            exactRepair = true;
          }
        }
      } else if (mode === 'update') {
        throw new MarketplaceConflictError(
          `${id} is not installed; updates require an existing package`,
        );
      }

      const versionPath = packageVersionPath(this.paths, id, version);
      if (pathExists(versionPath) && !exactRepair) {
        throw new MarketplaceConflictError(
          `${id}@${version} already exists in the immutable store`,
        );
      }
      const nextSource = exactRepair && current ? current.source : source;
      const nextEntry = packageEntry(bundle, nextSource, digest);
      const nextPackages = { ...lockfile.packages, [id]: nextEntry };
      const repairBackup = exactRepair
        ? this.repairQuarantinePath(id, version)
        : undefined;
      let movedToRepair = false;
      let published = false;

      try {
        lease.commit(() => {
          if (exactRepair && repairBackup && pathExists(versionPath)) {
            fs.mkdirSync(path.dirname(repairBackup), { recursive: true });
            fs.renameSync(versionPath, repairBackup);
            syncDirectory(path.dirname(versionPath));
            syncDirectory(path.dirname(repairBackup));
            movedToRepair = true;
          }
          this.publishBundle(versionPath, bundle, digest);
          published = true;
          this.writeLockfile({
            schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
            packages: nextPackages,
          });
        });
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (published) {
          try {
            removeTree(versionPath);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (movedToRepair && repairBackup) {
          try {
            if (!pathExists(repairBackup)) {
              throw new MarketplaceIntegrityError(
                'The repair backup disappeared before rollback',
              );
            }
            if (pathExists(versionPath)) removeTree(versionPath);
            fs.mkdirSync(path.dirname(versionPath), { recursive: true });
            fs.renameSync(repairBackup, versionPath);
            syncDirectory(path.dirname(versionPath));
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new MarketplaceIntegrityError(
            `Marketplace mutation failed and rollback was incomplete: ${errorText(error)}; ${rollbackErrors.map(errorText).join('; ')}`,
          );
        }
        throw error;
      }

      // The lockfile rename is the commit point. Cleanup must never roll it back.
      if (repairBackup && movedToRepair) {
        try {
          removeTree(repairBackup);
        } catch {
          // Reconciliation removes committed repair backups later.
        }
      }
      if (current && current.manifestVersion !== version) {
        try {
          removeTree(
            packageVersionPath(this.paths, id, current.manifestVersion),
          );
          this.pruneEmptyPackageDirectories(id);
        } catch {
          // The committed lockfile makes the old version an orphan to reconcile.
        }
      }
      return this.toStored(versionPath, bundle, nextSource, digest);
    });
  }

  private withLease<T>(operation: (lease: MarketplaceLease) => T): T {
    this.releasePendingLease();
    const lease = acquireMarketplaceLease(this.paths, this.lockOptions);
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      lease.assertCurrent();
      result = operation(lease);
    } catch (error) {
      operationError = error;
      operationFailed = true;
    }

    try {
      lease.release();
    } catch (releaseError) {
      this.pendingLeaseCleanup = lease;
      if (!operationFailed) throw releaseError;
    }
    if (operationFailed) throw operationError;
    return result as T;
  }

  private releasePendingLease(): void {
    const pending = this.pendingLeaseCleanup;
    if (!pending) return;
    try {
      pending.release();
    } catch (error) {
      if (!(error instanceof MarketplaceLockOwnershipError)) throw error;
    }
    this.pendingLeaseCleanup = undefined;
  }

  private normalizeId(id: string): string {
    try {
      return normalizeMarketplacePackageId(id);
    } catch (error) {
      throw new MarketplaceValidationError(errorText(error));
    }
  }

  private readLockfile(): MarketplaceLockfile {
    let serialized: string;
    try {
      serialized = fs.readFileSync(this.paths.lockfilePath, 'utf8');
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        return {
          schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
          packages: {},
        };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new MarketplaceLockfileError(
          `Marketplace lockfile is invalid: ${error.message}`,
        );
      }
      throw error;
    }
    const parsed = MarketplaceLockfileSchema.safeParse(value);
    if (!parsed.success) {
      throw new MarketplaceLockfileError(
        `Marketplace lockfile is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  private writeLockfile(lockfile: MarketplaceLockfile): void {
    const normalized: MarketplaceLockfile = {
      schemaVersion: MARKETPLACE_LOCKFILE_SCHEMA_VERSION,
      packages: Object.fromEntries(
        Object.entries(lockfile.packages).sort(([left], [right]) =>
          compareMarketplaceCodeUnits(left, right),
        ),
      ),
    };
    writeAtomic(
      this.paths.lockfilePath,
      `${canonicalizeMarketplaceValue(normalized)}\n`,
    );
  }

  private verifyLocked(
    lockfile: MarketplaceLockfile,
    id: string,
  ): MarketplaceVerification {
    const entry = lockfile.packages[id];
    if (!entry) {
      return { id, valid: false, message: `${id} is not installed` };
    }
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
      if (!(error instanceof MarketplaceIntegrityError)) throw error;
      return {
        id,
        version: entry.manifestVersion,
        valid: false,
        expectedDigest: entry.digest.value,
        message: error.message,
      };
    }
  }

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
    let bundle: MarketplacePackageBundle;
    let sidecar: string;
    try {
      bundle = bundleFrom(readJson(path.join(versionPath, 'package.json')));
      sidecar = fs
        .readFileSync(path.join(versionPath, 'sha256'), 'utf8')
        .trim();
    } catch (error) {
      if (
        error instanceof MarketplaceValidationError ||
        error instanceof SyntaxError ||
        errnoCode(error) === 'ENOENT'
      ) {
        throw new MarketplaceIntegrityError(
          `Cannot load ${id}@${entry.manifestVersion}: ${errorText(error)}`,
        );
      }
      throw error;
    }
    const digest = digestMarketplaceBundle(bundle);
    const expectedDomain =
      bundle.manifest.schemaVersion === MARKETPLACE_MANIFEST_SCHEMA_VERSION_V3
        ? MARKETPLACE_DIGEST_DOMAIN_V3
        : MARKETPLACE_DIGEST_DOMAIN;
    if (
      bundle.manifest.id !== id ||
      bundle.manifest.version !== entry.manifestVersion ||
      bundle.manifest.schemaVersion !== entry.manifestSchemaVersion ||
      sidecar !== digest ||
      entry.digest.algorithm !== 'sha256' ||
      entry.digest.domain !== expectedDomain ||
      entry.digest.value !== digest
    ) {
      throw new MarketplaceIntegrityError(
        `Integrity or identity mismatch for ${id}@${entry.manifestVersion}`,
      );
    }
    return this.toStored(versionPath, bundle, entry.source, digest);
  }

  private publishBundle(
    versionPath: string,
    bundle: MarketplacePackageBundle,
    digest: string,
  ): void {
    if (pathExists(versionPath)) {
      throw new MarketplaceConflictError(
        `${bundle.manifest.id}@${bundle.manifest.version} already exists in the immutable store`,
      );
    }
    const temporaryPath = path.join(
      this.paths.stagingDir,
      'pending',
      randomUUID(),
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
        if (pathExists(temporaryPath)) removeTree(temporaryPath);
      } catch {
        // Unpublished staging is reaped under the next lease.
      }
    }
  }

  private reconcileLockedState(
    lockfile: MarketplaceLockfile,
    lease: MarketplaceLease,
  ): void {
    lease.commit(() => {
      this.reconcileRepairQuarantines(lockfile);
      this.reconcileRemovalQuarantines(lockfile);
      this.removePendingStages();
      this.removeUnselectedVersions(lockfile);
    });
  }

  private reconcileRepairQuarantines(lockfile: MarketplaceLockfile): void {
    const repairRoot = path.join(this.paths.stagingDir, 'repair');
    for (const publisher of childDirectories(repairRoot)) {
      for (const name of childDirectories(path.join(repairRoot, publisher))) {
        const packageDir = path.join(repairRoot, publisher, name);
        const id = `${publisher}/${name}`;
        const selectedEntry = lockfile.packages[id];
        let selectedPackageVerified = false;
        const verifySelectedPackage = (): boolean => {
          if (!selectedEntry) return false;
          if (!selectedPackageVerified) {
            this.loadLockedPackage(lockfile, id);
            selectedPackageVerified = true;
          }
          return true;
        };
        for (const version of childDirectories(packageDir)) {
          const versionDir = path.join(packageDir, version);
          const entry = lockfile.packages[id];
          for (const operation of childEntries(versionDir)) {
            const backupPath = path.join(versionDir, operation);
            if (entry?.manifestVersion !== version) {
              if (!selectedEntry) {
                removeTree(backupPath);
                continue;
              }
              try {
                if (verifySelectedPackage()) removeTree(backupPath);
              } catch (error) {
                if (!isPackageReadFailure(error)) throw error;
              }
              continue;
            }
            const selectedPath = packageVersionPath(this.paths, id, version);
            if (!pathExists(selectedPath)) {
              fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
              fs.renameSync(backupPath, selectedPath);
              syncDirectory(path.dirname(selectedPath));
              continue;
            }
            try {
              this.loadLockedPackage(lockfile, id);
            } catch (error) {
              if (isPackageReadFailure(error)) continue;
              throw error;
            }
            removeTree(backupPath);
          }
          this.removeEmptyDirectory(versionDir);
        }
        this.removeEmptyDirectory(packageDir);
      }
      this.removeEmptyDirectory(path.join(repairRoot, publisher));
    }
    this.removeEmptyDirectory(repairRoot);
  }

  private reconcileRemovalQuarantines(lockfile: MarketplaceLockfile): void {
    const removedRoot = path.join(this.paths.stagingDir, 'removed');
    for (const publisher of childDirectories(removedRoot)) {
      for (const name of childDirectories(path.join(removedRoot, publisher))) {
        const packageDir = path.join(removedRoot, publisher, name);
        const id = `${publisher}/${name}`;
        const selected = lockfile.packages[id];
        for (const quarantineName of childEntries(packageDir)) {
          const quarantinePath = path.join(packageDir, quarantineName);
          if (!selected) {
            removeTree(quarantinePath);
            continue;
          }
          const installedPath = packageIdPath(this.paths, id);
          if (!pathExists(installedPath)) {
            fs.mkdirSync(path.dirname(installedPath), { recursive: true });
            fs.renameSync(quarantinePath, installedPath);
            syncDirectory(path.dirname(installedPath));
            continue;
          }
          try {
            this.loadLockedPackage(lockfile, id);
          } catch (error) {
            if (isPackageReadFailure(error)) continue;
            throw error;
          }
          removeTree(quarantinePath);
        }
        this.removeEmptyDirectory(packageDir);
      }
      this.removeEmptyDirectory(path.join(removedRoot, publisher));
    }
    this.removeEmptyDirectory(removedRoot);
  }

  private removePendingStages(): void {
    const pendingRoot = path.join(this.paths.stagingDir, 'pending');
    for (const entry of childEntries(pendingRoot)) {
      removeTree(path.join(pendingRoot, entry));
    }
    this.removeEmptyDirectory(pendingRoot);
  }

  private removeUnselectedVersions(lockfile: MarketplaceLockfile): void {
    for (const publisher of childDirectories(this.paths.packagesDir)) {
      const publisherPath = path.join(this.paths.packagesDir, publisher);
      for (const name of childDirectories(publisherPath)) {
        const id = `${publisher}/${name}`;
        const packageDir = path.join(publisherPath, name);
        const selectedEntry = lockfile.packages[id];
        const selectedVersion = selectedEntry?.manifestVersion;
        const unselectedVersions = childEntries(packageDir).filter(
          (version) => version !== selectedVersion,
        );
        if (selectedEntry && unselectedVersions.length > 0) {
          // Do not destroy recoverable package bytes until the lock-selected
          // version has passed the same integrity checks as a normal load.
          // This pruning is optional: leave old bytes in place on package
          // read failures so unrelated operations and exact repair can proceed.
          try {
            this.loadLockedPackage(lockfile, id);
          } catch (error) {
            if (isPackageReadFailure(error)) continue;
            throw error;
          }
        }
        for (const version of unselectedVersions) {
          removeTree(path.join(packageDir, version));
        }
        if (!selectedVersion) this.removeEmptyDirectory(packageDir);
      }
      this.removeEmptyDirectory(publisherPath);
    }
  }

  private removeEmptyDirectory(directory: string): void {
    if (!pathExists(directory)) return;
    if (fs.readdirSync(directory).length !== 0) return;
    fs.rmdirSync(directory);
    syncDirectory(path.dirname(directory));
  }

  private repairQuarantinePath(id: string, version: string): string {
    return path.join(
      this.paths.stagingDir,
      'repair',
      ...id.split('/'),
      version,
      randomUUID(),
    );
  }

  private removalQuarantinePath(id: string): string {
    return path.join(
      this.paths.stagingDir,
      'removed',
      ...id.split('/'),
      randomUUID(),
    );
  }

  private pruneEmptyPackageDirectories(id: string): void {
    const packageDir = packageIdPath(this.paths, id);
    const publisherDir = path.dirname(packageDir);
    this.removeEmptyDirectory(packageDir);
    this.removeEmptyDirectory(publisherDir);
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
