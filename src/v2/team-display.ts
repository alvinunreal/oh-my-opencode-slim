import { AGENT_ALIASES } from '../config/constants';

function legacyCanonical(name: string): string {
  return Object.hasOwn(AGENT_ALIASES, name) ? AGENT_ALIASES[name] : name;
}

/** Registry-derived canonical→visible identities, not model/label similarity. */
export function createTeamDisplayIdentity(
  identities: Readonly<Record<string, string>> = {},
) {
  const owners = new Map<string, Set<string>>();
  for (const [name, display] of Object.entries(identities)) {
    const canonical = legacyCanonical(name);
    if (canonical === display) continue;
    const names = owners.get(display) ?? new Set<string>();
    names.add(canonical);
    owners.set(display, names);
  }
  const aliases = new Map<string, string>();
  for (const [display, names] of owners) {
    // Ambiguous labels cannot prove identity. Nor can a label that is itself
    // a distinct canonical agent with its own registered visible identity.
    if (
      names.size !== 1 ||
      (Object.hasOwn(identities, display) && identities[display] !== display)
    )
      continue;
    aliases.set(display, [...names][0]);
  }
  const canonicalName = (name: string): string => {
    const canonical = legacyCanonical(name);
    return aliases.get(canonical) ?? canonical;
  };
  return {
    canonicalName,
    projectValues<T>(values: Readonly<Record<string, T>>): Record<string, T> {
      const result = new Map<string, T>();
      for (const [name, value] of Object.entries(values)) {
        const canonical = canonicalName(name);
        // Canonical values win regardless of insertion order.
        if (name === canonical || !result.has(canonical)) {
          result.set(canonical, value);
        }
      }
      return Object.fromEntries(result);
    },
  };
}
