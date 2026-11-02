import { describe, expect, jest, spyOn, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireMarketplaceLease } from '../marketplace/lease';
import { getMarketplacePaths } from '../marketplace/paths';
import { MarketplaceService } from '../marketplace/service';
import {
  createMarketplaceTools,
  resolveFinalizedOrchestratorIdentities,
} from './marketplace';

function fixture() {
  const calls: unknown[][] = [];
  const committed: string[] = [];
  const stored = {
    manifest: { id: 'x', version: '1.0.0', displayName: 'Example' },
    source: { kind: 'in-memory', label: 'test' },
    digest: 'digest',
  };
  const service = {
    projectDir: '/workspace',
    list: () => [stored],
    show: (id: string) => ({ id }),
    verify: (id?: string) => [{ id, valid: true }],
    status: () => ({
      liveAvailable: false,
      livePackages: null,
      reloadRequired: null,
    }),
    requestReload: () => ({ accepted: false, reloadRequired: null }),
    installRemote: async (target: string, signal?: AbortSignal) => {
      calls.push(['install', target, signal]);
      if (signal?.aborted) throw new Error('install aborted before commit');
      committed.push(`install:${target}`);
      return stored;
    },
    importFile: (path: string) => {
      calls.push(['import', path]);
      return stored;
    },
    updateRemote: async (target: string, signal?: AbortSignal) => {
      calls.push(['update', target, signal]);
      if (signal?.aborted) throw new Error('update aborted before commit');
      committed.push(`update:${target}`);
      return stored;
    },
    updateFile: (path: string) => {
      calls.push(['update_file', path]);
      return stored;
    },
    uninstallGlobal: (target: string, acknowledge: boolean) => {
      calls.push(['uninstall', target, acknowledge]);
      return { uninstalled: true };
    },
    enable: (target: string, scope: string) =>
      calls.push(['enable', target, scope]),
    disable: (target: string, scope: string) =>
      calls.push(['disable', target, scope]),
  };
  return { calls, committed, service: service as never };
}

