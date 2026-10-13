/**
 * Single seam for every host image-part shape.
 *
 * opencode's media part has changed shape three times — v1 `file`/`image`
 * parts with data URLs, the flat v2 `{mediaType, data}`, and v2.0.14+
 * `{media: Media.Asset}` class instances (the dev branch returns to the flat
 * shape). JSON-persisted replay can also hand over a serialized Asset with
 * no top-level `mediaType` and `bytes` sources encoded as base64 strings.
 * Every fact about recognizing and extracting images from those shapes
 * lives here; callers only ever see the normalized view below.
 *
 * Two sets, two jobs:
 *
 * - Identity (broad) — any `image/*` mime, an image-ish filename extension,
 *   or a v1 `image` part decides only whether the part is an image at all.
 *   Payloads the host could not classify count only when their bytes sniff
 *   into the consumable set. Identity parts get the `remote` view and are
 *   never stripped.
 * - Consumable (host mirror) — the observer consumes images only through the
 *   host read tool, which re-sniffs the actual file bytes and accepts a
 *   closed set of four mimes (jpeg/png/gif/webp). A part is saved and
 *   stripped only when its actual bytes land in that set (`bytes` view),
 *   and the saved extension comes only from the sniffed mime — a lying
 *   filename can never relabel the file. Strip ⇔ consumable: anything else
 *   stays inline, where the host's capability replacement is the backstop.
 *
 * The consumable set is necessary, not sufficient (the host resizer can
 * still fail to decode a signature match). If the host ever widens its set,
 * this mirror degrades benignly: an extra image stays inline instead of
 * being stripped. The host normalizes idempotently, so saving raw bytes
 * never double-compresses.
 */

import { detectInlineImageMime } from '../utils/image-signatures';

export interface ImageBytesView {
  readonly view: 'bytes';
  readonly bytes: Buffer;
  readonly ext: string;
  readonly filename?: string;
}

export interface ImageRemoteView {
  readonly view: 'remote';
}

export type ImagePartView = ImageBytesView | ImageRemoteView;

/**
 * Identity evidence only — an image-ish filename extension never qualifies a
 * part for saving, it just marks it as an image (remote, kept inline).
 */
const IMAGE_FILE_EXTENSION_RE =
  /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic|heif|avif)$/i;

/** Saved-file extension for each consumable (sniffable) mime. */
export const MIME_EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function partFilename(part: Record<string, unknown>): string | undefined {
  return typeof part.filename === 'string'
    ? part.filename
    : typeof part.name === 'string'
      ? part.name
      : undefined;
}

function hasImageFileExtension(filename: string | undefined): boolean {
  return Boolean(filename && IMAGE_FILE_EXTENSION_RE.test(filename));
}

function isImageMime(mime: string | undefined): boolean {
  return Boolean(mime?.startsWith('image/'));
}

/** Mime values that mean "the host could not classify this payload". */
function isUnclassifiedMime(mime: string | undefined): boolean {
  return mime === undefined || mime === 'application/octet-stream';
}

/** Base64 string or raw Uint8Array payload (flat dev shape) to bytes. */
function decodePayload(data: unknown): Buffer | null {
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string' && data.length > 0) {
    // Buffer.from leniently decodes invalid base64 instead of throwing;
    // host-produced parts are well-formed, and the fail-open contract
    // (never throw, never block) takes precedence here.
    return Buffer.from(data, 'base64');
  }
  return null;
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
}

export function asImagePart(part: unknown): ImagePartView | null {
  if (!isRecord(part) || typeof part.type !== 'string') return null;
  const filename = partFilename(part);

  // Resolve the declared mime and the inline payload for each host shape.
  let mime: string | undefined;
  let bytes: Buffer | null;
  if (part.type === 'image' || part.type === 'file') {
    const url = typeof part.url === 'string' ? part.url : undefined;
    const decoded = url ? decodeDataUrl(url) : null;
    // v1 payloads travel as data URLs, but keep accepting a base64 `data`
    // field (the pre-refactor hook did) so nothing materializable is lost.
    bytes = decoded?.data ?? decodePayload(part.data);
    mime = typeof part.mime === 'string' ? part.mime : decoded?.mime;
  } else if (part.type === 'media') {
    if (isRecord(part.media)) {
      // v2.0.14+ `{media: Media.Asset}`: a live class instance or its
      // JSON-serialized form (`source` only, `bytes` data as base64
      // strings). Dispatch on structure, never on the type tag alone — the
      // host's shape has drifted exactly there.
      const source = isRecord(part.media.source)
        ? part.media.source
        : undefined;
      mime =
        (typeof part.media.mediaType === 'string'
          ? part.media.mediaType
          : undefined) ??
        (typeof source?.mediaType === 'string' ? source.mediaType : undefined);
      bytes =
        source?.type === 'base64' || source?.type === 'bytes'
          ? decodePayload(source.data)
          : null;
    } else {
      // v2 flat `{mediaType, data}` (the dev-branch shape).
      mime = typeof part.mediaType === 'string' ? part.mediaType : undefined;
      bytes = decodePayload(part.data);
    }
  } else {
    return null;
  }

  // Identity: is this part an image at all? The unclassified channel
  // (#1247 rescue — clipboard images the host failed to type) only counts
  // when the bytes actually sniff into the consumable set, so an untyped
  // non-image payload never masquerades as an image (no observer-disabled
  // warning for files the observer could not read anyway). Specific
  // non-image declarations are never second-guessed.
  const sniffed = bytes ? detectInlineImageMime(bytes) : undefined;
  const evidence =
    isImageMime(mime) ||
    hasImageFileExtension(filename) ||
    part.type === 'image' ||
    (isUnclassifiedMime(mime) && sniffed !== undefined);
  if (!evidence) return null;

  // The only save gate: the actual bytes must land in the host read tool's
  // consumable set. Everything else stays inline (remote, never stripped).
  if (sniffed && bytes) {
    return { view: 'bytes', bytes, ext: MIME_EXT_BY_TYPE[sniffed], filename };
  }
  return { view: 'remote' };
}
