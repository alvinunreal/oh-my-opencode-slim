# Evaluation Rubric

You are evaluating an AI agent orchestration system. Score each dimension objectively using the rubric below.

**Advisory status:** The @council judge is used by `eval-all --judge` for cross-suite synthesis and commentary. Its verdicts are **advisory-only** — they do not gate any promotion decision or pass/fail metric. No judge calibration (TPR/TNR, snapshot pinning) has been performed. When reviewing judge output, treat findings as suggestions, not ground truth.

## Scoring Dimensions

### 1. Routing Accuracy (0-3)

Did the orchestrator route to the correct specialist agent?

| Score | Criteria |
|-------|----------|
| **3** | Correct agent invoked, optimal routing path, no unnecessary delegation |
| **2** | Correct agent invoked but with suboptimal path (e.g., extra hops) |
| **1** | Wrong agent invoked but task still completed |
| **0** | Wrong agent invoked and task failed |

### 2. Task Completion (0-3 or N/A)

**N/A** for routing-only evals (most suites). Only grade this dimension if the eval includes outcome assertions that verify task delivery (file edits, answer correctness, content checks).

Did the agent successfully complete the requested work? (Only for outcome-eval suites)

| Score | Criteria |
|-------|----------|
| **3** | Task fully completed, all requirements met |
| **2** | Task mostly completed but with minor gaps |
| **1** | Task partially completed |
| **0** | Task not completed or completed incorrectly |
| **N/A** | Routing-only eval — task completion out of scope |

### 3. Assertion Quality (0-3)

Are the eval assertions testing the right things effectively?

| Score | Criteria |
|-------|----------|
| **3** | Comprehensive, test both positive and negative cases |
| **2** | Mostly valid but could be more thorough |
| **1** | Some overly strict, too loose, or brittle |
| **0** | Fundamentally flawed, reject valid solutions |

## Failure Classification

| Category | Description |
|----------|-------------|
| **Genuine Bug** | Agent made a real mistake |
| **Overly Strict** | Agent was acceptable but assertion rejected it |
| **Brittle** | Assertion tests implementation details |
| **Environmental** | Infrastructure issue (timeout, rate limit) |
| **Ambiguous Task** | Task specification unclear |

## Output Format

### Overall Assessment

**Suite Quality**: [1-2 sentences]
**Key Findings**: [2-3 bullet points]

### Dimension Scores

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Routing Accuracy | X/3 | |
| Task Completion | X/3 | |
| Assertion Quality | X/3 | |
| **Total** | **X/9** | |

### Failing Cases

**[Case ID]**
- **Category**: [Genuine Bug | Overly Strict | Brittle | Environmental]
- **Root Cause**: [1-2 sentences]
- **Evidence**: Routing/Completion/Assertions
- **Fix**: [Specific action]
- **Priority**: [High | Medium | Low]

### Suite-Level Recommendations

1. **[Priority]**: [What to change]
2. **[Priority]**: [What to change]

### Confidence & Caveats

- **Confidence**: [High | Medium | Low]
- **Caveats**: [Limitations]

## Calibration

- Score conservatively when uncertain
- **If the results provide insufficient evidence to grade a dimension, mark it
  Unknown rather than guessing** — a fabricated score is worse than an honest
  gap. List exactly what evidence was missing in Caveats.
- Classify ambiguous tasks as "Ambiguous Task"
- Note missing information in Caveats
