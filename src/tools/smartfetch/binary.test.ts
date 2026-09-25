import { describe, expect, test } from 'bun:test';
import { base64Size, detectInlineImageMime } from './binary';

describe('smartfetch/inline images', () => {
  test('counts encoded bytes without the data URL prefix', () => {
    for (const [bytes, base64Bytes] of [
      [0, 0],
      [1, 4],
      [2, 4],
      [3, 4],
      [786432, 1048576],
      [786433, 1048580],
    ]) {
      expect(base64Size(bytes)).toBe(base64Bytes);
    }
  });

  test('recognizes only png, jpeg, gif and webp by signature', () => {
    const signatures: Array<[number[], string]> = [
      [[137, 80, 78, 71, 13, 10, 26, 10], 'image/png'],
      [[255, 216, 255, 224], 'image/jpeg'],
      [[...Buffer.from('GIF87a')], 'image/gif'],
      [[...Buffer.from('GIF89a')], 'image/gif'],
      [[...Buffer.from('RIFF1234WEBP')], 'image/webp'],
    ];
    for (const [bytes, mime] of signatures) {
      expect(detectInlineImageMime(Uint8Array.from(bytes))).toBe(mime);
    }
    for (const bytes of [
      [],
      [137, 80, 78, 71],
      [...Buffer.from('<svg></svg>')],
    ]) {
      expect(detectInlineImageMime(Uint8Array.from(bytes))).toBeUndefined();
    }
  });
});
