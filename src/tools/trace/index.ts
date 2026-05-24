import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { isTraceStale, regenerateTrace } from './io';

const z = tool.schema;

const DEFAULT_SPEC_DIR = 'docs/spec';

export function createTraceTool(
  _ctx: PluginInput,
): Record<string, ToolDefinition> {
  const trace_regenerate = tool({
    description: `Regenerate docs/spec/trace.md from requirements.md and design.md.

Scans REQ-* headings in requirements.md and DES-* headings + "Rationale anchor:" lines in design.md, then writes a fresh REQ→DES mapping table to trace.md.

Heading format is strict: each REQ/DES heading MUST match "## REQ-<digits>:" or "## DES-<digits>:" (level-2, trailing colon required). Headings like "## REQ-1 title" without a colon are ignored and produce an empty trace table. Multi-REQ anchors must be comma-separated on a single "Rationale anchor:" line.

Use when entering execution and trace is stale, or after editing requirements/design.

Returns a short status message.`,
    args: {
      spec_dir: z
        .string()
        .optional()
        .describe(
          `Path to the spec directory containing requirements.md and design.md. Defaults to "${DEFAULT_SPEC_DIR}" relative to the current working directory.`,
        ),
      check_only: z
        .boolean()
        .optional()
        .describe('If true, only report whether trace is stale; do not write.'),
    },
    async execute(args) {
      const dir =
        typeof args.spec_dir === 'string' && args.spec_dir
          ? args.spec_dir
          : DEFAULT_SPEC_DIR;

      if (args.check_only) {
        const stale = isTraceStale(dir);
        return stale ? `trace stale in ${dir}` : `trace fresh in ${dir}`;
      }

      const result = regenerateTrace(dir);
      return `trace regenerated at ${result.path}`;
    },
  });

  return { trace_regenerate };
}
