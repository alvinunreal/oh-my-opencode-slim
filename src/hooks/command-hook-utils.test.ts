import { describe, expect, it } from 'bun:test';
import { registerCommandHook } from './command-hook-utils';

describe('registerCommandHook', () => {
  it('registers a new command when none exists', () => {
    const config: Record<string, unknown> = {};
    const result = registerCommandHook(
      config,
      'my-command',
      'the template',
      'A test command',
    );
    expect(result).toBe(true);
    expect(config.command).toEqual({
      'my-command': { template: 'the template', description: 'A test command' },
    });
  });

  it('returns false when command already exists', () => {
    const config: Record<string, unknown> = {
      command: { 'my-command': { template: 'old', description: 'Old' } },
    };
    const result = registerCommandHook(
      config,
      'my-command',
      'new template',
      'New desc',
    );
    expect(result).toBe(false);
    expect(config.command).toEqual({
      'my-command': { template: 'old', description: 'Old' },
    });
  });

  it('adds a second command alongside an existing one', () => {
    const config: Record<string, unknown> = {
      command: { 'cmd-a': { template: 't', description: 'd' } },
    };
    registerCommandHook(config, 'cmd-b', 't2', 'd2');
    expect(config.command).toEqual({
      'cmd-a': { template: 't', description: 'd' },
      'cmd-b': { template: 't2', description: 'd2' },
    });
  });

  it('creates command object when config.command is absent', () => {
    const config: Record<string, unknown> = {};
    registerCommandHook(config, 'test', 'tmpl', 'desc');
    expect(config).toHaveProperty('command');
  });

  it('accepts kebab-case command names', () => {
    const config: Record<string, unknown> = {};
    registerCommandHook(config, 'deep-work', 'x', 'y');
    expect(config.command).toEqual({
      'deep-work': { template: 'x', description: 'y' },
    });
  });

  it('accepts snake_case command names', () => {
    const config: Record<string, unknown> = {};
    registerCommandHook(config, 'my_cmd', 'a', 'b');
    expect(config.command).toEqual({
      my_cmd: { template: 'a', description: 'b' },
    });
  });
});
