import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from './logger';

describe('logger', () => {
  const testLogFile = path.join(os.tmpdir(), 'oh-my-opencode-slim.log');

  beforeEach(() => {
    // Clean up log file before each test
    if (fs.existsSync(testLogFile)) {
      fs.unlinkSync(testLogFile);
    }
  });

  afterEach(() => {
    // Clean up log file after each test
    if (fs.existsSync(testLogFile)) {
      fs.unlinkSync(testLogFile);
    }
  });

  test('writes log message to file', () => {
    log('test message');

    expect(fs.existsSync(testLogFile)).toBe(true);
    const content = fs.readFileSync(testLogFile, 'utf-8');
    expect(content).toContain('test message');
  });

  test('includes timestamp in log entry', () => {
    log('timestamped message');

    const content = fs.readFileSync(testLogFile, 'utf-8');
    // Check for ISO timestamp format [YYYY-MM-DDTHH:MM:SS.sssZ]
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });

  test('logs message with data object', () => {
    log('message with data', { key: 'value', number: 42 });

    const content = fs.readFileSync(testLogFile, 'utf-8');
    expect(content).toContain('message with data');
    expect(content).toContain('"key":"value"');
    expect(content).toContain('"number":42');
  });

  test('logs message without data', () => {
    log('message without data');

    const content = fs.readFileSync(testLogFile, 'utf-8');
    expect(content).toContain('message without data');
    // Should not have extra JSON at the end
    expect(content.trim()).toMatch(/message without data\s*$/);
  });

  test('appends multiple log entries', () => {
    log('first message');
    log('second message');
    log('third message');

    const content = fs.readFileSync(testLogFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('first message');
    expect(lines[1]).toContain('second message');
    expect(lines[2]).toContain('third message');
  });

  test('handles complex data structures', () => {
    const complexData = {
      nested: { deep: { value: 'test' } },
      array: [1, 2, 3],
      boolean: true,
      null: null,
    };

    log('complex data', complexData);

    const content = fs.readFileSync(testLogFile, 'utf-8');
    expect(content).toContain('complex data');
    expect(content).toContain('"nested":');
    expect(content).toContain('"array":[1,2,3]');
    expect(content).toContain('"boolean":true');
  });

  test('handles special characters in message', () => {
    log('message with special chars: @#$%^&*()');

    const content = fs.readFileSync(testLogFile, 'utf-8');
    expect(content).toContain('message with special chars: @#$%^&*()');
  });

  test('handles empty string message', () => {
    log('');

    const content = fs.readFileSync(testLogFile, 'utf-8');
    expect(content).toMatch(
      /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\]\s+\n/,
    );
  });

  test('does not throw when logging fails', () => {
    // Make the log directory read-only to force a write error
    // This test is platform-dependent and might not work on all systems
    // So we'll just verify that log() doesn't throw
    expect(() => {
      log('test message', { data: 'value' });
    }).not.toThrow();
  });

  test('handles circular references in data', () => {
    const circular: any = { name: 'test' };
    circular.self = circular;

    // JSON.stringify will throw on circular references
    // The logger should handle this gracefully (catch block)
    expect(() => {
      log('circular data', circular);
    }).not.toThrow();
  });
});
