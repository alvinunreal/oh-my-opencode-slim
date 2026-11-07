import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectPaneIds,
  equalizeAgentPanes,
  equalizeUpdates,
  type HerdrLayoutNode,
  herdrSocketEndpoint,
  mainBoundaryUpdate,
  paneSpan,
  ratioAtPath,
} from './layout-equalize';

function pane(id: string): HerdrLayoutNode {
  return { type: 'pane', pane_id: id };
}

function split(
  direction: 'down' | 'right',
  first: HerdrLayoutNode,
  second: HerdrLayoutNode,
): HerdrLayoutNode {
  return { type: 'split', direction, ratio: 0.5, first, second };
}

describe('paneSpan', () => {
  test('sums along the split axis and takes the larger side across it', () => {
    // Three columns wide, one row tall.
    const inner = split(
      'right',
      split('right', pane('a'), pane('b')),
      pane('c'),
    );

    expect(paneSpan(pane('a'), 'down')).toBe(1);
    expect(paneSpan(inner, 'right')).toBe(3);
    // A horizontal split does not divide vertical space: still one row.
    expect(paneSpan(inner, 'down')).toBe(1);

    const vertical = split('down', pane('a'), pane('b'));
    expect(paneSpan(vertical, 'down')).toBe(2);
    expect(paneSpan(vertical, 'right')).toBe(1);
  });
});

describe('equalizeUpdates', () => {
  test('equalizes a three-pane agent chain to 2/3 and 1/2', () => {
    const chain = split('down', split('down', pane('a'), pane('b')), pane('c'));
    const root = split('right', pane('main'), chain);

    expect(equalizeUpdates(root, 'main')).toEqual([
      { path: [true], ratio: 2 / 3 },
      { path: [true, false], ratio: 1 / 2 },
    ]);
  });

  test('equalizes a four-pane agent chain to 3/4, 2/3 and 1/2', () => {
    const chain = split(
      'down',
      split('down', split('down', pane('a'), pane('b')), pane('c')),
      pane('d'),
    );
    const root = split('right', pane('main'), chain);

    expect(equalizeUpdates(root, 'main')).toEqual([
      { path: [true], ratio: 3 / 4 },
      { path: [true, false], ratio: 2 / 3 },
      { path: [true, false, false], ratio: 1 / 2 },
    ]);
  });

  test('uses the larger side (max) for perpendicular splits', () => {
    // `inner` is two rows tall (down) and two columns wide (right): the
    // vertical span is max(2, 1) = 2, not the sum 3.
    const inner = split(
      'right',
      split('down', pane('a'), pane('b')),
      pane('c'),
    );
    expect(paneSpan(inner, 'down')).toBe(2);
    expect(paneSpan(inner, 'right')).toBe(2);

    const root = split('down', inner, pane('d'));
    // A naive pane count would make the root 3/4; span says 2/3.
    expect(equalizeUpdates(root, 'main')).toEqual([
      { path: [], ratio: 2 / 3 },
      { path: [false], ratio: 1 / 2 },
      { path: [false, false], ratio: 1 / 2 },
    ]);
  });

  test('skips splits containing the main pane but equalizes deeper agents', () => {
    const agents = split(
      'down',
      split('down', pane('a1'), pane('a2')),
      pane('a3'),
    );
    // The main pane is nested deep inside the first child: every split on its
    // path must be left untouched, including the root.
    const mainSide = split(
      'right',
      pane('side'),
      split('down', pane('main'), pane('extra')),
    );
    const root = split('down', mainSide, agents);

    const updates = equalizeUpdates(root, 'main');

    expect(updates).toEqual([
      { path: [true], ratio: 2 / 3 },
      { path: [true, false], ratio: 1 / 2 },
    ]);
    expect(updates.every((update) => update.path[0] === true)).toBe(true);
  });

  test('returns no updates for a single-pane tab', () => {
    expect(equalizeUpdates(pane('main'), 'main')).toEqual([]);
  });

  test('skips subtrees holding panes this client did not spawn', () => {
    const agents = split('down', pane('a'), pane('b'));
    const agentSide = split('down', agents, pane('user'));
    const root = split('right', pane('main'), agentSide);

    // Without the tracked set, both the mixed subtree and the agent branch
    // are rewritten.
    expect(equalizeUpdates(root, 'main').map((u) => u.path)).toEqual([
      [true],
      [true, false],
    ]);

    // With it, only the all-agent branch inside the mixed subtree is touched.
    expect(equalizeUpdates(root, 'main', new Set(['a', 'b']))).toEqual([
      { path: [true, false], ratio: 0.5 },
    ]);
  });
});

