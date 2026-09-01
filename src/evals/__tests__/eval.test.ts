import { describe, expect, test } from 'bun:test';
import { checkAssertion } from '../assertions';
import { formatResult } from '../display';
import type { Transcript } from '../schema';
import { EvalSuiteSchema } from '../schema';
import { executeEvalCase, executeSuite } from '../scoring';
import { loadEvalSuite, loadEvalSuites } from '../suites';

describe('eval schema', () => {
  test('validates a minimal eval suite', async () => {
    const suite = EvalSuiteSchema.parse({
      name: 'test-suite',
      description: 'A test suite',
      evals: [
        {
          id: 'test-1',
          prompt: 'Do something',
          assertions: [
            {
              type: 'contains',
              value: 'hello',
              description: 'Should say hello',
            },
          ],
        },
      ],
    });

    expect(suite.name).toBe('test-suite');
    expect(suite.evals).toHaveLength(1);
    expect(suite.evals[0].agent).toBe('orchestrator'); // default
  });

  test('rejects invalid assertion type', async () => {
    expect(() =>
      EvalSuiteSchema.parse({
        name: 'bad',
        description: 'bad',
        evals: [
          {
            id: 'bad-1',
            prompt: 'Do something',
            assertions: [
              { type: 'invalid_type', value: 'x', description: 'bad' },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('eval loader', () => {
  test('loads all eval suites', async () => {
    const suites = loadEvalSuites();
    expect(suites.length).toBeGreaterThan(0);

    const names = suites.map((s) => s.name);
    expect(names).toContain('orchestrator-direct-execution');
    expect(names).toContain('orchestrator-natural-routing');
    expect(names).toContain('orchestrator-skill-triggers');
    expect(names).toContain('orchestrator-response-quality');
    expect(names).toContain('fixer-execution');
    expect(names).toContain('background-task-lifecycle');
    expect(names).toContain('parallel-delegation');
    expect(names).toContain('prompt-compliance');
    expect(names).toContain('cost-and-model-gates');
  });

  test('loads a specific suite', async () => {
    const suite = loadEvalSuite('orchestrator-natural-routing');
    expect(suite).not.toBeNull();
    expect(suite?.evals.length).toBeGreaterThan(0);
  });

  test('returns null for nonexistent suite', async () => {
    expect(loadEvalSuite('nonexistent')).toBeNull();
  });
});

describe('result formatting', () => {
  test('formats results', async () => {
    const result = formatResult({
      suiteName: 'test',
      totalEvals: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      passAtK: 2 / 3,
      passK: 2 / 3,
      results: [
        {
          evalId: 'a',
          prompt: 'test a',
          runs: 1,
          passRate: 1,
          passed: true,
          assertions: [],
        },
        {
          evalId: 'b',
          prompt: 'test b',
          runs: 1,
          passRate: 1,
          passed: true,
          assertions: [],
        },
        {
          evalId: 'c',
          prompt: 'test c',
          runs: 1,
          passRate: 0,
          passed: false,
          assertions: [
            {
              assertion: {
                type: 'contains',
                value: 'x',
                description: 'Should have x',
              },
              passed: false,
              evidence: 'Output did not contain x',
            },
          ],
        },
      ],
      durationMs: 1500,
      timestamp: new Date().toISOString(),
    });

    expect(result).toContain('2/3 passed');
    expect(result).toContain('test c...');
    expect(result).toContain('Should have x');
  });

  describe('checkAssertion', () => {
    test('contains passes when substring present', async () => {
      const assertion = {
        type: 'contains',
        value: 'hello',
        description: 'test',
      };
      const output = 'hello world';
      expect((await checkAssertion(assertion, output)).passed).toBe(true);
    });
    test('contains fails when substring absent', async () => {
      const assertion = {
        type: 'contains',
        value: 'hello',
        description: 'test',
      };
      const output = 'goodbye world';
      expect((await checkAssertion(assertion, output)).passed).toBe(false);
      expect((await checkAssertion(assertion, output)).evidence).toBe(
        'output did not contain "hello"',
      );
    });
    test('not_contains passes when substring absent', async () => {
      const assertion = {
        type: 'not_contains',
        value: 'hello',
        description: 'test',
      };
      const output = 'goodbye world';
      expect((await checkAssertion(assertion, output)).passed).toBe(true);
    });
    test('not_contains fails when substring present', async () => {
      const assertion = {
        type: 'not_contains',
        value: 'hello',
        description: 'test',
      };
      const output = 'hello world';
      expect((await checkAssertion(assertion, output)).passed).toBe(false);
      expect((await checkAssertion(assertion, output)).evidence).toBe(
        'output contained "hello"',
      );
    });
    test('regex passes when pattern matches', async () => {
      const assertion = { type: 'regex', value: '\\d+', description: 'test' };
      const output = 'there are 123 items';
      expect((await checkAssertion(assertion, output)).passed).toBe(true);
    });
    test('regex fails when pattern does not match', async () => {
      const assertion = { type: 'regex', value: '\\d+', description: 'test' };
      const output = 'no numbers here';
      expect((await checkAssertion(assertion, output)).passed).toBe(false);
      expect((await checkAssertion(assertion, output)).evidence).toBe(
        'output did not match /\\d+/',
      );
    });
    test('structure passes when pattern present', async () => {
      const assertion = {
        type: 'structure',
        value: 'name',
        description: 'test',
      };
      const output = '{"name": "test", "value": 123}';
      expect((await checkAssertion(assertion, output)).passed).toBe(true);
    });
    test('references_read passes when a read targets the reference path', async () => {
      const assertion = {
        type: 'references_read',
        value: 'references/full-guide.md',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                name: 'read',
                args: { filePath: 'skill://reflect/references/full-guide.md' },
              },
            ],
          },
        ],
      };
      expect(
        (await checkAssertion(assertion, 'synthesized answer', transcript))
          .passed,
      ).toBe(true);
    });
    test('references_read fails when no read targets the reference path', async () => {
      const assertion = {
        type: 'references_read',
        value: 'references/full-guide.md',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { name: 'read', args: { filePath: 'package.json' } },
              { name: 'bash', args: { command: 'ls' } },
            ],
          },
        ],
      };
      // Output quoting the phrase must NOT pass without an actual read.
      expect(
        (
          await checkAssertion(
            assertion,
            'output mentions Session Archaeology',
            transcript,
          )
        ).passed,
      ).toBe(false);
    });
    test('references_read fails when value is empty', async () => {
      const assertion = {
        type: 'references_read',
        value: '',
        description: 'test',
      };
      expect((await checkAssertion(assertion, 'output')).passed).toBe(false);
      expect((await checkAssertion(assertion, 'output')).evidence).toBe(
        'references_read requires value (reference file path) to be set',
      );
    });
    test('agent_routed passes when agent in transcript', async () => {
      const assertion = {
        type: 'agent_routed',
        value: 'fixer',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'agent', args: { agent: 'fixer' } }],
          },
        ],
        agentInvocations: [{ agent: 'fixer' }],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        true,
      );
    });
    test('agent_routed fails when agent not in transcript', async () => {
      const assertion = {
        type: 'agent_routed',
        value: 'fixer',
        description: 'test',
      };
      const transcript = {
        messages: [],
        agentInvocations: [{ agent: 'librarian' }],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
      expect(
        (await checkAssertion(assertion, '', transcript)).evidence,
      ).toContain('librarian');
    });
    test('agent_not_routed passes when agent absent from transcript', async () => {
      const assertion = {
        type: 'agent_not_routed',
        value: 'fixer',
        description: 'test',
      };
      const transcript = {
        messages: [],
        agentInvocations: [{ agent: 'librarian' }],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        true,
      );
    });
    test('agent_not_routed fails when agent in transcript', async () => {
      const assertion = {
        type: 'agent_not_routed',
        value: 'fixer',
        description: 'test',
      };
      const transcript = {
        messages: [],
        agentInvocations: [{ agent: 'fixer' }],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
      expect(
        (await checkAssertion(assertion, '', transcript)).evidence,
      ).toContain('incorrectly invoked');
    });
    test('tool_used checks transcript not text', async () => {
      const assertion = {
        type: 'tool_used',
        value: 'read',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'read', args: {} }],
          },
        ],
      };
      expect(
        (await checkAssertion(assertion, 'I did not use any tools', transcript))
          .passed,
      ).toBe(true);
      expect(
        (await checkAssertion(assertion, 'I used read tool', undefined)).passed,
      ).toBe(false);
    });
    test('file_contains requires filePath', async () => {
      const assertion = {
        type: 'file_contains',
        value: 'x',
        description: 'test',
      };
      expect((await checkAssertion(assertion, '')).passed).toBe(false);
      expect((await checkAssertion(assertion, '')).evidence).toBe(
        'file_contains requires filePath to be set',
      );
    });
    test('file_contains passes when file under eval root contains value', async () => {
      const assertion = {
        type: 'file_contains',
        value: 'eval',
        filePath: 'src/cli/eval.ts',
        description: 'test',
      };
      expect((await checkAssertion(assertion, '')).passed).toBe(true);
    });
    test('file_contains fails when file lacks value', async () => {
      const assertion = {
        type: 'file_contains',
        value: '__no_such_marker__',
        filePath: 'src/cli/eval.ts',
        description: 'test',
      };
      expect((await checkAssertion(assertion, '')).passed).toBe(false);
      expect((await checkAssertion(assertion, '')).evidence).toContain(
        'did not contain',
      );
    });
    test('file_contains fails for missing file', async () => {
      const assertion = {
        type: 'file_contains',
        value: 'x',
        filePath: 'src/evals/__tests__/does-not-exist.txt',
        description: 'test',
      };
      expect((await checkAssertion(assertion, '')).passed).toBe(false);
      expect((await checkAssertion(assertion, '')).evidence).toContain(
        'cannot read',
      );
    });
    test('background_task_completed passes on completed task call', async () => {
      const assertion = {
        type: 'background_task_completed',
        value: '',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                name: 'task',
                args: { subagent_type: 'fixer' },
                result:
                  '<task id="ses_1" state="completed">\n<task_result>done</task_result>',
              },
            ],
          },
        ],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        true,
      );
    });
    test('background_task_completed fails for errored task', async () => {
      const assertion = {
        type: 'background_task_completed',
        value: '',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                name: 'task',
                args: { subagent_type: 'fixer' },
                result:
                  '<task id="ses_1" state="error">\n<task_result>something broke</task_result>',
              },
            ],
          },
        ],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
    });
    test('background_task_completed fails when task still running', async () => {
      const assertion = {
        type: 'background_task_completed',
        value: '',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ name: 'task', args: {}, result: undefined }],
          },
        ],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
    });
    test('background_task_completed filters by agent name', async () => {
      const assertion = {
        type: 'background_task_completed',
        value: 'fixer',
        description: 'test',
      };
      const transcript = {
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                name: 'task',
                args: { subagent_type: 'explorer' },
                result:
                  '<task id="ses_1" state="completed">\n<task_result>done</task_result>',
              },
            ],
          },
        ],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
    });
    test('cost_under passes when total cost under cap', async () => {
      const assertion = {
        type: 'cost_under',
        value: '0.05',
        description: 'test',
      };
      const transcript = {
        messages: [],
        agentTokens: {
          orchestrator: { input: 1000, output: 500, cost: 0.01 },
          fixer: { input: 2000, output: 1000, cost: 0.02 },
        },
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        true,
      );
    });
    test('cost_under fails when total cost over cap', async () => {
      const assertion = {
        type: 'cost_under',
        value: '0.05',
        description: 'test',
      };
      const transcript = {
        messages: [],
        agentTokens: {
          orchestrator: { input: 1000, output: 500, cost: 0.06 },
        },
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
      expect(
        (await checkAssertion(assertion, '', transcript)).evidence,
      ).toContain('exceeded cap');
    });
    test('cost_under gates a single agent via JSON', async () => {
      const assertion = {
        type: 'cost_under',
        value: '{"agent": "orchestrator", "max": 0.02}',
        description: 'test',
      };
      const transcript = {
        messages: [],
        agentTokens: {
          orchestrator: { input: 1000, output: 500, cost: 0.05 },
          fixer: { input: 2000, output: 1000, cost: 0.001 },
        },
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
    });
    test('model_switches passes when count within threshold', async () => {
      const assertion = {
        type: 'model_switches',
        value: '1',
        description: 'test',
      };
      const transcript = {
        messages: [],
        modelSwitches: [{ from: 'primary', to: 'fallback' }],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        true,
      );
    });
    test('model_switches fails when count exceeds threshold', async () => {
      const assertion = {
        type: 'model_switches',
        value: '0',
        description: 'test',
      };
      const transcript = {
        messages: [],
        modelSwitches: [{ from: 'primary', to: 'fallback' }],
      };
      expect((await checkAssertion(assertion, '', transcript)).passed).toBe(
        false,
      );
    });
  });
});

