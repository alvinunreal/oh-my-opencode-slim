/**
 * Shared whole-text-anchored command-marker machinery for the v2 adapter.
 *
 * v2 command drafts are add-only (no `template`), so a registered command's
 * `execute` submits its marker as the ENTIRE user prompt and the merged
 * session context hook recovers it from the trailing message. Two marker
 * kinds exist, both produced by this factory:
 *
 * - generic commands: `<omos-cmd-command data-name="…">…</omos-cmd-command>`
 *   (deepwork / reflect / loop — see ./setup.ts)
 * - the interview command: `<omos-interview-command>…</omos-interview-command>`
 *   (see ./interview-bridge.ts)
 *
 * Compatibility contract (stored transcripts carry these markers — do not
 * regress; the pattern sources are pinned by ./command-marker.test.ts):
 *
 * - The wire format is byte-identical to the pre-unification
 *   implementations.
 * - The pattern is whole-text anchored (tolerating surrounding whitespace):
 *   v2 writes the marker as the whole submitted prompt, so whole-text
 *   anchoring is the dispatch contract, and a user-typed embedded marker
 *   must not hijack dispatch in the merged session context hook.
 * - `wrap` renders args byte-exact: `$`-sequences in args are never
 *   expanded.
 * - `strip` replaces via a function replacer so `$`-sequences in the
 *   captured args survive rewriting.
 * - Marker dispatch must mutate ONLY the trailing message; earlier
 *   messages stay byte-for-byte identical (provider prompt-cache prefix
 *   reuse — see AGENTS.md "Prompt Cache Safety").
 */

/** Payload parsed from (or rendered into) a command marker. */
export interface CommandMarker {
  /** Command name carried in the marker's attribute; `undefined` for
   * name-less markers. */
  readonly name?: string;
  /** Marker body. Multi-line allowed; the non-greedy capture with the `$`
   * anchor recovers bodies containing closing-tag look-alikes. */
  readonly args: string;
}

/** Kit configuration. Each knob maps to one fixed pattern segment, so a
 * given configuration always assembles the same pattern source. */
export interface CommandMarkerConfig {
  /** Marker element tag (`omos-cmd-command`). */
  readonly tag: string;
  /** Attribute whose quoted value carries the command name (`data-name`).
   * Omit for name-less markers. */
  readonly nameAttribute?: string;
  /** Charset the name attribute value must match (e.g. `[\w.-]+`).
   * Defaults to a non-empty run without quotes. */
  readonly namePattern?: string;
  /** Tolerate (and trim) whitespace between the tags and the args
   * capture — the interview marker's shape. Off by default: the generic
   * marker captures args raw. */
  readonly trimArgs?: boolean;
}

/** One parameterized command-marker kit. */
export interface CommandMarkerKit {
  /** Whole-text-anchored marker pattern — the single source shared by
   * `parse` and `strip`. */
  readonly pattern: RegExp;
  /** Render the marker text. Byte-exact: `$`-sequences in `args` (and in
   * the name) are never expanded. */
  readonly wrap: (marker: CommandMarker) => string;
  /** Parse the marker from a message text, if the text IS the marker
   * (whole-text anchor); otherwise `undefined`. */
  readonly parse: (text: string) => CommandMarker | undefined;
  /** Replace a marker-only `text` with its raw args; a no-op on any other
   * text (anchored pattern). */
  readonly strip: (text: string) => string;
}

/** Lazy body capture shared by every marker kind (non-greedy, multi-line). */
const ARGS_PATTERN = '([\\s\\S]*?)';

export function createCommandMarkerKit(
  config: CommandMarkerConfig,
): CommandMarkerKit {
  const tag = config.tag;
  const attribute = config.nameAttribute ?? '';
  const hasName = config.nameAttribute !== undefined;
  const namePattern = config.namePattern ?? '[^"]+';
  // Head segment between `<tag` and the args capture: named markers carry
  // `\s+attr="(charset)">`; name-less markers close the open tag directly.
  const head = hasName ? String.raw`\s+${attribute}="(${namePattern})">` : '>';
  // Inner padding around the args capture (interview marker only).
  const pad = config.trimArgs ? String.raw`\s*` : '';
  const source =
    String.raw`^\s*<${tag}` +
    head +
    pad +
    ARGS_PATTERN +
    pad +
    String.raw`<\/${tag}>\s*$`;
  const pattern = new RegExp(source);
  // Capture indices: group 1 is the name when present; the args group is
  // always the last one.
  const argsIndex = hasName ? 2 : 1;

  return {
    pattern,
    wrap: ({ name, args }) =>
      hasName
        ? `<${tag} ${attribute}="${name ?? ''}">${args}</${tag}>`
        : `<${tag}>${args}</${tag}>`,
    parse: (text) => {
      const match = text.match(pattern);
      if (!match) return undefined;
      return hasName
        ? { name: match[1], args: match[argsIndex] }
        : { args: match[argsIndex] };
    },
    strip: (text) =>
      // Function replacer: a string replacer would interpret
      // `$`-sequences in the captured args.
      text.replace(pattern, (...groups: string[]) => groups[argsIndex]),
  };
}
