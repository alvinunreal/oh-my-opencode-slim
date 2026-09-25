import { describe, expect, test } from 'bun:test';
import { reloadOpenCodeService } from './reload';

function commandRunner(
  responses: Record<
    string,
    { exitCode: number; stdout?: string; stderr?: string }
  >,
) {
  const calls: string[] = [];
  const run = async (args: readonly string[]) => {
    const key = args.join(' ');
    calls.push(key);
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${key}`);
    return {
      exitCode: response.exitCode,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    };
  };
  return { calls, run };
}

describe('OpenCode marketplace reload', () => {
  test('restarts an active v2 service', async () => {
    const runner = commandRunner({
      '--version': { exitCode: 0, stdout: 'opencode v2.0.2\n' },
      'service status': { exitCode: 0, stdout: 'http://127.0.0.1:4096\n' },
      'service restart': { exitCode: 0, stdout: 'http://127.0.0.1:4096\n' },
    });

    await expect(
      reloadOpenCodeService({ cwd: '/tmp/project', run: runner.run }),
    ).resolves.toEqual({
      status: 'reloaded',
      detail:
        'Active OpenCode v2 service restarted; marketplace configuration is applied.',
    });
    expect(runner.calls).toEqual([
      '--version',
      'service status',
      'service restart',
    ]);
  });

  test('leaves configuration pending when v2 has no service', async () => {
    const runner = commandRunner({
      '--version': { exitCode: 0, stdout: 'opencode 2.0.2' },
      'service status': { exitCode: 0, stdout: 'stopped\n' },
    });

    await expect(
      reloadOpenCodeService({ cwd: '/tmp/project', run: runner.run }),
    ).resolves.toMatchObject({ status: 'pending' });
    expect(runner.calls).toEqual(['--version', 'service status']);
  });

  test('does not attempt a service restart for v1', async () => {
    const runner = commandRunner({
      '--version': { exitCode: 0, stdout: '1.18.13' },
    });

    await expect(
      reloadOpenCodeService({ cwd: '/tmp/project', run: runner.run }),
    ).resolves.toMatchObject({ status: 'unsupported' });
    expect(runner.calls).toEqual(['--version']);
  });

  test('reports unavailable without failing when OpenCode cannot be run', async () => {
    const runner = commandRunner({
      '--version': { exitCode: 127, stderr: 'command not found' },
    });

    await expect(
      reloadOpenCodeService({ cwd: '/tmp/project', run: runner.run }),
    ).resolves.toMatchObject({ status: 'unavailable' });
  });

  test('reports a failed restart without throwing', async () => {
    const runner = commandRunner({
      '--version': { exitCode: 0, stdout: '2.0.2' },
      'service status': { exitCode: 0, stdout: 'http://127.0.0.1:4096' },
      'service restart': { exitCode: 1, stderr: 'restart failed' },
    });

    await expect(
      reloadOpenCodeService({ cwd: '/tmp/project', run: runner.run }),
    ).resolves.toEqual({
      status: 'unavailable',
      detail: 'OpenCode service unavailable: restart failed',
    });
  });
});
