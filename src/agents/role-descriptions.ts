import type { SpecialistRole } from '../config/agent-roles';

/** Dispatch guidance passed to the host as agent.description. */
export const SPECIALIST_DESCRIPTIONS: Readonly<Record<SpecialistRole, string>> =
  {
    explorer:
      'Read-only codebase recon, parallel searches, official docs, current APIs and tricky bugs. Do known-file reads and use facts already in context directly.',
    oracle:
      'Escalate major architecture, high-risk trade-offs, simplification, or debugging after two failed fixes. Not for routine verification.',
    designer:
      'Delegate all UI/UX: layout, hierarchy, motion, styling and responsive behavior. Review user-facing copy separately without changing visuals.',
    fixer:
      'Use for bounded multi-file or mechanical edits. Not for investigation, design judgment, small clear fixes, or context-heavy writing.',
    observer:
      'Analyze images, PDFs or diagrams, not plain text. Send the full file path and goal; requires a vision-capable model.',
  };
