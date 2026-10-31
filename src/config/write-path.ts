import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Resolve an existing config, including links, without treating a dangling link as absent. */
export function resolveConfigWritePath(filePath: string): string {
  const absolutePath = resolve(filePath);
  try {
    lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return join(
        resolveConfigWritePath(dirname(absolutePath)),
        basename(absolutePath),
      );
    }
    throw error;
  }

  try {
    return realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`Cannot resolve config path ${filePath}`, { cause: error });
  }
}
