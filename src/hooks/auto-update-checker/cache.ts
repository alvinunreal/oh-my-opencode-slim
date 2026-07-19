import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../../utils/logger';
import { getCurrentRuntimePackageJsonPath } from './checker';
import { CACHE_DIR, PACKAGE_NAME } from './constants';

interface AutoUpdateInstallContext {
  installDir: string;
  packageJsonPath: string;
}

interface PreparedPackageUpdate {
  stagingDir: string;
  targetDir: string;
}

function getTargetInstallContext(
  installContext: AutoUpdateInstallContext,
  version: string,
): AutoUpdateInstallContext {
  const installParent = path.dirname(installContext.installDir);
  const parentDir =
    path.basename(installParent) === 'packages'
      ? installParent
      : path.join(CACHE_DIR, 'packages');
  const installDir = path.join(parentDir, `${PACKAGE_NAME}@${version}`);
  return { installDir, packageJsonPath: path.join(installDir, 'package.json') };
}

export function resolveInstallContext(
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
  if (runtimePackageJsonPath) {
    const packageDir = path.dirname(runtimePackageJsonPath);
    const nodeModulesDir = path.dirname(packageDir);

    if (
      path.basename(packageDir) === PACKAGE_NAME &&
      path.basename(nodeModulesDir) === 'node_modules'
    ) {
      const installDir = path.dirname(nodeModulesDir);
      const packageJsonPath = path.join(installDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        return { installDir, packageJsonPath };
      }
    }

    return null;
  }

  const legacyPackageJsonPath = path.join(CACHE_DIR, 'package.json');
  if (fs.existsSync(legacyPackageJsonPath)) {
    return { installDir: CACHE_DIR, packageJsonPath: legacyPackageJsonPath };
  }

  return null;
}

/**
 * Prepares the current install root for a clean re-install of the target version.
 * Returns the install directory to run `bun install` in.
 */
export function preparePackageUpdate(
  version: string,
  packageName: string = PACKAGE_NAME,
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
  cacheIdentity: string = version,
): PreparedPackageUpdate | null {
  let stagingDir: string | null = null;
  try {
    const installContext = resolveInstallContext(runtimePackageJsonPath);
    if (!installContext) {
      log('[auto-update-checker] No install context found for auto-update');
      return null;
    }

    const targetContext = getTargetInstallContext(
      installContext,
      cacheIdentity,
    );
    const targetParent = path.dirname(targetContext.installDir);
    fs.mkdirSync(targetParent, { recursive: true });
    stagingDir = fs.mkdtempSync(
      path.join(targetParent, `.${PACKAGE_NAME}@${cacheIdentity}.staging-`),
    );
    fs.writeFileSync(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: { [packageName]: version },
      }),
    );

    return { stagingDir, targetDir: targetContext.installDir };
  } catch (err) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    log('[auto-update-checker] Failed to prepare package update:', err);
    return null;
  }
}

export function discardPreparedPackageUpdate(
  prepared: PreparedPackageUpdate,
): void {
  fs.rmSync(prepared.stagingDir, { recursive: true, force: true });
}

export function publishPackageUpdate(
  prepared: PreparedPackageUpdate,
  version: string,
): string | null {
  try {
    if (fs.existsSync(prepared.targetDir)) {
      if (verifyInstalledPackage(prepared.targetDir, version)) {
        discardPreparedPackageUpdate(prepared);
        return prepared.targetDir;
      }
      const quarantineDir = `${prepared.targetDir}.invalid-${process.pid}-${Date.now()}`;
      fs.renameSync(prepared.targetDir, quarantineDir);
      try {
        fs.renameSync(prepared.stagingDir, prepared.targetDir);
        if (verifyInstalledPackage(prepared.targetDir, version)) {
          fs.rmSync(quarantineDir, { recursive: true, force: true });
          return prepared.targetDir;
        }
        fs.rmSync(prepared.targetDir, { recursive: true, force: true });
        fs.renameSync(quarantineDir, prepared.targetDir);
        return null;
      } catch {
        if (fs.existsSync(prepared.targetDir)) {
          if (verifyInstalledPackage(prepared.targetDir, version)) {
            discardPreparedPackageUpdate(prepared);
            fs.rmSync(quarantineDir, { recursive: true, force: true });
            return prepared.targetDir;
          }
        }
      }
      if (!fs.existsSync(prepared.targetDir)) {
        fs.renameSync(quarantineDir, prepared.targetDir);
      }
      discardPreparedPackageUpdate(prepared);
      return null;
    }
    fs.renameSync(prepared.stagingDir, prepared.targetDir);
    if (verifyInstalledPackage(prepared.targetDir, version)) {
      return prepared.targetDir;
    }
    fs.rmSync(prepared.targetDir, { recursive: true, force: true });
    return null;
  } catch {
    discardPreparedPackageUpdate(prepared);
    return null;
  }
}

export function verifyInstalledPackage(
  installDir: string,
  version: string,
  packageName: string = PACKAGE_NAME,
): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(installDir, 'node_modules', packageName, 'package.json'),
        'utf-8',
      ),
    ) as { name?: string; version?: string };
    return packageJson.name === packageName && packageJson.version === version;
  } catch {
    return false;
  }
}
