import { describe, expect, test } from 'bun:test';
import { parseMarketplaceArgs } from './marketplace';

describe('marketplace CLI parsing', () => {
  test('parses lifecycle commands and the import alias', () => {
    expect(parseMarketplaceArgs(['import', './package.json'])).toEqual({
      command: 'install',
      value: './package.json',
      force: false,
      json: false,
      clear: false,
    });
  });

  test('requires package input for install and update', () => {
    expect(() => parseMarketplaceArgs(['install'])).toThrow();
    expect(() => parseMarketplaceArgs(['update'])).toThrow();
    expect(parseMarketplaceArgs(['list'])).toEqual({
      command: 'list',
      value: undefined,
      force: false,
      json: false,
      clear: false,
    });
    expect(() =>
      parseMarketplaceArgs(['remove', 'community/example', '--json']),
    ).toThrow();
  });

  test('parses enable, disable, and profile commands', () => {
    expect(parseMarketplaceArgs(['enable', 'community/example'])).toEqual({
      command: 'enable',
      value: 'community/example',
      force: false,
      json: false,
      clear: false,
    });
    expect(
      parseMarketplaceArgs(['profile', 'librarian', 'community/deep']),
    ).toEqual({
      command: 'profile',
      role: 'librarian',
      value: 'community/deep',
      force: false,
      json: false,
      clear: false,
    });
    expect(parseMarketplaceArgs(['profile', 'oracle', '--clear'])).toEqual({
      command: 'profile',
      role: 'oracle',
      force: false,
      json: false,
      clear: true,
    });
    expect(parseMarketplaceArgs(['status', '--json'])).toEqual({
      command: 'status',
      value: undefined,
      force: false,
      json: true,
      clear: false,
    });
  });
});
