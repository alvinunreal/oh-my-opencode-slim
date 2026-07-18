import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { crossSpawn } from '../utils/compat';

let cachedOpenCodePath: string | null = null;

function resolvePathCommand(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const isWindows = process.platform === 'win32';
    const resolver = isWindows ? 'where' : 'which';
    const result = spawnSync(resolver, [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: environment,
      // On Windows, `where opencode` returns multiple shims (opencode, opencode.cmd,
      // opencode.ps1). Node's spawnSync cannot execute an extensionless npm shim,
      // and since Node's CVE-2024-27980 patch .cmd/.bat files also require a shell.
      shell: isWindows,
    });

    if (result.status !== 0) {
      return null;
    }

    const lines = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    // On Windows, prefer executable shims (.cmd, .exe, .ps1) over the
    // extensionless npm wrapper that Node cannot spawn directly.
    if (isWindows) {
      const executable = lines.find((line) =>
        /\.(cmd|exe|ps1|bat)$/i.test(line),
      );
      return executable ?? lines[0];
    }

    return lines[0];
  } catch {
    return null;
  }
}

function canExecute(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const isWindows = process.platform === 'win32';
    const result = spawnSync(command, args, {
      stdio: 'ignore',
      env: environment,
      // Required on Windows to execute .cmd/.bat shims produced by npm/pnpm/yarn
      // (Node's CVE-2024-27980 patch blocks them without a shell).
      shell: isWindows,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getOpenCodePaths(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = environment.HOME || environment.USERPROFILE || '';
  const isWindows = process.platform === 'win32';
  const appData = environment.APPDATA || `${home}\\AppData\\Roaming`;
  const localAppData = environment.LOCALAPPDATA || `${home}\\AppData\\Local`;

  const windowsPaths = isWindows
    ? [
        // npm global shims (created as .cmd on Windows)
        `${appData}\\npm\\opencode.cmd`,
        `${appData}\\npm\\opencode.ps1`,
        // pnpm global
        `${localAppData}\\pnpm\\opencode.cmd`,
        // Yarn global
        `${localAppData}\\Yarn\\bin\\opencode.cmd`,
        // opencode.ai/install .exe location
        `${localAppData}\\Programs\\opencode\\opencode.exe`,
        // Scoop
        `${home}\\scoop\\shims\\opencode.exe`,
        `${home}\\scoop\\apps\\opencode\\current\\bin\\opencode.exe`,
        // Chocolatey
        `C:\\ProgramData\\chocolatey\\bin\\opencode.exe`,
      ]
    : [];

  return [
    // PATH (try this first)
    'opencode',
    ...windowsPaths,
    // User local installations (Linux & macOS)
    `${home}/.local/bin/opencode`,
    `${home}/.opencode/bin/opencode`,
    `${home}/bin/opencode`,
    // System-wide installations
    '/usr/local/bin/opencode',
    '/opt/opencode/bin/opencode',
    '/usr/bin/opencode',
    '/bin/opencode',
    // macOS specific
    '/Applications/OpenCode.app/Contents/MacOS/opencode',
    `${home}/Applications/OpenCode.app/Contents/MacOS/opencode`,
    // Homebrew (macOS & Linux)
    '/opt/homebrew/bin/opencode',
    '/home/linuxbrew/.linuxbrew/bin/opencode',
    `${home}/homebrew/bin/opencode`,
    // macOS user Library
    `${home}/Library/Application Support/opencode/bin/opencode`,
    // Snap (Linux)
    '/snap/bin/opencode',
    '/var/snap/opencode/current/bin/opencode',
    // Flatpak (Linux)
    '/var/lib/flatpak/exports/bin/ai.opencode.OpenCode',
    `${home}/.local/share/flatpak/exports/bin/ai.opencode.OpenCode`,
    // Nix (Linux/macOS)
    '/nix/store/opencode/bin/opencode',
    `${home}/.nix-profile/bin/opencode`,
    '/run/current-system/sw/bin/opencode',
    // Cargo (Rust toolchain)
    `${home}/.cargo/bin/opencode`,
    // npm/npx global
    `${home}/.npm-global/bin/opencode`,
    '/usr/local/lib/node_modules/opencode/bin/opencode',
    // Yarn global
    `${home}/.yarn/bin/opencode`,
    // PNPM
    `${home}/.pnpm-global/bin/opencode`,
  ];
}

export function resolveOpenCodePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const useCache = environment === process.env;
  if (useCache && cachedOpenCodePath) {
    return cachedOpenCodePath;
  }

  const pathOpenCodePath = resolvePathCommand('opencode', environment);
  if (pathOpenCodePath) {
    if (useCache) {
      cachedOpenCodePath = pathOpenCodePath;
    }
    return pathOpenCodePath;
  }

  const paths = getOpenCodePaths(environment);

  for (const opencodePath of paths) {
    if (opencodePath === 'opencode') continue;
    try {
      const stat = statSync(opencodePath);
      if (stat.isFile()) {
        if (useCache) {
          cachedOpenCodePath = opencodePath;
        }
        return opencodePath;
      }
    } catch {
      // Try next path
    }
  }

  // Fallback to 'opencode' and hope it's in PATH
  return 'opencode';
}

export async function isOpenCodeInstalled(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const useCache = environment === process.env;
  const pathOpenCodePath = resolvePathCommand('opencode', environment);

  if (
    pathOpenCodePath &&
    canExecute(pathOpenCodePath, ['--version'], environment)
  ) {
    if (useCache) {
      cachedOpenCodePath = pathOpenCodePath;
    }
    return true;
  }

  const paths = getOpenCodePaths(environment);

  for (const opencodePath of paths) {
    if (opencodePath === 'opencode') continue;
    if (canExecute(opencodePath, ['--version'], environment)) {
      if (useCache) {
        cachedOpenCodePath = opencodePath;
      }
      return true;
    }
  }
  return false;
}

export async function isTmuxInstalled(): Promise<boolean> {
  try {
    const proc = crossSpawn(['tmux', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function getOpenCodeVersion(): Promise<string | null> {
  const opencodePath = resolveOpenCodePath();
  try {
    const proc = crossSpawn([opencodePath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const outputPromise = proc.stdout();
    await proc.exited;
    if (proc.exitCode === 0) {
      return (await outputPromise).trim();
    }
  } catch {
    // Failed
  }
  return null;
}

export function getOpenCodePath(): string | null {
  const path = resolveOpenCodePath();
  return path === 'opencode' ? null : path;
}

export async function fetchLatestVersion(
  packageName: string,
): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}
