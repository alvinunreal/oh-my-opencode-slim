import { describe, expect, test } from 'bun:test';
import { parseMarketplaceArgs } from './marketplace';

describe('marketplace CLI parsing', () => {
  test('keeps local import distinct from registry install/update', () => {
    expect(parseMarketplaceArgs(['import', './package.json'])).toEqual({
      command: 'import',
      value: './package.json',
      force: false,
      json: false,
    });
    expect(
      parseMarketplaceArgs(['import', './package-v2.json', '--update']),
    ).toEqual({
      command: 'import',
      value: './package-v2.json',
      force: false,
      json: false,
      update: true,
    });
    expect(
      parseMarketplaceArgs(['install', 'community/example@1.2.3']),
    ).toEqual({
      command: 'install',
      value: 'community/example@1.2.3',
      force: false,
      json: false,
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
    });
    expect(parseMarketplaceArgs(['update', 'community/example']).command).toBe(
      'update',
    );
    expect(() =>
      parseMarketplaceArgs(['remove', 'community/example', '--json']),
    ).toThrow();
  });

  test('parses enable, disable, and status commands', () => {
    expect(parseMarketplaceArgs(['enable', 'community/example'])).toEqual({
      command: 'enable',
      value: 'community/example',
      force: false,
      json: false,
    });
    expect(parseMarketplaceArgs(['status', '--json'])).toEqual({
      command: 'status',
      value: undefined,
      force: false,
      json: true,
    });
  });
});
