import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

let cachedOpenCodePath: string | null = null;

function resolvePathCommand(command: string): string | null {
  try {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(resolver, [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    if (result.status !== 0) {
      return null;
    }

    const resolved = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return resolved ?? null;
  } catch {
    return null;
  }
}

function canExecute(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getOpenCodePaths(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';

  return [
    // PATH (try this first)
    'opencode',
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

export function resolveOpenCodePath(): string {
  if (cachedOpenCodePath) {
    return cachedOpenCodePath;
  }

  const pathOpenCodePath = resolvePathCommand('opencode');
  if (pathOpenCodePath) {
    cachedOpenCodePath = pathOpenCodePath;
    return pathOpenCodePath;
  }

  const paths = getOpenCodePaths();

  for (const opencodePath of paths) {
    if (opencodePath === 'opencode') continue;
    try {
      const stat = statSync(opencodePath);
      if (stat.isFile()) {
        cachedOpenCodePath = opencodePath;
        return opencodePath;
      }
    } catch {
      // Try next path
    }
  }

  // Fallback to 'opencode' and hope it's in PATH
  return 'opencode';
}

export async function isOpenCodeInstalled(): Promise<boolean> {
  const pathOpenCodePath = resolvePathCommand('opencode');

  if (pathOpenCodePath && canExecute(pathOpenCodePath, ['--version'])) {
    cachedOpenCodePath = pathOpenCodePath;
    return true;
  }

  const paths = getOpenCodePaths();

  for (const opencodePath of paths) {
    if (opencodePath === 'opencode') continue;
    if (canExecute(opencodePath, ['--version'])) {
      cachedOpenCodePath = opencodePath;
      return true;
    }
  }
  return false;
}

export async function isTmuxInstalled(): Promise<boolean> {
  return canExecute('tmux', ['-V']);
}

export async function getOpenCodeVersion(): Promise<string | null> {
  const opencodePath = resolveOpenCodePath();
  try {
    const result = spawnSync(opencodePath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      return result.stdout.trim();
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
