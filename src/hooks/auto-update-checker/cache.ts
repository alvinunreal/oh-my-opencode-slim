import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../../utils/logger';
import { getCurrentRuntimePackageJsonPath } from './checker';
import { PACKAGE_NAME } from './constants';

interface AutoUpdateInstallContext {
  installDir: string;
  packageJsonPath: string;
}

interface PreparedPackageUpdate {
  stagingDir: string;
  targetDir: string;
}

export function getTargetInstallContext(
  installContext: AutoUpdateInstallContext,
  version: string,
): AutoUpdateInstallContext | null {
  const installParent = path.dirname(installContext.installDir);
  if (path.basename(installParent) !== 'packages') return null;
  const installDir = path.join(installParent, `${PACKAGE_NAME}@${version}`);
  return { installDir, packageJsonPath: path.join(installDir, 'package.json') };
}

export function resolveInstallContext(
  runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
  if (!runtimePackageJsonPath) return null;

  const packageDir = path.dirname(runtimePackageJsonPath);
  const nodeModulesDir = path.dirname(packageDir);
  const installDir = path.dirname(nodeModulesDir);
  const installParent = path.dirname(installDir);

  // Only the OpenCode v1 wrapper layout
  // (<cache>/packages/oh-my-opencode-slim@<spec>/node_modules/oh-my-opencode-slim)
  // is a supported install root. The v2 layout (<cache>/npm/<sanitize(spec)>/<int>/...)
  // is deliberately rejected, as is the legacy <cache>/package.json root.
  const isV1Wrapper =
    path.basename(packageDir) === PACKAGE_NAME &&
    path.basename(nodeModulesDir) === 'node_modules' &&
    path.basename(installParent) === 'packages' &&
    path.basename(installDir).startsWith(`${PACKAGE_NAME}@`);
  if (!isV1Wrapper) return null;

  const packageJsonPath = path.join(installDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;

  return { installDir, packageJsonPath };
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
    if (!targetContext) {
      log('[auto-update-checker] No v1 packages wrapper for auto-update');
      return null;
    }
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