describe('executeEvalCase', () => {
  const evalCase = {
    id: 'test',
    prompt: 'say hello',
    assertions: [
      {
        type: 'contains' as const,
        value: 'hello',
        description: 'should greet',
      },
    ],
  };

  test('passes when all assertions pass across all runs', async () => {
    const result = await executeEvalCase(
      evalCase,
      ['hello world', 'hello again', 'say hello'],
      [],
    );
    expect(result.passed).toBe(true);
    expect(result.runs).toBe(3);
    expect(result.passRate).toBe(1);
  });

  test('fails when majority of runs fail', async () => {
    const result = await executeEvalCase(
      evalCase,
      ['goodbye', 'goodbye', 'hello'],
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.runs).toBe(3);
    expect(result.passRate).toBeCloseTo(1 / 3);
  });

  test('returns error when no outputs provided', async () => {
    const result = await executeEvalCase(evalCase, [], []);
    expect(result.passed).toBe(false);
    expect(result.runs).toBe(0);
    expect(result.error).toContain('no outputs');
  });
});

describe('executeSuite', () => {
  test('returns empty result for nonexistent suite', async () => {
    const result = await executeSuite('nonexistent', {});
    expect(result.totalEvals).toBe(0);
  });

  test('executes orchestrator-natural-routing suite with mock outputs', async () => {
    const outputs: Record<string, string> = {
      'substantial-updates-to-fixer': 'delegating to @fixer for implementation',
      'simple-architecture-answered-directly':
        'asking @oracle for architecture guidance',
      'major-architecture-to-oracle':
        'asking @oracle for architecture guidance',
      'external-docs-to-librarian': '@librarian should research this',
      'codebase-search-to-explorer': 'found observability.ts defines emitEvent',
      'broad-search-to-explorer': 'searching the codebase with @explorer',
      'ui-work-to-designer': 'delegating this to @designer for UI work',
    };
    // agent_routed assertions need transcripts with agentInvocations
    const transcripts: Record<string, Transcript[]> = {
      'substantial-updates-to-fixer': [
        { messages: [], agentInvocations: [{ agent: 'fixer' }] },
      ],
      'simple-architecture-answered-directly': [
        { messages: [], agentInvocations: [] },
      ],
      'major-architecture-to-oracle': [
        { messages: [], agentInvocations: [{ agent: 'oracle' }] },
      ],
      'external-docs-to-librarian': [
        { messages: [], agentInvocations: [{ agent: 'librarian' }] },
      ],
      'codebase-search-to-explorer': [
        { messages: [], agentInvocations: [{ agent: 'explorer' }] },
      ],
      'broad-search-to-explorer': [
        { messages: [], agentInvocations: [{ agent: 'explorer' }] },
      ],
      'ui-work-to-designer': [
        {
          messages: [],
          agentInvocations: [{ agent: 'explorer' }, { agent: 'designer' }],
        },
      ],
    };

    const result = await executeSuite(
      'orchestrator-natural-routing',
      outputs,
      transcripts,
    );
    expect(result.totalEvals).toBe(6);
    expect(result.skipped).toBe(0);
    expect(result.passed).toBe(6);
    expect(result.failed).toBe(0);
  });

  test('skips evals with no output', async () => {
    const result = await executeSuite('orchestrator-natural-routing', {});
    expect(result.totalEvals).toBe(6);
    expect(result.skipped).toBe(6);
    expect(result.passed).toBe(0);
  });

  test('treats empty and whitespace-only outputs as missing', async () => {
    const result = await executeSuite('orchestrator-direct-execution', {
      'trivial-edit-direct': ['', '\n'],
    });
    const trivial = result.results.find(
      (r) => r.evalId === 'trivial-edit-direct',
    );

    expect(trivial?.runs).toBe(0);
    expect(trivial?.error).toContain('no output');
    expect(result.skipped).toBe(4);
  });

  test('supports multi-run outputs', async () => {
    const outputs: Record<string, string[]> = {
      'trivial-should-handle-directly': [
        'The scripts section defines the npm run commands',
        'The scripts section defines the npm run commands',
        'The scripts section defines the npm run commands',
      ],
    };

    const result = await executeSuite('orchestrator-direct-execution', outputs);
    const trivial = result.results.find(
      (r) => r.evalId === 'trivial-should-handle-directly',
    );
    expect(trivial).toBeDefined();
    expect(trivial?.runs).toBe(3);
    expect(trivial?.passed).toBe(true);
    expect(trivial?.passRate).toBe(1);
  });
});

