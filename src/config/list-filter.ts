/**
 * The shared `"*"` / `"!name"` list syntax: an entry without a leading `!`
 * allows, `!name` denies, `"*"` covers every available name, and `"!*"` denies
 * everything. Agent `skills` / `mcps` lists and the multiplexer pane filter all
 * speak it.
 */

export interface ListFilter {
  allow: readonly string[];
  deny: readonly string[];
}

/** Splits a filter list into its allow and deny halves (deny drops the `!`). */
export function splitListFilter(items: readonly string[]): ListFilter {
  return {
    allow: items.filter((item) => !item.startsWith('!')),
    deny: items
      .filter((item) => item.startsWith('!'))
      .map((item) => item.slice(1)),
  };
}

/**
 * Whether one name passes the filter. A name that cannot be read never passes
 * an explicit allow list: only a wildcard-inclusive filter covers it.
 */
export function matchesListFilter(
  name: string | undefined,
  { allow, deny }: ListFilter,
): boolean {
  if (deny.includes('*')) return false;
  if (name === undefined) return allow.includes('*');
  if (allow.includes('*')) return !deny.includes(name);
  return allow.includes(name) && !deny.includes(name);
}
