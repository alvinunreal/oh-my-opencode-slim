import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface MarketplacePaths {
  rootDir: string;
  packagesDir: string;
  lockfilePath: string;
  lockDir: string;
  stagingDir: string;
}

export function getMarketplacePaths(rootDir?: string): MarketplacePaths {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  const dataHome =
    xdgDataHome && isAbsolute(xdgDataHome)
      ? xdgDataHome
      : join(homedir(), '.local', 'share');
  const root =
    rootDir ??
    join(dataHome, 'opencode', 'storage', 'oh-my-opencode-slim', 'marketplace');
  return {
    rootDir: root,
    packagesDir: join(root, 'packages'),
    lockfilePath: join(root, 'lock.json'),
    lockDir: join(root, 'marketplace.lock'),
    stagingDir: join(root, '.staging'),
  };
}
