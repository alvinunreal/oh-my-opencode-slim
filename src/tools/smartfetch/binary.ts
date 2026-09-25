import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BinaryFetch } from './types';

export function base64Size(byteLength: number) {
  return 4 * Math.ceil(byteLength / 3);
}

export function detectInlineImageMime(data: Uint8Array) {
  if (
    data.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => data[index] === byte,
    )
  )
    return 'image/png';
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return 'image/jpeg';
  if (data.length >= 6) {
    const signature = Buffer.from(data.subarray(0, 6)).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}

export function fitUtf8(text: string, maxBytes: number, maxUnits = Infinity) {
  let base = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (base.length + char.length > maxUnits || bytes + size > maxBytes) break;
    base += char;
    bytes += size;
  }
  return base;
}

function extensionForMime(contentType: string) {
  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/zip': 'zip',
  };
  return map[mime] || 'bin';
}

export function buildBinaryResultMessage(
  fetchResult: BinaryFetch,
  savedPath?: string,
) {
  const subject = fetchResult.binaryKind.toUpperCase();
  if (savedPath) return `${subject} content saved to ${savedPath}`;
  return `${subject} content omitted because it exceeds the download limit.`;
}

export async function saveBinary(
  binaryDir: string,
  data: Uint8Array,
  contentType: string,
  filename?: string,
) {
  await mkdir(binaryDir, { recursive: true });
  const initialName =
    filename || `webfetch-${Date.now()}.${extensionForMime(contentType)}`;
  const parsed = path.parse(initialName);
  const ext = parsed.ext || `.${extensionForMime(contentType)}`;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = `-${attempt}${ext}`;
    const candidateName =
      attempt === 0
        ? initialName
        : `${fitUtf8(parsed.name, 255 - Buffer.byteLength(suffix))}${suffix}`;
    const file = path.join(binaryDir, candidateName);
    try {
      await writeFile(file, data, { flag: 'wx' });
      return file;
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Unable to allocate unique filename for binary content');
}
