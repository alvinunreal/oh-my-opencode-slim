/**
 * The activation message's head announcement. Pure constant so the
 * deepwork-goal hook (always loaded) can read it without importing the
 * deepwork command module (which bundles SKILL.md at build time).
 * Single owner: `../index.ts` re-exports it for existing callers.
 */
export function routerHeadAnnouncement(sessionID: string): string {
  return `Your deepwork router head is \`.slim/deepwork/${sessionID}.md\`; the skill covers setup, planning, gates, and state rules.`;
}
