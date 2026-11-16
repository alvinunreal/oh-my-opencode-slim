import { expect, test } from 'bun:test';
import { classifyOpenCodeVersion } from './opencode-version';

test('classifies colored OpenCode version output', () => {
  const colored = (version: string) =>
    `\x1b[1mopencode\x1b[0m \x1b[2mv\x1b[0m\x1b[1m${version}\x1b[0m\n`;
  expect(classifyOpenCodeVersion(colored('2.3.0'))).toBe('supported');
  expect(classifyOpenCodeVersion(colored('2.2.4'))).toBe('unsupported');
});
