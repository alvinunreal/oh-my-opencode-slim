function cleanupAlias(input: string, preserveSlash: boolean): string {
  let value = input.toLowerCase().trim();
  value = value.replace(/\bfp[a-z0-9.-]*\b/g, ' ');
  value = value.replace(/\btee\b/g, ' ');

  if (preserveSlash) {
    value = value.replace(/[_\s]+/g, '-');
    value = value.replace(/-+/g, '-');
    value = value.replace(/\/+/g, '/');
    value = value.replace(/\/-+/g, '/');
    value = value.replace(/-+\//g, '/');
    value = value.replace(/^\/+|\/+$/g, '');
    value = value.replace(/^-+|-+$/g, '');
    return value;
  }

  value = value.replace(/[/_\s]+/g, '-');
  value = value.replace(/-+/g, '-');
  value = value.replace(/^-+|-+$/g, '');
  return value;
}

function addDerivedAliases(seed: string, aliases: Set<string>): void {
  const slashAlias = cleanupAlias(seed, true);
  const flatAlias = cleanupAlias(seed, false);

  if (slashAlias) aliases.add(slashAlias);
  if (flatAlias) aliases.add(flatAlias);

  if (slashAlias) {
    aliases.add(slashAlias.replace(/-(free|flash)$/i, ''));
  }
  if (flatAlias) {
    aliases.add(flatAlias.replace(/-(free|flash)$/i, ''));
  }

  if (slashAlias.includes('/')) {
    aliases.add(cleanupAlias(slashAlias.replace(/\//g, ' '), false));
    aliases.add(cleanupAlias(slashAlias.replace(/\//g, '-'), false));
    const lastPart = slashAlias.split('/').at(-1);
    if (lastPart) {
      addDerivedAliases(lastPart, aliases);
    }
  }
}

export function buildModelKeyAliases(input: string): string[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return [];

  const aliases = new Set<string>();
  const slashIndex = normalized.indexOf('/');
  const afterProvider =
    slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;

  addDerivedAliases(normalized, aliases);
  addDerivedAliases(afterProvider, aliases);

  return [...aliases].filter((alias) => alias.length > 0);
}
