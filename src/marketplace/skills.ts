export interface MarketplaceSkillRequirements {
  readonly packageId: string;
  readonly skills: readonly string[];
}

export function missingMarketplaceSkills(
  requirements: readonly MarketplaceSkillRequirements[],
  available: readonly string[],
): string[] {
  const names = new Set(available);
  return requirements.flatMap(({ packageId, skills }) =>
    skills
      .filter((skill) => !names.has(skill))
      .map((skill) => `${packageId}: ${skill}`),
  );
}

export function skillIdsFromResponse(
  response: unknown,
  key: 'name' | 'id',
): string[] {
  const items = Array.isArray(response)
    ? response
    : response && typeof response === 'object' && 'data' in response
      ? response.data
      : undefined;
  if (
    !Array.isArray(items) ||
    items.some(
      (item) =>
        !item || typeof item !== 'object' || typeof item[key] !== 'string',
    )
  ) {
    throw new Error('Could not verify the native skill inventory');
  }
  return items.map((item) => item[key] as string);
}