describe('assertion: file_exists', () => {
  test('passes when file exists', async () => {
    const result = await checkAssertion(
      {
        type: 'file_exists',
        value: '',
        filePath: 'src/evals/schema.ts',
        description: 'test',
      },
      '',
    );
    expect(result.passed).toBe(true);
  });

  test('fails when file does not exist', async () => {
    const result = await checkAssertion(
      {
        type: 'file_exists',
        value: '',
        filePath: 'src/evals/__tests__/does-not-exist.ts',
        description: 'test',
      },
      '',
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('does not exist');
  });

  test('fails when filePath is not set', async () => {
    const result = await checkAssertion(
      { type: 'file_exists', value: '', description: 'test' },
      '',
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('requires filePath');
  });
});

describe('assertion: agent_invocations_count', () => {
  test('passes with {max:0} when 0 invocations', async () => {
    const result = await checkAssertion(
      {
        type: 'agent_invocations_count',
        value: '{"max": 0}',
        description: 'test',
      },
      '',
      { messages: [], agentInvocations: [] },
    );
    expect(result.passed).toBe(true);
  });

  test('fails with {max:0} when invocations > 0', async () => {
    const result = await checkAssertion(
      {
        type: 'agent_invocations_count',
        value: '{"max": 0}',
        description: 'test',
      },
      '',
      {
        messages: [],
        agentInvocations: [{ agent: 'fixer' }],
      },
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('expected');
    expect(result.evidence).toContain('got 1');
  });

  test('exact number match', async () => {
    const result = await checkAssertion(
      {
        type: 'agent_invocations_count',
        value: '2',
        description: 'test',
      },
      '',
      {
        messages: [],
        agentInvocations: [{ agent: 'fixer' }, { agent: 'explorer' }],
      },
    );
    expect(result.passed).toBe(true);
  });
});
