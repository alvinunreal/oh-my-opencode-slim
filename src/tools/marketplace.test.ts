import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createMarketplaceTools,
  resolveFinalizedOrchestratorIdentities,
} from './marketplace';

function fixture() {
  const calls: unknown[][] = [];
  const committed: string[] = [];
  const service = {
    projectDir: '/workspace',
    list: () => [{ id: 'x' }],
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
      return {};
    },
    importFile: (path: string) => {
      calls.push(['import', path]);
      return {};
    },
    updateRemote: async (target: string, signal?: AbortSignal) => {
      calls.push(['update', target, signal]);
      if (signal?.aborted) throw new Error('update aborted before commit');
      committed.push(`update:${target}`);
      return {};
    },
    updateFile: (path: string) => {
      calls.push(['update_file', path]);
      return {};
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
    ).toEqual([{ id: 'x' }]);
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
    ).toEqual([{ id: 'x' }]);
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
    ).toEqual([{ id: 'x' }]);
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
    ).toEqual([{ id: 'x' }]);
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
