import { describe, expect, test } from 'bun:test';
import {
  isPluginDisabledByEnv,
  isTruthyEnvValue,
  PLUGIN_DISABLE_ENV,
} from './env';

describe('isTruthyEnvValue', () => {
  test.each(['1', 'true', 'TRUE', ' yes ', 'on'])('%p is truthy', (value) => {
    expect(isTruthyEnvValue(value)).toBe(true);
  });

  test.each([
    undefined,
    '',
    '0',
    'false',
    'no',
    'off',
    'anything',
  ])('%p is not truthy', (value) => {
    expect(isTruthyEnvValue(value)).toBe(false);
  });
});

describe('isPluginDisabledByEnv', () => {
  test('reads OH_MY_OPENCODE_SLIM_DISABLE', () => {
    expect(isPluginDisabledByEnv({ [PLUGIN_DISABLE_ENV]: '1' })).toBe(true);
    expect(isPluginDisabledByEnv({ [PLUGIN_DISABLE_ENV]: '0' })).toBe(false);
  });
});
