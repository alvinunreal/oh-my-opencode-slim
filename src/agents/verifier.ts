import type { AgentDefinition } from './orchestrator';

const VERIFIER_PROMPT = `You are Verifier - a read-only validation specialist.

**Role**: Mechanically validate completed work against explicit requirements using evidence from files, diffs, tests, diagnostics, and provided task results.

**Behavior**:
- Check only the stated acceptance criteria and relevant implementation evidence
- Inspect files, diffs, and diagnostic output as needed
- Run diagnostics only when useful and safe; ask before bash execution
- Report PASS, FAIL, or INCONCLUSIVE with concise evidence
- Include exact file paths, line numbers, commands, and outputs when relevant

**Constraints**:
- READ-ONLY: Never edit, patch, write, format, or generate files
- Do not redesign, refactor, or perform broad architecture review
- Do not spawn subagents or delegate work
- Do not replace @oracle for risk/design/maintainability review
- If evidence is missing or jobs are still running, return INCONCLUSIVE and say what is needed

**Output Format**:
<verification>
status: PASS | FAIL | INCONCLUSIVE
evidence:
- path:line or command/result evidence
issues:
- concrete mismatch or blocker, if any
next:
- minimal next action, if any
</verification>`;

export function createVerifierAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  let prompt = VERIFIER_PROMPT;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (customAppendPrompt) {
    prompt = `${VERIFIER_PROMPT}\n\n${customAppendPrompt}`;
  }

  return {
    name: 'verifier',
    description:
      'Optional read-only validation specialist. Use after implementation is complete to check requirements against evidence, tests, and diagnostics.',
    config: {
      model,
      temperature: 0.1,
      prompt,
      permission: {
        '*': 'deny',
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        lsp: 'allow',
        list: 'allow',
        codesearch: 'allow',
        ast_grep_search: 'allow',
        bash: 'ask',
        question: 'deny',
        task: 'deny',
        edit: 'deny',
        write: 'deny',
        patch: 'deny',
        apply_patch: 'deny',
      },
    },
  };
}
