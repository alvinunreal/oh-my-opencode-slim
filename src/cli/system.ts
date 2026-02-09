import { statSync } from 'node:fs';

let cachedOpenCodePath: string | null = null;

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
  const paths = getOpenCodePaths();

  for (const opencodePath of paths) {
    try {
      const proc = Bun.spawn([opencodePath, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
      if (proc.exitCode === 0) {
        cachedOpenCodePath = opencodePath;
        return true;
      }
    } catch {
      // Try next path
    }
  }
  return false;
}

export async function isTmuxInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['tmux', '-V'], {
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
    const proc = Bun.spawn([opencodePath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode === 0) {
      return output.trim();
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
