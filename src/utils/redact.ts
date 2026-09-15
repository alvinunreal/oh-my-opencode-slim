/**
 * Shape-based secret redaction, applied at the logger compose point
 * (src/utils/logger.ts) so every sink — file, stderr, and the append-
 * failure fallback — emits redacted entries, plus (for ordering
 * semantics only) at the parse-miss preview call site in
 * task-session-manager/tool-execute-hooks.ts.
 *
 * A second, stricter mode — maskTaskOutputStructure, below — provides
 * structure-only disclosure for untrusted-format previews (the
 * parse-miss site): field/tag names survive, values are NEVER disclosed
 * there, not even partially.
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

// ── Structure-preserving value masking (parse-miss previews) ──────────
//
// Structure-only disclosure for untrusted-format content: tag and field
// NAMES survive (enough to diagnose host output drift), but every VALUE
// is fully hidden behind the literal [masked] placeholder — including
// benign-looking ones, because values (description fields in particular)
// carry orchestrator/user-authored text. The placeholder is deliberately
// distinct from the partial-keep `…` convention above: this site never
// discloses value bytes at all.

const MASKED_PLACEHOLDER = '[masked]';

/** A well-formed XML-ish tag: `<name attr=value ...>` or `<name/>`.
 * Attribute values may be double-quoted, single-quoted, or unquoted
 * (unquoted values stop at `/` so a self-closing `/>` marker is not
 * swallowed). Anything that does not parse as name + attribute pairs
 * (no closing `>`, stray `=`/quotes) does not match and is left to the
 * prose pass. */
const XML_TAG_PATTERN =
  /<[A-Za-z][\w.-]*(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>/=]+))*\s*\/?>/g;

/** One `name="value"` / `name='value'` / `name=value` pair inside a
 * matched tag (unquoted values stop at `/` for the same reason). */
const XML_ATTR_PATTERN = /([\w:.-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'<>/=]+)/g;

/** Prose key-value token: `key: value` / `key=value`. The key is a
 * word/hyphen run; URL schemes are excluded both ways — a key followed
 * by `://` is a scheme (`postgres://…`), and a key preceded by `/` is a
 * URL authority component (`…//deploy:password@…`) — so URL credentials
 * stay intact for the precise redactSecretsForLog URL rule instead of
 * being blunt-masked here. The value run stops at common punctuation
 * delimiters so surrounding prose (parens, sentence ends) survives. */
const KEY_VALUE_PATTERN =
  /(?<!\/)\b([\w-]+)(\s*[:=]\s*)(?!\/\/)([A-Za-z0-9_\-/.+=:@~]+)/g;

function maskXmlAttribute(
  _match: string,
  name: string,
  eq: string,
  value: string,
): string {
  if (value.startsWith('"')) return `${name}${eq}"${MASKED_PLACEHOLDER}"`;
  if (value.startsWith("'")) return `${name}${eq}'${MASKED_PLACEHOLDER}'`;
  return `${name}${eq}${MASKED_PLACEHOLDER}`;
}

/**
 * Structure-preserving value masking for untrusted-format task output
 * previews: XML-ish tags keep tag + attribute names with every attribute
 * value replaced by `[masked]`; prose `key:`/`key=` tokens keep the key
 * and mask the value run; everything else passes through
 * redactSecretsForLog (vendor/generic/URL-credential rules still apply
 * to free text). Deterministic — no wall-clock or randomness.
 */
export function maskTaskOutputStructure(input: string): string {
  const xmlMasked = input.replace(XML_TAG_PATTERN, (tag) =>
    tag.replace(XML_ATTR_PATTERN, maskXmlAttribute),
  );
  const kvMasked = xmlMasked.replace(
    KEY_VALUE_PATTERN,
    (_match, key: string, eq: string) => `${key}${eq}${MASKED_PLACEHOLDER}`,
  );
  return redactSecretsForLog(kvMasked);
}
