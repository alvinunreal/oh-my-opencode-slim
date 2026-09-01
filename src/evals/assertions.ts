import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Assertion, Transcript } from './schema';
import { REPO_ROOT } from './suites';

export async function checkAssertion(
  assertion: Assertion,
  output: string,
  transcript?: Transcript,
): Promise<{ passed: boolean; evidence?: string }> {
  switch (assertion.type) {
    case 'contains':
      return {
        passed: output.toLowerCase().includes(assertion.value.toLowerCase()),
        evidence: output.toLowerCase().includes(assertion.value.toLowerCase())
          ? undefined
          : `output did not contain "${assertion.value}"`,
      };

    case 'not_contains':
      return {
        passed: !output.toLowerCase().includes(assertion.value.toLowerCase()),
        evidence: !output.toLowerCase().includes(assertion.value.toLowerCase())
          ? undefined
          : `output contained "${assertion.value}"`,
      };

    case 'regex':
      try {
        const re = new RegExp(assertion.value, 'i');
        return {
          passed: re.test(output),
          evidence: re.test(output)
            ? undefined
            : `output did not match /${assertion.value}/`,
        };
      } catch {
        return {
          passed: false,
          evidence: `invalid regex: ${assertion.value}`,
        };
      }

    case 'tool_used': {
      const toolCalls =
        transcript?.messages?.flatMap((m) => m.toolCalls ?? []) ?? [];
      const used = toolCalls.some(
        (t) => t.name?.toLowerCase() === assertion.value.toLowerCase(),
      );
      return {
        passed: used,
        evidence: used
          ? undefined
          : `tool "${assertion.value}" not found in transcript (${toolCalls.length} tool calls recorded)`,
      };
    }

    case 'tool_not_used': {
      const toolCalls =
        transcript?.messages?.flatMap((m) => m.toolCalls ?? []) ?? [];
      const used = toolCalls.some(
        (t) => t.name?.toLowerCase() === assertion.value.toLowerCase(),
      );
      return {
        passed: !used,
        evidence: !used
          ? undefined
          : `tool "${assertion.value}" was used (${toolCalls.length} tool calls recorded)`,
      };
    }

    case 'files_modified': {
      const toolCalls =
        transcript?.messages?.flatMap((m) => m.toolCalls ?? []) ?? [];
      const target = assertion.value.toLowerCase();
      const WRITE_TOOLS = new Set([
        'write',
        'edit',
        'patch',
        'apply_patch',
        'rewrite',
        'multi_write',
        'create',
        'update',
      ]);
      const edited = toolCalls.some((t) => {
        const name = t.name?.toLowerCase() ?? '';
        if (!WRITE_TOOLS.has(name)) return false;
        const argText = JSON.stringify(t.args ?? '').toLowerCase();
        return argText.includes(target);
      });
      return {
        passed: edited,
        evidence: edited
          ? undefined
          : `no write/edit tool call targeting "${assertion.value}" found in transcript`,
      };
    }

    case 'file_contains': {
      if (!assertion.filePath) {
        return {
          passed: false,
          evidence: 'file_contains requires filePath to be set',
        };
      }
      const filePath = resolve(REPO_ROOT, assertion.filePath);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const passed = content.includes(assertion.value);
        return {
          passed,
          evidence: passed
            ? undefined
            : `file "${assertion.filePath}" did not contain "${assertion.value}"`,
        };
      } catch (e) {
        return {
          passed: false,
          evidence: `file_contains: cannot read "${assertion.filePath}": ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    case 'structure': {
      const passed = output.includes(assertion.value);
      return {
        passed,
        evidence: passed
          ? undefined
          : `structural pattern "${assertion.value}" not found`,
      };
    }

    case 'references_read': {
      const toolCalls =
        transcript?.messages?.flatMap((m) => m.toolCalls ?? []) ?? [];
      const target = assertion.value.toLowerCase();
      if (!target) {
        return {
          passed: false,
          evidence:
            'references_read requires value (reference file path) to be set',
        };
      }
      const READ_TOOLS: Record<string, true> = {
        read: true,
        file_read: true,
      };
      const read = toolCalls.some((t) => {
        const name = t.name?.toLowerCase() ?? '';
        if (!READ_TOOLS[name]) return false;
        const argText = JSON.stringify(t.args ?? '').toLowerCase();
        return argText.includes(target);
      });
      return {
        passed: read,
        evidence: read
          ? undefined
          : `reference "${assertion.value}" not read (${toolCalls.length} tool calls recorded)`,
      };
    }

    case 'agent_routed': {
      const invocations = transcript?.agentInvocations ?? [];
      const value = assertion.value;
      const match =
        value.endsWith('*') && value.length > 1
          ? (name: string) =>
              name?.toLowerCase().startsWith(value.slice(0, -1).toLowerCase())
          : (name: string) => name?.toLowerCase() === value.toLowerCase();
      const found = invocations.some((i) => match(i.agent ?? ''));
      return {
        passed: found,
        evidence: found
          ? undefined
          : `agent "${assertion.value}" not observed (agents: ${invocations.map((i) => i.agent).join(', ') || 'none'})`,
      };
    }

    case 'agent_not_routed': {
      const invocations = transcript?.agentInvocations ?? [];
      const found = invocations.some(
        (i) => i.agent?.toLowerCase() === assertion.value.toLowerCase(),
      );
      return {
        passed: !found,
        evidence: found
          ? `agent "${assertion.value}" was incorrectly invoked`
          : undefined,
      };
    }

    case 'subagent_count': {
      const invocations = transcript?.agentInvocations ?? [];
      const uniqueAgents = new Set(invocations.map((i) => i.agent));
      const count = uniqueAgents.size;
      try {
        const expected = JSON.parse(assertion.value) as
          | { min?: number; max?: number }
          | number;
        if (typeof expected === 'number') {
          return {
            passed: count === expected,
            evidence:
              count === expected
                ? undefined
                : `expected ${expected} unique agents, got ${count}`,
          };
        }
        const min = expected.min ?? 0;
        const max = expected.max ?? Infinity;
        const passed = count >= min && count <= max;
        return {
          passed,
          evidence: passed
            ? undefined
            : `expected ${min}-${max} unique agents, got ${count}`,
        };
      } catch {
        return {
          passed: false,
          evidence: 'subagent_count: invalid value format',
        };
      }
    }

    case 'background_task_completed': {
      const toolCalls =
        transcript?.messages?.flatMap((m) => m.toolCalls ?? []) ?? [];
      const target = assertion.value.toLowerCase();
      const completed = toolCalls.some((t) => {
        const name = t.name?.toLowerCase() ?? '';
        if (name !== 'task') return false;
        const argText = JSON.stringify(t.args ?? '').toLowerCase();
        if (target && !argText.includes(target)) return false;
        const result = typeof t.result === 'string' ? t.result : '';
        return result.includes('state="completed"');
      });
      return {
        passed: completed,
        evidence: completed
          ? undefined
          : `no completed task tool call${target ? ` targeting "${assertion.value}"` : ''} in transcript`,
      };
    }

    case 'cost_under': {
      const agentTokens = transcript?.agentTokens ?? {};
      try {
        const spec = JSON.parse(assertion.value) as
          | { agent?: string; max: number }
          | number;
        const max = typeof spec === 'number' ? spec : spec.max;
        const total = Object.entries(agentTokens)
          .filter(([agent]) =>
            typeof spec !== 'number' && spec.agent
              ? agent.toLowerCase() === spec.agent.toLowerCase()
              : true,
          )
          .reduce((s, [, u]) => s + (u.cost ?? 0), 0);
        const passed = total <= max;
        return {
          passed,
          evidence: passed
            ? undefined
            : `total cost $${total.toFixed(4)} exceeded cap $${max}`,
        };
      } catch {
        return {
          passed: false,
          evidence: 'cost_under: invalid value format',
        };
      }
    }

    case 'model_switches': {
      const count = transcript?.modelSwitches?.length ?? 0;
      const max = Number(assertion.value);
      const passed = Number.isFinite(max) && count <= max;
      return {
        passed,
        evidence: passed
          ? undefined
          : `model switched ${count} times (max ${assertion.value})`,
      };
    }

    case 'file_exists': {
      if (!assertion.filePath) {
        return {
          passed: false,
          evidence: 'file_exists requires filePath to be set',
        };
      }
      const filePath = resolve(REPO_ROOT, assertion.filePath);
      const exists = existsSync(filePath);
      return {
        passed: exists,
        evidence: exists
          ? undefined
          : `file_exists: "${assertion.filePath}" does not exist`,
      };
    }

    case 'agent_invocations_count': {
      const count = transcript?.agentInvocations?.length ?? 0;
      try {
        const expected = JSON.parse(assertion.value) as
          | { min?: number; max?: number }
          | number;
        if (typeof expected === 'number') {
          return {
            passed: count === expected,
            evidence:
              count === expected
                ? undefined
                : `agent_invocations_count: expected ${expected}, got ${count}`,
          };
        }
        const min = expected.min ?? 0;
        const max = expected.max ?? Infinity;
        const passed = count >= min && count <= max;
        return {
          passed,
          evidence: passed
            ? undefined
            : `agent_invocations_count: expected ${assertion.value}, got ${count}`,
        };
      } catch {
        return {
          passed: false,
          evidence: 'agent_invocations_count: invalid value format',
        };
      }
    }

    default:
      return { passed: false, evidence: `unknown assertion type` };
  }
}
