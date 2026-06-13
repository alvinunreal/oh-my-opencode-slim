import { describe, expect, test } from 'bun:test';
import {
  getActiveRuntimePreset,
  getPreviousRuntimePreset,
  setActiveRuntimePreset,
  setActiveRuntimePresetWithPrevious,
} from './runtime-preset';

describe('runtime-preset', () => {
  // Cleanup after each test to avoid state leakage
  test('getActiveRuntimePreset returns null initially', () => {
    setActiveRuntimePreset(null);
    expect(getActiveRuntimePreset()).toBeNull();
    setActiveRuntimePreset(null);
  });

  test('setActiveRuntimePreset sets the active preset', () => {
    setActiveRuntimePreset(null);
    setActiveRuntimePreset('foo');
    expect(getActiveRuntimePreset()).toBe('foo');
    setActiveRuntimePreset(null);
  });

  test('setActiveRuntimePresetWithPrevious sets active and previous', () => {
    setActiveRuntimePreset(null);
    setActiveRuntimePreset('old');
    setActiveRuntimePresetWithPrevious('new');
    expect(getActiveRuntimePreset()).toBe('new');
    expect(getPreviousRuntimePreset()).toBe('old');
    setActiveRuntimePreset(null);
  });

  test('setActiveRuntimePresetWithPrevious with null sets previous to old', () => {
    setActiveRuntimePreset(null);
    setActiveRuntimePreset('old');
    setActiveRuntimePresetWithPrevious(null);
    expect(getActiveRuntimePreset()).toBeNull();
    expect(getPreviousRuntimePreset()).toBe('old');
    setActiveRuntimePreset(null);
  });
});
