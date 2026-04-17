/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test';
import { resolveGrepCli, resolveGrepCliWithAutoInstall } from './resolver';
import { createTempTracker } from './test-helpers';

describe('tools/grep/resolver', () => {
  createTempTracker({ resetResolver: true });

  test.each([
    {
      name: 'prioritizes system rg over managed rg and system grep',
      deps: {
        findExecutable: (name: string) => {
          if (name === 'rg') {
            return '/usr/bin/rg';
          }

          if (name === 'grep') {
            return '/usr/bin/grep';
          }

          return null;
        },
        getInstalledRipgrepPath: () =>
          '/home/user/.cache/oh-my-opencode-slim/grep/bin/rg',
      },
      expected: {
        path: '/usr/bin/rg',
        backend: 'rg',
        source: 'system-rg',
      },
    },
    {
      name: 'prefers managed rg before system grep',
      deps: {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () =>
          '/home/user/.cache/oh-my-opencode-slim/grep/bin/rg',
      },
      expected: {
        path: '/home/user/.cache/oh-my-opencode-slim/grep/bin/rg',
        backend: 'rg',
        source: 'managed-rg',
      },
    },
    {
      name: 'ignores non-GNU grep fallbacks',
      deps: {
        findExecutable: (name: string) =>
          name === 'grep' ? '/usr/bin/grep' : null,
        getInstalledRipgrepPath: () => null,
        isSupportedGrep: () => false,
      },
      expected: {
        path: 'rg',
        backend: 'rg',
        source: 'missing-rg',
      },
    },
  ])('resolveGrepCli $name', ({ deps, expected }) => {
    expect(resolveGrepCli(deps)).toEqual(expected);
  });

  test('resolveGrepCliWithAutoInstall installs ripgrep once on miss', async () => {
    let installedPath: string | null = null;
    const installLatest = mock(async () => {
      installedPath = '/home/user/.cache/oh-my-opencode-slim/grep/bin/rg';
      return installedPath;
    });

    const resolverDeps = {
      findExecutable: (name: string) =>
        name === 'grep' ? '/usr/bin/grep' : null,
      getInstalledRipgrepPath: () => installedPath,
      installLatestStableRipgrep: installLatest,
      logger: () => undefined,
    };

    const first = await resolveGrepCliWithAutoInstall(resolverDeps);
    const second = await resolveGrepCliWithAutoInstall(resolverDeps);

    expect(first).toEqual({
      path: '/home/user/.cache/oh-my-opencode-slim/grep/bin/rg',
      backend: 'rg',
      source: 'managed-rg',
    });
    expect(second).toEqual(first);
    expect(installLatest.mock.calls).toHaveLength(1);
  });

  test('resolveGrepCliWithAutoInstall falls back to system grep when install fails', async () => {
    const logger = mock(() => undefined);

    const cli = await resolveGrepCliWithAutoInstall({
      findExecutable: (name) => (name === 'grep' ? '/usr/bin/grep' : null),
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => {
        throw new Error('network down');
      },
      logger,
    });

    expect(cli).toEqual({
      path: '/usr/bin/grep',
      backend: 'grep',
      source: 'system-gnu-grep',
    });
    expect(logger.mock.calls).toHaveLength(1);
  });

  test('resolveGrepCliWithAutoInstall does not cache aborts as permanent install failures', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveGrepCliWithAutoInstall(
        {
          findExecutable: () => null,
          getInstalledRipgrepPath: () => null,
          installLatestStableRipgrep: async () => {
            throw new Error('should not reach installer when already aborted');
          },
          logger: () => undefined,
        },
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled before execution started/i);

    const cli = await resolveGrepCliWithAutoInstall({
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => '/tmp/managed-rg',
      logger: () => undefined,
    });

    expect(cli).toEqual({
      path: '/tmp/managed-rg',
      backend: 'rg',
      source: 'managed-rg',
    });
  });

  test('resolveGrepCliWithAutoInstall retries after an aborted install attempt', async () => {
    let attempts = 0;
    const controller = new AbortController();

    const firstAttempt = resolveGrepCliWithAutoInstall(
      {
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async (signal?: AbortSignal) => {
          attempts += 1;
          await new Promise<never>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          });
          return '/tmp/unreachable';
        },
        logger: () => undefined,
      },
      controller.signal,
    );

    controller.abort();

    await expect(firstAttempt).rejects.toThrow(
      /cancelled before execution started/i,
    );

    const secondAttempt = await resolveGrepCliWithAutoInstall({
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => {
        attempts += 1;
        return '/tmp/managed-rg';
      },
      logger: () => undefined,
    });

    expect(attempts).toBe(2);
    expect(secondAttempt.source).toBe('managed-rg');
  });

  test('resolveGrepCliWithAutoInstall throws a clear error when rg and grep are unavailable', async () => {
    await expect(
      resolveGrepCliWithAutoInstall({
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async () => {
          throw new Error('network down');
        },
        logger: () => undefined,
      }),
    ).rejects.toThrow(/Neither ripgrep \(rg\) nor GNU grep is available\./);
  });

  test('resolveGrepCliWithAutoInstall retries after a previous install failure when no fallback exists', async () => {
    let attempts = 0;

    await expect(
      resolveGrepCliWithAutoInstall({
        findExecutable: () => null,
        getInstalledRipgrepPath: () => null,
        installLatestStableRipgrep: async () => {
          attempts += 1;
          throw new Error(`network down ${attempts}`);
        },
        logger: () => undefined,
      }),
    ).rejects.toThrow(/network down 1/);

    const second = await resolveGrepCliWithAutoInstall({
      findExecutable: () => null,
      getInstalledRipgrepPath: () => null,
      installLatestStableRipgrep: async () => {
        attempts += 1;
        return '/tmp/managed-rg';
      },
      logger: () => undefined,
    });

    expect(attempts).toBe(2);
    expect(second).toEqual({
      path: '/tmp/managed-rg',
      backend: 'rg',
      source: 'managed-rg',
    });
  });
});
