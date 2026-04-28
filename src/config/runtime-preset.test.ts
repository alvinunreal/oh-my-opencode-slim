import { describe, expect, test } from 'bun:test';
import {
  getActiveRuntimePreset,
  getPreviousRuntimePreset,
  rollbackRuntimePreset,
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

  test('rollbackRuntimePreset restores active and clears previous', () => {
    setActiveRuntimePreset(null);
    setActiveRuntimePreset('old');
    setActiveRuntimePresetWithPrevious('new');
    rollbackRuntimePreset('old');
    expect(getActiveRuntimePreset()).toBe('old');
    expect(getPreviousRuntimePreset()).toBeNull();
    setActiveRuntimePreset(null);
  });

  test('rollbackRuntimePreset with null clears active and previous', () => {
    setActiveRuntimePreset(null);
    setActiveRuntimePresetWithPrevious('new');
    rollbackRuntimePreset(null);
    expect(getActiveRuntimePreset()).toBeNull();
    expect(getPreviousRuntimePreset()).toBeNull();
    setActiveRuntimePreset(null);
  });
});
