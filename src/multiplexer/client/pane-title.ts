/**
 * Pane-title metadata for the FR-8 crash-leftover sweep (task 3.8).
 *
 * A created pane's title encodes the owning client pid and the child session
 * id: `omosc:<pid>:<childSessionId>`. The sweep reads titles back from the
 * multiplexer, parses them and closes leftovers whose owner is dead and whose
 * child session is gone.
 *
 * NFR-5: the title is data. Parsing is strict (exact shape only) so a user
 * pane title can never be mistaken for ours, and no parsed field is ever
 * interpreted as an executable instruction — the only value handed to a
 * multiplexer command is the pane id read from the multiplexer itself.
 */

/** Fixed title prefix identifying plugin-owned panes. */
export const PANE_TITLE_PREFIX = 'omosc';

/** Parsed metadata of one plugin-owned pane title. */
export interface PaneTitleMetadata {
  ownerPid: number;
  childSessionId: string;
}

/**
 * Session ids are opaque `ses_*` strings; the charset gate keeps the parser
 * strict without assuming a length. Anything outside this charset is user
 * data and must be skipped.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_PATTERN = /^omosc:(\d{1,10}):([A-Za-z0-9_-]{1,64})$/;

/** Encodes owner pid + child session id as pane-title metadata. */
export function encodePaneTitle(
  ownerPid: number,
  childSessionId: string,
): string {
  return `${PANE_TITLE_PREFIX}:${ownerPid}:${childSessionId}`;
}

/**
 * Strictly parses a plugin-owned pane title. Returns null for every
 * non-matching (user) title, malformed pid, or malformed session id.
 */
export function parsePaneTitle(
  title: string | null | undefined,
): PaneTitleMetadata | null {
  if (typeof title !== 'string') return null;
  const match = TITLE_PATTERN.exec(title);
  if (!match) return null;

  const ownerPid = Number(match[1]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;

  const childSessionId = match[2];
  if (!SESSION_ID_PATTERN.test(childSessionId)) return null;

  return { ownerPid, childSessionId };
}
