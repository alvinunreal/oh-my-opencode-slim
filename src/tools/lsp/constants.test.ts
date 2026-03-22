import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_DIAGNOSTICS,
  DEFAULT_MAX_REFERENCES,
  SEVERITY_MAP,
  SYMBOL_KIND_MAP,
} from './constants';

describe('constants', () => {
  describe('SYMBOL_KIND_MAP', () => {
    test('should have correct number of symbol kinds', () => {
      expect(Object.keys(SYMBOL_KIND_MAP).length).toBe(26);
    });

    test('should map File to 1', () => {
      expect(SYMBOL_KIND_MAP[1]).toBe('File');
    });

    test('should map Module to 2', () => {
      expect(SYMBOL_KIND_MAP[2]).toBe('Module');
    });

    test('should map Class to 5', () => {
      expect(SYMBOL_KIND_MAP[5]).toBe('Class');
    });

    test('should map Method to 6', () => {
      expect(SYMBOL_KIND_MAP[6]).toBe('Method');
    });

    test('should map Function to 12', () => {
      expect(SYMBOL_KIND_MAP[12]).toBe('Function');
    });

    test('should map Variable to 13', () => {
      expect(SYMBOL_KIND_MAP[13]).toBe('Variable');
    });

    test('should map Constant to 14', () => {
      expect(SYMBOL_KIND_MAP[14]).toBe('Constant');
    });

    test('should map TypeParameter to 26', () => {
      expect(SYMBOL_KIND_MAP[26]).toBe('TypeParameter');
    });
  });

  describe('SEVERITY_MAP', () => {
    test('should have correct number of severity levels', () => {
      expect(Object.keys(SEVERITY_MAP).length).toBe(4);
    });

    test('should map 1 to error', () => {
      expect(SEVERITY_MAP[1]).toBe('error');
    });

    test('should map 2 to warning', () => {
      expect(SEVERITY_MAP[2]).toBe('warning');
    });

    test('should map 3 to information', () => {
      expect(SEVERITY_MAP[3]).toBe('information');
    });

    test('should map 4 to hint', () => {
      expect(SEVERITY_MAP[4]).toBe('hint');
    });
  });

  describe('DEFAULT_MAX_REFERENCES', () => {
    test('should be 200', () => {
      expect(DEFAULT_MAX_REFERENCES).toBe(200);
    });
  });

  describe('DEFAULT_MAX_DIAGNOSTICS', () => {
    test('should be 200', () => {
      expect(DEFAULT_MAX_DIAGNOSTICS).toBe(200);
    });
  });
});

// Note: NearestRoot tests require complex file system mocking
// and are better suited for integration tests with real directory structures.
// The constants themselves (maps and default values) are tested above.
describe('NearestRoot', () => {
  test('should be exported as a function', () => {
    const { NearestRoot } = require('./constants');
    expect(typeof NearestRoot).toBe('function');
  });

  test('should return a function when called', () => {
    const { NearestRoot } = require('./constants');
    const rootFn = NearestRoot(['package.json']);
    expect(typeof rootFn).toBe('function');
  });

  test('should accept optional exclude patterns', () => {
    const { NearestRoot } = require('./constants');
    const rootFn = NearestRoot(['package.json'], ['deno.json']);
    expect(typeof rootFn).toBe('function');
  });
});