describe('mainBoundaryUpdate', () => {
  test('pins the root split to the main share when main is the first child', () => {
    const root = split('right', pane('main'), pane('agent'));
    expect(mainBoundaryUpdate(root, 'main', 0.8)).toEqual({
      path: [],
      ratio: 0.8,
    });
  });

  test('inverts the share when main is the second child', () => {
    const root = split('right', pane('agent'), pane('main'));
    expect(mainBoundaryUpdate(root, 'main', 0.8)).toEqual({
      path: [],
      ratio: 0.2,
    });
  });

  test('finds a nested boundary rather than assuming the root', () => {
    const root = split(
      'down',
      split('right', pane('side'), pane('main')),
      pane('agent'),
    );
    expect(mainBoundaryUpdate(root, 'main', 0.75)).toEqual({
      path: [false],
      ratio: 0.25,
    });
  });

  test('returns null when the main pane is absent', () => {
    expect(mainBoundaryUpdate(pane('agent'), 'main', 0.8)).toBeNull();
  });

  test('clamps the share to the schema range', () => {
    const root = split('right', pane('main'), pane('agent'));
    expect(mainBoundaryUpdate(root, 'main', 0.95)?.ratio).toBe(0.8);
    expect(mainBoundaryUpdate(root, 'main', 0.05)?.ratio).toBe(0.2);
  });
});

describe('ratioAtPath / collectPaneIds', () => {
  const root = split(
    'right',
    pane('main'),
    split('down', pane('a'), pane('b')),
  );

  test('reads the ratio of the split at a path', () => {
    expect(ratioAtPath(root, [])).toBe(0.5);
    expect(ratioAtPath(root, [true])).toBe(0.5);
    expect(ratioAtPath(root, [true, false])).toBeNull();
  });

  test('collects every pane id', () => {
    expect([...collectPaneIds(root)].sort()).toEqual(['a', 'b', 'main']);
  });
});

// --- socket layer -------------------------------------------------------
// A fake herdr speaks the same one-request-per-connection protocol, so these
// tests cover timeout, malformed JSON, error replies, zoomed tabs and the
// epsilon skip without a real herdr.

