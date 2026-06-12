import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type SpawnResult = {
  exited: Promise<number>;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  kill: () => boolean;
  exitCode: number | null;
  proc: never;
};

const crossSpawnMock = mock((_command: string[]) => createSpawnResult());

mock.module('../../utils/compat', () => ({
  crossSpawn: crossSpawnMock,
}));

let importCounter = 0;

function createSpawnResult(
  exitCode = 0,
  stdout = '',
  stderr = '',
): SpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: () => Promise.resolve(stdout),
    stderr: () => Promise.resolve(stderr),
    kill: () => true,
    exitCode,
    proc: {} as never,
  };
}

function createPaneListJson(parentTabId = 0): string {
  return JSON.stringify([
    {
      id: 0,
      is_plugin: false,
      tab_id: parentTabId,
    },
    {
      id: 4,
      is_plugin: false,
      tab_id: 1,
    },
  ]);
}

async function importFreshZellij() {
  return import(`./index?test=${importCounter++}`);
}

function commands(): string[][] {
  return crossSpawnMock.mock.calls.map((call) => call[0] as string[]);
}

async function spawnSecondAgentTabPane(
  layout: 'main-vertical' | 'main-horizontal' | 'tiled',
): Promise<string[] | undefined> {
  const { ZellijMultiplexer } = await importFreshZellij();
  const zellij = new ZellijMultiplexer(layout, 60, 'agent-tab');

  crossSpawnMock.mockImplementation((command: string[]) => {
    if (command[0] === 'which') {
      return createSpawnResult(0, '/usr/bin/zellij\n');
    }
    if (command.includes('list-tabs')) {
      return createSpawnResult(
        0,
        JSON.stringify([{ name: 'opencode-agents', tab_id: 5 }]),
      );
    }
    if (command.includes('current-tab-info')) {
      return createSpawnResult(0, JSON.stringify({ tab_id: 0 }));
    }
    if (command.includes('list-panes')) {
      return createSpawnResult(0, 'PANE ID\nterminal_7\n');
    }
    if (command.includes('new-pane')) {
      return createSpawnResult(0, 'terminal_8\n');
    }
    return createSpawnResult();
  });

  await zellij.spawnPane(
    'session-1',
    'First agent worker',
    'http://localhost:4096',
    '/repo',
  );

  await zellij.spawnPane(
    'session-2',
    'Second agent worker',
    'http://localhost:4096',
    '/repo',
  );

  return commands().findLast((command) => command.includes('new-pane'));
}

