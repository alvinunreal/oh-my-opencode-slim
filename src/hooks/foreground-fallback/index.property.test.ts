import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { asHttpStatus } from './dedup';

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
    const nonInteger = fc.oneof(
      fc.constant(Number.NaN),
      fc
        .double({ noNaN: true, noDefaultInfinity: true })
        .filter((value) => !Number.isInteger(value)),
    );
    fc.assert(
      fc.property(nonInteger, (value) => {
        expect(asHttpStatus(value)).toBeUndefined();
      }),
    );
  });

  test('rejects values outside the accepted input shapes', () => {
    const wrongLengthString = fc.oneof(
      fc.string({ maxLength: 2 }),
      fc.string({ minLength: 4, maxLength: 5 }),
    );
    const nonDigitString = fc
      .tuple(
        fc.constantFrom('a', 'x', '-'),
        fc.string({ minLength: 2, maxLength: 2 }),
      )
      .map(([first, rest]) => `${first}${rest}`);
    const outOfShape = fc.oneof(
      fc.array(fc.integer()),
      fc.object(),
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
      fc.constant(Infinity),
      fc.constant(-Infinity),
      fc
        .double({ min: 100, max: 599 })
        .filter((value) => !Number.isInteger(value)),
      wrongLengthString,
      nonDigitString,
    );

    fc.assert(
      fc.property(outOfShape, (value) => {
        expect(asHttpStatus(value)).toBeUndefined();
      }),
    );
  });
});

describe('asHttpStatus fixed examples', () => {
  test('numeric and string 404 parse to 404', () => {
    expect(asHttpStatus(404)).toBe(404);
    expect(asHttpStatus('404')).toBe(404);
  });

  test('out-of-range and non-numeric strings are rejected', () => {
    expect(asHttpStatus('600')).toBeUndefined();
    expect(asHttpStatus('099')).toBeUndefined();
    expect(asHttpStatus('abc')).toBeUndefined();
  });
});
