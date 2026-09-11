import { describe, expect, test } from 'bun:test';
import { adaptMcpServer } from './setup';

describe('adaptMcpServer', () => {
  test('remote config maps to v2 shape', () => {
    expect(
      adaptMcpServer({
        type: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Key': 'v' },
        oauth: false,
      }),
    ).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Key': 'v' },
      oauth: false,
    });
  });

  test('local config maps to v2 shape', () => {
    expect(
      adaptMcpServer({
        type: 'local',
        command: ['npx', 'x'],
        environment: { A: '1' },
      }),
    ).toEqual({
      type: 'local',
      command: ['npx', 'x'],
      environment: { A: '1' },
    });
  });

  test('undefined optionals are omitted', () => {
    expect(adaptMcpServer({ type: 'remote', url: 'u' })).toEqual({
      type: 'remote',
      url: 'u',
    });
  });
});
