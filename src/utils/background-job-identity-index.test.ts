import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBackgroundJobIdentityIndex } from './background-job-identity-index';

let xdgHome: string;
let previousXdg: string | undefined;

function storagePath(projectDir: string): string {
  const hash = createHash('sha256')
    .update(path.resolve(projectDir))
    .digest('hex')
    .slice(0, 12);
  return path.join(
    xdgHome,
    'opencode',
    'storage',
    'oh-my-opencode-slim',
    hash,
    'background-job-identities.json',
  );
}

describe('background job identity index', () => {
  beforeEach(() => {
    previousXdg = process.env.XDG_DATA_HOME;
    xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-index-'));
    process.env.XDG_DATA_HOME = xdgHome;
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    fs.rmSync(xdgHome, { recursive: true, force: true });
  });

  test('persists aliases by parent and project without changing an existing task mapping', () => {
    const project = path.join(xdgHome, 'project');
    const index = createBackgroundJobIdentityIndex(project);
    const first = index.reserve('parent', 'ses_a', 'fixer', 'fix');
    expect(first).toEqual({
      parentSessionID: 'parent',
      taskID: 'ses_a',
      agent: 'fixer',
      alias: 'fix-1',
      directory: project,
    });
    expect(index.reserve('parent', 'ses_a', 'fixer', 'fix', 100)).toEqual(
      first,
    );
    expect(() => index.reserve('parent', 'ses_a', 'explorer', 'exp')).toThrow();

    const restarted = createBackgroundJobIdentityIndex(project);
    expect(restarted.lookup('parent', first.alias)).toEqual(first);
    expect(restarted.lookup('parent', first.taskID)).toEqual(first);
    expect(restarted.lookup('different-parent', first.alias)).toBeUndefined();
    expect(
      createBackgroundJobIdentityIndex(path.join(xdgHome, 'elsewhere')).lookup(
        'parent',
        first.alias,
      ),
    ).toBeUndefined();

    const next = restarted.reserve('parent', 'ses_b', 'fixer', 'fix');
    expect(next.alias).toBe('fix-2');
    restarted.forget('parent', 'ses_a');
    expect(index.lookup('parent', first.alias)).toBeUndefined();
    expect(() => index.reserve('parent', first.alias, 'fixer', 'fix')).toThrow(
      'Invalid',
    );
    expect(index.reserve('parent', 'ses_c', 'fixer', 'fix').alias).toBe(
      'fix-3',
    );
    expect(fs.statSync(path.dirname(storagePath(project))).mode & 0o777).toBe(
      0o700,
    );
    expect(fs.statSync(storagePath(project)).mode & 0o777).toBe(0o600);
  });

  test('two live instances and independent child processes allocate without collisions', async () => {
    const project = path.join(xdgHome, 'race');
    const a = createBackgroundJobIdentityIndex(project);
    const b = createBackgroundJobIdentityIndex(project);
    expect(a.reserve('parent', 'ses_a', 'fixer', 'fix').alias).toBe('fix-1');
    expect(b.reserve('parent', 'ses_b', 'fixer', 'fix').alias).toBe('fix-2');

    const modulePath = path.join(
      import.meta.dir,
      'background-job-identity-index.ts',
    );
    const source = `const {createBackgroundJobIdentityIndex} = await import(${JSON.stringify(modulePath)});
      const identity = createBackgroundJobIdentityIndex(process.env.PROJECT_DIR).reserve('parent', process.env.TASK_ID, 'fixer', 'fix');
      console.log(identity.alias);`;
    const file = storagePath(project);
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: 2_147_483_647,
        host: os.hostname(),
        token: 'dead',
      }),
      { mode: 0o600 },
    );
    fs.utimesSync(lock, new Date(0), new Date(0));
    const children = ['ses_c', 'ses_d'].map((taskID) =>
      Bun.spawn([process.execPath, '-e', source], {
        env: { ...process.env, PROJECT_DIR: project, TASK_ID: taskID },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        exit: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results.map((item) => item.stderr)).toEqual(['', '']);
    expect(results.map((item) => item.exit)).toEqual([0, 0]);
    expect(results.map((item) => item.stdout).sort()).toEqual([
      'fix-3',
      'fix-4',
    ]);
    expect(a.lookup('parent', 'ses_c')?.alias).not.toBe(
      a.lookup('parent', 'ses_d')?.alias,
    );
  });

  test('resume claims survive restart until matching token settles them', () => {
    const project = path.join(xdgHome, 'resume');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const baseline = {
      childLatestUserID: 'msg_before_resume',
      childLatestUserCreatedAt: 1234,
      claimedAt: 0,
    };
    expect(index.inspectResumeClaim('parent', 'ses_a')).toBeUndefined();
    const token = index.claimResume('parent', 'ses_a', baseline);
    expect(typeof token).toBe('string');
    const persisted = JSON.parse(
      fs.readFileSync(storagePath(project), 'utf8'),
    ) as {
      entries: Array<{ pendingResume?: unknown }>;
    };
    expect(persisted.entries[0].pendingResume).toEqual({ token, baseline });
    expect(index.inspectResumeClaim('parent', 'ses_a')).toEqual({
      token,
      baseline,
    });
    const restarted = createBackgroundJobIdentityIndex(project);
    expect(restarted.claimResume('parent', 'ses_a')).toBeUndefined();
    expect(restarted.inspectResumeClaim('parent', 'ses_a')).toEqual({
      token,
      baseline,
    });
    expect(restarted.hasUnsettledResume('parent', 'ses_a')).toBe(true);
    expect(() => restarted.forget('parent', 'ses_a')).toThrow('unsettled');
    restarted.settleResume('parent', 'ses_a', 'incorrect-token');
    expect(restarted.hasUnsettledResume('parent', 'ses_a')).toBe(true);
    expect(restarted.inspectResumeClaim('parent', 'ses_a')?.token).toBe(token);
    if (token === undefined) throw new Error('Missing resume claim token');
    restarted.settleResume('parent', 'ses_a', token);
    expect(restarted.hasUnsettledResume('parent', 'ses_a')).toBe(false);
    expect(restarted.inspectResumeClaim('parent', 'ses_a')).toBeUndefined();
    const legacyCallToken = restarted.claimResume('parent', 'ses_a');
    expect(restarted.inspectResumeClaim('parent', 'ses_a')).toEqual({
      token: legacyCallToken,
    });
    expect(
      restarted.inspectResumeClaim('other-parent', 'ses_a'),
    ).toBeUndefined();
    expect(
      restarted.inspectResumeClaim('parent', 'ses_missing'),
    ).toBeUndefined();
  });

  test('reads legacy string claims as unknown baselines without clearing them', () => {
    const project = path.join(xdgHome, 'legacy-resume');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const file = storagePath(project);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      entries: Array<{ pendingResume?: string }>;
    };
    state.entries[0].pendingResume = 'legacy-token';
    fs.writeFileSync(file, JSON.stringify(state));
    const restarted = createBackgroundJobIdentityIndex(project);
    expect(restarted.inspectResumeClaim('parent', 'ses_a')).toEqual({
      token: 'legacy-token',
    });
    expect(restarted.claimResume('parent', 'ses_a')).toBeUndefined();
    expect(restarted.hasUnsettledResume('parent', 'ses_a')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(state);
    restarted.settleResume('parent', 'ses_a', 'wrong-token');
    expect(restarted.inspectResumeClaim('parent', 'ses_a')).toEqual({
      token: 'legacy-token',
    });
    restarted.settleResume('parent', 'ses_a', 'legacy-token');
    expect(restarted.inspectResumeClaim('parent', 'ses_a')).toBeUndefined();
  });

  test('rejects malformed claim baselines without rewriting the index', () => {
    const project = path.join(xdgHome, 'invalid-resume');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const file = storagePath(project);
    const clean = fs.readFileSync(file, 'utf8');
    for (const baseline of [
      {},
      { childLatestUserID: '' },
      { childLatestUserID: 'msg', childLatestUserCreatedAt: -1 },
      { childLatestUserID: 'msg', claimedAt: 'yesterday' },
      { childLatestUserID: 'msg', extra: true },
    ]) {
      expect(() =>
        index.claimResume('parent', 'ses_a', baseline as never),
      ).toThrow('Invalid background job resume baseline');
      expect(fs.readFileSync(file, 'utf8')).toBe(clean);
      const state = JSON.parse(clean) as {
        entries: Array<{ pendingResume?: unknown }>;
      };
      state.entries[0].pendingResume = { token: 'pending', baseline };
      const corrupt = JSON.stringify(state);
      fs.writeFileSync(file, corrupt);
      expect(() => index.inspectResumeClaim('parent', 'ses_a')).toThrow(
        'corrupt',
      );
      expect(() => index.claimResume('parent', 'ses_a')).toThrow('corrupt');
      expect(() => index.settleResume('parent', 'ses_a', 'pending')).toThrow(
        'corrupt',
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
      fs.writeFileSync(file, clean);
    }
  });

  test('concurrent processes allow only one baseline claim', async () => {
    const project = path.join(xdgHome, 'claim-race');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const modulePath = path.join(
      import.meta.dir,
      'background-job-identity-index.ts',
    );
    const source = `const {createBackgroundJobIdentityIndex} = await import(${JSON.stringify(modulePath)});
      const token = createBackgroundJobIdentityIndex(process.env.PROJECT_DIR)
        .claimResume('parent', 'ses_a', {childLatestUserID: process.env.MESSAGE_ID});
      console.log(JSON.stringify({token}));`;
    const children = ['msg_a', 'msg_b'].map((messageID) =>
      Bun.spawn([process.execPath, '-e', source], {
        env: { ...process.env, PROJECT_DIR: project, MESSAGE_ID: messageID },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        exit: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results.map((item) => item.exit)).toEqual([0, 0]);
    expect(results.map((item) => item.stderr)).toEqual(['', '']);
    const tokens = results.map(
      (item) => (JSON.parse(item.stdout) as { token?: string }).token,
    );
    expect(tokens.filter((token) => token !== undefined)).toHaveLength(1);
    expect(['msg_a', 'msg_b']).toContain(
      index.inspectResumeClaim('parent', 'ses_a')?.baseline?.childLatestUserID,
    );
    expect(index.inspectResumeClaim('parent', 'ses_a')?.token).toBe(
      tokens.find((token) => token !== undefined),
    );
    expect(index.claimResume('parent', 'ses_a')).toBeUndefined();
  });

  test('a failed baseline claim write does not leave a pending claim', () => {
    const project = path.join(xdgHome, 'failed-resume-write');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const file = storagePath(project);
    const original = fs.readFileSync(file, 'utf8');
    const injected = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('injected rename failure');
    });
    try {
      expect(() =>
        index.claimResume('parent', 'ses_a', {
          childLatestUserID: 'msg_before_resume',
        }),
      ).toThrow('injected rename failure');
    } finally {
      injected.mockRestore();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(index.inspectResumeClaim('parent', 'ses_a')).toBeUndefined();
    const token = index.claimResume('parent', 'ses_a', {
      childLatestUserID: 'msg_before_resume',
    });
    expect(index.inspectResumeClaim('parent', 'ses_a')).toEqual({
      token,
      baseline: { childLatestUserID: 'msg_before_resume' },
    });
  });

  test('capacity evicts settled identities without recycling aliases', () => {
    const project = path.join(xdgHome, 'capacity');
    const file = storagePath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const entries = Array.from({ length: 4096 }, (_, index) => ({
      identity: {
        parentSessionID: 'parent',
        taskID: `ses_${index + 1}`,
        agent: 'fixer',
        alias: `fix-${index + 1}`,
        directory: project,
      },
      ...(index === 4095 ? { pendingResume: 'pending-token' } : {}),
    }));
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, counter: 4096, entries }),
      { mode: 0o600 },
    );
    const index = createBackgroundJobIdentityIndex(project);
    expect(index.reserve('parent', 'ses_new', 'fixer', 'fix').alias).toBe(
      'fix-4097',
    );
    expect(index.lookup('parent', 'fix-1')).toBeUndefined();
    expect(index.lookup('parent', 'fix-4096')?.taskID).toBe('ses_4096');
    expect(index.hasUnsettledResume('parent', 'ses_4096')).toBe(true);
    expect(
      index.reserve('parent', 'ses_after', 'fixer', 'fix', 5000).alias,
    ).toBe('fix-5001');

    const full = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      entries: Array<{ pendingResume?: string }>;
    };
    for (const item of full.entries) item.pendingResume = 'pending-token';
    fs.writeFileSync(file, JSON.stringify(full));
    expect(() =>
      index.reserve('parent', 'ses_rejected', 'fixer', 'fix'),
    ).toThrow('full of unsettled');
    expect(index.lookup('parent', 'ses_rejected')).toBeUndefined();
  });

  test('rejects corrupt or unsupported state instead of treating it as empty', () => {
    const project = path.join(xdgHome, 'corrupt');
    const index = createBackgroundJobIdentityIndex(project);
    const first = index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const file = storagePath(project);
    fs.writeFileSync(file, '{broken json');
    expect(() => index.lookup('parent', first.alias)).toThrow('corrupt');
    expect(() => index.reserve('parent', 'ses_b', 'fixer', 'fix')).toThrow(
      'corrupt',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, counter: 1, entries: [] }),
    );
    expect(() =>
      createBackgroundJobIdentityIndex(project).lookup('parent', first.alias),
    ).toThrow('corrupt');
    for (const identity of [
      { ...first, directory: path.join(xdgHome, 'other') },
      { ...first, alias: 'fix-2' },
      { ...first, taskID: 'fix-1' },
    ]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          counter: 1,
          entries: [{ identity }],
        }),
      );
      expect(() => index.reserve('parent', 'ses_b', 'fixer', 'fix')).toThrow(
        'corrupt',
      );
    }
    const outside = path.join(xdgHome, 'outside-index.json');
    fs.writeFileSync(outside, '{untouched', { mode: 0o600 });
    fs.unlinkSync(file);
    fs.symlinkSync(outside, file);
    expect(() => index.reserve('parent', 'ses_b', 'fixer', 'fix')).toThrow(
      'Cannot open',
    );
    expect(fs.readFileSync(outside, 'utf8')).toBe('{untouched');
  });

  test('returns the committed alias when directory fsync fails after rename', () => {
    const project = path.join(xdgHome, 'post-rename');
    const index = createBackgroundJobIdentityIndex(project);
    const fsync = fs.fsyncSync;
    const unlink = fs.unlinkSync;
    const injected = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        throw new Error('injected directory fsync failure');
      }
      return fsync(fd);
    });
    const injectedCleanup = spyOn(fs, 'unlinkSync').mockImplementation(
      (target) => {
        if (
          String(target).includes('.lock.') &&
          String(target).endsWith('.tmp')
        ) {
          throw new Error('injected lock temp cleanup failure');
        }
        return unlink(target);
      },
    );
    try {
      const first = index.reserve('parent', 'ses_a', 'fixer', 'fix');
      expect(first.alias).toBe('fix-1');
      expect(index.lookup('parent', 'ses_a')).toEqual(first);
      expect(index.reserve('parent', 'ses_b', 'fixer', 'fix').alias).toBe(
        'fix-2',
      );
      expect(fs.statSync(storagePath(project)).mode & 0o777).toBe(0o600);
    } finally {
      injectedCleanup.mockRestore();
      injected.mockRestore();
    }
  });

  test('a failure before rename does not commit or consume an alias', () => {
    const project = path.join(xdgHome, 'pre-rename');
    const index = createBackgroundJobIdentityIndex(project);
    const unlink = fs.unlinkSync;
    const injected = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('injected rename failure');
    });
    const injectedCleanup = spyOn(fs, 'unlinkSync').mockImplementation(
      (target) => {
        if (String(target).endsWith('.tmp')) {
          throw new Error('injected temp cleanup failure');
        }
        return unlink(target);
      },
    );
    try {
      expect(() => index.reserve('parent', 'ses_a', 'fixer', 'fix')).toThrow(
        'injected rename failure',
      );
      expect(index.lookup('parent', 'ses_a')).toBeUndefined();
    } finally {
      injectedCleanup.mockRestore();
      injected.mockRestore();
    }
    expect(index.reserve('parent', 'ses_b', 'fixer', 'fix').alias).toBe(
      'fix-1',
    );
  });

  test('ignores orphan temp files, respects live/foreign locks, recovers verified dead lock', () => {
    const project = path.join(xdgHome, 'locks');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const file = storagePath(project);
    fs.writeFileSync(`${file}.interrupted.tmp`, '{partial');
    expect(index.lookup('parent', 'fix-1')?.taskID).toBe('ses_a');
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        token: 'live',
      }),
      { mode: 0o600 },
    );
    expect(() => index.reserve('parent', 'ses_b', 'fixer', 'fix')).toThrow(
      'lock unavailable',
    );
    expect(index.lookup('parent', 'ses_b')).toBeUndefined();
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: 2_147_483_647,
        host: 'foreign-host',
        token: 'foreign',
      }),
    );
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => index.reserve('parent', 'ses_b', 'fixer', 'fix')).toThrow(
      'lock unavailable',
    );
    fs.writeFileSync(lock, '');
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => index.reserve('parent', 'ses_b', 'fixer', 'fix')).toThrow(
      'lock unavailable',
    );
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: 2_147_483_647,
        host: os.hostname(),
        token: 'dead',
      }),
    );
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(index.reserve('parent', 'ses_b', 'fixer', 'fix').alias).toBe(
      'fix-2',
    );
  });

  test('a killed writer leaves only an orphan temp file or a recoverable owned lock', async () => {
    const project = path.join(xdgHome, 'crashed-lock');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const lock = `${storagePath(project)}.lock`;
    const source = `const fs = require('node:fs');
      const temp = process.env.LOCK + '.crashed.' + process.pid + '.tmp';
      const fd = fs.openSync(temp, 'wx', 0o600);
      if (process.env.PUBLISH === 'yes') {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: require('node:os').hostname(), token: 'child' }));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fs.linkSync(temp, process.env.LOCK);
      }
      console.log('ready');
      setInterval(() => {}, 1000);`;
    for (const publish of ['no', 'yes']) {
      const child = Bun.spawn([process.execPath, '-e', source], {
        env: { ...process.env, LOCK: lock, PUBLISH: publish },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        const first = await child.stdout.getReader().read();
        if (first.done) {
          throw new Error(await new Response(child.stderr).text());
        }
        expect(new TextDecoder().decode(first.value)).toContain('ready');
        if (publish === 'yes') {
          fs.utimesSync(lock, new Date(0), new Date(0));
          expect(() =>
            index.reserve('parent', 'ses_locked', 'fixer', 'fix'),
          ).toThrow('lock unavailable');
        } else {
          expect(fs.existsSync(lock)).toBe(false);
        }
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }
      if (publish === 'yes') {
        fs.utimesSync(lock, new Date(0), new Date(0));
      }
    }
    expect(index.reserve('parent', 'ses_b', 'fixer', 'fix').alias).toBe(
      'fix-2',
    );
    expect(
      fs
        .readdirSync(path.dirname(lock))
        .some((name) => name.startsWith(`${path.basename(lock)}.crashed.`)),
    ).toBe(true);
  }, 10_000);

  test('persists one unsettled message or revive operation claim', () => {
    const project = path.join(xdgHome, 'operations');
    const index = createBackgroundJobIdentityIndex(project);
    const identity = index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const baseline = {
      childLatestUserID: 'user-1',
      childLatestUserCreatedAt: 10,
    };

    const token = index.claimOperation(
      'parent',
      identity.taskID,
      'message',
      baseline,
    );
    expect(token).toBeString();
    expect(index.hasUnsettledOperation('parent', identity.taskID)).toBe(true);
    expect(
      index.inspectOperationClaim('parent', identity.taskID, 'message'),
    ).toEqual({ token, baseline, phase: 'prepared' });

    const restarted = createBackgroundJobIdentityIndex(project);
    expect(
      restarted.claimOperation('parent', identity.taskID, 'revive', baseline),
    ).toBeUndefined();
    expect(
      restarted.settleOperation('parent', identity.taskID, 'message', 'wrong'),
    ).toBe(false);
    expect(restarted.hasUnsettledOperation('parent', identity.taskID)).toBe(
      true,
    );
    if (!token) throw new Error('missing operation token');
    expect(
      restarted.markOperationSent('parent', identity.taskID, 'message', token),
    ).toBe(true);
    expect(
      restarted.markOperationAccepted(
        'parent',
        identity.taskID,
        'message',
        token,
      ),
    ).toBe(true);
    expect(
      restarted.settleOperation('parent', identity.taskID, 'message', token),
    ).toBe(true);
    expect(restarted.hasUnsettledOperation('parent', identity.taskID)).toBe(
      false,
    );
    expect(
      restarted.inspectOperationClaim('parent', identity.taskID, 'message'),
    ).toBe(undefined);
  });

  test('phase transitions are durable, fenced, and idempotent', () => {
    const project = path.join(xdgHome, 'operation-phases');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const token = index.claimOperation('parent', 'ses_a', 'message', {
      childLatestUserID: 'user-1',
    });
    if (!token) throw new Error('missing operation token');
    const restarted = createBackgroundJobIdentityIndex(project);
    const phase = () =>
      restarted.inspectOperationClaim('parent', 'ses_a', 'message')?.phase;
    const persistedPhase = () => {
      const state = JSON.parse(
        fs.readFileSync(storagePath(project), 'utf8'),
      ) as {
        entries: Array<{
          pendingOperations: { message: { phase: string } };
        }>;
      };
      return state.entries[0].pendingOperations.message.phase;
    };
    expect(phase()).toBe('prepared');
    expect(persistedPhase()).toBe('prepared');
    expect(
      restarted.markOperationAccepted('parent', 'ses_a', 'message', token),
    ).toBe(false);
    expect(
      restarted.beginOperationCompensation('parent', 'ses_a', 'message', token),
    ).toBe(false);
    expect(
      restarted.markOperationSent('parent', 'ses_a', 'revive', token),
    ).toBe(false);
    expect(
      restarted.markOperationSent('parent', 'ses_a', 'message', 'wrong'),
    ).toBe(false);
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        token,
        'accepted_and_completed',
      ),
    ).toBe(false);
    expect(phase()).toBe('prepared');

    expect(
      restarted.markOperationSent('parent', 'ses_a', 'message', token),
    ).toBe(true);
    expect(
      restarted.markOperationSent('parent', 'ses_a', 'message', token),
    ).toBe(true);
    expect(phase()).toBe('sent_unknown');
    expect(persistedPhase()).toBe('sent_unknown');
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        token,
        'pre_send_failure',
      ),
    ).toBe(false);
    expect(restarted.settleOperation('parent', 'ses_a', 'message', token)).toBe(
      false,
    );
    expect(phase()).toBe('sent_unknown');
    expect(
      restarted.markOperationAccepted('parent', 'ses_a', 'message', 'wrong'),
    ).toBe(false);
    expect(phase()).toBe('sent_unknown');
    expect(
      restarted.markOperationAccepted('parent', 'ses_a', 'message', token),
    ).toBe(true);
    expect(
      restarted.markOperationAccepted('parent', 'ses_a', 'message', token),
    ).toBe(true);
    expect(
      restarted.markOperationSent('parent', 'ses_a', 'message', token),
    ).toBe(false);
    expect(phase()).toBe('accepted');
    expect(persistedPhase()).toBe('accepted');
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        token,
        'authoritative_rejection',
      ),
    ).toBe(false);
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        token,
        'compensated',
      ),
    ).toBe(false);
    expect(phase()).toBe('accepted');
    expect(
      restarted.beginOperationCompensation(
        'parent',
        'ses_a',
        'message',
        'wrong',
      ),
    ).toBe(false);
    expect(phase()).toBe('accepted');
    expect(
      restarted.beginOperationCompensation('parent', 'ses_a', 'message', token),
    ).toBe(true);
    expect(
      restarted.beginOperationCompensation('parent', 'ses_a', 'message', token),
    ).toBe(true);
    expect(phase()).toBe('compensating');
    expect(persistedPhase()).toBe('compensating');
    expect(restarted.settleOperation('parent', 'ses_a', 'message', token)).toBe(
      false,
    );
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'revive',
        token,
        'compensated',
      ),
    ).toBe(false);
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        'wrong',
        'compensated',
      ),
    ).toBe(false);
    expect(phase()).toBe('compensating');
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        token,
        'compensated',
      ),
    ).toBe(true);
    expect(
      restarted.settleOperation(
        'parent',
        'ses_a',
        'message',
        token,
        'compensated',
      ),
    ).toBe(false);
    expect(phase()).toBeUndefined();
  });

  test('replaced operation tokens fence the old owner before send', () => {
    const project = path.join(xdgHome, 'replaced-operation-token');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const oldToken = index.claimOperation('parent', 'ses_a', 'message');
    if (!oldToken) throw new Error('missing old operation token');
    expect(
      index.settleOperation(
        'parent',
        'ses_a',
        'message',
        oldToken,
        'pre_send_failure',
      ),
    ).toBe(true);

    const newToken = index.claimOperation('parent', 'ses_a', 'message');
    if (!newToken) throw new Error('missing replacement operation token');
    expect(newToken).not.toBe(oldToken);
    expect(
      index.markOperationSent('parent', 'ses_a', 'message', oldToken),
    ).toBe(false);
    expect(
      index.inspectOperationClaim('parent', 'ses_a', 'message')?.phase,
    ).toBe('prepared');
    expect(
      index.markOperationSent('parent', 'ses_a', 'message', newToken),
    ).toBe(true);
    expect(
      index.inspectOperationClaim('parent', 'ses_a', 'message')?.phase,
    ).toBe('sent_unknown');
  });

  test('resolutions clear only matching evidence phases, never ambiguous rejection', () => {
    const index = createBackgroundJobIdentityIndex(
      path.join(xdgHome, 'resolutions'),
    );
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const claim = () => {
      const token = index.claimOperation('parent', 'ses_a', 'revive');
      if (!token) throw new Error('missing operation token');
      return token;
    };
    const phase = () =>
      index.inspectOperationClaim('parent', 'ses_a', 'revive')?.phase;
    const preSend = claim();
    expect(
      index.settleOperation(
        'parent',
        'ses_a',
        'revive',
        preSend,
        'invalid-resolution' as never,
      ),
    ).toBe(false);
    expect(phase()).toBe('prepared');
    expect(
      index.settleOperation(
        'parent',
        'ses_a',
        'revive',
        preSend,
        'accepted_and_completed',
      ),
    ).toBe(false);
    expect(phase()).toBe('prepared');
    expect(
      index.settleOperation(
        'parent',
        'ses_a',
        'revive',
        preSend,
        'pre_send_failure',
      ),
    ).toBe(true);
    expect(phase()).toBeUndefined();
    const rejectedPrepared = claim();
    index.settleOperation(
      'parent',
      'ses_a',
      'revive',
      rejectedPrepared,
      'authoritative_rejection',
    );
    expect(phase()).toBeUndefined();
    const rejectedSent = claim();
    index.markOperationSent('parent', 'ses_a', 'revive', rejectedSent);
    index.settleOperation(
      'parent',
      'ses_a',
      'revive',
      rejectedSent,
      'pre_send_failure',
    );
    expect(phase()).toBe('sent_unknown');
    index.settleOperation(
      'parent',
      'ses_a',
      'revive',
      rejectedSent,
      'authoritative_rejection',
    );
    expect(phase()).toBeUndefined();
    const accepted = claim();
    index.markOperationSent('parent', 'ses_a', 'revive', accepted);
    index.markOperationAccepted('parent', 'ses_a', 'revive', accepted);
    index.settleOperation(
      'parent',
      'ses_a',
      'revive',
      accepted,
      'pre_send_failure',
    );
    index.settleOperation(
      'parent',
      'ses_a',
      'revive',
      accepted,
      'authoritative_rejection',
    );
    expect(phase()).toBe('accepted');
    expect(index.settleOperation('parent', 'ses_a', 'revive', accepted)).toBe(
      true,
    );
    expect(phase()).toBeUndefined();
    const legacySuccess = claim();
    expect(
      index.settleOperation('parent', 'ses_a', 'revive', legacySuccess),
    ).toBe(true);
    expect(phase()).toBeUndefined();
    const unknown = claim();
    index.markOperationSent('parent', 'ses_a', 'revive', unknown);
    index.beginOperationCompensation('parent', 'ses_a', 'revive', unknown);
    expect(phase()).toBe('compensating');
    index.settleOperation('parent', 'ses_a', 'revive', unknown, 'compensated');
    expect(phase()).toBeUndefined();
  });

  test('legacy operation records parse as prepared and malformed state fails closed', () => {
    const project = path.join(xdgHome, 'legacy-operations');
    const index = createBackgroundJobIdentityIndex(project);
    index.reserve('parent', 'ses_a', 'fixer', 'fix');
    const file = storagePath(project);
    const clean = fs.readFileSync(file, 'utf8');
    const legacy = JSON.parse(clean) as {
      entries: Array<{ pendingOperations?: unknown; pendingResume?: string }>;
    };
    legacy.entries[0].pendingOperations = {
      message: {
        token: 'legacy-token',
        baseline: { childLatestUserID: 'old' },
      },
    };
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(index.inspectOperationClaim('parent', 'ses_a', 'message')).toEqual({
      token: 'legacy-token',
      baseline: { childLatestUserID: 'old' },
      phase: 'prepared',
    });
    expect(index.claimOperation('parent', 'ses_a', 'revive')).toBeUndefined();
    index.markOperationSent('parent', 'ses_a', 'message', 'legacy-token');
    expect(
      index.inspectOperationClaim('parent', 'ses_a', 'message')?.phase,
    ).toBe('sent_unknown');
    for (const invalid of [
      { message: { token: 'legacy-token', phase: 'impossible' } },
      { message: { token: 'legacy-token', baseline: {} } },
      { message: { token: '' } },
      { message: { token: 'a' }, revive: { token: 'b' } },
      {},
    ]) {
      legacy.entries[0].pendingOperations = invalid;
      const corrupt = JSON.stringify(legacy);
      fs.writeFileSync(file, corrupt);
      expect(() =>
        index.inspectOperationClaim('parent', 'ses_a', 'message'),
      ).toThrow('corrupt');
      expect(() =>
        index.settleOperation(
          'parent',
          'ses_a',
          'message',
          'legacy-token',
          'authoritative_rejection',
        ),
      ).toThrow('corrupt');
      expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
    }
    legacy.entries[0].pendingOperations = { message: { token: 'a' } };
    legacy.entries[0].pendingResume = 'b';
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(() => index.claimOperation('parent', 'ses_a', 'revive')).toThrow(
      'corrupt',
    );
  });

  test('exact session ID reservation supports one atomic operation claim across processes', async () => {
    const project = path.join(xdgHome, 'operation-race');
    const index = createBackgroundJobIdentityIndex(project);
    const identity = index.reserve('parent', 'ses_exact', 'fixer', 'fix', 12);
    expect(identity.alias).toBe('fix-13');
    expect(identity.alias).not.toBe(identity.taskID);
    const modulePath = path.join(
      import.meta.dir,
      'background-job-identity-index.ts',
    );
    const source = `const {createBackgroundJobIdentityIndex} = await import(${JSON.stringify(modulePath)});
      const token = createBackgroundJobIdentityIndex(process.env.PROJECT_DIR)
        .claimOperation('parent', 'ses_exact', process.env.OPERATION);
      console.log(JSON.stringify({token}));`;
    const children = ['message', 'revive'].map((operation) =>
      Bun.spawn([process.execPath, '-e', source], {
        env: { ...process.env, PROJECT_DIR: project, OPERATION: operation },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        exit: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results.map((result) => result.exit)).toEqual([0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(['', '']);
    expect(
      results
        .map(
          (result) => (JSON.parse(result.stdout) as { token?: string }).token,
        )
        .filter((token) => token !== undefined),
    ).toHaveLength(1);
    expect(index.hasUnsettledOperation('parent', 'ses_exact')).toBe(true);
    expect(() => index.forget('parent', 'ses_exact')).toThrow('unsettled');
    expect(index.claimResume('parent', 'ses_exact')).toBeUndefined();
  });
});
