import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogDir, initLogger, log, resetLogger } from './logger';

describe('logger', () => {
  let tmpDir: string;
  let origLogDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    origLogDir = process.env.OPENCODE_LOG_DIR;
    process.env.OPENCODE_LOG_DIR = tmpDir;
    resetLogger();
  });

  afterEach(() => {
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

  test('initLogger creates per-session log file', () => {
    initLogger('20260416T143052');
    log('test message');

    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(['oh-my-opencode-slim.20260416T143052.log']);
  });

  test('writes log message with timestamp', () => {
    initLogger('session1');
    log('timestamped message');

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    expect(content).toContain('timestamped message');
  });

  test('logs message with data object', () => {
    initLogger('session1');
    log('message with data', { key: 'value', number: 42 });

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('"key":"value"');
    expect(content).toContain('"number":42');
  });

  test('logs message without extra JSON when no data', () => {
    initLogger('session1');
    log('message without data');

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content.trim()).toMatch(/message without data\s*$/);
  });

  test('appends multiple log entries', () => {
    initLogger('session1');
    log('first');
    log('second');
    log('third');

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
    expect(lines[2]).toContain('third');
  });

  test('initLogger called twice uses second session file', () => {
    initLogger('session1');
    log('from session1');
    initLogger('session2');
    log('from session2');

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

  test('handles circular references in data', () => {
    initLogger('session1');
    const circular: any = { name: 'test' };
    circular.self = circular;

    expect(() => log('circular data', circular)).not.toThrow();

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('circular data');
    expect(content).toContain('[unserializable]');
  });

  test('getLogDir returns OPENCODE_LOG_DIR when set', () => {
    expect(getLogDir()).toBe(tmpDir);
  });

  test('getLogDir falls back to os.homedir when env not set', () => {
    delete process.env.OPENCODE_LOG_DIR;
    try {
      expect(getLogDir()).toBe(
        path.join(os.homedir(), '.local/share/opencode'),
      );
    } finally {
      if (origLogDir === undefined) {
        delete process.env.OPENCODE_LOG_DIR;
      } else {
        process.env.OPENCODE_LOG_DIR = origLogDir;
      }
    }
  });

  test('handles complex data structures', () => {
    initLogger('session1');
    log('complex data', {
      nested: { deep: { value: 'test' } },
      array: [1, 2, 3],
      boolean: true,
      null: null,
    });

    const logPath = path.join(tmpDir, 'oh-my-opencode-slim.session1.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('"nested":');
    expect(content).toContain('"array":[1,2,3]');
    expect(content).toContain('"boolean":true');
  });
});
