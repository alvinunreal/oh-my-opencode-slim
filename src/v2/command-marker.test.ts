import { describe, expect, test } from 'bun:test';
import {
  type CommandMarkerKit,
  createCommandMarkerKit,
} from './command-marker';

/** Mirrors the generic marker configuration in ./setup.ts. */
const commandMarker: CommandMarkerKit = createCommandMarkerKit({
  tag: 'omos-cmd-command',
  nameAttribute: 'data-name',
  namePattern: '[\\w.-]+',
});

/** Mirrors the interview marker configuration in ./interview-bridge.ts. */
const interviewMarker: CommandMarkerKit = createCommandMarkerKit({
  tag: 'omos-interview-command',
  trimArgs: true,
});

/** Pinned pattern bytes — stored transcripts carry these markers, so the
 * regex sources must never drift. */
const COMMAND_MARKER_PATTERN_SOURCE =
  String.raw`^\s*<omos-cmd-command\s+data-name="([\w.-]+)">` +
  String.raw`([\s\S]*?)<\/omos-cmd-command>\s*$`;
const INTERVIEW_MARKER_PATTERN_SOURCE =
  String.raw`^\s*<omos-interview-command>\s*([\s\S]*?)` +
  String.raw`\s*<\/omos-interview-command>\s*$`;

describe('createCommandMarkerKit', () => {
  test('assembles the pinned pattern sources byte-for-byte', () => {
    expect(commandMarker.pattern.source).toBe(COMMAND_MARKER_PATTERN_SOURCE);
    expect(interviewMarker.pattern.source).toBe(
      INTERVIEW_MARKER_PATTERN_SOURCE,
    );
  });

  test('wrap renders the exact marker shapes', () => {
    expect(commandMarker.wrap({ name: 'deepwork', args: 'focus' })).toBe(
      '<omos-cmd-command data-name="deepwork">focus</omos-cmd-command>',
    );
    expect(commandMarker.wrap({ name: 'loop', args: '' })).toBe(
      '<omos-cmd-command data-name="loop"></omos-cmd-command>',
    );
    expect(interviewMarker.wrap({ args: 'build a notes app' })).toBe(
      '<omos-interview-command>build a notes app</omos-interview-command>',
    );
    expect(interviewMarker.wrap({ args: '' })).toBe(
      '<omos-interview-command></omos-interview-command>',
    );
    // Name-less markers ignore a stray name.
    expect(interviewMarker.wrap({ name: 'ignored', args: 'x' })).toBe(
      '<omos-interview-command>x</omos-interview-command>',
    );
  });

  test('round-trips wrap → parse → strip (generic marker)', () => {
    for (const args of ['', 'focus 25m', 'line one\nline two\nline three']) {
      const text = commandMarker.wrap({ name: 'deepwork', args });
      expect(commandMarker.parse(text)).toEqual({ name: 'deepwork', args });
      expect(commandMarker.strip(text)).toBe(args);
    }
    for (const name of ['git_commit', 'Task.v2', 'deepwork', 'a-b-c']) {
      const text = commandMarker.wrap({ name, args: 'x' });
      expect(commandMarker.parse(text)).toEqual({ name, args: 'x' });
    }
  });

  test('round-trips wrap → parse → strip (interview marker)', () => {
    for (const args of ['', 'build a notes app', 'line one\nline two']) {
      const text = interviewMarker.wrap({ args });
      expect(interviewMarker.parse(text)).toEqual({ args });
      expect(interviewMarker.strip(text)).toBe(args);
    }
  });

  test('wrap never expands $-sequences in args (byte-exact)', () => {
    // A string replacer would turn $$ into $, $& into the whole match,
    // $` into the preceding text, and $1 into a capture.
    expect(commandMarker.wrap({ name: 'loop', args: 'pay $$ now' })).toBe(
      '<omos-cmd-command data-name="loop">pay $$ now</omos-cmd-command>',
    );
    expect(interviewMarker.wrap({ args: 'a $& b $` $$ $1 c' })).toBe(
      '<omos-interview-command>a $& b $` $$ $1 c</omos-interview-command>',
    );
  });

  test('strip keeps $-sequences byte-exact (function replacer)', () => {
    const args = 'a $& b $` $$ $1 c';
    const commandText = commandMarker.wrap({ name: 'loop', args });
    expect(commandMarker.strip(commandText)).toBe(args);
    expect(interviewMarker.strip(interviewMarker.wrap({ args }))).toBe(args);
  });

  test('whole-text anchored: embedded markers never parse or strip', () => {
    const commandText = commandMarker.wrap({ name: 'reflect', args: 'a b' });
    const embeddedCommand = `look at ${commandText} please`;
    expect(commandMarker.parse(embeddedCommand)).toBeUndefined();
    expect(commandMarker.strip(embeddedCommand)).toBe(embeddedCommand);

    const interviewText = interviewMarker.wrap({ args: 'hijack' });
    const embeddedInterview = `before ${interviewText} after`;
    expect(interviewMarker.parse(embeddedInterview)).toBeUndefined();
    expect(interviewMarker.strip(embeddedInterview)).toBe(embeddedInterview);
  });

  test('whole-text anchored: surrounding whitespace is tolerated', () => {
    const commandText = commandMarker.wrap({ name: 'reflect', args: 'a b' });
    expect(commandMarker.parse(`  \n${commandText}\n  `)).toEqual({
      name: 'reflect',
      args: 'a b',
    });
    const interviewText = interviewMarker.wrap({ args: 'idea' });
    expect(interviewMarker.parse(` \t${interviewText}\t `)).toEqual({
      args: 'idea',
    });
  });

  test('non-greedy bodies recover closing-tag look-alikes', () => {
    // The lazy capture plus the `$` anchor extend over a closing-tag
    // substring inside the body, so the full args round-trip.
    const commandArgs = 'a</omos-cmd-command>b\nline two';
    const commandText = commandMarker.wrap({ name: 'loop', args: commandArgs });
    expect(commandMarker.parse(commandText)).toEqual({
      name: 'loop',
      args: commandArgs,
    });

    const interviewArgs = 'a</omos-interview-command>b';
    const interviewText = interviewMarker.wrap({ args: interviewArgs });
    expect(interviewMarker.parse(interviewText)).toEqual({
      args: interviewArgs,
    });
  });

  test('trimArgs knob: raw capture vs whitespace trimmed inside the tags', () => {
    // Generic marker (trimArgs off): args are captured raw.
    const raw =
      '<omos-cmd-command data-name="loop">  padded  </omos-cmd-command>';
    expect(commandMarker.parse(raw)).toEqual({
      name: 'loop',
      args: '  padded  ',
    });
    expect(commandMarker.strip(raw)).toBe('  padded  ');

    // Interview marker (trimArgs on): whitespace inside the tags is
    // tolerated and trimmed from the capture.
    const trimmed =
      '<omos-interview-command>  padded  </omos-interview-command>';
    expect(interviewMarker.parse(trimmed)).toEqual({ args: 'padded' });
    expect(interviewMarker.strip(trimmed)).toBe('padded');
  });

  test('returns undefined without a marker (kinds never cross-match)', () => {
    expect(commandMarker.parse('plain user text')).toBeUndefined();
    expect(interviewMarker.parse('plain user text')).toBeUndefined();
    expect(
      commandMarker.parse(interviewMarker.wrap({ args: 'x' })),
    ).toBeUndefined();
    expect(
      interviewMarker.parse(commandMarker.wrap({ name: 'x', args: 'y' })),
    ).toBeUndefined();
  });
});
