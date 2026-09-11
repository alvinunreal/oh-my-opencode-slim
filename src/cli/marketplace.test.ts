import { describe, expect, test } from 'bun:test';
import { parseMarketplaceArgs } from './marketplace';

describe('marketplace CLI parsing', () => {
  test('keeps local import distinct from registry install/update', () => {
    expect(parseMarketplaceArgs(['import', './package.json'])).toEqual({
      command: 'import',
      value: './package.json',
      force: false,
      json: false,
      clear: false,
    });
    expect(
      parseMarketplaceArgs(['import', './package-v2.json', '--update']),
    ).toEqual({
      command: 'import',
      value: './package-v2.json',
      force: false,
      json: false,
      clear: false,
      update: true,
    });
    expect(
      parseMarketplaceArgs(['install', 'community/example@1.2.3']),
    ).toEqual({
      command: 'install',
      value: 'community/example@1.2.3',
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
    expect(parseMarketplaceArgs(['update', 'community/example']).command).toBe(
      'update',
    );
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
