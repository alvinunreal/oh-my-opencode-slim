import { describe, expect, test } from 'bun:test';
import { createCommandMarkerKit } from './command-marker';
import { INTERVIEW_MARKER } from './interview-bridge';
import { COMMAND_MARKER } from './setup';

// The REAL configured kits from the two call sites — not mirror configs:
// every pin below fails loudly if a site config (tag / nameAttribute /
// namePattern / trimArgs) drifts. The marker bytes feed the trailing
// message rewrite, so drift must never pass CI silently.

/** Pinned pattern bytes — stored transcripts carry these markers, so the
 * regex sources must never drift. */
const COMMAND_MARKER_PATTERN_SOURCE =
  String.raw`^\s*<omos-cmd-command\s+data-name="([\w.-]+)">` +
  String.raw`([\s\S]*?)<\/omos-cmd-command>\s*$`;
const INTERVIEW_MARKER_PATTERN_SOURCE =
  String.raw`^\s*<omos-interview-command>\s*([\s\S]*?)` +
  String.raw`\s*<\/omos-interview-command>\s*$`;

describe('command marker kits (real configured instances)', () => {
  test('pin the configured pattern sources byte-for-byte', () => {
    expect(COMMAND_MARKER.pattern.source).toBe(COMMAND_MARKER_PATTERN_SOURCE);
    expect(INTERVIEW_MARKER.pattern.source).toBe(
      INTERVIEW_MARKER_PATTERN_SOURCE,
    );
  });

  test('wrap renders the exact marker shapes', () => {
    expect(COMMAND_MARKER.wrap({ name: 'deepwork', args: 'focus' })).toBe(
      '<omos-cmd-command data-name="deepwork">focus</omos-cmd-command>',
    );
    expect(COMMAND_MARKER.wrap({ name: 'loop', args: '' })).toBe(
      '<omos-cmd-command data-name="loop"></omos-cmd-command>',
    );
    expect(INTERVIEW_MARKER.wrap({ args: 'build a notes app' })).toBe(
      '<omos-interview-command>build a notes app</omos-interview-command>',
    );
    expect(INTERVIEW_MARKER.wrap({ args: '' })).toBe(
      '<omos-interview-command></omos-interview-command>',
    );
    // Name-less markers ignore a stray name.
    expect(INTERVIEW_MARKER.wrap({ name: 'ignored', args: 'x' })).toBe(
      '<omos-interview-command>x</omos-interview-command>',
    );
  });

  test('round-trips wrap → parse → strip (generic marker)', () => {
    for (const args of ['', 'focus 25m', 'line one\nline two\nline three']) {
      const text = COMMAND_MARKER.wrap({ name: 'deepwork', args });
      expect(COMMAND_MARKER.parse(text)).toEqual({ name: 'deepwork', args });
      expect(COMMAND_MARKER.strip(text)).toBe(args);
    }
    for (const name of ['git_commit', 'Task.v2', 'deepwork', 'a-b-c']) {
      const text = COMMAND_MARKER.wrap({ name, args: 'x' });
      expect(COMMAND_MARKER.parse(text)).toEqual({ name, args: 'x' });
    }
  });

  test('round-trips wrap → parse → strip (interview marker)', () => {
    for (const args of ['', 'build a notes app', 'line one\nline two']) {
      const text = INTERVIEW_MARKER.wrap({ args });
      expect(INTERVIEW_MARKER.parse(text)).toEqual({ args });
      expect(INTERVIEW_MARKER.strip(text)).toBe(args);
    }
  });

  test('wrap never expands $-sequences in args (byte-exact)', () => {
    // A string replacer would turn $$ into $, $& into the whole match,
    // $` into the preceding text, and $1 into a capture.
    expect(COMMAND_MARKER.wrap({ name: 'loop', args: 'pay $$ now' })).toBe(
      '<omos-cmd-command data-name="loop">pay $$ now</omos-cmd-command>',
    );
    expect(INTERVIEW_MARKER.wrap({ args: 'a $& b $` $$ $1 c' })).toBe(
      '<omos-interview-command>a $& b $` $$ $1 c</omos-interview-command>',
    );
  });

  test('strip keeps $-sequences byte-exact (function replacer)', () => {
    const args = 'a $& b $` $$ $1 c';
    const commandText = COMMAND_MARKER.wrap({ name: 'loop', args });
    expect(COMMAND_MARKER.strip(commandText)).toBe(args);
    expect(INTERVIEW_MARKER.strip(INTERVIEW_MARKER.wrap({ args }))).toBe(args);
  });

  test('whole-text anchored: embedded markers never parse or strip', () => {
    const commandText = COMMAND_MARKER.wrap({ name: 'reflect', args: 'a b' });
    const embeddedCommand = `look at ${commandText} please`;
    expect(COMMAND_MARKER.parse(embeddedCommand)).toBeUndefined();
    expect(COMMAND_MARKER.strip(embeddedCommand)).toBe(embeddedCommand);

    const interviewText = INTERVIEW_MARKER.wrap({ args: 'hijack' });
    const embeddedInterview = `before ${interviewText} after`;
    expect(INTERVIEW_MARKER.parse(embeddedInterview)).toBeUndefined();
    expect(INTERVIEW_MARKER.strip(embeddedInterview)).toBe(embeddedInterview);
  });

  test('whole-text anchored: surrounding whitespace is tolerated', () => {
    const commandText = COMMAND_MARKER.wrap({ name: 'reflect', args: 'a b' });
    expect(COMMAND_MARKER.parse(`  \n${commandText}\n  `)).toEqual({
      name: 'reflect',
      args: 'a b',
    });
    const interviewText = INTERVIEW_MARKER.wrap({ args: 'idea' });
    expect(INTERVIEW_MARKER.parse(` \t${interviewText}\t `)).toEqual({
      args: 'idea',
    });
  });

  test('non-greedy bodies recover closing-tag look-alikes', () => {
    // The lazy capture plus the `$` anchor extend over a closing-tag
    // substring inside the body, so the full args round-trip.
    const commandArgs = 'a</omos-cmd-command>b\nline two';
    const commandText = COMMAND_MARKER.wrap({
      name: 'loop',
      args: commandArgs,
    });
    expect(COMMAND_MARKER.parse(commandText)).toEqual({
      name: 'loop',
      args: commandArgs,
    });

    const interviewArgs = 'a</omos-interview-command>b';
    const interviewText = INTERVIEW_MARKER.wrap({ args: interviewArgs });
    expect(INTERVIEW_MARKER.parse(interviewText)).toEqual({
      args: interviewArgs,
    });
  });

  test('trimArgs knob: raw capture vs whitespace trimmed inside the tags', () => {
    // Generic marker (trimArgs off): args are captured raw.
    const raw =
      '<omos-cmd-command data-name="loop">  padded  </omos-cmd-command>';
    expect(COMMAND_MARKER.parse(raw)).toEqual({
      name: 'loop',
      args: '  padded  ',
    });
    expect(COMMAND_MARKER.strip(raw)).toBe('  padded  ');

    // Interview marker (trimArgs on): whitespace inside the tags is
    // tolerated and trimmed from the capture.
    const trimmed =
      '<omos-interview-command>  padded  </omos-interview-command>';
    expect(INTERVIEW_MARKER.parse(trimmed)).toEqual({ args: 'padded' });
    expect(INTERVIEW_MARKER.strip(trimmed)).toBe('padded');
  });

  test('returns undefined without a marker (kinds never cross-match)', () => {
    expect(COMMAND_MARKER.parse('plain user text')).toBeUndefined();
    expect(INTERVIEW_MARKER.parse('plain user text')).toBeUndefined();
    expect(
      COMMAND_MARKER.parse(INTERVIEW_MARKER.wrap({ args: 'x' })),
    ).toBeUndefined();
    expect(
      INTERVIEW_MARKER.parse(COMMAND_MARKER.wrap({ name: 'x', args: 'y' })),
    ).toBeUndefined();
  });
});

describe('createCommandMarkerKit factory (synthetic configs)', () => {
  test('namePattern defaults to a non-empty run without quotes', () => {
    const kit = createCommandMarkerKit({ tag: 'k', nameAttribute: 'data-x' });
    expect(kit.pattern.source).toBe(
      String.raw`^\s*<k\s+data-x="([^"]+)">([\s\S]*?)<\/k>\s*$`,
    );
    expect(kit.parse('<k data-x="any value!">a</k>')).toEqual({
      name: 'any value!',
      args: 'a',
    });
    expect(kit.parse('<k data-x="">a</k>')).toBeUndefined();
  });

  test('config drives every assembled pattern segment', () => {
    const kit = createCommandMarkerKit({
      tag: 'k',
      nameAttribute: 'id',
      namePattern: '[a-z]+',
      trimArgs: true,
    });
    expect(kit.pattern.source).toBe(
      String.raw`^\s*<k\s+id="([a-z]+)">\s*([\s\S]*?)\s*<\/k>\s*$`,
    );
  });
});
