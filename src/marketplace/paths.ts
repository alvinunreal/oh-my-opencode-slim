import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MarketplacePaths {
  rootDir: string;
  packagesDir: string;
  lockfilePath: string;
  lockDir: string;
  stagingDir: string;
}

export function getMarketplacePaths(rootDir?: string): MarketplacePaths {
  const root =
    rootDir ??
    join(
      process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
      'opencode',
      'storage',
      'oh-my-opencode-slim',
      'marketplace',
    );
  return {
    rootDir: root,
    packagesDir: join(root, 'packages'),
    lockfilePath: join(root, 'lock.json'),
    lockDir: join(root, 'marketplace.lock'),
    stagingDir: join(root, '.staging'),
  };
}
