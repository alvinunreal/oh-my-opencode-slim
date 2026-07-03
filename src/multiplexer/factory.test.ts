import { afterEach, describe, expect, test } from 'bun:test';

async function importFreshFactory(suffix: string) {
  return import(`./factory?test=${suffix}-${Date.now()}-${Math.random()}`);
}

describe('multiplexer factory', () => {
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;

  afterEach(() => {
    process.env.TMUX = originalTmux;
    process.env.TMUX_PANE = originalTmuxPane;
    process.env.HERDR_ENV = originalHerdrEnv;
    process.env.HERDR_PANE_ID = originalHerdrPaneId;
  });

  test('returns a fresh tmux instance per call', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('tmux-first');

    const first = getMultiplexer({
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    process.env.TMUX_PANE = '%2';

    const { getMultiplexer: getMultiplexerAgain } =
      await importFreshFactory('tmux-second');

    const second = getMultiplexerAgain({
      type: 'tmux',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });

  test('returns a fresh auto-detected tmux instance per call', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('auto-first');

    const first = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    process.env.TMUX_PANE = '%2';

    const { getMultiplexer: getMultiplexerAgain } =
      await importFreshFactory('auto-second');

    const second = getMultiplexerAgain({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });

  test('returns a herdr instance when type is herdr', async () => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';

    const { getMultiplexer } = await importFreshFactory('herdr-explicit');

    const multiplexer = getMultiplexer({
      type: 'herdr',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('herdr');
  });

  test('auto-detects herdr when HERDR_ENV is set', async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.HERDR_ENV = '1';
    process.env.HERDR_PANE_ID = 'w1:p1';

    const { getMultiplexer } = await importFreshFactory('auto-herdr');

    const multiplexer = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('herdr');
  });

  test('auto-detects herdr when only HERDR_PANE_ID is set', async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.HERDR_ENV;
    process.env.HERDR_PANE_ID = 'w1:p1';

    const { getMultiplexer } = await importFreshFactory('auto-herdr-pane');

    const multiplexer = getMultiplexer({
      type: 'auto',
      layout: 'main-vertical',
      main_pane_size: 60,
      zellij_pane_mode: 'agent-tab',
    });

    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('herdr');
  });
});
