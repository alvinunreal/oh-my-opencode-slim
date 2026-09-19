import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MultiplexerConfig } from '../config/schema';

async function importFreshFactory(suffix: string) {
  return import(`./factory?test=${suffix}-${Date.now()}-${Math.random()}`);
}

const BASE_CONFIG: Omit<MultiplexerConfig, 'type'> = {
  layout: 'main-vertical',
  main_pane_size: 60,
};

const PANE_ENV_KEYS = [
  'TMUX',
  'TMUX_PANE',
  'ZELLIJ',
  'ZELLIJ_PANE_ID',
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'KITTY_PID',
  'KITTY_WINDOW_ID',
  'CMUX_TUI_SOCKET',
  'CMUX_MUX_SOCKET',
  'CMUX_SOCKET_PATH',
  'CMUX_WORKSPACE_ID',
  'CMUX_SURFACE_ID',
] as const;

describe('multiplexer factory', () => {
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of PANE_ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PANE_ENV_KEYS) {
      const value = originals.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('returns a fresh tmux instance per call', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('tmux-first');

    const first = getMultiplexer({ ...BASE_CONFIG, type: 'tmux' });

    process.env.TMUX_PANE = '%2';

    const { getMultiplexer: getMultiplexerAgain } =
      await importFreshFactory('tmux-second');

    const second = getMultiplexerAgain({ ...BASE_CONFIG, type: 'tmux' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });

  test('returns a fresh auto-detected tmux instance per call', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('auto-first');

    const first = getMultiplexer({ ...BASE_CONFIG, type: 'auto' });

    process.env.TMUX_PANE = '%2';

    const { getMultiplexer: getMultiplexerAgain } =
      await importFreshFactory('auto-second');

    const second = getMultiplexerAgain({ ...BASE_CONFIG, type: 'auto' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Object.is(first, second)).toBe(false);
  });

  test('returns a herdr instance when type is herdr', async () => {
    process.env.HERDR_PANE_ID = 'w1:p1';

    const { getMultiplexer } = await importFreshFactory('herdr-explicit');

    const multiplexer = getMultiplexer({ ...BASE_CONFIG, type: 'herdr' });

    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('herdr');
  });

  test('auto-detects herdr from HERDR_PANE_ID', async () => {
    process.env.HERDR_PANE_ID = 'w1:p1';

    const { getMultiplexer } = await importFreshFactory('auto-herdr-pane');

    const multiplexer = getMultiplexer({ ...BASE_CONFIG, type: 'auto' });

    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('herdr');
  });

  test('auto does not detect herdr from HERDR_ENV alone', async () => {
    process.env.HERDR_ENV = '1';

    const { getMultiplexer } = await importFreshFactory('auto-herdr-env');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })).toBeNull();
  });

  test('auto-detects zellij from ZELLIJ_PANE_ID', async () => {
    process.env.ZELLIJ_PANE_ID = '3';

    const { getMultiplexer } = await importFreshFactory('auto-zellij-pane');

    const multiplexer = getMultiplexer({ ...BASE_CONFIG, type: 'auto' });

    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('zellij');
  });

  test('auto does not detect zellij from ZELLIJ alone', async () => {
    process.env.ZELLIJ = '0';

    const { getMultiplexer } = await importFreshFactory('auto-zellij-env');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })).toBeNull();
  });

  test('auto does not detect tmux from TMUX alone', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,123,0';

    const { getMultiplexer } = await importFreshFactory('auto-tmux-env');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })).toBeNull();
  });

  test('returns a cmux instance when explicitly configured', async () => {
    const { getMultiplexer } = await importFreshFactory('cmux-explicit');
    const multiplexer = getMultiplexer({
      ...BASE_CONFIG,
      type: 'cmux',
      layout: 'tiled',
    });
    expect(multiplexer?.type).toBe('cmux');
    // The configured layout must reach the adapter: cmux picks its split
    // direction at spawn time, so the first pane needs the real layout.
    // @ts-expect-error - accessing private for test
    expect(multiplexer?.layout).toBe('tiled');
  });

  test('auto-detects cmux from CMUX_TUI_SOCKET alone', async () => {
    process.env.CMUX_TUI_SOCKET = '/tmp/cmux-tui.sock';

    const { getMultiplexer } = await importFreshFactory('auto-cmux-tui');

    const multiplexer = getMultiplexer({
      ...BASE_CONFIG,
      type: 'auto',
      layout: 'even-vertical',
    });
    expect(multiplexer?.type).toBe('cmux');
    // @ts-expect-error - accessing private for test
    expect(multiplexer?.layout).toBe('even-vertical');
  });

  test('auto-detects cmux from the legacy CMUX_MUX_SOCKET', async () => {
    process.env.CMUX_MUX_SOCKET = '/tmp/cmux-mux.sock';

    const { getMultiplexer } = await importFreshFactory('auto-cmux-mux');

    const multiplexer = getMultiplexer({
      ...BASE_CONFIG,
      type: 'auto',
      layout: 'even-horizontal',
    });
    expect(multiplexer?.type).toBe('cmux');
    // @ts-expect-error - accessing private for test
    expect(multiplexer?.layout).toBe('even-horizontal');
  });

  test('auto does not detect cmux from the removed CMUX_SOCKET_PATH', async () => {
    process.env.CMUX_SOCKET_PATH = '/tmp/cmux.sock';
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.CMUX_SURFACE_ID = 'surface-1';

    const { getMultiplexer } = await importFreshFactory('auto-cmux-legacy');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })).toBeNull();
  });

  test('returns a kitty instance when type is kitty', async () => {
    const { getMultiplexer } = await importFreshFactory('kitty-explicit');
    const multiplexer = getMultiplexer({ ...BASE_CONFIG, type: 'kitty' });
    expect(multiplexer).not.toBeNull();
    expect(multiplexer?.type).toBe('kitty');
  });

  test('auto-detects kitty from KITTY_WINDOW_ID', async () => {
    process.env.KITTY_WINDOW_ID = '4';

    const { getMultiplexer } = await importFreshFactory('auto-kitty-window');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })?.type).toBe(
      'kitty',
    );
  });

  test('auto does not detect kitty from KITTY_PID alone', async () => {
    process.env.KITTY_PID = '12345';

    const { getMultiplexer } = await importFreshFactory('auto-kitty-pid');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })).toBeNull();
  });

  test('auto returns null when no pane-level signal is present', async () => {
    const { getMultiplexer } = await importFreshFactory('auto-none');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'auto' })).toBeNull();
  });

  test('returns null when type is none', async () => {
    process.env.TMUX_PANE = '%1';

    const { getMultiplexer } = await importFreshFactory('type-none');

    expect(getMultiplexer({ ...BASE_CONFIG, type: 'none' })).toBeNull();
  });
});