interface FakeHerdr {
  socketPath: string;
  received: Array<{ method: string; params: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function startFakeHerdr(
  reply: (request: {
    method: string;
    params: Record<string, unknown>;
  }) => unknown,
): Promise<FakeHerdr> {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-eq-'));
  const socketPath = join(dir, 'herdr.sock');
  const received: FakeHerdr['received'] = [];

  const server: Server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      received.push(request);
      const response = reply(request);
      if (response === undefined) return; // never answer: timeout path
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(herdrSocketEndpoint(socketPath), resolve),
  );

  return {
    socketPath,
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const agentChain: HerdrLayoutNode = split('down', pane('a'), pane('b'));
const layoutExport = (root: HerdrLayoutNode, zoomed = false) => ({
  result: { layout: { root, zoomed } },
});

describe('herdrSocketEndpoint', () => {
  test('maps a Windows socket path onto the named pipe herdr binds', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      expect(herdrSocketEndpoint('C:\\Users\\foo\\herdr.sock')).toBe(
        '\\\\.\\pipe\\C:\\Users\\foo\\herdr.sock',
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });

  test('leaves a POSIX socket path unchanged', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      expect(herdrSocketEndpoint('/tmp/herdr.sock')).toBe('/tmp/herdr.sock');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('equalizeAgentPanes (socket)', () => {
  test('writes the main boundary and skips ratios already on target', async () => {
    const fake = await startFakeHerdr((request) =>
      request.method === 'layout.export'
        ? layoutExport(split('right', pane('main'), agentChain))
        : { result: {} },
    );
    try {
      const ok = await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        mainPaneShare: 0.8,
      });

      expect(ok).toBe(true);
      const writes = fake.received.filter(
        (r) => r.method === 'layout.set_split_ratio',
      );
      // Root ratio 0.5 → 0.8 (boundary); the agent split is already 1/2.
      expect(writes).toHaveLength(1);
      expect(writes[0].params).toEqual({
        tab_id: 't1',
        path: [],
        ratio: 0.8,
      });
    } finally {
      await fake.close();
    }
  });

  test('does nothing when every split is already equal', async () => {
    const root = split('right', pane('main'), agentChain);
    (root as { ratio: number }).ratio = 0.8;
    const fake = await startFakeHerdr(() => layoutExport(root));
    try {
      const ok = await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        mainPaneShare: 0.8,
      });
      expect(ok).toBe(true);
      expect(fake.received).toHaveLength(1);
      expect(fake.received[0].method).toBe('layout.export');
    } finally {
      await fake.close();
    }
  });

  test('skips a zoomed tab without writing', async () => {
    const fake = await startFakeHerdr(() =>
      layoutExport(split('right', pane('main'), agentChain), true),
    );
    try {
      const ok = await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        mainPaneShare: 0.8,
      });
      expect(ok).toBe(true);
      expect(fake.received).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  test('reports pane ids for pruning', async () => {
    const fake = await startFakeHerdr(() =>
      layoutExport(split('right', pane('main'), agentChain)),
    );
    try {
      const seen = new Set<string>();
      await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        onPanesSeen: (ids) => {
          for (const id of ids) seen.add(id);
        },
      });
      expect([...seen].sort()).toEqual(['a', 'b', 'main']);
    } finally {
      await fake.close();
    }
  });

  test('does not rewrite the boundary when pruning removes the last agent', async () => {
    const fake = await startFakeHerdr(() =>
      layoutExport(split('right', pane('main'), pane('user'))),
    );
    try {
      const agents = new Set(['stale']);
      const ok = await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        mainPaneShare: 0.6,
        agentPaneIds: agents,
        onPanesSeen: (ids) => {
          for (const id of agents) if (!ids.has(id)) agents.delete(id);
        },
      });
      expect(ok).toBe(true);
      expect(agents.size).toBe(0);
      expect(fake.received.map((request) => request.method)).toEqual([
        'layout.export',
      ]);
    } finally {
      await fake.close();
    }
  });

  test('returns false when a ratio write is rejected', async () => {
    const fake = await startFakeHerdr((request) =>
      request.method === 'layout.export'
        ? layoutExport(split('right', pane('main'), agentChain))
        : { error: { code: 'nope', message: 'unsupported' } },
    );
    try {
      const ok = await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        mainPaneShare: 0.8,
      });
      expect(ok).toBe(false);
    } finally {
      await fake.close();
    }
  });

  test('returns false on malformed JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-eq-'));
    const socketPath = join(dir, 'herdr.sock');
    const server = createServer((socket) => {
      socket.on('data', () => socket.end('not json\n'));
    });
    await new Promise<void>((resolve) =>
      server.listen(herdrSocketEndpoint(socketPath), resolve),
    );
    try {
      const ok = await equalizeAgentPanes({
        socketPath,
        tabId: 't1',
        mainPaneId: 'main',
      });
      expect(ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns false when the socket is missing', async () => {
    const ok = await equalizeAgentPanes({
      socketPath: join(tmpdir(), 'definitely-not-a-herdr.sock'),
      tabId: 't1',
      mainPaneId: 'main',
    });
    expect(ok).toBe(false);
  });

  // Real timing on purpose: a timeout can only be observed by waiting for it.
  // Kept to a 50 ms budget so the suite stays fast.
  test('returns false when herdr never answers', async () => {
    const fake = await startFakeHerdr(() => undefined);
    try {
      const ok = await equalizeAgentPanes({
        socketPath: fake.socketPath,
        tabId: 't1',
        mainPaneId: 'main',
        timeoutMs: 50,
        budgetMs: 50,
      });
      expect(ok).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
