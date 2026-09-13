/**
 * Secret-shaped token redaction for plugin log previews.
 *
 * Plugin logs are collected into public GitHub issues by the report flow,
 * and tool outputs are untrusted-by-format: the parse-miss preview path
 * (task output without a parsable task id) logs raw host output, so any
 * secret-shaped token it happens to carry must be masked before it
 * reaches the log file. Masking keeps 4 leading + 2 trailing characters
 * (enough to identify the credential KIND and correlate occurrences)
 * and replaces the middle with an ellipsis.
 *
 * Deliberately cheap and shape-based (no heuristics about "suspicious"
 * context): known vendor prefixes first, then a generic long opaque-run
 * rule that catches high-entropy tokens of unknown scheme. Benign short
 * identifiers — session ids, short URLs, XML-ish task output structure —
 * pass through unchanged.
 */

/** Replace a masked token's middle, keeping 4 leading + 2 trailing chars. */
function maskToken(token: string): string {
  if (token.length <= 8) return '…';
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}

interface RedactionRule {
  pattern: RegExp;
  /** Extract the secret part to mask from the match (default: whole). */
  group?: number;
}

const REDACTION_RULES: RedactionRule[] = [
  // OpenAI-style API keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  // GitHub tokens (pat, oauth, user, server, refresh).
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g },
  // Slack tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  // AWS access key ids.
  { pattern: /\bAKIA[0-9A-Z]{12,}\b/g },
  // Bearer scheme: keep the scheme, mask the token.
  { pattern: /\bBearer\s+([A-Za-z0-9._-]{12,})/g, group: 1 },
  // Generic long opaque run (unknown vendor scheme, high-entropy blob).
  { pattern: /\b[A-Za-z0-9_\-/.+=]{32,}\b/g },
];

export function redactSecretsForLog(input: string): string {
  let output = input;
  for (const rule of REDACTION_RULES) {
    output = output.replace(rule.pattern, (match, ...rest) => {
      const secret = rule.group === undefined ? match : rest[rule.group - 1];
      if (typeof secret !== 'string' || secret.length === 0) return match;
      return rule.group === undefined
        ? maskToken(secret)
        : `${match.slice(0, match.length - secret.length)}${maskToken(secret)}`;
    });
  }
  return output;
}
