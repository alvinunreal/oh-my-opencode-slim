import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards the invariant: after initial plugin load, config must come only from
// the in-memory map, never re-read from disk. webfetch's secondary-model
// resolution is the hot path (every fetch call), so this tripwire pins the
// smartfetch source files to be config-disk-free. Any future change that
// re-introduces a config-file read here must be an explicit, reviewed
// decision — and needs a test that proves it is not on the per-call path.
const SRC_ROOT = path.join(import.meta.dir, '..', '..', '..');

const GUARDED_FILES = [
  'src/tools/smartfetch/secondary-model.ts',
  'src/tools/smartfetch/tool.ts',
];

// Any match here means the file can read config files (or the plugin-config
// loader) from disk. Importing the loader itself is banned: secondary-model
// resolution must consume values already captured in memory at construction.
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'node:fs', regex: /from 'node:fs['/]/ },
  { name: 'node:fs/promises', regex: /from 'node:fs\/promises'/ },
  { name: 'loadPluginConfig', regex: /loadPluginConfig/ },
  { name: 'config/loader', regex: /config\/loader/ },
  { name: 'cli/config-io', regex: /cli\/config-io/ },
  { name: 'cli/paths', regex: /cli\/paths/ },
  { name: 'getExistingConfigPath', regex: /getExistingConfigPath/ },
];

describe('smartfetch config re-read guard', () => {
  test('secondary-model source stays config-disk-free', () => {
    for (const file of GUARDED_FILES) {
      const content = readFileSync(path.join(SRC_ROOT, file), 'utf8');
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        expect(
          content.match(regex),
          `${file} must not import ${name} (config would be re-read from disk on every webfetch call)`,
        ).toBeNull();
      }
    }
  });
});