describe('marketplace tools', () => {
  test('list and mutation results omit prompts while show retains them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-tool-summary-'));
    const service = new MarketplaceService({
      rootDir: join(root, 'store'),
      projectDir: root,
      pluginVersion: '3.2.0',
    });
    const makeBundle = (version: string) => ({
      manifest: {
        schemaVersion: 2,
        id: 'team/summary',
        version,
        displayName: 'Summary agent',
        description: 'Test fixture',
        agentName: 'summary-agent',
        prompt: 'PRIVATE FULL PROMPT',
        skills: [],
        mcps: [],
        tools: [],
        author: { name: 'Test' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '*' },
        model: { source: 'session' },
        routing: { description: 'Summary', when: 'Testing.', keywords: [] },
      },
    });
    try {
      const file = join(root, 'bundle.json');
      writeFileSync(file, JSON.stringify(makeBundle('1.0.0')));
      const tools = createMarketplaceTools({ service });
      const context = { agent: 'orchestrator' } as never;
      const imported = await tools.marketplace_manage.execute(
        { action: 'import', target: file },
        context,
      );
      expect(imported).not.toContain('PRIVATE FULL PROMPT');
      expect(JSON.parse(imported)).toMatchObject({
        id: 'team/summary',
        version: '1.0.0',
        name: 'Summary agent',
      });
      const listed = await tools.marketplace_inspect.execute(
        { action: 'list' },
        context,
      );
      expect(listed).not.toContain('PRIVATE FULL PROMPT');
      expect(JSON.parse(listed)).toMatchObject([
        { id: 'team/summary', version: '1.0.0' },
      ]);
      const shown = await tools.marketplace_inspect.execute(
        { action: 'show', target: 'team/summary' },
        context,
      );
      expect(JSON.parse(shown).manifest.prompt).toBe('PRIVATE FULL PROMPT');
      writeFileSync(file, JSON.stringify(makeBundle('1.1.0')));
      const updated = await tools.marketplace_manage.execute(
        { action: 'update_file', target: file },
        context,
      );
      expect(updated).not.toContain('PRIVATE FULL PROMPT');
      expect(JSON.parse(updated)).toMatchObject({
        id: 'team/summary',
        version: '1.1.0',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retries a busy store without blocking the host event loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-host-wait-'));
    const service = new MarketplaceService({
      rootDir: join(root, 'store'),
      projectDir: root,
      pluginVersion: '3.2.0',
      lock: { timeoutMs: 0 },
    });
    const owner = acquireMarketplaceLease(service.store.paths);
    let released = false;
    jest.useFakeTimers();
    try {
      const inspect = createMarketplaceTools({ service }).marketplace_inspect;
      let settled = false;
      const result = inspect.execute({ action: 'status' }, {
        agent: 'orchestrator',
      } as never);
      result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      owner.release();
      released = true;
      jest.advanceTimersByTime(20);
      expect(JSON.parse(await result)).toMatchObject({ desiredPackageIds: [] });

      const configDir = join(root, '.opencode');
      const configPath = join(configDir, 'oh-my-opencode-slim.json');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          preset: 'work',
          presets: { work: { marketplace: { agents: ['team/blocked'] } } },
        }),
      );
      const configOwner = acquireMarketplaceLease(
        getMarketplacePaths(
          join(configDir, '.oh-my-opencode-slim.json.write-lock'),
        ),
      );
      let configReleased = false;
      try {
        const manage = createMarketplaceTools({ service }).marketplace_manage;
        const change = manage.execute(
          { action: 'disable', target: 'team/blocked' },
          { agent: 'orchestrator' } as never,
        );
        await Promise.resolve();
        configOwner.assertCurrent();
        configOwner.release();
        configReleased = true;
        jest.advanceTimersByTime(20);
        expect(JSON.parse(await change)).toEqual({ enabled: false });
        expect(readFileSync(configPath, 'utf8')).not.toContain('team/blocked');
      } finally {
        if (!configReleased) configOwner.release();
      }

      const secondOwner = acquireMarketplaceLease(service.store.paths);
      try {
        const abort = new AbortController();
        const cancelled = inspect.execute({ action: 'status' }, {
          agent: 'orchestrator',
          abort: abort.signal,
        } as never);
        await Promise.resolve();
        abort.abort(new Error('cancelled'));
        await expect(cancelled).rejects.toThrow('cancelled');
        secondOwner.assertCurrent();
      } finally {
        secondOwner.release();
      }
    } finally {
      if (!released) owner.release();
      jest.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retries local update leases without downloading the package again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-remote-lease-'));
    const bundle = (version: string) => ({
      manifest: {
        schemaVersion: 2,
        id: 'team/lease',
        version,
        displayName: 'Lease fixture',
        description: 'Test fixture',
        agentName: 'lease-agent',
        prompt: 'Test.',
        skills: [],
        mcps: [],
        tools: [],
        author: { name: 'Test' },
        tags: [],
        license: 'MIT',
        compatibility: { plugin: '*' },
        model: { source: 'session' },
        routing: { description: 'Lease', when: 'Testing.', keywords: [] },
      },
    });
    let downloadCount = 0;
    let commitOwner: ReturnType<typeof acquireMarketplaceLease> | undefined;
    let releaseDownload!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const service = new MarketplaceService({
      rootDir: join(root, 'store'),
      projectDir: root,
      pluginVersion: '3.2.0',
      registryClient: {
        download: async () => {
          throw new Error('unexpected v2 download');
        },
        downloadV3: async () => {
          downloadCount++;
          if (downloadCount === 1) {
            commitOwner = acquireMarketplaceLease(service.store.paths);
            releaseDownload();
          }
          return {
            bundle: bundle('2.0.0') as never,
            entry: {} as never,
            indexUrl: 'https://registry.test/v3/index.json',
            packageUrl: 'https://registry.test/v3/package.json',
          };
        },
      },
    });
    service.install(bundle('1.0.0') as never);
    const read = spyOn(service.store, 'show');
    const update = spyOn(service.store, 'update');
    const readOwner = acquireMarketplaceLease(service.store.paths);
    let readReleased = false;
    jest.useFakeTimers();
    const advanceRetry = async () => {
      for (let i = 0; i < 30 && jest.getTimerCount() === 0; i++) {
        await Promise.resolve();
      }
      expect(jest.getTimerCount()).toBeGreaterThan(0);
      jest.advanceTimersByTime(20);
    };
    try {
      const manage = createMarketplaceTools({ service }).marketplace_manage;
      const result = manage.execute(
        { action: 'update', target: 'team/lease' },
        { agent: 'orchestrator' } as never,
      );
      await advanceRetry();
      await advanceRetry();
      expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(downloadCount).toBe(0);
      readOwner.release();
      readReleased = true;
      await advanceRetry();
      await downloadStarted;
      await advanceRetry();
      await advanceRetry();
      commitOwner?.release();
      commitOwner = undefined;
      await advanceRetry();
      await result;
      expect(service.store.show('team/lease').manifest.version).toBe('2.0.0');
      expect(update.mock.calls.length).toBeGreaterThan(1);
      expect(downloadCount).toBe(1);
    } finally {
      if (!readReleased) readOwner.release();
      commitOwner?.release();
      read.mockRestore();
      update.mockRestore();
      jest.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exposes fixed action enum schemas and orchestrator alias guard', async () => {
    const { service } = fixture();
    const tools = createMarketplaceTools({
      service,
      orchestratorIdentities: new Set(['workflow-lead']),
      cwd: '/project',
    });
    expect(Object.values(tools.marketplace_inspect.args.action.enum)).toEqual([
      'list',
      'show',
      'verify',
      'status',
      'request_reload',
    ]);
    expect(Object.values(tools.marketplace_manage.args.action.enum)).toEqual([
      'install',
      'import',
      'update',
      'update_file',
      'uninstall',
      'enable',
      'disable',
    ]);
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute({ action: 'list' } as never, { agent: 'fixer' } as never),
    ).rejects.toThrow('only to the orchestrator');
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'workflow-lead' } as never,
        ),
      ),
    ).toMatchObject([{ id: 'x', version: '1.0.0', name: 'Example' }]);
  });

  test('uses live finalized identity and rejects calls before registry readiness', async () => {
    let finalized = false;
    const tools = createMarketplaceTools({
      service: fixture().service,
      getOrchestratorIdentities: () => {
        if (!finalized) throw new Error('not ready');
        return new Set(['orchestrator', 'host-lead']);
      },
    });
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute(
        { action: 'list' } as never,
        { agent: 'host-lead' } as never,
      ),
    ).rejects.toThrow('until the agent registry is finalized');
    finalized = true;
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'host-lead' } as never,
        ),
      ),
    ).toMatchObject([{ id: 'x', version: '1.0.0', name: 'Example' }]);
  });

  test('rejects a shared orchestrator/fixer display alias but keeps canonical access', async () => {
    const identities = resolveFinalizedOrchestratorIdentities({
      agentNames: ['orchestrator', 'fixer'],
      identities: { orchestrator: 'Lead', fixer: 'Lead' },
    });
    expect(identities).toEqual(new Set(['orchestrator']));

    const tools = createMarketplaceTools({
      service: fixture().service,
      getOrchestratorIdentities: () => identities,
    });
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute({ action: 'list' } as never, { agent: 'Lead' } as never),
    ).rejects.toThrow('only to the orchestrator');
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'orchestrator' } as never,
        ),
      ),
    ).toMatchObject([{ id: 'x', version: '1.0.0', name: 'Example' }]);
  });

  test('does not treat orchestrator as canonical when a specialist owns that visible name', async () => {
    const identities = resolveFinalizedOrchestratorIdentities({
      agentNames: ['orchestrator', 'fixer'],
      identities: { orchestrator: 'Lead', fixer: 'orchestrator' },
    });
    expect(identities).toEqual(new Set(['Lead']));

    const tools = createMarketplaceTools({
      service: fixture().service,
      getOrchestratorIdentities: () => identities,
    });
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      inspect.execute(
        { action: 'list' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('only to the orchestrator');
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'list' } as never,
          { agent: 'Lead' } as never,
        ),
      ),
    ).toMatchObject([{ id: 'x', version: '1.0.0', name: 'Example' }]);
  });

  test('management adapters resolve files against cwd and never claim reload', async () => {
    const { calls, service } = fixture();
    const tools = createMarketplaceTools({ service, cwd: '/project' });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await manage.execute(
      { action: 'import', target: 'bundle.json' } as never,
      { agent: 'orchestrator' } as never,
    );
    await manage.execute(
      { action: 'enable', target: 'author/name' } as never,
      { agent: 'orchestrator' } as never,
    );
    expect(calls).toEqual([
      ['import', '/project/bundle.json'],
      ['enable', 'author/name', 'project'],
    ]);
    const inspect = tools.marketplace_inspect as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    expect(
      JSON.parse(
        await inspect.execute(
          { action: 'request_reload' } as never,
          { agent: 'orchestrator' } as never,
        ),
      ),
    ).toMatchObject({ accepted: false, reloadRequired: null });
  });

  test('rejects blank targets at execution even if a caller bypasses schema parsing', async () => {
    const tools = createMarketplaceTools({ service: fixture().service });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };
    await expect(
      manage.execute(
        { action: 'enable', target: '   ' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('nonblank');
  });

  test('requires acknowledgement before global uninstall', async () => {
    const { calls, service } = fixture();
    const tools = createMarketplaceTools({ service });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };

    await expect(
      manage.execute(
        { action: 'uninstall', target: 'author/package' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('acknowledge_other_projects: true');
    await expect(
      manage.execute(
        {
          action: 'uninstall',
          target: 'author/package',
          acknowledge_other_projects: false,
        } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('acknowledge_other_projects: true');
    expect(calls).toEqual([]);

    await manage.execute(
      {
        action: 'uninstall',
        target: 'author/package',
        acknowledge_other_projects: true,
      } as never,
      { agent: 'orchestrator' } as never,
    );
    expect(calls).toEqual([['uninstall', 'author/package', true]]);
  });

  test('declares acknowledgement as a plain optional boolean', () => {
    const tools = createMarketplaceTools({ service: fixture().service });
    const ack = tools.marketplace_manage.args.acknowledge_other_projects;
    // Locks the #1471 fix: z.literal(true) rejects false here and emits
    // const:true, which Gemini rejects with HTTP 400.
    expect(ack.safeParse(false).success).toBe(true);
    expect(ack.safeParse(undefined).success).toBe(true);
    const toJSONSchema = (
      z as unknown as { toJSONSchema?: (schema: unknown) => unknown }
    ).toJSONSchema;
    if (typeof toJSONSchema === 'function') {
      const json = toJSONSchema(ack) as { const?: unknown; enum?: unknown };
      expect(json).not.toHaveProperty('const');
      expect(json).not.toHaveProperty('enum');
    }
  });

  test('routes activation scope and rejects scope for unrelated actions', async () => {
    const { calls, service } = fixture();
    const tools = createMarketplaceTools({ service });
    const manage = tools.marketplace_manage as unknown as {
      execute(args: never, ctx: never): Promise<string>;
    };

    await manage.execute(
      { action: 'disable', target: 'author/package', scope: 'user' } as never,
      { agent: 'orchestrator' } as never,
    );
    expect(calls).toEqual([['disable', 'author/package', 'user']]);
    await expect(
      manage.execute(
        { action: 'install', target: 'author/package', scope: 'user' } as never,
        { agent: 'orchestrator' } as never,
      ),
    ).rejects.toThrow('scope is only supported by enable and disable');
    expect(calls).toHaveLength(1);
  });

  test.each(['install', 'update'] as const)(
    'passes the abort signal to remote %s and does not commit when aborted',
    async (action) => {
      const { calls, committed, service } = fixture();
      const tools = createMarketplaceTools({ service });
      const manage = tools.marketplace_manage as unknown as {
        execute(args: never, ctx: never): Promise<string>;
      };
      const controller = new AbortController();
      controller.abort();

      await expect(
        manage.execute(
          { action, target: 'author/package' } as never,
          { agent: 'orchestrator', abort: controller.signal } as never,
        ),
      ).rejects.toThrow(`${action} aborted before commit`);
      expect(calls).toEqual([[action, 'author/package', controller.signal]]);
      expect(committed).toEqual([]);
    },
  );
});
