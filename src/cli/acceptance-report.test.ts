/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test';
import {
  type AcceptanceCheckResult,
  summarizeAcceptanceResults,
} from './acceptance-report';

describe('acceptance report', () => {
  test('summarizes pass, fail, and missing counts by group', () => {
    const results: AcceptanceCheckResult[] = [
      {
        id: 'FR-001',
        group: 'FR',
        description: 'x',
        file: 'a',
        testName: 'a',
        status: 'pass',
        durationMs: 10,
      },
      {
        id: 'PR-001',
        group: 'PR',
        description: 'y',
        file: 'b',
        testName: 'b',
        status: 'fail',
        durationMs: 10,
      },
      {
        id: 'QR-001',
        group: 'QR',
        description: 'z',
        file: 'c',
        testName: 'c',
        status: 'missing',
        durationMs: 0,
      },
    ];

    const summary = summarizeAcceptanceResults(results);
    expect(summary.total).toBe(3);
    expect(summary.pass).toBe(1);
    expect(summary.fail).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.byGroup.FR.pass).toBe(1);
    expect(summary.byGroup.PR.fail).toBe(1);
    expect(summary.byGroup.QR.missing).toBe(1);
    expect(summary.recommendedExitCode).toBe(1);
  });
});
