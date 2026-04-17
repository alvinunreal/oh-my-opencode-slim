import { sanitizeTitle } from '../../tools/grep/path-utils';

const FILE_SUMMARY_RE = /^Found (\d+) matching file(?:s)?\.$/;
const MATCH_SUMMARY_RE =
  /^Found (\d+)(?: total)? match(?:es)? across (\d+) file(?:s)?\.$/;
const NO_RESULTS_RE = /^(?:No matches found\.|No files found\.|No visible (?:results|files) were collected before the search stopped\.)$/;
const MTIME_NO_VISIBLE_RE =
  /^(?:mtime (?:sorting|replay|discovery) could not produce visible results after discovering \d+ candidate file(?:s)?\.|Search stopped during mtime (?:sorting|replay|discovery) after discovering \d+ candidate file(?:s)? before replay produced visible results\.)$/;

interface ToolExecuteAfterInput {
  tool: string;
  args?: {
    pattern?: unknown;
  };
}

interface ToolExecuteAfterOutput {
  title?: unknown;
  output: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseGrepSummary(output: string): {
  matches: number;
  files: number;
} | null {
  const lines = output.split(/\r?\n/, 6);
  for (const line of lines) {
    const fileMatch = FILE_SUMMARY_RE.exec(line);
    if (fileMatch) {
      const files = Number.parseInt(fileMatch[1] ?? '0', 10);
      return { matches: files, files };
    }

    const matchSummary = MATCH_SUMMARY_RE.exec(line);
    if (matchSummary) {
      return {
        matches: Number.parseInt(matchSummary[1] ?? '0', 10),
        files: Number.parseInt(matchSummary[2] ?? '0', 10),
      };
    }
  }

  const firstLine = lines.find((line) => line.length > 0);
  if (firstLine && (NO_RESULTS_RE.test(firstLine) || MTIME_NO_VISIBLE_RE.test(firstLine))) {
    return { matches: 0, files: 0 };
  }

  return null;
}

export function createGrepRenderMetadataHook() {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'grep') return;
      if (typeof output.output !== 'string') return;

      const counts = parseGrepSummary(output.output);
      const metadata = isRecord(output.metadata) ? output.metadata : {};
      if (counts) {
        metadata.matches = counts.matches;
        metadata.files = counts.files;
      }
      output.metadata = metadata;

      if (
        (typeof output.title !== 'string' || output.title.length === 0) &&
        typeof input.args?.pattern === 'string' &&
        input.args.pattern.length > 0
      ) {
        output.title = sanitizeTitle(input.args.pattern);
      }
    },
  };
}
