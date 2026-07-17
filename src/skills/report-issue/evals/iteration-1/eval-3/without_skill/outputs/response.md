# Response: GitHub Issue (dry-run — not submitted)

**Would file with:**
```bash
gh issue create \
  --repo alvinunreal/oh-my-opencode-slim \
  --label bug \
  --title "Secret/API key leakage into plugin log + council tool returns garbled output" \
  --body "$(cat << 'BODY'
## Description

Two related bugs discovered during normal use:

### Bug 1: Secrets leak into plugin log file

The plugin logger (`src/utils/logger.ts`) writes all messages and structured data to disk **with zero sanitization or redaction**. If user-provided content containing an API key (e.g., a pasted `curl` command with `ANTHROPIC_API_KEY`) passes through any path that calls `log(message, data)`, the key is written in plaintext to:

```
~/.local/share/opencode/log/oh-my-opencode-slim.<sessionId>.log
```

Reproduction: paste a command containing an API key into the chat, have the orchestrator process it, and then inspect the plugin log file. The `log()` function at `src/utils/logger.ts:89` does:

```ts
const logEntry = `[${timestamp}] ${message} ${dataStr}\n`;
```

The `dataStr` is a `JSON.stringify` of the second argument with no filtering. While the logger isn't directly called with chat text, structured data objects logged alongside user-facing operations can capture sensitive strings that happen to be in scope.

### Bug 2: Council session tool returns garbled output

After the above interaction (API key in prompt context), the `council_session` tool returned garbled/unparseable output instead of the expected formatted councillor results.

The council tool (`src/tools/council.ts`) collects responses from parallel councillor sessions via `councilManager.runCouncil()` → `extractSessionResult()`. If any councillor session returns malformed content (potentially due to the API key string leaking into the session prompt or being interpreted by the provider), the extracted result gets concatenated without validation and returned as-is.

The root cause could be one of:
1. The API key string leaks into a councillor sub-session prompt through some path, causing the LLM to produce corrupted output
2. `extractSessionResult()` (`src/utils/session.ts:190`) has no validation of extracted content — it blindly joins all assistant text parts
3. The council formatting at `src/agents/council.ts` (`formatCouncillorResults`) assumes well-formed input from all councillors

## Impact

- **Security**: API keys stored in plaintext in log files (7-day retention per `src/utils/logger.ts:8`)
- **Reliability**: Council tool produces unusable output when prompts contain certain strings

## Environment

- oh-my-opencode-slim: latest
- OpenCode: latest
- OS: Linux

## Suggested Fix

### Logger (immediate security fix)
Add a redaction step to `src/utils/logger.ts` that scrubs common secret patterns (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `Authorization: Bearer`, etc.) from both `message` and `data` before writing. A simple regex replace on known patterns would cover the immediate risk:

```ts
const SENSITIVE_PATTERNS = [
  /(ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|TAVILY_API_KEY|EXA_API_KEY)=['"]?\S+['"]?/gi,
  /(Authorization:\s*Bearer\s+)\S+/gi,
];

function redact(input: string): string {
  return SENSITIVE_PATTERNS.reduce((s, re) => s.replace(re, '$1=****'), input);
}
```

### Council tool (reliability fix)
1. Add content validation in `extractSessionResult()` — detect and reject obviously malformed LLM responses
2. Add error boundaries in `formatCouncillorResults()` to handle unexpected councillor output gracefully
3. Log a structured warning when councillor output fails validation so the failure is observable without exposing content

## Labels

- `bug`
- (unlabeled → `needs-triage`)

## Related

- `src/utils/logger.ts` — no secret redaction
- `src/utils/session.ts` — `extractSessionResult()` no content validation
- `src/council/council-manager.ts` — orchestrates councillor sessions
- `src/tools/council.ts` — council_session tool implementation
BODY
)"
```

---

*↑ This is what I would submit. Stopped before actually running `gh issue create` as instructed.*
