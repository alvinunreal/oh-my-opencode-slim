import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marketplaceCommand } from '../cli/marketplace';
import type { MarketplacePackageBundle } from '../marketplace-contract';
import { createMarketplaceRegistryEntry } from '../marketplace-contract';
import { createMarketplaceTool } from '../tools/marketplace';
import type { MarketplaceRegistryDownload } from './registry-client';
import { MARKETPLACE_REGISTRY_INDEX_URL } from './registry-client';
import { MarketplaceService } from './service';

function bundle(version = '1.0.0'): MarketplacePackageBundle {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'community/dispatch-agent',
      version,
      displayName: 'Dispatch agent',
      description: 'A dispatch test package.',
      agentName: 'dispatchagent',
      prompt: 'Use the explorer role.',
      author: { name: 'Community' },
      tags: ['dispatch'],
      license: 'MIT',
      compatibility: { plugin: '>=3.0.0' },
      routing: {
        description: 'Dispatch test routing.',
        keywords: ['dispatch'],
        when: 'When dispatching.',
      },
      skills: [],
      mcps: [],
      tools: [],
      model: { source: 'explicit', candidates: ['provider/model'] },
    },
  };
}

function download(version: string): MarketplaceRegistryDownload {
  const packageBundle = bundle(version);
  return {
    bundle: packageBundle,
    entry: createMarketplaceRegistryEntry(packageBundle),
    indexUrl: MARKETPLACE_REGISTRY_INDEX_URL,
    packageUrl: `https://registry.ohmyopencodeslim.com/v2/artifacts/community/dispatch-agent/${version}.json`,
  };
}

function clientFor(
  versions: readonly string[],
  signals: AbortSignal[] = [],
): Pick<MarketplaceService['registryClient'], 'download'> {
  let position = 0;
  return {
    download: async (_selector, _minimumVersion, signal) => {
      if (signal) signals.push(signal);
      const version = versions[Math.min(position++, versions.length - 1)];
      return download(version);
    },
  };
}

afterEach(() => {
  mock.restore();
});

describe('R1 explicit CLI and tool dispatch', () => {
  test('CLI dispatches install/update to a mocked remote client', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-cli-dispatch-'));
    const calls: Array<{ selector: string; minimumVersion?: string }> = [];
    const registryClient = {
      download: async (selector: string, minimumVersion?: string) => {
        calls.push({ selector, minimumVersion });
        return download(minimumVersion ? '2.0.0' : '1.0.0');
      },
    };
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const options = {
        rootDir: root,
        projectDir: root,
        pluginVersion: '3.1.0',
        registryClient,
        reload: async () => ({
          status: 'pending' as const,
          detail: 'test reload pending',
        }),
      };
      expect(
        await marketplaceCommand(
          ['install', 'community/dispatch-agent'],
          options,
        ),
      ).toBe(0);
      expect(
        await marketplaceCommand(
          ['update', 'community/dispatch-agent'],
          options,
        ),
      ).toBe(0);
      expect(calls).toEqual([
        { selector: 'community/dispatch-agent', minimumVersion: undefined },
        { selector: 'community/dispatch-agent', minimumVersion: '1.0.0' },
      ]);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('tool dispatches remote install/update and propagates cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-dispatch-'));
    const signals: AbortSignal[] = [];
    try {
      const service = new MarketplaceService({
        rootDir: root,
        pluginVersion: '3.1.0',
        registryClient: clientFor(['1.0.0', '2.0.0'], signals),
      });
      const tool = createMarketplaceTool({
        service,
        projectDir: root,
        shouldManageSession: () => true,
      }).marketplace;
      const abortSignal = new AbortController().signal;
      const context = {
        sessionID: 'orchestrator-session',
        agent: 'orchestrator',
        abort: abortSignal,
      };
      await tool.execute(
        { action: 'install', packageId: 'community/dispatch-agent' },
        context as never,
      );
      await tool.execute(
        { action: 'update', packageId: 'community/dispatch-agent' },
        context as never,
      );
      expect(service.show('community/dispatch-agent').manifest.version).toBe(
        '2.0.0',
      );
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBe(abortSignal);

      const controller = new AbortController();
      controller.abort();
      const cancelledService = new MarketplaceService({
        rootDir: join(root, 'cancelled'),
        pluginVersion: '3.1.0',
        registryClient: {
          download: async (_selector, _minimumVersion, signal) => {
            expect(signal).toBe(controller.signal);
            expect(signal?.aborted).toBe(true);
            throw new Error('cancelled');
          },
        },
      });
      const cancelledTool = createMarketplaceTool({
        service: cancelledService,
        projectDir: root,
        shouldManageSession: () => true,
      }).marketplace;
      await expect(
        cancelledTool.execute(
          { action: 'install', packageId: 'community/dispatch-agent' },
          { ...context, abort: controller.signal } as never,
        ),
      ).rejects.toThrow('cancelled');
      expect(cancelledService.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
