/**
 * Byte-signature table for the host read tool's closed image set.
 *
 * The observer consumes images only through the host read tool, which
 * re-sniffs the actual file bytes with exactly these four signatures
 * (read-filesystem `imageMime`) and gates its resize/normalize pipeline on
 * the same four mimes (tool/read.ts `SUPPORTED_IMAGE_MIMES`). Anything else
 * is a BinaryFileError — a saved image outside this set is one nobody in the
 * stack can view. Keep this table aligned with the host's; a miss means
 * "not ours to save" — and absent any other image evidence, not an image at
 * all.
 *
 * Necessary, not sufficient: the host resizer can still fail to decode a
 * signature match. If the host widens its set, this mirror degrades
 * benignly — an extra image stays inline instead of being stripped.
 */

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((value, index) => bytes[index] === value);

/** Mirrors the host read tool's imageMime byte sniffing. */
export function detectInlineImageMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp';
  }
  return undefined;
}
