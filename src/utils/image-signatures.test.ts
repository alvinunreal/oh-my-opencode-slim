import { describe, expect, it } from 'bun:test';
import { detectInlineImageMime } from './image-signatures';

describe('detectInlineImageMime (host read-tool mirror)', () => {
  it('detects each signature of the closed consumable set', () => {
    const cases: Array<[Uint8Array, string]> = [
      [Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex')), 'image/png'],
      [
        Uint8Array.from(Buffer.from('ffd8ffe000104a464946', 'hex')),
        'image/jpeg',
      ],
      [Uint8Array.from(Buffer.from('GIF87a', 'latin1')), 'image/gif'],
      [Uint8Array.from(Buffer.from('GIF89a', 'latin1')), 'image/gif'],
      [
        Uint8Array.from(
          Buffer.concat([
            Buffer.from('RIFF', 'latin1'),
            Buffer.alloc(4),
            Buffer.from('WEBP', 'latin1'),
          ]),
        ),
        'image/webp',
      ],
    ];
    for (const [bytes, mime] of cases) {
      expect(detectInlineImageMime(bytes)).toBe(mime);
    }
  });

  it('rejects everything outside the host set', () => {
    const cases: Uint8Array[] = [
      Uint8Array.from(Buffer.from('BM\x36\x00\x00\x00', 'latin1')), // BMP
      Uint8Array.from(Buffer.from('49492a00', 'hex')), // TIFF little-endian
      Uint8Array.from(
        Buffer.concat([
          Buffer.alloc(4),
          Buffer.from('ftypheic', 'latin1'),
          Buffer.alloc(4),
        ]),
      ), // HEIC
      Uint8Array.from(Buffer.from('%PDF-1.7', 'latin1')),
      Uint8Array.from(Buffer.from('plain text, not an image')),
      Uint8Array.from([0x00, 0x00, 0x00]),
    ];
    for (const bytes of cases) {
      expect(detectInlineImageMime(bytes)).toBeUndefined();
    }
  });

  it('rejects short fragments that only partially match', () => {
    expect(
      detectInlineImageMime(Uint8Array.from([0xff, 0xd8])),
    ).toBeUndefined();
    expect(
      detectInlineImageMime(Uint8Array.from([0x47, 0x49, 0x46])),
    ).toBeUndefined();
    expect(
      detectInlineImageMime(Uint8Array.from(Buffer.from('RIFF', 'latin1'))),
    ).toBeUndefined();
  });
});
