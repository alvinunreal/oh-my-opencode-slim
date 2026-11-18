/**
 * Shape-based secret redaction, applied at the logger compose point
 * (src/utils/logger.ts) so every sink — file, stderr, and the append-
 * failure fallback — emits redacted entries.
 *
 * Threat model — honest limits: this is a best-effort barrier against
 * ACCIDENTAL leaks in short log previews (a credential that rides along
 * in a tool-output preview, error message, or data blob). It is NOT an
 * adversarial guarantee. Residual gaps, documented: unprefixed secrets
 * shorter than the generic 32-char run rule; secrets containing
 * run-breaking characters (spaces, colons, quotes); and chunked or
 * obfuscated content that never forms one contiguous matchable token.
 *
 * Masking keeps 4 leading + 2 trailing characters (enough to identify
 * the credential KIND and correlate occurrences) and replaces the
 * middle with an ellipsis. Rules are deliberately cheap and shape-based
 * (no heuristics about "suspicious" context): known vendor prefixes
 * first, then authorization schemes and URL credentials, then a generic
 * long opaque-run rule that catches high-entropy tokens of unknown
 * scheme. Benign short identifiers — session ids, short URLs, XML-ish
 * task output structure — pass through unchanged; long opaque
 * non-secrets (UUIDs, hashes, long paths) are masked as an accepted
 * false positive.
 */

/** Replace a masked token's middle, keeping 4 leading + 2 trailing chars. */
function maskToken(token: string): string {
  if (token.length <= 8) return '…';
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}

interface RedactionRule {
  pattern: RegExp;
  /** Build the redacted replacement for one match of `pattern`. */
  replace: (match: string, groups: string[]) => string;
}

/** Default replacement: mask the whole match. */
function maskWhole(match: string): string {
  return maskToken(match);
}

const REDACTION_RULES: RedactionRule[] = [
  // OpenAI-style API keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: maskWhole },
  // GitHub tokens (pat, oauth, user, server, refresh).
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, replace: maskWhole },
  // GitLab personal access tokens.
  { pattern: /\bglpat-[A-Za-z0-9_-]{8,}\b/g, replace: maskWhole },
  // Slack tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, replace: maskWhole },
  // AWS access key ids and STS temporary credentials.
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g,
    replace: maskWhole,
  },
  // Authorization schemes: keep the scheme word, mask the credential.
  {
    pattern: /\b(?:Bearer|Basic|token|Token)\s+[A-Za-z0-9._+/=-]{8,}/g,
    replace: (match) => {
      const split = match.match(/^(\S+)(\s+)([\s\S]+)$/);
      if (!split) return maskWhole(match);
      return `${split[1]}${split[2]}${maskToken(split[3])}`;
    },
  },
  // URL credentials scheme://user:password@ — mask ONLY the password;
  // scheme://user@ without a password stays untouched.
  {
    pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:([^@\s]+)@/g,
    replace: (match, groups) =>
      groups.length === 0 || groups[0].length === 0
        ? maskWhole(match)
        : `${match.slice(0, match.length - groups[0].length - 1)}${maskToken(groups[0])}@`,
  },
  // Generic long opaque run (unknown vendor scheme, high-entropy blob).
  { pattern: /\b[A-Za-z0-9_\-/.+=]{32,}\b/g, replace: maskWhole },
];

export function redactSecretsForLog(input: string): string {
  let output = input;
  for (const rule of REDACTION_RULES) {
    output = output.replace(
      rule.pattern,
      (match: string, ...rest: unknown[]) => {
        // Replace-callback args: match, capture groups, offset, string.
        const groups = rest
          .slice(0, Math.max(rest.length - 2, 0))
          .map((group) => (typeof group === 'string' ? group : ''));
        return rule.replace(match, groups);
      },
    );
  }
  return output;
}
