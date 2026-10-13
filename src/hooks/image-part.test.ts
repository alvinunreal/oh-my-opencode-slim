import { describe, expect, it } from 'bun:test';
import { detectInlineImageMime } from '../utils/image-signatures';
import { asImagePart, MIME_EXT_BY_TYPE } from './image-part';

const IMG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const IMG_BASE64 = IMG_BYTES.toString('base64');
const IMG_DATA_URL = `data:image/png;base64,${IMG_BASE64}`;
/** Real HEIC container prefix: size box + 'ftypheic' brand + padding. */
const HEIC_BYTES = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.alloc(4),
]);
const BMP_BYTES = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(2)]);

/** v2.0.14+ Media.Asset, live-instance form (base64 or bytes source). */
function assetPart(
  source: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'media',
    media: { mediaType: 'image/png', kind: 'image', source, ...overrides },
    filename: 'clipboard.png',
  };
}

describe('asImagePart host shape matrix', () => {
  describe('v1 file/image parts', () => {
    it('materializes a v1 image part with a base64 data field (no url)', () => {
      const view = asImagePart({
        type: 'image',
        data: IMG_BASE64,
        filename: 'paste.png',
      });
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'paste.png',
      });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });
    it('materializes a v1 image part with a data URL', () => {
      const view = asImagePart({ type: 'image', url: IMG_DATA_URL });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('materializes a v1 file part carrying image bytes', () => {
      const view = asImagePart({
        type: 'file',
        url: IMG_DATA_URL,
        filename: 'photo.png',
      });
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'photo.png',
      });
    });

    it('treats a v1 image behind a remote URL as remote', () => {
      expect(
        asImagePart({ type: 'image', url: 'https://example.com/a.png' }),
      ).toEqual({
        view: 'remote',
      });
    });

    it('treats a zero-byte v1 data URL as remote', () => {
      // 'A' is one base64 character: it decodes to zero bytes.
      expect(
        asImagePart({ type: 'image', url: 'data:image/png;base64,A' }),
      ).toEqual({
        view: 'remote',
      });
    });

    it('treats an extension-only v1 file part as remote', () => {
      expect(
        asImagePart({
          type: 'file',
          filename: 'logo.svg',
          url: 'file:///tmp/logo.svg',
        }),
      ).toEqual({ view: 'remote' });
    });

    it('rejects non-image v1 file parts', () => {
      expect(
        asImagePart({ type: 'file', url: 'data:text/plain;base64,aGk=' }),
      ).toBeNull();
    });

    it('keeps a v1 image with a heic data URL inline as remote', () => {
      expect(
        asImagePart({
          type: 'image',
          url: `data:image/heic;base64,${HEIC_BYTES.toString('base64')}`,
        }),
      ).toEqual({ view: 'remote' });
    });

    it('keeps a v1 image whose bytes contradict its declared mime inline', () => {
      expect(
        asImagePart({
          type: 'image',
          url: `data:image/png;base64,${BMP_BYTES.toString('base64')}`,
        }),
      ).toEqual({ view: 'remote' });
    });
  });

  describe('flat v2 media parts', () => {
    it('materializes a flat media part with base64 data', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: IMG_BASE64,
        filename: 'shot.png',
      });
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'shot.png',
      });
    });

    it('materializes flat media with Uint8Array data (dev shape)', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: new Uint8Array(IMG_BYTES),
      });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('treats flat media with no payload as remote', () => {
      expect(asImagePart({ type: 'media', mediaType: 'image/png' })).toEqual({
        view: 'remote',
      });
    });

    it('treats flat media with an empty payload as remote', () => {
      expect(
        asImagePart({ type: 'media', mediaType: 'image/png', data: '' }),
      ).toEqual({ view: 'remote' });
    });

    it('keeps a lying image claim with foreign bytes inline as remote', () => {
      // Declared image mimes are real image evidence, so the part stays a
      // remote image — but the bytes never reach the save gate.
      for (const bytes of [
        HEIC_BYTES,
        Buffer.from('PK\x03\x04-archive', 'latin1'),
      ]) {
        expect(
          asImagePart({
            type: 'media',
            mediaType: 'image/png',
            data: bytes.toString('base64'),
            filename: 'photo.png',
          }),
        ).toEqual({ view: 'remote' });
      }
    });

    it('keeps declared svg media inline and never saves it', () => {
      expect(
        asImagePart({ type: 'media', mediaType: 'image/svg+xml' }),
      ).toEqual({ view: 'remote' });
      expect(
        asImagePart({
          type: 'media',
          mediaType: 'image/svg+xml',
          data: Buffer.from('<svg></svg>').toString('base64'),
        }),
      ).toEqual({ view: 'remote' });
    });
  });

  describe('v2.0.14+ Media.Asset parts', () => {
    it('materializes an Asset with a base64 source (#1247 clipboard case)', () => {
      const view = asImagePart(
        assetPart({ type: 'base64', data: IMG_BASE64, mediaType: 'image/png' }),
      );
      expect(view).toMatchObject({
        view: 'bytes',
        ext: '.png',
        filename: 'clipboard.png',
      });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('materializes an Asset with a bytes source', () => {
      const view = asImagePart(
        assetPart({
          type: 'bytes',
          data: new Uint8Array(IMG_BYTES),
          mediaType: 'image/png',
        }),
      );
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('materializes the JSON-replayed Asset form: no top-level mediaType, bytes-as-base64-string', () => {
      // Asset.toJSON emits { source, info } only; a bytes source serializes
      // its data as base64 while keeping type === 'bytes'.
      const view = asImagePart({
        type: 'media',
        media: {
          source: { type: 'bytes', data: IMG_BASE64, mediaType: 'image/png' },
        },
        filename: 'replayed.png',
      });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('treats Asset url and ref sources as remote', () => {
      expect(
        asImagePart(
          assetPart({ type: 'url', url: 'https://example.com/a.png' }),
        ),
      ).toEqual({ view: 'remote' });
      expect(
        asImagePart(
          assetPart({ type: 'ref', provider: 'openai', id: 'file-1' }),
        ),
      ).toEqual({ view: 'remote' });
    });

    it('treats an unrecognized Asset source as remote, not null', () => {
      expect(
        asImagePart(assetPart({ type: 'stream', data: IMG_BASE64 })),
      ).toEqual({ view: 'remote' });
    });

    it('treats malformed Asset carriers as remote', () => {
      expect(asImagePart(assetPart({ type: 'base64', data: 42 }))).toEqual({
        view: 'remote',
      });
    });

    it('treats a zero-byte Asset payload as remote', () => {
      expect(
        asImagePart(
          assetPart({
            type: 'bytes',
            data: new Uint8Array(0),
            mediaType: 'image/png',
          }),
        ),
      ).toEqual({ view: 'remote' });
    });

    it('detects an Asset image via filename extension when mediaType is generic', () => {
      const view = asImagePart(
        assetPart(
          { type: 'url', url: 'https://example.com/x' },
          { mediaType: 'application/octet-stream' },
        ),
      );
      expect(view).toEqual({ view: 'remote' });
    });

    it('rejects non-image Asset media', () => {
      expect(
        asImagePart({
          type: 'media',
          media: {
            mediaType: 'audio/mpeg',
            source: { type: 'base64', data: 'AAAA', mediaType: 'audio/mpeg' },
          },
        }),
      ).toBeNull();
    });

    it('rescues good bytes behind a lying heic declaration', () => {
      const view = asImagePart(
        assetPart(
          { type: 'base64', data: IMG_BASE64, mediaType: 'image/png' },
          { mediaType: 'image/heic' },
        ),
      );
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
    });

    it('keeps a genuinely heic Asset inline as remote', () => {
      expect(
        asImagePart(
          assetPart(
            {
              type: 'base64',
              data: HEIC_BYTES.toString('base64'),
              mediaType: 'image/heic',
            },
            { mediaType: 'image/heic' },
          ),
        ),
      ).toEqual({ view: 'remote' });
    });
  });

  describe('non-image and degenerate parts', () => {
    it('rejects plain text parts, non-records, and unknown types', () => {
      expect(asImagePart({ type: 'text', text: 'hi' })).toBeNull();
      expect(asImagePart('media')).toBeNull();
      expect(asImagePart(null)).toBeNull();
      expect(asImagePart({ type: 'video', url: IMG_DATA_URL })).toBeNull();
    });

    it('rejects a media part whose media field is not a record', () => {
      expect(asImagePart({ type: 'media', media: 'not-an-asset' })).toBeNull();
    });

    it('rescues an unclassified octet-stream Asset by sniffing image signatures', () => {
      // IMG_BYTES is the PNG signature: a clipboard image the host could not
      // classify still reaches the observer pipeline.
      const view = asImagePart({
        type: 'media',
        media: {
          mediaType: 'application/octet-stream',
          source: { type: 'base64', data: IMG_BASE64 },
        },
        filename: 'clipboard',
      });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      expect((view as { bytes: Buffer }).bytes.equals(IMG_BYTES)).toBe(true);
    });

    it('rescues an unclassified octet-stream Asset without any filename (#1247)', () => {
      const view = asImagePart({
        type: 'media',
        media: {
          mediaType: 'application/octet-stream',
          source: { type: 'base64', data: IMG_BASE64 },
        },
      });
      expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
    });

    it('rejects unclassified payloads whose bytes never hit the sniff table', () => {
      // Zero-evidence non-image payloads (an untyped ZIP, stray text, or a
      // genuinely exotic image format) are not images to this pipeline:
      // nobody in the stack can view them, so the observer-disabled
      // warning must not claim otherwise.
      const foreign = [
        Buffer.from('PK\x03\x04-archive', 'latin1'), // ZIP
        Buffer.from('plain text, not an image'),
        BMP_BYTES,
        Buffer.from('49492a00', 'hex'), // TIFF little-endian
        Buffer.from('4d4d002a', 'hex'), // TIFF big-endian
        HEIC_BYTES,
        Buffer.concat([
          Buffer.alloc(4),
          Buffer.from('ftypavif', 'latin1'),
          Buffer.alloc(4),
        ]),
      ];
      for (const bytes of foreign) {
        expect(
          asImagePart({
            type: 'media',
            mediaType: 'application/octet-stream',
            data: bytes.toString('base64'),
          }),
        ).toBeNull();
        expect(
          asImagePart({
            type: 'media',
            media: {
              mediaType: 'application/octet-stream',
              source: {
                type: 'bytes',
                data: new Uint8Array(bytes),
                mediaType: 'application/octet-stream',
              },
            },
            filename: 'clipboard',
          }),
        ).toBeNull();
      }
    });

    it('keeps an unclassified payload with an image filename but foreign bytes inline', () => {
      // Hole B: octet-stream + photo.png + HEIC bytes — the extension can
      // never qualify a payload whose actual bytes are not consumable.
      expect(
        asImagePart({
          type: 'media',
          mediaType: 'application/octet-stream',
          data: HEIC_BYTES.toString('base64'),
          filename: 'photo.png',
        }),
      ).toEqual({ view: 'remote' });
    });

    it('never second-guesses a specific non-image declaration', () => {
      expect(
        asImagePart({
          type: 'media',
          media: {
            mediaType: 'audio/mpeg',
            source: {
              type: 'base64',
              data: IMG_BASE64,
              mediaType: 'audio/mpeg',
            },
          },
        }),
      ).toBeNull();
    });

    it('keeps a v1 file with a declared pdf payload and an image filename inline', () => {
      expect(
        asImagePart({
          type: 'file',
          url: `data:application/pdf;base64,${Buffer.from('%PDF-1.7').toString('base64')}`,
          filename: 'photo.bmp',
        }),
      ).toEqual({ view: 'remote' });
    });
  });

  describe('consumable-set byte gate', () => {
    it('saves only bytes that sniff into the host read tool image set', () => {
      const consumable: Array<[Buffer, string]> = [
        [IMG_BYTES, 'image/png'],
        [Buffer.from('ffd8ffe000104a464946', 'hex'), 'image/jpeg'],
        [Buffer.from('GIF87a', 'latin1'), 'image/gif'],
        [Buffer.from('GIF89a', 'latin1'), 'image/gif'],
        [
          Buffer.concat([
            Buffer.from('RIFF', 'latin1'),
            Buffer.alloc(4),
            Buffer.from('WEBP', 'latin1'),
          ]),
          'image/webp',
        ],
      ];
      for (const [bytes, mime] of consumable) {
        expect(
          asImagePart({
            type: 'media',
            mediaType: 'application/octet-stream',
            data: bytes.toString('base64'),
          }),
        ).toMatchObject({ view: 'bytes', ext: MIME_EXT_BY_TYPE[mime] });
      }
    });

    it('every bytes view satisfies the strip⇔consumable invariant', () => {
      const parts = [
        { type: 'image', url: IMG_DATA_URL },
        {
          type: 'media',
          mediaType: 'image/png',
          data: IMG_BASE64,
          filename: 'shot.png',
        },
        {
          type: 'media',
          mediaType: 'application/octet-stream',
          data: Buffer.from('ffd8ffe000104a464946', 'hex').toString('base64'),
        },
        {
          type: 'file',
          url: `data:image/gif;base64,${Buffer.from('GIF89a', 'latin1').toString('base64')}`,
          filename: 'clip.gif',
        },
      ];
      for (const part of parts) {
        const view = asImagePart(part);
        expect(view?.view).toBe('bytes');
        const sniffed = detectInlineImageMime(
          (view as { bytes: Buffer }).bytes,
        );
        expect(sniffed).toBeDefined();
        expect((view as { ext: string }).ext).toBe(
          MIME_EXT_BY_TYPE[sniffed as string],
        );
      }
    });
  });

  describe('extension resolution', () => {
    it('derives the saved extension only from sniffed bytes, never the filename', () => {
      for (const filename of ['photo.jpg', 'shot.nef', 'photo.bmp']) {
        const view = asImagePart({
          type: 'media',
          mediaType: 'image/png',
          data: IMG_BASE64,
          filename,
        });
        expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      }
    });

    it('rescues good bytes behind unmapped and exotic image declarations', () => {
      for (const mime of [
        'image/heic',
        'image/heif',
        'image/tiff',
        'image/avif',
        'image/x-nikon-raw',
      ]) {
        const view = asImagePart({
          type: 'media',
          mediaType: mime,
          data: IMG_BASE64,
          filename: 'shot.nef',
        });
        expect(view).toMatchObject({ view: 'bytes', ext: '.png' });
      }
    });

    it('sniffs the extension for extensionless filenames', () => {
      const view = asImagePart({
        type: 'media',
        mediaType: 'image/png',
        data: IMG_BASE64,
        filename: 'clipboard',
      });
      expect(view).toMatchObject({ ext: '.png', filename: 'clipboard' });
    });
  });
});
