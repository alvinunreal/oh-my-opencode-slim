import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { flushLoggerForTesting, initLogger, log, resetLogger } from './logger';

describe('logger', () => {
  let tmpDir: string;
  let origLogDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    origLogDir = process.env.OPENCODE_LOG_DIR;
    process.env.OPENCODE_LOG_DIR = tmpDir;
    resetLogger();
  });

  afterEach(async () => {
    await flushLoggerForTesting();
    if (origLogDir === undefined) {
      delete process.env.OPENCODE_LOG_DIR;
    } else {
      process.env.OPENCODE_LOG_DIR = origLogDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('log() silently no-ops before initLogger()', () => {
    log('should not crash');
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });

  test('falls back to stderr when logger initialization cannot create directory', async () => {
    const blockedLogDir = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(blockedLogDir, 'not a directory');
    process.env.OPENCODE_LOG_DIR = blockedLogDir;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      initLogger('session1');
      log('fallback message');
      await flushLoggerForTesting();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('falling back to stderr'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('fallback message'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('falls back to stderr when the log file path is a directory', async () => {
    const logDir = path.join(tmpDir, 'log-dir');
    const logFilePath = path.join(logDir, 'oh-my-opencode-slim.session1.log');
    fs.mkdirSync(logFilePath, { recursive: true });
    process.env.OPENCODE_LOG_DIR = logDir;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => initLogger('session1')).not.toThrow();
      log('open failure fallback message');
      await flushLoggerForTesting();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('falling back to stderr'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('open failure fallback message'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('falls back to stderr when appending a log entry fails', async () => {
    const logDir = path.join(tmpDir, 'log-dir');
    process.env.OPENCODE_LOG_DIR = logDir;
    initLogger('session1');
    fs.rmSync(logDir, { recursive: true, force: true });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      log('failed file write');
      await flushLoggerForTesting();
      log('subsequent fallback message');
      await flushLoggerForTesting();

      const fallbackWarnings = errorSpy.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('falling back to stderr'),
      );

      expect(fallbackWarnings).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed file write'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('subsequent fallback message'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('warns once when multiple queued writes fail', async () => {
    const logDir = path.join(tmpDir, 'log-dir');
    process.env.OPENCODE_LOG_DIR = logDir;
    initLogger('session1');
    fs.rmSync(logDir, { recursive: true, force: true });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      log('first queued failure');
      log('second queued failure');
      log('third queued failure');
      await flushLoggerForTesting();

      const fallbackWarnings = errorSpy.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('falling back to stderr'),
      );
      expect(fallbackWarnings).toHaveLength(1);

      for (const message of [
        'first queued failure',
        'second queued failure',
        'third queued failure',
      ]) {
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('does not let a stale failed write replace a newer file sink', async () => {
    const oldLogDir = fs.mkdtempSync(path.join(tmpDir, 'old-log-'));
    const newLogDir = fs.mkdtempSync(path.join(tmpDir, 'new-log-'));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.env.OPENCODE_LOG_DIR = oldLogDir;
      initLogger('old');
      log('stale message');
      fs.rmSync(oldLogDir, { recursive: true, force: true });

      process.env.OPENCODE_LOG_DIR = newLogDir;
      initLogger('new');
      log('new message');
      await flushLoggerForTesting();

      log('after stale failure');
      await flushLoggerForTesting();

      const newLogFile = path.join(newLogDir, 'oh-my-opencode-slim.new.log');
      const content = fs.readFileSync(newLogFile, 'utf-8');
      expect(content).toContain('new message');
      expect(content).toContain('after stale failure');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('stale message'),
      );

      const fallbackWarnings = errorSpy.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' &&
          message.includes('falling back to stderr'),
      );
      expect(fallbackWarnings).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('keeps logging best-effort when stderr fallback throws', async () => {
    const logDir = path.join(tmpDir, 'log-dir');
    process.env.OPENCODE_LOG_DIR = logDir;
    initLogger('session1');
    fs.rmSync(logDir, { recursive: true, force: true });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr unavailable');
    });

    try {
      expect(() => log('first failed write')).not.toThrow();
      await flushLoggerForTesting();

      expect(() => log('second failed write')).not.toThrow();
      await flushLoggerForTesting();

      errorSpy.mockImplementation(() => {});
      log('after stderr failure');
      await flushLoggerForTesting();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('after stderr failure'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('initLogger creates per-session log file', () => {
    initLogger('20260416T143052');
    log('test message');

    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(['oh-my-opencode-slim.20260416T143052.log']);
  });

  test('writes log message with timestamp', async () => {
    initLogger('session1');
    log('timestamped message');
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    expect(content).toContain('timestamped message');
  });

  test('logs message with data object', async () => {
    initLogger('session1');
    log('message with data', { key: 'value', number: 42 });
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('"key":"value"');
    expect(content).toContain('"number":42');
  });

  test('logs message without extra JSON when no data', async () => {
    initLogger('session1');
    log('message without data');
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content.trim()).toMatch(/message without data\s*$/);
  });

  test('appends multiple log entries', async () => {
    initLogger('session1');
    log('first');
    log('second');
    log('third');
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
    expect(lines[2]).toContain('third');
  });

  test('initLogger called twice uses second session file', async () => {
    initLogger('session1');
    log('from session1');
    initLogger('session2');
    log('from session2');
    await flushLoggerForTesting();

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toEqual([
      'oh-my-opencode-slim.session1.log',
      'oh-my-opencode-slim.session2.log',
    ]);

    const content1 = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
    const content2 = fs.readFileSync(path.join(tmpDir, files[1]), 'utf-8');
    expect(content1).toContain('from session1');
    expect(content1).not.toContain('from session2');
    expect(content2).toContain('from session2');
  });

  test('cleanup deletes files older than 7 days', () => {
    const oldFileName = 'oh-my-opencode-slim.20260301T000000.log';
    const oldPath = path.join(tmpDir, oldFileName);
    fs.writeFileSync(oldPath, 'old log\n');

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldPath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    initLogger('current');
    log('init');

    const files = fs.readdirSync(tmpDir);
    expect(files).not.toContain(oldFileName);
    expect(files.find((f) => f.includes('current'))).toBeDefined();
  });

  test('cleanup preserves recent files', () => {
    const recentFileName = 'oh-my-opencode-slim.20260415T000000.log';
    const recentPath = path.join(tmpDir, recentFileName);
    fs.writeFileSync(recentPath, 'recent log\n');

    initLogger('current');

    const files = fs.readdirSync(tmpDir);
    expect(files).toContain(recentFileName);
  });

  test('cleanup with mixed-age files deletes only old ones', () => {
    const oldFileName = 'oh-my-opencode-slim.old.log';
    const oldPath = path.join(tmpDir, oldFileName);
    fs.writeFileSync(oldPath, 'old log\n');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldPath, new Date(eightDaysAgo), new Date(eightDaysAgo));

    const recentFileName = 'oh-my-opencode-slim.recent.log';
    const recentPath = path.join(tmpDir, recentFileName);
    fs.writeFileSync(recentPath, 'recent log\n');

    initLogger('current');
    log('init');

    const files = fs.readdirSync(tmpDir);
    expect(files).not.toContain(oldFileName);
    expect(files).toContain(recentFileName);
    expect(files.find((f) => f.includes('current'))).toBeDefined();
  });

  test('cleanup with no existing files does not crash', () => {
    expect(() => initLogger('fresh')).not.toThrow();
    log('init');
    const files = fs.readdirSync(tmpDir);
    expect(files.find((f) => f.includes('fresh'))).toBeDefined();
  });

  test('handles circular references in data', async () => {
    initLogger('session1');
    const circular: any = { name: 'test' };
    circular.self = circular;

    expect(() => log('circular data', circular)).not.toThrow();
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('circular data');
    expect(content).toContain('[unserializable]');
  });

  test('handles complex data structures', async () => {
    initLogger('session1');
    log('complex data', {
      nested: { deep: { value: 'test' } },
      array: [1, 2, 3],
      boolean: true,
      null: null,
    });
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('"nested":');
    expect(content).toContain('"array":[1,2,3]');
    expect(content).toContain('"boolean":true');
  });

  test('applies shape-based secret redaction at the compose point', async () => {
    initLogger('session1');
    // Runtime-joined so secret scanning does not flag the fixture.
    const token = ['sk-', 'proj-', 'abcdef1234567890', 'abcdef'].join('');
    log('token leaked', { data: { token } });
    await flushLoggerForTesting();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    // Mask marker present, raw token gone …
    expect(content).toContain('sk-p…ef');
    expect(content).not.toContain(token);
    // … while the entry furniture (timestamp + message) stays intact.
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    expect(content).toContain('token leaked');
  });

  test('stderr fallback entries are redacted too', async () => {
    const blockedLogDir = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(blockedLogDir, 'not a directory');
    process.env.OPENCODE_LOG_DIR = blockedLogDir;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      initLogger('session1');
      // Runtime-joined so secret scanning does not flag the fixture.
      const token = ['ghp_', 'ABCDEFGHIJKLMNOP', 'QRSTUVWXYZ1234'].join('');
      log('stderr leak', { token });
      await flushLoggerForTesting();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ghp_…34'));
      const entry = errorSpy.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('stderr leak'),
      );
      expect(entry?.[0]).not.toContain(token);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