describe('ZellijMultiplexer', () => {
  const originalZellij = process.env.ZELLIJ;
  const originalZellijPaneId = process.env.ZELLIJ_PANE_ID;

  beforeEach(() => {
    process.env.ZELLIJ = '1';
    process.env.ZELLIJ_PANE_ID = '0';

    crossSpawnMock.mockReset();
    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });
  });

  afterEach(() => {
    process.env.ZELLIJ = originalZellij;
    process.env.ZELLIJ_PANE_ID = originalZellijPaneId;
  });

  test('current-tab mode spawns a pane in the parent OpenCode tab', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: true, paneId: 'terminal_2' });

    const allCommands = commands();
    const newPaneCommand = allCommands.find((command) =>
      command.includes('new-pane'),
    );

    expect(newPaneCommand).toEqual([
      '/usr/bin/zellij',
      'action',
      'new-pane',
      '--tab-id',
      '0',
      '--direction',
      'right',
      '--name',
      'Current tab worker',
      '--close-on-exit',
      '--',
      'sh',
      '-lc',
      "opencode attach 'http://localhost:4096' --session 'session-1' --dir '/repo'",
    ]);
    expect(allCommands.some((command) => command.includes('new-tab'))).toBe(
      false,
    );
    expect(
      allCommands.some((command) => command.includes('go-to-tab-by-id')),
    ).toBe(false);
  });

  test('current-tab mode reports failure when zellij does not return a terminal pane id', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson());
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'plugin_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    expect(result).toEqual({ success: false });
  });

  test('current-tab mode targets the parent OpenCode tab even when another tab is focused', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(0, createPaneListJson(0));
      }
      if (command.includes('current-tab-info')) {
        return createSpawnResult(0, JSON.stringify({ tab_id: 1 }));
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    const result = await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );

    const tabIdArgIndex = newPaneCommand?.indexOf('--tab-id') ?? -1;
    expect(result).toEqual({ success: true, paneId: 'terminal_2' });
    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[tabIdArgIndex + 1]).toBe('0');
  });

  test('current-tab mode accepts terminal-prefixed parent pane ids', async () => {
    process.env.ZELLIJ_PANE_ID = 'terminal_0';

    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    const tabIdArgIndex = newPaneCommand?.indexOf('--tab-id') ?? -1;

    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[tabIdArgIndex + 1]).toBe('0');
  });

  test('current-tab mode falls back to the focused tab if parent tab lookup fails', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(1, '', 'list failed');
      }
      if (command.includes('current-tab-info')) {
        return createSpawnResult(0, JSON.stringify({ tab_id: 1 }));
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    const tabIdArgIndex = newPaneCommand?.indexOf('--tab-id') ?? -1;

    expect(tabIdArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[tabIdArgIndex + 1]).toBe('1');
  });

  test('current-tab mode caches the fallback focused tab after parent tab lookup fails', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-vertical', 60, 'current-tab');
    let currentTabId = 1;

    crossSpawnMock.mockImplementation((command: string[]) => {
      if (command[0] === 'which') {
        return createSpawnResult(0, '/usr/bin/zellij\n');
      }
      if (command.includes('list-panes')) {
        return createSpawnResult(1, '', 'list failed');
      }
      if (command.includes('current-tab-info')) {
        return createSpawnResult(0, JSON.stringify({ tab_id: currentTabId++ }));
      }
      if (command.includes('new-pane')) {
        return createSpawnResult(0, 'terminal_2\n');
      }
      return createSpawnResult();
    });

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );
    await zellij.spawnPane(
      'session-2',
      'Current tab worker 2',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommands = commands().filter((command) =>
      command.includes('new-pane'),
    );

    expect(
      newPaneCommands.map((command) => {
        const tabIdArgIndex = command.indexOf('--tab-id');
        return command[tabIdArgIndex + 1];
      }),
    ).toEqual(['1', '1']);
  });

  test('main-horizontal layout opens current-tab panes down', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('main-horizontal', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    const directionArgIndex = newPaneCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[directionArgIndex + 1]).toBe('down');
  });

  test('even-horizontal layout uses zellij native current-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('even-horizontal', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    expect(newPaneCommand).not.toContain('--direction');
  });

  test('even-vertical layout uses zellij native current-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('even-vertical', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );
    expect(newPaneCommand).not.toContain('--direction');
  });

  test('tiled layout uses zellij native current-tab pane placement', async () => {
    const { ZellijMultiplexer } = await importFreshZellij();
    const zellij = new ZellijMultiplexer('tiled', 60, 'current-tab');

    await zellij.spawnPane(
      'session-1',
      'Current tab worker',
      'http://localhost:4096',
      '/repo',
    );

    const newPaneCommand = commands().find((command) =>
      command.includes('new-pane'),
    );

    expect(newPaneCommand).not.toContain('--direction');
  });

  test('main-vertical layout opens agent-tab panes right', async () => {
    const newPaneCommand = await spawnSecondAgentTabPane('main-vertical');
    const directionArgIndex = newPaneCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[directionArgIndex + 1]).toBe('right');
  });

  test('main-horizontal layout opens agent-tab panes down', async () => {
    const newPaneCommand = await spawnSecondAgentTabPane('main-horizontal');
    const directionArgIndex = newPaneCommand?.indexOf('--direction') ?? -1;

    expect(directionArgIndex).toBeGreaterThanOrEqual(0);
    expect(newPaneCommand?.[directionArgIndex + 1]).toBe('down');
  });

  test('tiled layout uses zellij native agent-tab pane placement', async () => {
    const newPaneCommand = await spawnSecondAgentTabPane('tiled');

    expect(newPaneCommand).not.toContain('--direction');
  });
});
