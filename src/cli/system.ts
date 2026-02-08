const OPENCODE_PATHS = [
  // PATH (try this first)
  'opencode',
  // User local installations (Linux & macOS)
  `${process.env.HOME}/.local/bin/opencode`,
  `${process.env.HOME}/.opencode/bin/opencode`,
  `${process.env.HOME}/bin/opencode`,
  // System-wide installations
  '/usr/local/bin/opencode',
  '/opt/opencode/bin/opencode',
  '/usr/bin/opencode',
  '/bin/opencode',
  // macOS specific
  '/Applications/OpenCode.app/Contents/MacOS/opencode',
  `${process.env.HOME}/Applications/OpenCode.app/Contents/MacOS/opencode`,
  // Homebrew (macOS & Linux)
  '/opt/homebrew/bin/opencode',
  '/home/linuxbrew/.linuxbrew/bin/opencode',
  `${process.env.HOME}/homebrew/bin/opencode`,
  // macOS user Library
  `${process.env.HOME}/Library/Application Support/opencode/bin/opencode`,
  // Snap (Linux)
  '/snap/bin/opencode',
  '/var/snap/opencode/current/bin/opencode',
  // Flatpak (Linux)
  '/var/lib/flatpak/exports/bin/ai.opencode.OpenCode',
  `${process.env.HOME}/.local/share/flatpak/exports/bin/ai.opencode.OpenCode`,
  // Nix (Linux/macOS)
  '/nix/store/opencode/bin/opencode',
  `${process.env.HOME}/.nix-profile/bin/opencode`,
  '/run/current-system/sw/bin/opencode',
  // Cargo (Rust toolchain)
  `${process.env.HOME}/.cargo/bin/opencode`,
  // npm/npx global
  `${process.env.HOME}/.npm-global/bin/opencode`,
  '/usr/local/lib/node_modules/opencode/bin/opencode',
  // Yarn global
  `${process.env.HOME}/.yarn/bin/opencode`,
  // PNPM
  `${process.env.HOME}/.pnpm-global/bin/opencode`,
];

let cachedOpenCodePath: string | null = null;

export function resolveOpenCodePath(): string {
  if (cachedOpenCodePath) {
    return cachedOpenCodePath;
  }

  for (const opencodePath of OPENCODE_PATHS) {
    try {
      // Check if we can execute it
      const proc = Bun.spawn([opencodePath, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      // Don't wait for exit here, just check if spawn worked
      cachedOpenCodePath = opencodePath;
      return opencodePath;
    } catch {
      // Try next path
    }
  }

  // Fallback to 'opencode' and hope it's in PATH
  return 'opencode';
}

export async function isOpenCodeInstalled(): Promise<boolean> {
  for (const opencodePath of OPENCODE_PATHS) {
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
