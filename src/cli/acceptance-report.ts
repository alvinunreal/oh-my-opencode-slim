import { existsSync } from 'node:fs';
import { join } from 'node:path';

type CriteriaGroup = 'FR' | 'PR' | 'QR';
type CriteriaStatus = 'pass' | 'fail' | 'missing';

interface AcceptanceCheck {
  id: string;
  group: CriteriaGroup;
  description: string;
  file: string;
  testName: string;
}

export interface AcceptanceCheckResult extends AcceptanceCheck {
  status: CriteriaStatus;
  durationMs: number;
  error?: string;
}

export interface AcceptanceSummary {
  total: number;
  pass: number;
  fail: number;
  missing: number;
  byGroup: Record<
    CriteriaGroup,
    { total: number; pass: number; fail: number; missing: number }
  >;
  recommendedExitCode: number;
}

const CHECKS: AcceptanceCheck[] = [
  {
    id: 'FR-001',
    group: 'FR',
    description: 'NanoGPT CLI flag parsing',
    file: 'src/cli/index.test.ts',
    testName: 'parses --nanogpt=yes in install args',
  },
  {
    id: 'FR-002',
    group: 'FR',
    description: 'NanoGPT/OpenCode discovery parsing',
    file: 'src/cli/opencode-models.test.ts',
    testName: 'FR-002 discovers models from verbose output catalog',
  },
  {
    id: 'FR-003/004/005/007/008',
    group: 'FR',
    description: 'Core routing assignment/policy/fallback/cross-provider',
    file: 'src/cli/acceptance-criteria-v2.test.ts',
    testName: 'FR-003/004/005/007/008 with >=4 models across systems',
  },
  {
    id: 'FR-006',
    group: 'FR',
    description: 'Subscription quota pressure handling',
    file: 'src/cli/acceptance-criteria-v2.test.ts',
    testName:
      'FR-006 quota pressure reduces subscription preference in hybrid mode',
  },
  {
    id: 'FR-009/010/011',
    group: 'FR',
    description: 'Migration preservation and reversibility',
    file: 'src/cli/acceptance-criteria-v2.test.ts',
    testName: 'FR-009/010/011 migration keeps legacy assignments reversible',
  },
  {
    id: 'FR-012',
    group: 'FR',
    description: 'Rollback to V1 backup path',
    file: 'src/cli/acceptance-criteria-v2.test.ts',
    testName: 'FR-012 rollback restores V1 backup from migrated config',
  },
  {
    id: 'PR-001/003/004 + QR-003',
    group: 'PR',
    description: 'Selection/config/memory and shadow drift benchmark',
    file: 'src/cli/acceptance-criteria-v2.test.ts',
    testName: 'PR-001/003/004 and QR-003 with >=4 models',
  },
  {
    id: 'PR-002',
    group: 'PR',
    description: 'Discovery timeout handling',
    file: 'src/cli/opencode-models.test.ts',
    testName: 'returns timeout error when discovery process exceeds timeout',
  },
  {
    id: 'QR-002',
    group: 'QR',
    description: 'Provider combination matrix coverage',
    file: 'src/cli/acceptance-criteria-v2.test.ts',
    testName:
      'QR-002 provider-combination integration matrix runs across diverse combinations',
  },
  {
    id: 'QR-004',
    group: 'QR',
    description: 'Migration reliability checks',
    file: 'src/cli/migration.test.ts',
    testName: 'migrates legacy Chutes two-slot fields into per-agent map',
  },
  {
    id: 'QR-005',
    group: 'QR',
    description: 'Rollback reliability checks',
    file: 'src/cli/migration-rollback.test.ts',
    testName: 'rolls back to V1 backup and keeps rollback snapshot',
  },
];

const DEFAULT_TEST_TIMEOUT_MS = 120_000;

function parseOptions(args: string[]): { json: boolean } {
  return {
    json: args.includes('--json'),
  };
}

async function runCheck(
  check: AcceptanceCheck,
  rootDir: string,
): Promise<AcceptanceCheckResult> {
  const filePath = join(rootDir, check.file);
  if (!existsSync(filePath)) {
    return {
      ...check,
      status: 'missing',
      durationMs: 0,
      error: `missing file: ${check.file}`,
    };
  }

  const startedAt = performance.now();
  const proc = Bun.spawn(
    [process.execPath, 'test', check.file, '-t', check.testName],
    {
      cwd: rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      proc.kill();
      reject(new Error(`timeout after ${DEFAULT_TEST_TIMEOUT_MS}ms`));
    }, DEFAULT_TEST_TIMEOUT_MS);
    proc.exited.finally(() => clearTimeout(id));
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    const stderr = await new Response(proc.stderr).text();
    const durationMs = performance.now() - startedAt;

    return {
      ...check,
      status: exitCode === 0 ? 'pass' : 'fail',
      durationMs,
      error: exitCode === 0 ? undefined : stderr.trim() || 'test failed',
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    return {
      ...check,
      status: 'fail',
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeAcceptanceResults(
  results: AcceptanceCheckResult[],
): AcceptanceSummary {
  const byGroup: AcceptanceSummary['byGroup'] = {
    FR: { total: 0, pass: 0, fail: 0, missing: 0 },
    PR: { total: 0, pass: 0, fail: 0, missing: 0 },
    QR: { total: 0, pass: 0, fail: 0, missing: 0 },
  };

  for (const result of results) {
    const group = byGroup[result.group];
    group.total += 1;
    group[result.status] += 1;
  }

  const pass = results.filter((result) => result.status === 'pass').length;
  const fail = results.filter((result) => result.status === 'fail').length;
  const missing = results.filter(
    (result) => result.status === 'missing',
  ).length;

  return {
    total: results.length,
    pass,
    fail,
    missing,
    byGroup,
    recommendedExitCode: fail > 0 ? 1 : 0,
  };
}

function printHuman(
  summary: AcceptanceSummary,
  results: AcceptanceCheckResult[],
): void {
  console.log('Acceptance Report (Plan v2)');
  console.log(
    `Total: ${summary.total}  Pass: ${summary.pass}  Fail: ${summary.fail}  Missing: ${summary.missing}`,
  );
  console.log('');

  for (const group of ['FR', 'PR', 'QR'] as const) {
    const section = summary.byGroup[group];
    console.log(
      `${group}: ${section.pass}/${section.total} pass` +
        (section.fail > 0 ? `, ${section.fail} fail` : '') +
        (section.missing > 0 ? `, ${section.missing} missing` : ''),
    );

    for (const result of results.filter((item) => item.group === group)) {
      const icon =
        result.status === 'pass'
          ? 'PASS'
          : result.status === 'fail'
            ? 'FAIL'
            : 'MISS';
      const duration = `${Math.round(result.durationMs)}ms`;
      console.log(
        `  [${icon}] ${result.id} - ${result.description} (${duration})`,
      );
      if (result.status !== 'pass' && result.error) {
        console.log(`    ${result.error.split('\n')[0]}`);
      }
    }
    console.log('');
  }
}

export async function acceptanceReport(args: string[]): Promise<number> {
  const options = parseOptions(args);
  const rootDir = process.cwd();
  const results: AcceptanceCheckResult[] = [];

  for (const check of CHECKS) {
    results.push(await runCheck(check, rootDir));
  }

  const summary = summarizeAcceptanceResults(results);

  if (options.json) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    printHuman(summary, results);
  }

  return summary.recommendedExitCode;
}
