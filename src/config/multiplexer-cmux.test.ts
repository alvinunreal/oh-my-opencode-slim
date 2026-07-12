import { describe, expect, test } from 'bun:test';
import { MultiplexerConfigSchema, MultiplexerTypeSchema } from './schema';

describe('cmux multiplexer schema', () => {
  test('accepts cmux as a multiplexer type and config', () => {
    expect(MultiplexerTypeSchema.parse('cmux')).toBe('cmux');
    expect(MultiplexerConfigSchema.parse({ type: 'cmux' }).type).toBe('cmux');
  });
});
