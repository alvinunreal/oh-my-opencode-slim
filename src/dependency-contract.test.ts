import { describe, expect, test } from 'bun:test';

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  version?: string;
};

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return (await Bun.file(
    new URL(relativePath, import.meta.url),
  ).json()) as PackageManifest;
}

const rootManifest = await readManifest('../package.json');
const openCodePluginManifest = await readManifest(
  '../node_modules/@opencode-ai/plugin/package.json',
);
const openTuiSolidManifest = await readManifest(
  '../node_modules/@opentui/solid/package.json',
);

describe('dependency compatibility contract', () => {
  test('keeps OpenCode plugin and SDK on one exact version', () => {
    const pluginVersion = rootManifest.dependencies?.['@opencode-ai/plugin'];
    const sdkVersion = rootManifest.dependencies?.['@opencode-ai/sdk'];

    expect(pluginVersion).toBeDefined();
    expect(pluginVersion).toBe(sdkVersion);
    expect(openCodePluginManifest.version).toBe(pluginVersion);
    expect(openCodePluginManifest.dependencies?.['@opencode-ai/sdk']).toBe(
      sdkVersion,
    );
  });

  test('pins one compatible OpenTUI and Solid family', () => {
    const coreVersion = rootManifest.optionalDependencies?.['@opentui/core'];
    const solidVersion = rootManifest.optionalDependencies?.['@opentui/solid'];
    const solidJsVersion = rootManifest.optionalDependencies?.['solid-js'];

    expect(coreVersion).toBeDefined();
    expect(coreVersion).toBe(solidVersion);
    expect(openTuiSolidManifest.version).toBe(solidVersion);
    expect(openTuiSolidManifest.dependencies?.['@opentui/core']).toBe(
      coreVersion,
    );
    expect(openTuiSolidManifest.peerDependencies?.['solid-js']).toBe(
      solidJsVersion,
    );

    for (const packageName of ['@opentui/core', '@opentui/solid']) {
      const peerRange = openCodePluginManifest.peerDependencies?.[packageName];
      const installedVersion = rootManifest.optionalDependencies?.[packageName];
      expect(peerRange).toBeDefined();
      expect(installedVersion).toBeDefined();
      expect(
        Bun.semver.satisfies(installedVersion ?? '', peerRange ?? ''),
      ).toBe(true);
    }
  });
});
