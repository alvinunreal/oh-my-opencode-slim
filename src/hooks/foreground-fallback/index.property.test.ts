import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { asHttpStatus } from './index';

describe('asHttpStatus properties', () => {
  test('accepts integer HTTP status codes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 599 }), (value) => {
        expect(asHttpStatus(value)).toBe(value);
      }),
    );
  });

  test('rejects integers outside the HTTP status range', () => {
    const outsideRange = fc.oneof(
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: 99 }),
      fc.integer({ min: 600, max: Number.MAX_SAFE_INTEGER }),
    );
    fc.assert(
      fc.property(outsideRange, (value) => {
        expect(asHttpStatus(value)).toBeUndefined();
      }),
    );
  });

  test('parses three-digit status strings in range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 599 }), (value) => {
        const status = String(value);
        expect(asHttpStatus(status)).toBe(Number(status));
      }),
    );
  });

  test('rejects out-of-range three-digit status strings', () => {
    const outsideRange = fc.oneof(
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 600, max: 999 }),
    );
    fc.assert(
      fc.property(outsideRange, (value) => {
        expect(asHttpStatus(String(value).padStart(3, '0'))).toBeUndefined();
      }),
    );
  });

  test('rejects non-integers and NaN', () => {
    const nonInteger = fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((value) => !Number.isInteger(value));
    fc.assert(
      fc.property(nonInteger, (value) => {
        expect(asHttpStatus(value)).toBeUndefined();
      }),
    );
    fc.assert(
      fc.property(fc.constant(Number.NaN), (value) => {
        expect(asHttpStatus(value)).toBeUndefined();
      }),
    );
  });
});
