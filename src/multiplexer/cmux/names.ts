/**
 * cmux display-name derivation.
 *
 * The tab name set at creation is `parent_name/child_name`:
 * - `parent_name` is the parent tab's `name`, or `Agent<selfPid>` when the
 *   tab has none (the pid is this client process, which carries the parent
 *   view — zero extra reads);
 * - `child_name` is `<subagentType>:<token>`, where `token` is the last at
 *   most five characters of the child session id (never padded, never
 *   reused). The child session id is known before the spawn and is stable
 *   for the lifetime of the session.
 *
 * The name is human-facing only. The crash sweep identifies plugin views
 * through the `omosc:<pid>:<childSessionId>` data marker inside the launch
 * argv, never through this name, so a bounded token collision only costs
 * readability. Tab indices are deliberately never used: a user closing a tab
 * shifts them, which would produce duplicate names.
 */

/** Longest allowed child-name token (the session-id suffix). */
export const CHILD_TOKEN_LENGTH = 5;

/** Child-name agent-type fallback when the session has none. */
const FALLBACK_SUBAGENT_TYPE = 'subagent';

/**
 * Strips C0/C1 control characters so a display name can never smuggle
 * terminal escape sequences or line breaks into the tab bar.
 */
function stripControlCharacters(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control) cleaned += char;
  }
  return cleaned;
}

/** Last at most `maxLength` characters of a session id (no padding). */
export function shortToken(
  sessionId: string,
  maxLength: number = CHILD_TOKEN_LENGTH,
): string {
  if (maxLength <= 0) return '';
  return sessionId.slice(-maxLength);
}

/** `parent_name`: the parent tab name, or `Agent<selfPid>` when empty. */
export function parentName(
  tabName: string | null | undefined,
  selfPid: number,
): string {
  const name =
    typeof tabName === 'string' ? stripControlCharacters(tabName) : '';
  return name.length > 0 ? name : `Agent${selfPid}`;
}

/** `child_name`: `<subagentType|subagent>:<session-id suffix>`. */
export function childName(
  subagentType: string | null | undefined,
  childSessionId: string,
): string {
  const cleaned =
    typeof subagentType === 'string'
      ? stripControlCharacters(subagentType)
      : '';
  const type = cleaned.length > 0 ? cleaned : FALLBACK_SUBAGENT_TYPE;
  const token = stripControlCharacters(shortToken(childSessionId));
  return `${type}:${token}`;
}

/** Final `parent_name/child_name` tab name. */
export function displayName(parent: string, child: string): string {
  return `${parent}/${child}`;
}
